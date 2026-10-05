/**
 * 预加载脚本：在渲染进程里暴露安全的 window.clipHistory API。
 * 渲染进程无法直接访问 Node / Electron，只能通过这些方法操作剪贴板历史。
 *
 * ⚠️ 本文件里任何未捕获的异常都会让 preload 中断，
 *    导致 window.clipHistory 暴露不出来、整个界面白屏。所以这里只做取值，不碰 DOM。
 */
const { contextBridge, ipcRenderer } = require('electron');

// 启动时的主题：同步取一次（异步回调必定晚于首帧，深色模式会闪白）。
// 取不到就按浅色处理；无论成功失败都不能让异常冒出去。
// 真正写入 <html data-theme> 由 renderer/theme-init.js 在 <head> 里完成——
// preload 执行时 <html> 元素可能还没解析出来，直接操作 DOM 会抛错。
let initialTheme = 'light';
try {
  const saved = ipcRenderer.sendSync('clip:themeSync');
  const prefersDark = typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = saved === 'dark' || (saved === 'system' && prefersDark);
  initialTheme = isDark ? 'dark' : 'light';
} catch (e) {
  initialTheme = 'light';
}

contextBridge.exposeInMainWorld('clipHistory', {
  loadList: () => ipcRenderer.invoke('clip:loadList'),
  copyRecord: (id) => ipcRenderer.invoke('clip:copy', { id }),
  pinRecord: (id, pinned) => ipcRenderer.invoke('clip:pin', { id, pinned }),
  deleteRecord: (id) => ipcRenderer.invoke('clip:del', { id }),
  setRemark: (id, remark) => ipcRenderer.invoke('clip:remark', { id, remark }),
  editContent: (id, content) => ipcRenderer.invoke('clip:editContent', { id, content }),
  getSettings: () => ipcRenderer.invoke('clip:getSettings'),
  setSettings: (patch) => ipcRenderer.invoke('clip:setSettings', patch),
  quit: () => ipcRenderer.invoke('clip:quit'),
  // 打开帮助文档（'readme' 或 'tutorial'）
  openDoc: (type) => ipcRenderer.invoke('help:openDoc', type),
  // 获取当前软件版本号
  getVersion: () => ipcRenderer.invoke('clip:getVersion'),
  // 启动时已解析好的主题（同步返回，供 theme-init.js 在首帧前写入 <html>）
  getThemeSync: () => initialTheme,
  // 订阅数据变化推送（新增/删除/置顶等都会触发）
  onChanged: (cb) => { ipcRenderer.on('clip:changed', (_e, data) => cb(data)); }
});
