/**
 * 预加载脚本：在渲染进程里暴露安全的 window.clipHistory API。
 * 渲染进程无法直接访问 Node / Electron，只能通过这些方法操作剪贴板历史。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipHistory', {
  loadList: () => ipcRenderer.invoke('clip:loadList'),
  copyRecord: (id) => ipcRenderer.invoke('clip:copy', { id }),
  pinRecord: (id, pinned) => ipcRenderer.invoke('clip:pin', { id, pinned }),
  deleteRecord: (id) => ipcRenderer.invoke('clip:del', { id }),
  setRemark: (id, remark) => ipcRenderer.invoke('clip:remark', { id, remark }),
  getSettings: () => ipcRenderer.invoke('clip:getSettings'),
  setSettings: (patch) => ipcRenderer.invoke('clip:setSettings', patch),
  quit: () => ipcRenderer.invoke('clip:quit'),
  // 打开帮助文档（'readme' 或 'tutorial'）
  openDoc: (type) => ipcRenderer.invoke('help:openDoc', type),
  // 获取当前软件版本号
  getVersion: () => ipcRenderer.invoke('clip:getVersion'),
  // 订阅数据变化推送（新增/删除/置顶等都会触发）
  onChanged: (cb) => { ipcRenderer.on('clip:changed', (_e, data) => cb(data)); }
});
