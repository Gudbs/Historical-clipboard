/**
 * 自动验证脚本：npx electron scripts/verify.js
 *
 * 用临时目录隔离测试数据（不碰真实的 %APPDATA%\ClipHistory），
 * 验证核心业务逻辑（去重 / 图片 / 文件 / 置顶 / 删除 / 清理 / 设置）和界面能否正常加载。
 * 全部通过时退出码为 0。
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 隔离测试数据目录（测试后自动删除）
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliphist-verify-'));
app.setPath('userData', testDir);
app.setName('ClipHistory');

const results = [];
function check(name, cond) { results.push({ name, pass: !!cond }); }

app.whenReady().then(async () => {
  const db = require('../src/db');
  const store = require('../src/store');
  await db.init();
  store.setChangeHandler(() => {});

  // ---------- 业务逻辑测试 ----------
  const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  // 文本：插入两条，再重复插入第一条 → 不新增，刷新到顶部
  store.onCaptured({ type: 'text', hash: 'h1', content: '第一段文本' });
  store.onCaptured({ type: 'text', hash: 'h2', content: '第二段文本' });
  store.onCaptured({ type: 'text', hash: 'h1', content: '第一段文本' });
  let recs = store.listRecords();
  check('文本记录插入', recs.filter((r) => r.type === 'text').length === 2);
  check('重复内容不新增', recs.length === 2);
  check('重复内容刷新到顶部', recs[0].content === '第一段文本');

  // 图片：落盘原图 + 缩略图
  const img = nativeImage.createFromBuffer(PNG_1PX);
  store.onCaptured({ type: 'image', hash: 'img1', image: img });
  const imgRec = store.listRecords().find((r) => r.type === 'image');
  const imgFull = path.join(db.getImagesDir(), imgRec.image_name);
  const imgThumb = path.join(db.getImagesDir(), 'thumb_' + imgRec.image_name);
  check('图片记录生成', !!imgRec && !!imgRec.image_name);
  check('原图文件存在', fs.existsSync(imgFull));
  check('缩略图文件存在', fs.existsSync(imgThumb));

  // 文件：模拟 FileNameW（UTF-16LE 路径列表）
  const paths = ['C:\\folder\\a.txt', 'C:\\folder\\b.png'];
  const utf16 = Buffer.concat(
    paths.map((p) => Buffer.concat([Buffer.from(p, 'utf16le'), Buffer.from([0, 0])]))
  );
  const fileBufJson = JSON.stringify({ FileNameW: utf16.toString('base64') });
  store.onCaptured({ type: 'files', hash: 'f1', content: paths.join('\n'), fileBufJson, fileNames: JSON.stringify(paths) });
  const fileRec = store.listRecords().find((r) => r.type === 'files');
  check('文件记录生成', !!fileRec && JSON.parse(fileRec.file_names).length === 2);

  // 置顶：置顶的记录排在最前
  const second = store.listRecords().find((r) => r.content === '第二段文本');
  store.setPinned(second.id, true);
  recs = store.listRecords();
  check('置顶记录排在最前', recs[0].id === second.id);

  // 备注
  store.setRemark(second.id, '我的备注');
  check('备注保存', store.listRecords().find((r) => r.id === second.id).remark === '我的备注');

  // 删除图片记录 → 文件被同步清理
  store.deleteRecord(imgRec.id);
  check('删除图片后文件清理', !fs.existsSync(imgFull) && !fs.existsSync(imgThumb));

  // 清理：过期普通记录删除，过期置顶记录保留
  store.onCaptured({ type: 'text', hash: 'h_old', content: '过期普通记录' });
  const oldRec = store.listRecords().find((r) => r.content === '过期普通记录');
  db.run('UPDATE records SET created_at = ? WHERE id = ?', [Date.now() - 10 * 24 * 3600 * 1000, oldRec.id]);
  store.onCaptured({ type: 'text', hash: 'h_old2', content: '过期置顶记录' });
  const pinnedOld = store.listRecords().find((r) => r.content === '过期置顶记录');
  db.run('UPDATE records SET created_at = ? WHERE id = ?', [Date.now() - 10 * 24 * 3600 * 1000, pinnedOld.id]);
  store.setPinned(pinnedOld.id, true);
  db.setSetting('retention_days', '3');
  store.cleanup();
  check('过期普通记录被清理', !store.listRecords().find((r) => r.id === oldRec.id));
  check('过期置顶记录保留', !!store.listRecords().find((r) => r.id === pinnedOld.id));

  // 设置
  const s = store.setSettings({ retentionDays: 1 });
  check('留存天数设置生效', s.retentionDays === 1);

  // 复制回写（文本）：应不报错
  try {
    const target = store.listRecords().find((r) => r.content === '第一段文本');
    store.copyRecord(target.id);
    check('复制回写不报错', true);
  } catch (e) {
    check('复制回写不报错', false);
  }

  // ---------- 界面加载测试 ----------
  const uiErrors = [];
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '..', 'src', 'preload.js')
    }
  });
  win.webContents.on('console-message', (_e, details) => {
    const msg = typeof details === 'string' ? details : (details && details.message) || '';
    if (msg.toLowerCase().includes('error')) uiErrors.push(msg);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => uiErrors.push('fail-load ' + code + ' ' + desc));
  win.webContents.on('render-process-gone', (_e, d) => uiErrors.push('render-gone ' + d.reason));

  // 注册 IPC（界面加载后会调用 loadList）
  const { register } = require('../src/ipc');
  register(store, { win, quit: () => {} });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 2000)); // 等待 renderer 初始渲染完成
  check('界面加载无错误', uiErrors.length === 0);
  if (uiErrors.length) console.log('界面错误详情:', JSON.stringify(uiErrors, null, 2));

  // ---------- 汇总 ----------
  let allPass = true;
  for (const r of results) {
    console.log((r.pass ? '[通过]' : '[失败]') + '  ' + r.name);
    if (!r.pass) allPass = false;
  }
  console.log(allPass ? '\n✅ 全部测试通过' : '\n❌ 存在失败用例');
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  app.exit(allPass ? 0 : 1);
});
