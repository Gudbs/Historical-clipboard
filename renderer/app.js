/**
 * 界面逻辑：拉取记录列表、渲染卡片、搜索筛选、卡片操作、设置面板。
 * 只能通过 window.clipHistory（preload.js 暴露）与主进程通信。
 *
 * 卡片交互（本次改造后）：
 *   - 卡片右上角「···」→ 点击在按钮右侧弹出下拉菜单（编辑内容 / 置顶 / 删除）
 *   - 卡片内部「📋」复制按钮 → 只有手动点击它才把本条记录复制到剪贴板
 *   - 点击页面空白处或滚动窗口 → 收起下拉菜单
 *   - 点击卡片其他位置：不再触发复制
 */
const api = window.clipHistory;

// 全量记录（已排序）与当前搜索过滤后的记录
let records = [];
let filtered = [];

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const emptySub = emptyEl.querySelector('.empty-sub');
const searchInput = document.getElementById('searchInput');

/* ---------- 数据加载与渲染 ---------- */

async function load() {
  const res = await api.loadList();
  if (res.ok) {
    records = res.records || [];
    applyFilter();
  }
}

/** 取出文件记录的文件名列表（数据库里存的是 JSON 字符串） */
function fileNamesOf(rec) {
  try { return JSON.parse(rec.file_names || '[]'); } catch (e) { return []; }
}

/** 一条记录里所有可被搜索的文字：正文（文件记录即路径列表）+ 备注 */
function searchTextOf(rec) {
  return [(rec.content || ''), (rec.remark || '')].join('\n').toLowerCase();
}

/** 应用搜索关键词，过滤后渲染 */
function applyFilter() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) {
    filtered = records;
  } else {
    // 所有类型统一检索：正文 / 备注都能命中
    // （文本按内容，文件按路径与文件名，图片按备注，且备注对任何类型都生效）
    filtered = records.filter((r) => searchTextOf(r).includes(q));
  }
  render();
}

/** 渲染卡片列表 */
function render() {
  listEl.innerHTML = '';
  if (filtered.length === 0) {
    emptyEl.classList.remove('hidden');
    const hasSearch = searchInput.value.trim() !== '';
    emptyEl.querySelector('.empty-title').textContent = hasSearch ? '没有找到匹配的记录' : '还没有剪贴板记录';
    emptySub.textContent = hasSearch ? '换个关键词试试，或清空搜索框' : '去复制点文本、图片或文件试试';
    return;
  }
  emptyEl.classList.add('hidden');
  const frag = document.createDocumentFragment();
  filtered.forEach((rec, i) => frag.appendChild(createCard(rec, i === filtered.length - 1)));
  listEl.appendChild(frag);
}

/**
 * 创建一条记录卡片
 * @param {object} rec    记录数据
 * @param {boolean} isLast 是否为列表最后一张（决定「···」菜单向上还是向下展开）
 */
