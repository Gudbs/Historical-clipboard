/**
 * 界面逻辑：拉取记录列表、渲染卡片、搜索筛选、卡片操作、设置面板。
 * 只能通过 window.clipHistory（preload.js 暴露）与主进程通信。
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

  // —— 卡片主体 ——
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

  // —— 底部信息行：时间 + 备注 + 操作按钮 ——
  const meta = document.createElement('div');
  meta.className = 'card-meta';

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

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  actions.appendChild(actionBtn('✏️', '备注', () => openRemarkModal(rec)));
  actions.appendChild(actionBtn('📌', rec.pinned ? '取消置顶' : '置顶', () => api.pinRecord(rec.id, !rec.pinned)));
  actions.appendChild(actionBtn('🗑️', '删除', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    // 防误删：第一次点击进入确认状态，第二次才真正删除
    if (!btn.classList.contains('confirming')) {
      btn.classList.add('confirming');
      btn.textContent = '确认删除';
      setTimeout(() => { btn.classList.remove('confirming'); btn.textContent = '🗑️'; }, 1500);
      return;
    }
    await api.deleteRecord(rec.id);
  }));
  meta.appendChild(actions);
  card.appendChild(meta);

  // 置顶徽章
  if (rec.pinned) {
    const badge = document.createElement('span');
    badge.className = 'pin-badge';
    badge.textContent = '已置顶';
    card.appendChild(badge);
  }

  // 点击卡片 → 重新复制到系统剪贴板
  card.addEventListener('click', () => api.copyRecord(rec.id));
  return card;
}

/** 创建操作小按钮（点击时阻止事件冒泡，避免触发卡片复制） */
function actionBtn(text, title, onClick) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

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

/* ---------- 备注编辑 ---------- */

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

load();
