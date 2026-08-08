/**
 * 系统托盘：让软件后台常驻监听剪贴板。
 * 关闭主窗口会隐藏到托盘，只有托盘右键"退出"才真正退出。
 */
const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let tray = null;

function init({ show, quit }) {
  if (tray) return;

  // 托盘图标（打包时已 asarUnpack，Electron 会自动映射到正确路径）
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'tray-icon.png'));

  tray = new Tray(icon);
  tray.setToolTip('剪贴板历史');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主界面', click: show },
    { type: 'separator' },
    { label: '退出', click: quit }
  ]));
  tray.on('double-click', show); // 双击托盘也能打开主界面
}

module.exports = { init };