function createCard(rec, isLast) {
  const card = document.createElement('div');
  card.className = 'card' + (rec.pinned ? ' pinned' : '');
  card.dataset.id = rec.id;

  // —— 卡片主体（文本 / 图片 / 文件）——
  const body = document.createElement('div');
  body.className = 'card-body';

  if (rec.type === 'text') {
    const p = document.createElement('p');
    p.className = 'text-preview';
    p.textContent = rec.content || '';
    body.appendChild(p);
  } else if (rec.type === 'image') {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.loading = 'lazy';
    img.alt = '图片';
    img.src = 'clipimg://thumb_' + rec.image_name; // 自定义协议读取本地缩略图
    img.title = '点击放大预览';
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      openPreview(rec);
    });
    body.appendChild(img);
  } else if (rec.type === 'files') {
    const names = fileNamesOf(rec);
    const wrap = document.createElement('div');
    wrap.className = 'file-card';
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = '📁';
    const ul = document.createElement('ul');
    ul.className = 'file-list';
    names.slice(0, 20).forEach((n) => {
      const li = document.createElement('li');
      li.textContent = n;
      ul.appendChild(li);
    });
    if (names.length > 20) {
      const more = document.createElement('li');
      more.className = 'file-more';
      more.textContent = '… 共 ' + names.length + ' 个文件';
      ul.appendChild(more);
    }
    wrap.appendChild(icon);
    wrap.appendChild(ul);
    body.appendChild(wrap);
  }
  card.appendChild(body);

  // —— 右上角「···」更多操作按钮 ——
  const moreBtn = document.createElement('button');
  moreBtn.className = 'more-btn';
  moreBtn.textContent = '···';
  moreBtn.title = '更多操作';
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu(card, rec, moreBtn, isLast);
  });
  card.appendChild(moreBtn);

  // —— 底部信息行：置顶徽章 + 时间 + 备注 + 复制按钮 ——
  const meta = document.createElement('div');
  meta.className = 'card-meta';

  if (rec.pinned) {
    const badge = document.createElement('span');
    badge.className = 'pin-badge';
    badge.textContent = '已置顶';
    meta.appendChild(badge);
  }

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTime(rec.created_at);
  meta.appendChild(time);

  if (rec.remark) {
    const rm = document.createElement('span');
    rm.className = 'remark-text';
    rm.textContent = '备注：' + rec.remark;
    rm.title = rec.remark;
    meta.appendChild(rm);
  }

  // 独立的复制按钮：只有手动点它才复制本条到剪贴板
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = '📋';
  copyBtn.title = '复制到剪贴板';
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const res = await api.copyRecord(rec.id);
    if (res && res.ok) showCopyTip(card);
  });
  meta.appendChild(copyBtn);

  card.appendChild(meta);
  return card;
}

/* ---------- 下拉菜单（全局单例） ---------- */

let menuEl = null;

/** 确保下拉菜单元素存在（只创建一次） */
function ensureMenu() {
  if (menuEl) return menuEl;
  menuEl = document.createElement('div');
  menuEl.className = 'dropdown-menu hidden';
  document.body.appendChild(menuEl);
  return menuEl;
}

/** 收起下拉菜单 */
function hideMenu() {
  if (menuEl) menuEl.classList.add('hidden');
}

/**
 * 在「···」按钮右侧弹出本条记录的下拉菜单。
 * 最后一张卡片向下没有空间，菜单改为向上展开（底部与按钮对齐），其余卡片一律向下展开。
 */
function toggleMenu(card, rec, moreBtn, isLast) {
  const menu = ensureMenu();
  // 菜单已打开且属于同一张卡片 → 再次点击收起
  if (menu._targetId === rec.id && !menu.classList.contains('hidden')) {
    hideMenu();
    return;
  }

  // 填充四个菜单项（顺序：编辑备注 → 编辑本条内容 → 置顶/取消置顶 → 删除）
  menu.innerHTML = '';
  addMenuItem(menu, '编辑备注', () => { hideMenu(); openRemarkModal(rec); });
  addMenuItem(menu, '编辑本条内容', () => { hideMenu(); openEditContentModal(rec); });
  addMenuItem(menu, rec.pinned ? '取消置顶' : '置顶本条记录', () => { hideMenu(); api.pinRecord(rec.id, !rec.pinned); });
  addMenuItem(menu, '删除本条记录', () => { hideMenu(); askDelete(rec.id); }, 'danger');
  menu._targetId = rec.id;

  // 先显示再量尺寸：菜单是 display:none 时量不到宽高，同帧内改完位置不会闪
  menu.classList.remove('hidden');
  const rect = moreBtn.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || 160;
  const menuHeight = menu.offsetHeight || 160;

  // 水平：紧贴「···」按钮右侧；超出窗口右边缘时改放按钮左侧
  let left = rect.right;
  if (left + menuWidth > window.innerWidth - 8) left = rect.left - menuWidth;
  menu.style.left = Math.max(8, left) + 'px';

  // 垂直：最后一张卡片向上展开（菜单底部对齐按钮底部）；其余卡片向下展开（顶部对齐按钮顶部）
  let top = isLast ? rect.bottom - menuHeight : rect.top;
  if (top < 8) top = 8; // 窗口太矮时贴顶，保证菜单顶端可见
  menu.style.top = top + 'px';
}

