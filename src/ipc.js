/**
 * IPC 注册：把主进程能力安全暴露给渲染进程（配合 preload.js 的 contextBridge）。
 * 每个 handler 都返回 { ok, ... }，出错时返回 { ok: false, error }。
 */
const { ipcMain } = require('electron');

function errMsg(e) {
  return e && e.message ? e.message : String(e);
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
}

module.exports = { register };
