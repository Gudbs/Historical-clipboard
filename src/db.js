/**
 * 数据层：基于 sql.js（SQLite 编译为 WASM，纯 JS 无原生依赖）的持久化封装。
 *
 * - 数据库文件保存在本机用户数据目录：%APPDATA%\ClipHistory\clipboard.db
 * - 图片文件保存在：%APPDATA%\ClipHistory\images\
 * - 每次数据变更后「防抖」写盘，退出时同步 flush，保证不丢数据。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

let SQL = null;      // sql.js 模块实例
let db = null;       // 数据库实例
let dbPath = '';     // 数据库文件路径
let imagesDir = '';  // 图片存储目录
let saveTimer = null;

/** 初始化：加载 wasm、打开数据库、建表（启动时调用一次） */
async function init() {
  const userData = app.getPath('userData');
  dbPath = path.join(userData, 'clipboard.db');
  imagesDir = path.join(userData, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  // 直接从 asar 内读取 wasm 字节，避开打包后路径问题
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });

  if (fs.existsSync(dbPath)) {
    // 已有数据：载入旧数据库文件
    db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
  } else {
    db = new SQL.Database();
  }

  // 建表
  db.run(`CREATE TABLE IF NOT EXISTS records (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,               -- 'text' | 'image' | 'files'
    content     TEXT,                        -- 文本全文 / 文件路径文本（预览、搜索、回写）
    hash        TEXT NOT NULL,               -- 内容去重指纹（sha256）
    image_name  TEXT,                        -- 图片文件名（images 目录下）
    file_buf    TEXT,                        -- 文件复制原始剪贴板数据（JSON 字符串，base64）
    file_names  TEXT,                        -- 文件路径列表（JSON 数组）
    remark      TEXT NOT NULL DEFAULT '',    -- 用户备注
    pinned      INTEGER NOT NULL DEFAULT 0,  -- 0/1 置顶
    pinned_at   INTEGER,                     -- 置顶时间（置顶组内排序）
    created_at  INTEGER NOT NULL,            -- 复制时间（显示、清理依据）
    updated_at  INTEGER
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_records_created ON records(created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_records_hash ON records(hash)`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

  saveNow(); // 把建表结果落盘
  return db;
}

/** 查询多行 */
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/** 查询单行 */
function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

/** 执行变更语句（写操作，会自动触发防抖保存） */
function run(sql, params = []) {
  db.run(sql, params);
  saveSoon();
}

/** 图片存储目录 */
function getImagesDir() {
  return imagesDir;
}

/* ---------- 持久化 ---------- */

/** 防抖保存：600ms 内只落盘一次，避免频繁复制时重复写磁盘 */
function saveSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

/** 立即同步保存（退出前调用，保证数据不丢） */
function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!db) return;
  const data = Buffer.from(db.export());
  fs.writeFileSync(dbPath, data);
}

/** 读取设置项（不存在返回 defaultValue） */
function getSetting(key, defaultValue = '') {
  const row = get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : defaultValue;
}

/** 写入设置项（触发防抖保存） */
function setSetting(key, value) {
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
}

module.exports = { init, all, get, run, getImagesDir, saveSoon, saveNow, getSetting, setSetting };