/** 添加一个下拉菜单项 */
function addMenuItem(menu, label, onClick, extraClass) {
  const item = document.createElement('button');
  item.className = 'menu-item' + (extraClass ? ' ' + extraClass : '');
  item.textContent = label;
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  menu.appendChild(item);
}

// 点击页面任意空白处收起菜单
document.addEventListener('click', (e) => {
  if (menuEl && !menuEl.contains(e.target)) hideMenu();
});
// 滚动或改变窗口大小时收起菜单（防止菜单错位）
window.addEventListener('scroll', hideMenu, true);
window.addEventListener('resize', hideMenu);

/* ---------- 时间格式化 ---------- */

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- 搜索（防抖 150ms） ---------- */

let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilter, 150);
});

/* ---------- 弹窗通用 ---------- */

function showModal(id) { document.getElementById(id).classList.remove('hidden'); }
function hideModal(id) { document.getElementById(id).classList.add('hidden'); }

// 点击遮罩空白处关闭弹窗
// 「编辑本条内容」与「放弃修改」例外：只能点按钮关闭，避免误触丢失正在编辑的内容
const MASK_CLICK_LOCKED = ['editContentModal', 'discardModal'];
document.querySelectorAll('.modal-mask').forEach((mask) => {
  if (MASK_CLICK_LOCKED.includes(mask.id)) return;
  mask.addEventListener('click', (e) => {
    if (e.target === mask) mask.classList.add('hidden');
  });
});

/* ---------- 备注编辑（菜单项「编辑备注」入口） ---------- */

let remarkTargetId = null;

function openRemarkModal(rec) {
  remarkTargetId = rec.id;
  document.getElementById('remarkInput').value = rec.remark || '';
  showModal('remarkModal');
  document.getElementById('remarkInput').focus();
}

document.getElementById('remarkSave').addEventListener('click', async () => {
  await api.setRemark(remarkTargetId, document.getElementById('remarkInput').value.trim());
  hideModal('remarkModal');
});
document.getElementById('remarkCancel').addEventListener('click', () => hideModal('remarkModal'));
document.getElementById('remarkInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('remarkSave').click();
});

/* ---------- 编辑本条内容（菜单项「编辑本条内容」入口） ---------- */

let editContentTargetId = null;
let editContentOriginal = ''; // 打开弹窗时的原文，用来判断用户有没有改过

/** 打开「编辑本条内容」弹窗；图片记录不支持编辑正文，弹出风格一致的提示窗口 */
function openEditContentModal(rec) {
  if (rec.type === 'image') {
    showNotice('图片类型剪贴内容不支持编辑正文');
    return;
  }
  editContentTargetId = rec.id;
  const input = document.getElementById('editContentInput');
  input.value = rec.content || '';
  input.style.height = ''; // 恢复默认高度，不沿用上一条记录拖拽出来的高度
  editContentOriginal = input.value;
  showModal('editContentModal');
  input.focus();
}

document.getElementById('editContentSave').addEventListener('click', async () => {
  const text = document.getElementById('editContentInput').value;
  if (!text.trim()) { hideModal('editContentModal'); return; } // 内容为空时不更新
  await api.editContent(editContentTargetId, text);
  hideModal('editContentModal');
});

// 取消：没改过内容直接关闭；改过则先确认，避免误点丢失编辑
document.getElementById('editContentCancel').addEventListener('click', () => {
  if (document.getElementById('editContentInput').value === editContentOriginal) {
    hideModal('editContentModal');
    return;
  }
  hideModal('editContentModal'); // 先收起编辑窗，确认弹窗单独显示
  showModal('discardModal');
});

// 继续编辑：回到编辑窗，已输入的内容原样保留
document.getElementById('discardCancel').addEventListener('click', () => {
  hideModal('discardModal');
  showModal('editContentModal');
  document.getElementById('editContentInput').focus();
});

