/**
 * 业务逻辑层：所有剪贴板记录的增删改查、去重、复制回写、置顶、备注、自动清理。
 *
 * 与剪贴板监听器（clipboard-monitor.js）的协作方式：
 *   monitor 每轮轮询读出剪贴板内容 → 调用 store.onCaptured(entry)；
 *   store 负责判定"跳过 / 刷新旧记录 / 新增记录"，以及向界面广播变化。
 */
const { clipboard, nativeImage, app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

// 上一轮剪贴板内容的指纹（用于去重，避免每 800ms 反复处理同一内容）
let lastHash = null;
// 界面刷新回调（由 ipc.js 注册，负责广播 clip:changed 到渲染进程）
let changeHandler = null;

/** sha256 指纹：字符串或 Buffer 都支持 */
function sha256(data) {
  const h = crypto.createHash('sha256');
  h.update(data);
  return h.digest('hex');
}

/** 数据变化后通知界面刷新 */
function notify() {
  if (changeHandler) changeHandler();
}

/** 设置界面刷新回调（ipc.js 调用） */
function setChangeHandler(fn) {
  changeHandler = fn;
}

/**
 * 剪贴板捕获入口（由 clipboard-monitor.js 调用）。
 * @param {{ type:'text'|'image'|'files', hash:string, content?:string,
 *          image?:import('electron').NativeImage, fileBufJson?:string, fileNames?:string }} entry
 */
function onCaptured(entry) {
  // 与上一轮轮询到的内容相同（剪贴板没变或刚回写过），直接忽略
  if (entry.hash === lastHash) return;
  lastHash = entry.hash;

  // 去重：内容已存在 → 只刷新复制时间，让它回到列表顶部（"重复复制只保存一条"）
  const existing = db.get('SELECT * FROM records WHERE hash = ?', [entry.hash]);
  if (existing) {
    db.run('UPDATE records SET created_at = ?, updated_at = ? WHERE id = ?',
      [Date.now(), Date.now(), existing.id]);
    notify();
    return;
  }

  // 新内容：先给图片落盘，再写数据库
  const id = crypto.randomUUID();
  const now = Date.now();
  let imageName = null;
  if (entry.type === 'image') {
    imageName = id + '.png';
    const dir = db.getImagesDir();
    fs.writeFileSync(path.join(dir, imageName), entry.image.toPNG());
    // 生成缩略图（列表展示用，避免大图拖慢界面）
    const h = entry.image.getSize().height;
    const thumb = entry.image.resize({ height: Math.min(256, h) });
    fs.writeFileSync(path.join(dir, 'thumb_' + imageName), thumb.toPNG());
  }

  db.run(
    `INSERT INTO records (id, type, content, hash, image_name, file_buf, file_names,
                          remark, pinned, pinned_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, entry.type, entry.content || '', entry.hash, imageName,
     entry.fileBufJson || null, entry.fileNames || null,
     '', 0, null, now, now]
  );
  notify();
}

/** 记录列表（已按 置顶在前 + 时间倒序 排好） */
function listRecords() {
  return db.all(
    `SELECT id, type, content, image_name, file_names, remark, pinned, created_at
     FROM records
     ORDER BY pinned DESC, COALESCE(pinned_at, created_at) DESC, created_at DESC`
  );
}

/** 点击卡片：把该记录重新复制到系统剪贴板 */
function copyRecord(id) {
  const rec = db.get('SELECT * FROM records WHERE id = ?', [id]);
  if (!rec) return;

  if (rec.type === 'text') {
    const text = rec.content || '';
    clipboard.writeText(text);
    lastHash = sha256(text); // 抑制：防止自己回写的内容被再次记录
  } else if (rec.type === 'image') {
    const img = nativeImage.createFromPath(path.join(db.getImagesDir(), rec.image_name));
    if (!img.isEmpty()) {
      clipboard.writeImage(img);
      lastHash = sha256(img.toBitmap());
    }
  } else if (rec.type === 'files') {
    // 文件复制：把保存的原始剪贴板数据原样写回（FileNameW + FileName + DropEffect）
    let data = {};
    try { data = JSON.parse(rec.file_buf || '{}'); } catch (e) { data = {}; }
    if (data.FileNameW) {
      clipboard.writeBuffer('FileNameW', Buffer.from(data.FileNameW, 'base64'));
      if (data.FileName) clipboard.writeBuffer('FileName', Buffer.from(data.FileName, 'base64'));
      if (data.DropEffect) clipboard.writeBuffer('Preferred DropEffect', Buffer.from(data.DropEffect, 'base64'));
      else clipboard.writeBuffer('Preferred DropEffect', Buffer.from([5])); // DROPEFFECT_COPY=5 复制语义
      lastHash = sha256(data.FileNameW);
    } else {
      // 兜底：复制文件路径文本
      const text = rec.content || '';
      clipboard.writeText(text);
      lastHash = sha256(text);
    }
  }
}

/** 置顶 / 取消置顶 */
function setPinned(id, pinned) {
  const now = Date.now();
  db.run('UPDATE records SET pinned = ?, pinned_at = ? WHERE id = ?',
    [pinned ? 1 : 0, pinned ? now : null, id]);
  notify();
}

/** 删除单条记录（同时删除对应的图片文件） */
function deleteRecord(id) {
  const rec = db.get('SELECT * FROM records WHERE id = ?', [id]);
  if (!rec) return;
  db.run('DELETE FROM records WHERE id = ?', [id]);
  removeImageFiles(rec);
  notify();
}

/** 设置备注（图片 / 文件记录靠备注检索） */
function setRemark(id, remark) {
  db.run('UPDATE records SET remark = ? WHERE id = ?', [remark || '', id]);
  notify();
}

/* ---------- 设置 ---------- */

function getSettings() {
  return {
    retentionDays: Number(db.getSetting('retention_days', '3')),
    autostart: db.getSetting('autostart', '0') === '1'
  };
}

function setSettings({ retentionDays, autostart }) {
  if (retentionDays !== undefined && [1, 3, 5].includes(Number(retentionDays))) {
    db.setSetting('retention_days', String(retentionDays));
  }
  if (autostart !== undefined) {
    app.setLoginItemSettings({ openAtLogin: !!autostart });
    db.setSetting('autostart', autostart ? '1' : '0');
  }
  cleanup(); // 按新留存天数立即清理一次
  notify();
  return getSettings();
}

/* ---------- 自动清理 ---------- */

/** 启动定时清理：立即一次 + 之后每小时一次 */
function cleanupStart() {
  cleanup();
  setInterval(cleanup, 60 * 60 * 1000);
}

/** 清理：删除"未置顶"且超过留存天数的记录，并回收孤儿图片文件 */
function cleanup() {
  const days = Number(db.getSetting('retention_days', '3')) || 3;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const expired = db.all('SELECT * FROM records WHERE pinned = 0 AND created_at < ?', [cutoff]);
  let changed = expired.length > 0;
  for (const rec of expired) {
    db.run('DELETE FROM records WHERE id = ?', [rec.id]);
    removeImageFiles(rec);
  }
  if (collectOrphanImages()) changed = true;
  if (changed) notify();
}

/** 删除某条记录对应的图片文件（原图 + 缩略图） */
function removeImageFiles(rec) {
  if (!rec || rec.type !== 'image' || !rec.image_name) return;
  const dir = db.getImagesDir();
  for (const name of [rec.image_name, 'thumb_' + rec.image_name]) {
    try { fs.unlinkSync(path.join(dir, name)); } catch (e) { /* 文件不存在忽略 */ }
  }
}

/** 回收图片目录中已不被任何记录引用的文件 */
function collectOrphanImages() {
  const dir = db.getImagesDir();
  const used = new Set();
  for (const r of db.all('SELECT image_name FROM records WHERE image_name IS NOT NULL')) {
    used.add(r.image_name);
    used.add('thumb_' + r.image_name);
  }
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return false; }
  let removed = false;
  for (const f of files) {
    if (!used.has(f)) {
      try { fs.unlinkSync(path.join(dir, f)); removed = true; } catch (e) { /* 忽略 */ }
    }
  }
  return removed;
}

module.exports = {
  onCaptured, listRecords, copyRecord, setPinned, deleteRecord, setRemark,
  getSettings, setSettings, cleanupStart, cleanup, setChangeHandler
};
