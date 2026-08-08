/**
 * IPC 注册：把主进程能力安全暴露给渲染进程（配合 preload.js 的 contextBridge）。
 * 每个 handler 都返回 { ok, ... }，出错时返回 { ok: false, error }。
 */
const { ipcMain, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');

function errMsg(e) {
  return e && e.message ? e.message : String(e);
}

/** 帮助文档在本机的位置（区分开发模式与打包后的安装目录） */
function getDocPath(type) {
  if (app.isPackaged) {
    // 打包后：文档经 extraResources 放在 resources/docs 下（asar 之外，系统程序可直接打开）
    return type === 'tutorial'
      ? path.join(process.resourcesPath, 'docs', '教程.md')
      : path.join(process.resourcesPath, 'docs', 'README.md');
  }
  // 开发模式：直接读取项目内文件
  return type === 'tutorial'
    ? path.join(__dirname, '..', 'docs', '教程.md')
    : path.join(__dirname, '..', 'README.md');
}

function register(store, { win, quit }) {
  // 数据变化时通知渲染进程重新加载列表
  store.setChangeHandler(() => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('clip:changed', { reason: 'data' });
    }
  });

  // 获取完整记录列表（已排序）
  ipcMain.handle('clip:loadList', () => {
    try { return { ok: true, records: store.listRecords() }; }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  });

  // 点击卡片：重新复制到系统剪贴板
  ipcMain.handle('clip:copy', (_e, { id }) => {
    try { store.copyRecord(id); return { ok: true }; }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  });

  // 置顶 / 取消置顶
  ipcMain.handle('clip:pin', (_e, { id, pinned }) => {
    try { store.setPinned(id, !!pinned); return { ok: true }; }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  });

  // 删除单条记录
  ipcMain.handle('clip:del', (_e, { id }) => {
    try { store.deleteRecord(id); return { ok: true }; }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  });

  // 设置备注
  ipcMain.handle('clip:remark', (_e, { id, remark }) => {
    try { store.setRemark(id, remark); return { ok: true }; }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  });

  // 编辑本条记录的内容（文本正文；图片记录不支持）
  ipcMain.handle('clip:editContent', (_e, { id, content }) => {
    try { store.editContent(id, content || ''); return { ok: true }; }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  });

  // 读取设置
  ipcMain.handle('clip:getSettings', () => {
    try { return { ok: true, settings: store.getSettings() }; }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  });

  // 修改设置（留存天数 / 开机自启）
  ipcMain.handle('clip:setSettings', (_e, patch) => {
    try { return { ok: true, settings: store.setSettings(patch || {}) }; }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  });

  // 真正退出程序
  ipcMain.handle('clip:quit', () => {
    try { quit(); return { ok: true }; }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  });

  // 打开帮助文档（README / 教程.md），用系统默认程序打开
  ipcMain.handle('help:openDoc', async (_e, type) => {
    try {
      const file = getDocPath(type === 'tutorial' ? 'tutorial' : 'readme');
      if (!fs.existsSync(file)) return { ok: false, error: '文档文件不存在' };
      const openErr = await shell.openPath(file);
      if (openErr && openErr.length > 0) {
        // 系统没有关联打开方式时，退而在资源管理器中定位该文件
        shell.showItemInFolder(file);
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: errMsg(e) }; }
  });

  // 获取当前软件版本号（设置面板显示用）
  ipcMain.handle('clip:getVersion', () => {
    try { return { ok: true, version: app.getVersion() }; }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  });
}

module.exports = { register };