// 放弃修改：编辑窗已收起，直接回到列表
document.getElementById('discardOk').addEventListener('click', () => hideModal('discardModal'));

/* ---------- 复制成功提示 ---------- */

let copyTipTimer = null; // 全局唯一的隐藏定时器，防止连续复制时旧定时器误删新提示

/** 复制成功后，在卡片下方显示一行静态文字提示，2 秒后自动消失 */
function showCopyTip(card) {
  const old = card.querySelector('.copy-tip');
  if (old) old.remove();
  const tip = document.createElement('div');
  tip.className = 'copy-tip';
  tip.textContent = '复制成功！';
  card.appendChild(tip);
  clearTimeout(copyTipTimer);
  copyTipTimer = setTimeout(() => {
    const el = card.querySelector('.copy-tip');
    if (el) el.remove();
  }, 2000);
}

/* ---------- 通用提示弹窗（风格与编辑备注一致） ---------- */

function showNotice(text) {
  document.getElementById('noticeText').textContent = text;
  showModal('noticeModal');
}
document.getElementById('noticeOk').addEventListener('click', () => hideModal('noticeModal'));

/* ---------- 图片预览（点击缩略图放大查看，支持按钮缩放 / 滚轮缩放 / 拖拽平移） ---------- */

let previewZoom = 1;
let previewX = 0;      // 图片平移量（屏幕像素，不随缩放变化）
let previewY = 0;
let previewDrag = null; // 拖拽起点：{ startX, startY, origX, origY }

function openPreview(rec) {
  previewZoom = 1;
  previewX = 0;
  previewY = 0;
  document.getElementById('previewImg').src = 'clipimg://' + rec.image_name; // 原图（非缩略图）
  applyPreviewZoom();
  showModal('previewModal');
}

function applyPreviewZoom() {
  const img = document.getElementById('previewImg');
  // translate 在 scale 之后应用 → 平移量即屏幕像素，拖拽手感不受缩放影响
  img.style.transform = 'translate(' + previewX + 'px, ' + previewY + 'px) scale(' + previewZoom + ')';
  document.getElementById('previewZoomText').textContent = Math.round(previewZoom * 100) + '%';
}

document.getElementById('zoomIn').addEventListener('click', () => {
  previewZoom = Math.min(previewZoom + 0.2, 3);   // 最大放大 300%
  applyPreviewZoom();
});
document.getElementById('zoomOut').addEventListener('click', () => {
  previewZoom = Math.max(previewZoom - 0.2, 0.25); // 最小缩小到 25%
  applyPreviewZoom();
});
document.getElementById('previewClose').addEventListener('click', () => hideModal('previewModal'));

// —— 滚轮缩放：围绕鼠标位置缩放（passive:false 以便阻止容器滚动）——
const previewBox = document.querySelector('.preview-box');
previewBox.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newZoom = Math.min(3, Math.max(0.25, previewZoom * factor));
  const ratio = newZoom / previewZoom;
  // 鼠标相对图片当前中心的偏移 → 缩放后保持光标下的图片点不动
  const imgRect = document.getElementById('previewImg').getBoundingClientRect();
  const dX = e.clientX - (imgRect.left + imgRect.width / 2);
  const dY = e.clientY - (imgRect.top + imgRect.height / 2);
  previewX += (1 - ratio) * dX;
  previewY += (1 - ratio) * dY;
  previewZoom = newZoom;
  applyPreviewZoom();
});

// —— 鼠标拖拽平移图片 ——
previewBox.addEventListener('mousedown', (e) => {
  previewDrag = { startX: e.clientX, startY: e.clientY, origX: previewX, origY: previewY };
  previewBox.classList.add('dragging');
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!previewDrag) return;
  previewX = previewDrag.origX + (e.clientX - previewDrag.startX);
  previewY = previewDrag.origY + (e.clientY - previewDrag.startY);
  applyPreviewZoom();
});
window.addEventListener('mouseup', () => {
  if (previewDrag) {
    previewDrag = null;
    previewBox.classList.remove('dragging');
  }
});

