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

/** 应用搜索关键词，过滤后渲染 */
function applyFilter() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) {
    filtered = records;
  } else {
    // 文本按内容检索；图片 / 文件按备注检索
    filtered = records.filter((r) => {
      if (r.type === 'text') return (r.content || '').toLowerCase().includes(q);
      return (r.remark || '').toLowerCase().includes(q);
    });
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
  for (const rec of filtered) frag.appendChild(createCard(rec));
  listEl.appendChild(frag);
}

/** 创建一条记录卡片 */
function createCard(rec) {
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
    body.appendChild(img);
  } else if (rec.type === 'files') {
    let names = [];
    try { names = JSON.parse(rec.file_names || '[]'); } catch (e) { names = []; }
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
    toggleMenu(card, rec, moreBtn);
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

/** 在「···」按钮右侧弹出本条记录的下拉菜单 */
function toggleMenu(card, rec, moreBtn) {
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
  addMenuItem(menu, '删除本条记录', () => { hideMenu(); api.deleteRecord(rec.id); }, 'danger');
  menu._targetId = rec.id;

  // 定位：紧贴「···」按钮右侧；超出窗口右边缘时改放左侧
  const rect = moreBtn.getBoundingClientRect();
  const menuWidth = 160;
  let left = rect.right + 4;
  if (left + menuWidth > window.innerWidth - 8) left = rect.left - menuWidth - 4;
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = rect.top + 'px';

  menu.classList.remove('hidden');
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
document.querySelectorAll('.modal-mask').forEach((mask) => {
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

/** 打开「编辑本条内容」弹窗；图片记录不支持编辑正文，给出窗口提示 */
function openEditContentModal(rec) {
  if (rec.type === 'image') {
    alert('图片类型剪贴内容不支持编辑正文');
    return;
  }
  editContentTargetId = rec.id;
  document.getElementById('editContentInput').value = rec.content || '';
  showModal('editContentModal');
  document.getElementById('editContentInput').focus();
}

document.getElementById('editContentSave').addEventListener('click', async () => {
  const text = document.getElementById('editContentInput').value;
  if (!text.trim()) { hideModal('editContentModal'); return; } // 内容为空时不更新
  await api.editContent(editContentTargetId, text);
  hideModal('editContentModal');
});
document.getElementById('editContentCancel').addEventListener('click', () => hideModal('editContentModal'));

/* ---------- 复制成功提示 ---------- */

/** 复制成功后，在卡片下方显示一行静态文字提示，2 秒后自动消失 */
function showCopyTip(card) {
  const old = card.querySelector('.copy-tip');
  if (old) old.remove();
  const tip = document.createElement('div');
  tip.className = 'copy-tip';
  tip.textContent = '复制成功！';
  card.appendChild(tip);
  setTimeout(() => {
    const el = card.querySelector('.copy-tip');
    if (el) el.remove();
  }, 2000);
}

/* ---------- 设置面板 ---------- */

const settingsBtn = document.getElementById('settingsBtn');
const settingsClose = document.getElementById('settingsClose');
const autostartCheck = document.getElementById('autostartCheck');

async function openSettings() {
  const res = await api.getSettings();
  if (res.ok) {
    const s = res.settings;
    document.querySelectorAll('input[name="retention"]').forEach((r) => {
      r.checked = Number(r.value) === s.retentionDays;
    });
    autostartCheck.checked = !!s.autostart;
  }
  showModal('settingsModal');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', () => hideModal('settingsModal'));

// 帮助文档按钮：用系统默认程序打开 README / 教程
document.getElementById('helpReadme').addEventListener('click', () => api.openDoc('readme'));
document.getElementById('helpTutorial').addEventListener('click', () => api.openDoc('tutorial'));

// 留存天数选择后立即生效
document.querySelectorAll('input[name="retention"]').forEach((r) => {
  r.addEventListener('change', () => {
    if (r.checked) api.setSettings({ retentionDays: Number(r.value) });
  });
});

// 开机自启开关后立即生效
autostartCheck.addEventListener('change', () => {
  api.setSettings({ autostart: autostartCheck.checked });
});

/* ---------- 订阅主进程推送 ---------- */

api.onChanged(() => load());

/* ---------- 启动 ---------- */

// 显示当前软件版本号
api.getVersion().then((res) => {
  if (res.ok) document.getElementById('versionText').textContent = res.version;
});

load();
