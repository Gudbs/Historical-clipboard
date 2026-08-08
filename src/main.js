/**
 * 主进程入口：负责应用生命周期、创建主窗口、注册图片协议、装配各模块。
 *
 * 启动顺序：
 *   app ready → 初始化数据库 → 启动剪贴板轮询 → 创建窗口/托盘 → 注册 IPC → 启动清理
 */
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// 固定应用显示名，保证开发与打包后的数据目录一致（%APPDATA%\ClipHistory）
app.setName('ClipHistory');
app.setAppUserModelId('com.example.cliphistory');

// 单实例锁：防止软件被重复打开导致同时轮询、双写数据库
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 必须在 app ready 之前注册自定义协议（图片显示用 clipimg://）
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'clipimg',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ]);

  let win = null;
  let isQuiting = false; // 用户从托盘点"退出"时为 true，此时允许真正关闭窗口

  function createWindow() {
    win = new BrowserWindow({
      width: 920,
      height: 720,
      minWidth: 640,
      minHeight: 480,
      title: '剪贴板历史',
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
      webPreferences: {
        contextIsolation: true,   // 渲染进程与主进程隔离，安全
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.setMenuBarVisibility(false); // 隐藏默认菜单栏

    // 点击窗口右上角关闭按钮 → 隐藏到托盘，后台继续监听
    win.on('close', (e) => {
      if (!isQuiting) {
        e.preventDefault();
        win.hide();
      }
    });
  }

  // 已有实例在运行时再次启动 → 显示主窗口
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    // 1) 数据库
    const db = require('./db');
    await db.init();

    // 2) 业务层 + 剪贴板监听
    const store = require('./store');
    require('./clipboard-monitor').start(store);

    // 3) 图片协议：clipimg://<文件名> 读取 images 目录下的图片
    const imagesDir = db.getImagesDir();
    protocol.handle('clipimg', (req) => {
      const name = new URL(req.url).hostname;
      // 只允许普通文件名，防止路径穿越
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) return new Response('', { status: 404 });
      const filePath = path.join(imagesDir, name);
      if (!fs.existsSync(filePath)) return new Response('', { status: 404 });
      return net.fetch(pathToFileURL(filePath).toString());
    });

    // 4) 窗口 + 托盘
    createWindow();
    require('./tray').init({
      show: () => { if (win) { win.show(); win.focus(); } },
      quit: () => { isQuiting = true; app.quit(); }
    });

    // 5) IPC
    require('./ipc').register(store, {
      win,
      quit: () => { isQuiting = true; app.quit(); }
    });

    // 6) 自动清理（立即 + 每小时）
    store.cleanupStart();

    // 冒烟测试模式：CLIPHISTORY_SMOKE=1 npm start 时 5 秒后自动退出，用于自动验证启动无报错
    if (process.env.CLIPHISTORY_SMOKE) {
      setTimeout(() => {
        console.log('[smoke] 主进程启动正常');
        app.exit(0);
      }, 5000);
    }
  });

  // 退出前同步保存数据库，保证最后一条记录不丢
  app.on('before-quit', () => {
    isQuiting = true;
    require('./db').saveNow();
  });

  // 所有窗口关闭时不退出（托盘常驻后台监听）
  app.on('window-all-closed', () => {});
}