/* ---------- 删除确认弹窗（「确定」为红色警告色） ---------- */

let confirmDeleteId = null;

function askDelete(id) {
  confirmDeleteId = id;
  showModal('confirmModal');
}
document.getElementById('confirmOk').addEventListener('click', async () => {
  await api.deleteRecord(confirmDeleteId);
  hideModal('confirmModal');
});
document.getElementById('confirmCancel').addEventListener('click', () => hideModal('confirmModal'));

/* ---------- 设置面板 ---------- */

const settingsBtn = document.getElementById('settingsBtn');
const settingsClose = document.getElementById('settingsClose');
const autostartCheck = document.getElementById('autostartCheck');
const retentionSelect = document.getElementById('retentionSelect');
const retentionCustomWrap = document.getElementById('retentionCustomWrap');
const retentionCustomInput = document.getElementById('retentionCustomInput');

const RETENTION_MIN = 1;
const RETENTION_MAX = 15; // 自定义留存天数上限

/** 把留存天数回填到下拉框：1 / 3 天直接选中，其它天数一律走「自定义」 */
function fillRetention(days) {
  const d = Number(days);
  if (d === 1 || d === 3) {
    retentionSelect.value = String(d);
    retentionCustomWrap.classList.add('hidden');
  } else {
    retentionSelect.value = 'custom';
    retentionCustomInput.value = String(d);
    retentionCustomWrap.classList.remove('hidden');
  }
}

/** 读取自定义输入框的天数并夹到 1 ~ 15 之间（越界时回填修正值） */
function readCustomDays() {
  let n = Math.round(Number(retentionCustomInput.value));
  if (!isFinite(n) || n < RETENTION_MIN) n = RETENTION_MIN;
  if (n > RETENTION_MAX) n = RETENTION_MAX;
  retentionCustomInput.value = String(n);
  return n;
}

async function openSettings() {
  const res = await api.getSettings();
  if (res.ok) {
    const s = res.settings;
    fillRetention(s.retentionDays);
    autostartCheck.checked = !!s.autostart;
  }
  showModal('settingsModal');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', () => hideModal('settingsModal'));

// 帮助文档按钮：用系统默认程序打开 README / 教程
document.getElementById('helpReadme').addEventListener('click', () => api.openDoc('readme'));
document.getElementById('helpTutorial').addEventListener('click', () => api.openDoc('tutorial'));

// 留存时长：选中即生效；切到「自定义」时展开天数输入框并聚焦
retentionSelect.addEventListener('change', () => {
  if (retentionSelect.value === 'custom') {
    retentionCustomWrap.classList.remove('hidden');
    retentionCustomInput.focus();
    retentionCustomInput.select();
    api.setSettings({ retentionDays: readCustomDays() });
  } else {
    retentionCustomWrap.classList.add('hidden');
    api.setSettings({ retentionDays: Number(retentionSelect.value) });
  }
});

// 自定义天数：输入完成（回车 / 失焦）时生效，超过 15 天自动夹回 15
retentionCustomInput.addEventListener('change', () => {
  api.setSettings({ retentionDays: readCustomDays() });
});
retentionCustomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') retentionCustomInput.blur(); // 交由 change 事件统一处理
});

// 开机自启开关后立即生效
autostartCheck.addEventListener('change', () => {
  api.setSettings({ autostart: autostartCheck.checked });
});

/* ---------- 订阅主进程推送 ---------- */

api.onChanged(() => load());

/* ---------- 更新说明（点击设置面板底部版本号查看） ---------- */

