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

  // 编辑本条内容（文本）：内容更新 + 去重指纹重算
  store.editContent(second.id, '第二段文本（已编辑）');
  const editedRec = store.listRecords().find((r) => r.id === second.id);
  const expectHash = require('crypto').createHash('sha256').update('第二段文本（已编辑）').digest('hex');
  const editedHash = db.get('SELECT hash FROM records WHERE id = ?', [second.id]).hash;
  check('编辑本条内容生效', editedRec.content === '第二段文本（已编辑）');
  check('编辑后指纹同步重算', editedHash === expectHash);

  // 编辑本条内容（图片）：不支持，内容保持不变
  const imgContentBefore = store.listRecords().find((r) => r.id === imgRec.id).content;
  store.editContent(imgRec.id, '尝试修改图片正文');
  check('图片记录不支持编辑正文', store.listRecords().find((r) => r.id === imgRec.id).content === imgContentBefore);

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

  // ---------- 界面加载与交互测试 ----------
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
  // 插入一条记录，触发主进程推送 → 界面渲染出卡片
  store.onCaptured({ type: 'text', hash: 'ui_1', content: 'UI 交互测试文本' });
  await new Promise((r) => setTimeout(r, 800)); // 等待渲染完成

  check('界面加载无错误', uiErrors.length === 0);
  if (uiErrors.length) console.log('界面错误详情:', JSON.stringify(uiErrors, null, 2));

  // 交互验证：复制按钮 / 「···」菜单（紧贴定位）/ 点击空白收起 / 复制成功提示
  const ui = await win.webContents.executeJavaScript(`(async () => {
    const card = document.querySelector('.card');
    const moreBtn = card && card.querySelector('.more-btn');
    const copyBtn = card && card.querySelector('.copy-btn');
    // 点击「···」→ 菜单弹出
    moreBtn && moreBtn.click();
    const menu = document.querySelector('.dropdown-menu');
    const menuVisible = menu && !menu.classList.contains('hidden');
    const itemCount = menu ? menu.querySelectorAll('.menu-item').length : 0;
    // 菜单紧贴按钮：顶部对齐，且左边缘贴按钮右缘（或超出窗口时贴左缘）
    const rect = moreBtn ? moreBtn.getBoundingClientRect() : null;
    const menuLeft = menu ? parseFloat(menu.style.left) : NaN;
    const menuW = menu ? (menu.offsetWidth || 160) : 160;
    const topAligned = menuVisible && rect && menu ? Math.abs(parseFloat(menu.style.top) - rect.top) < 1 : false;
    const flushRight = !isNaN(menuLeft) && rect ? Math.abs(menuLeft - rect.right) < 1 : false;
    const flushLeft = !isNaN(menuLeft) && rect ? Math.abs(menuLeft - (rect.left - menuW)) < 1 : false;
    const flushAligned = menuVisible && (flushRight || flushLeft);
    // 点击页面空白处 → 菜单收起
    document.body.click();
    const menuClosed = menu && menu.classList.contains('hidden');
    // 点击复制按钮（触发 IPC 复制，不应抛错），稍等后检查「复制成功！」提示
    let copyOk = false;
    try { if (copyBtn) copyBtn.click(); copyOk = true; } catch (e) { copyOk = false; }
    await new Promise((r) => setTimeout(r, 200));
    const tipShown = !!card && !!card.querySelector('.copy-tip');
    return { hasMoreBtn: !!moreBtn, hasCopyBtn: !!copyBtn, menuVisible, itemCount, topAligned, flushAligned, menuClosed, copyOk, tipShown };
  })()`);
  check('卡片渲染出「···」按钮', !!ui.hasMoreBtn);
  check('卡片渲染出独立复制按钮', !!ui.hasCopyBtn);
  check('菜单弹出且包含 4 项', !!ui.menuVisible && ui.itemCount === 4);
  check('菜单紧贴按钮弹出（顶部对齐 / 左右贴合）', !!ui.topAligned && !!ui.flushAligned);
  check('点击空白处收起菜单', !!ui.menuClosed);
  check('点击复制按钮不报错', !!ui.copyOk);
  check('复制成功后显示「复制成功！」提示', !!ui.tipShown);

  // 插入一条图片记录 → 渲染出图片卡片，验证预览 / 提示弹窗 / 删除确认
  store.onCaptured({ type: 'image', hash: 'ui_img', image: nativeImage.createFromBuffer(PNG_1PX) });
  await new Promise((r) => setTimeout(r, 400));

  const ui2 = await win.webContents.executeJavaScript(`(async () => {
    const thumb = document.querySelector('.card .thumb');
    const imgCard = thumb ? thumb.closest('.card') : null;
    const imgThumb = imgCard && imgCard.querySelector('.thumb');
    // 点击图片缩略图 → 打开预览弹窗
    imgThumb && imgThumb.click();
    const previewShown = !document.getElementById('previewModal').classList.contains('hidden');
    // 点击放大按钮 → 缩放比例变化
    const zoomBefore = document.getElementById('previewZoomText').textContent;
    document.getElementById('zoomIn').click();
    const zoomAfter = document.getElementById('previewZoomText').textContent;
    const zoomChanged = zoomBefore !== zoomAfter;
    // 关闭预览弹窗
    document.getElementById('previewClose').click();
    const previewClosed = document.getElementById('previewModal').classList.contains('hidden');
    // 图片卡片「···」菜单 → 第 2 项「编辑本条内容」→ 弹出风格一致的提示
    const moreBtn = imgCard && imgCard.querySelector('.more-btn');
    moreBtn && moreBtn.click();
    const items = document.querySelectorAll('.dropdown-menu .menu-item');
    items[1] && items[1].click();
    const noticeShown = !document.getElementById('noticeModal').classList.contains('hidden');
    const noticeText = document.getElementById('noticeText').textContent;
    document.getElementById('noticeOk').click();
    const noticeClosed = document.getElementById('noticeModal').classList.contains('hidden');
    // 图片卡片「···」菜单 → 第 4 项「删除本条记录」→ 确认弹窗（红色确定按钮）
    moreBtn && moreBtn.click();
    const items2 = document.querySelectorAll('.dropdown-menu .menu-item');
    items2[3] && items2[3].click();
    const confirmShown = !document.getElementById('confirmModal').classList.contains('hidden');
    const confirmDanger = document.getElementById('confirmOk').classList.contains('btn-danger');
    // 点「取消」→ 弹窗关闭，图片卡片仍在
    document.getElementById('confirmCancel').click();
    const confirmClosed = document.getElementById('confirmModal').classList.contains('hidden');
    const cardStillThere = !!document.querySelector('.card .thumb');
    return { previewShown, zoomChanged, previewClosed, noticeShown, noticeText, noticeClosed, confirmShown, confirmDanger, confirmClosed, cardStillThere };
  })()`);
  check('点击图片缩略图打开预览弹窗', !!ui2.previewShown);
  check('预览弹窗支持放大缩放', !!ui2.zoomChanged);
  check('预览弹窗可关闭', !!ui2.previewClosed);
  check('图片记录编辑本条内容弹出风格一致提示', !!ui2.noticeShown && ui2.noticeText === '图片类型剪贴内容不支持编辑正文');
  check('提示弹窗可关闭', !!ui2.noticeClosed);
  check('删除前弹出确认窗口', !!ui2.confirmShown);
  check('删除确认按钮为红色警告色', !!ui2.confirmDanger);
  check('取消删除后弹窗关闭且卡片仍在', !!ui2.confirmClosed && !!ui2.cardStillThere);

  // 预览弹窗：滚轮缩放 + 鼠标拖拽平移
  const ui3 = await win.webContents.executeJavaScript(`(async () => {
    const thumb = document.querySelector('.card .thumb');
    const imgCard = thumb ? thumb.closest('.card') : null;
    const box = document.getElementById('previewModal').querySelector('.preview-box');
    const img = document.getElementById('previewImg');
    imgCard && imgCard.querySelector('.thumb').click();
    const opened = !document.getElementById('previewModal').classList.contains('hidden');
    // 滚轮缩放（deltaY<0 放大）
    const zBefore = document.getElementById('previewZoomText').textContent;
    box.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
    const wheelZoomed = zBefore !== document.getElementById('previewZoomText').textContent;
    // 鼠标拖拽平移（mousedown → mousemove → mouseup）
    const tBefore = img.style.transform;
    box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 140, clientY: 130 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const dragged = tBefore !== img.style.transform;
    document.getElementById('previewClose').click();
    return { opened, wheelZoomed, dragged };
  })()`);
  check('滚轮缩放预览图片', !!ui3.opened && !!ui3.wheelZoomed);
  check('鼠标拖拽移动预览图片', !!ui3.opened && !!ui3.dragged);

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