// 更新日志数据：从新到旧排列，发新版时在最前面加一条即可
const CHANGELOG = [
  {
    version: '1.2.7',
    items: [
      '修复：「编辑本条内容」的文本框可以无限往下拉，拉过头会把「取消 / 保存」按钮挤出窗口点不到；现在限制了最大高度',
      '修复：打开下一条记录的编辑窗时，会沿用上一条拖拽出来的高度；现在每次打开都恢复默认高度',
      '「编辑本条内容」点击窗口外的空白区域不再关闭，避免误触丢失正在编辑的内容',
      '「编辑本条内容」改过内容后点「取消」，会先弹出确认窗口询问是否放弃修改，可选「继续编辑」返回'
    ]
  },
  {
    version: '1.2.6',
    items: [
      '修复：列表最后一张卡片点开「···」菜单时，菜单会被窗口底部挡住显示不全；现在最后一张卡片的菜单向上展开，其余卡片仍向下展开',
      '设置按钮从搜索框内移到搜索框右侧，搜索框更宽敞',
      '自动清理留存时长改为下拉选择：1 天 / 3 天 / 自定义，自定义可填 1 ~ 15 天，超过 15 天会自动改回 15'
    ]
  },
  {
    version: '1.2.5',
    items: [
      '修复：给文本记录加了备注后，用备注搜索却搜不到这张卡片（现在「正文 + 备注」统一检索）',
      '修复：复制的文件卡片搜不到，现在可以按文件名、文件路径搜索',
      '修复：编辑文本内容时不再显示红色波浪线的拼写错误提示，只显示纯文本',
      '新增：点击设置面板底部的版本号，可查看当前版本及历史版本的更新内容'
    ]
  },
  {
    version: '1.2.4',
    items: [
      '图片记录点击「编辑本条内容」时的不支持提示，改为与编辑备注一致的弹窗风格',
      '新增图片预览：点击缩略图即可放大查看原图，支持按钮缩放、滚轮缩放、拖拽移动',
      '新增删除确认：删除前先弹确认窗口，「确定」为红色警告色'
    ]
  },
  {
    version: '1.2.3',
    items: [
      '修复：「···」下拉菜单紧贴按钮右侧弹出，顶部与按钮对齐',
      '修复：点击「📋」复制成功后，卡片底部显示「复制成功！」提示，2 秒后自动消失'
    ]
  },
  {
    version: '1.2.2',
    items: [
      '「···」菜单新增「编辑本条内容」：可修改文本记录的剪贴板原文',
      '原「编辑内容」更名为「编辑备注」，菜单顺序调整为：编辑备注 → 编辑本条内容 → 置顶本条记录 → 删除本条记录'
    ]
  },
  {
    version: '1.2.1',
    items: [
      '设置面板新增「帮助文档」按钮：一键打开 README.md 与 docs/教程.md',
      '设置面板底部显示当前软件版本号'
    ]
  },
  {
    version: '1.2.0',
    items: [
      '统一软件图标：新增多分辨率图标 build/icons/icon.ico（内置 16 / 32 / 48 / 256）',
      '打包时自定义图标完整嵌入 exe，桌面快捷方式、任务栏、窗口图标三处一致'
    ]
  }
];

let currentVersion = '';

/** 渲染更新说明：当前版本高亮显示，历史版本依次排在下方 */
function renderChangelog() {
  const box = document.getElementById('changelogBody');
  box.innerHTML = '';
  for (const entry of CHANGELOG) {
    const isCurrent = entry.version === currentVersion;
    const sec = document.createElement('section');
    sec.className = 'log-entry' + (isCurrent ? ' current' : '');

    const h = document.createElement('h4');
    h.className = 'log-version';
    h.textContent = 'v' + entry.version + (isCurrent ? '（当前版本）' : '');
    sec.appendChild(h);

    const ul = document.createElement('ul');
    ul.className = 'log-list';
    for (const item of entry.items) {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    }
    sec.appendChild(ul);
    box.appendChild(sec);
  }
}

document.getElementById('versionLine').addEventListener('click', () => {
  renderChangelog();
  showModal('changelogModal');
});
document.getElementById('changelogClose').addEventListener('click', () => hideModal('changelogModal'));

/* ---------- 启动 ---------- */

// 显示当前软件版本号（版本号取自 package.json，打包后即安装包版本）
api.getVersion().then((res) => {
  if (res.ok) {
    currentVersion = res.version;
    document.getElementById('versionText').textContent = res.version;
  }
});

load();
