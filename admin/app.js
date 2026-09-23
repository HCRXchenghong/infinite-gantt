const TOKEN_KEY = 'yxes_token';
const loginView = document.querySelector('#loginView');
const manageView = document.querySelector('#manageView');
const eventModal = document.querySelector('#eventModal');

// 全局缓存（用于自动补全与编辑回填）
let cache = { events: [], roster: [] };

const state = {
  editingId: null,
  eventOwners: [],
};

async function checkAuth() {
  const t = localStorage.getItem(TOKEN_KEY);
  if (t) {
    const res = await fetch(`/api/auth?t=${t}`);
    const data = await res.json();
    if (data.ok) return showManage();
  }
  showLogin();
}

function showLogin() {
  loginView.hidden = false;
  manageView.hidden = true;
  localStorage.removeItem(TOKEN_KEY);
}

async function showManage() {
  loginView.hidden = true;
  manageView.hidden = false;
  await refresh();
  loadList();
}

async function refresh() {
  const res = await fetch('/api/data');
  cache = await res.json();
  renderRoster();
}

// ============ 侧栏导航 ============
document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    item.classList.add('active');
    const page = item.dataset.page;
    document.querySelector('#page-events').hidden = page !== 'events';
    document.querySelector('#page-roster').hidden = page !== 'roster';
  });
});

// ============ 登录 / 退出 ============
document.querySelector('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.querySelector('#loginErr');
  err.textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: document.querySelector('#user').value, pass: document.querySelector('#pass').value }),
  });
  const data = await res.json();
  if (!data.ok) return (err.textContent = data.error || '登录失败');
  localStorage.setItem(TOKEN_KEY, data.token);
  showManage();
});

document.querySelector('#logout').addEventListener('click', async () => {
  const t = localStorage.getItem(TOKEN_KEY);
  if (t) fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${t}` } });
  showLogin();
});

async function authFetch(url, opts = {}) {
  const t = localStorage.getItem(TOKEN_KEY) || '';
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}` },
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('未登录');
  }
  return res;
}

// ============ 事件弹窗 ============
function openModal(isEdit) {
  if (isEdit) {
    document.querySelector('#formTitle').textContent = '编辑事件';
    document.querySelector('#saveBtn').textContent = '保存修改';
  } else {
    document.querySelector('#formTitle').textContent = '新增事件';
    document.querySelector('#saveBtn').textContent = '保存事件';
  }
  eventModal.hidden = false;
  document.querySelector('#title').focus();
}

function closeModal() {
  eventModal.hidden = true;
  resetForm();
}

document.querySelector('#newEventBtn').addEventListener('click', () => openModal(false));
document.querySelector('#cancelEdit').addEventListener('click', closeModal);
document.querySelector('#modalCloseBtn').addEventListener('click', closeModal);
// 点击遮罩关闭
eventModal.addEventListener('click', (e) => {
  if (e.target === eventModal) closeModal();
});
// Esc 关闭
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !eventModal.hidden) closeModal();
});

// ============ 负责人输入组件（自动补全 chip） ============
function renderEventOwners() {
  const box = document.querySelector('#eventOwners');
  box.innerHTML = '';
  state.eventOwners.forEach((name) => {
    const chip = document.createElement('span');
    chip.className = 'owner-chip';
    chip.innerHTML = `${name}<button type="button" class="chip-x" data-name="${name}">×</button>`;
    chip.querySelector('.chip-x').addEventListener('click', () => {
      state.eventOwners = state.eventOwners.filter((n) => n !== name);
      renderEventOwners();
    });
    box.appendChild(chip);
  });
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'ownerInput';
  input.placeholder = state.eventOwners.length ? '继续输入姓名…' : '输入姓名，回车添加';
  input.setAttribute('list', 'rosterList');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value.trim();
      if (v && !state.eventOwners.includes(v)) {
        state.eventOwners.push(v);
        renderEventOwners();
      }
    }
  });
  box.appendChild(input);
}

// ============ 人员名单管理 ============
function renderRoster() {
  const box = document.querySelector('#rosterChips');
  document.querySelector('#rosterCount').textContent = `(${cache.roster.length})`;
  const dl = document.querySelector('#rosterList');
  dl.innerHTML = cache.roster.map((n) => `<option value="${n}">`).join('');
  if (!cache.roster.length) {
    box.innerHTML = '<p class="hint">暂无人员，请在下方输入添加。</p>';
    return;
  }
  box.innerHTML = cache.roster.map((n) =>
    `<span class="owner-chip roster-chip">${n}<button type="button" class="chip-x" data-name="${n}">×</button></span>`
  ).join('');
  box.querySelectorAll('.chip-x').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await authFetch('/api/roster-remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: btn.dataset.name }),
      });
      await refresh();
    });
  });
}

function addRosterName(name) {
  const v = (name || '').trim();
  if (!v) return;
  authFetch('/api/roster', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names: [v] }),
  }).then(() => refresh());
}

document.querySelector('#rosterAdd').addEventListener('click', () => {
  const input = document.querySelector('#rosterInput');
  addRosterName(input.value);
  input.value = '';
});
document.querySelector('#rosterInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const input = document.querySelector('#rosterInput');
    addRosterName(input.value);
    input.value = '';
  }
});

// ============ 事件表单 ============
function resetForm() {
  state.editingId = null;
  state.eventOwners = [];
  document.querySelector('#formErr').textContent = '';
  document.querySelector('#eventForm').reset();
  renderEventOwners();
}

// 把负责人输入框里还没回车确认的文字也收进来，避免直接点保存时丢失
function flushOwnerInput() {
  const input = document.querySelector('#ownerInput');
  if (!input) return;
  const v = input.value.trim();
  if (v && !state.eventOwners.includes(v)) state.eventOwners.push(v);
}

document.querySelector('#eventForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.querySelector('#formErr');
  err.textContent = '';

  flushOwnerInput();

  const title = document.querySelector('#title').value.trim();
  const part = document.querySelector('#part').value;
  const start = document.querySelector('#start').value;
  const end = document.querySelector('#end').value;

  // 自定义校验：错误一定显示在弹窗内，不依赖浏览器原生气泡
  if (!title) return (err.textContent = '请填写事件标题');
  if (!part) return (err.textContent = '请选择所属部分');
  if (!start) return (err.textContent = '请选择开始时间');
  if (!end) return (err.textContent = '请选择结束时间');
  if (new Date(end) < new Date(start)) return (err.textContent = '结束时间不能早于开始时间');

  const body = {
    title, part, start, end,
    desc: document.querySelector('#desc').value.trim(),
    owners: state.eventOwners,
  };
  const isEdit = state.editingId != null;

  try {
    const res = await authFetch('/api/events', {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isEdit ? { ...body, id: state.editingId } : body),
    });
    const data = await res.json();
    if (!data.ok) return (err.textContent = data.error || '保存失败');
    closeModal();
    await refresh();
    loadList();
  } catch (ex) {
    // authFetch 在 401 时已切回登录页；其余异常在此兜底显示
    err.textContent = ex.message === '未登录' ? '登录已过期，请重新登录' : ('保存出错：' + ex.message);
  }
});

// ============ 事件列表 ============
async function loadList() {
  const res = await fetch('/api/events');
  const events = await res.json();
  document.querySelector('#count').textContent = `(${events.length})`;
  const list = document.querySelector('#list');
  const sorted = [...events].sort((a, b) => new Date(a.start) - new Date(b.start));
  if (!sorted.length) {
    list.innerHTML = '<p class="hint">暂无事件，请点右上角「新建事件」添加。</p>';
    return;
  }
  list.innerHTML = sorted
    .map((e) => {
      const cls = { 硬件研发: 'hw', 软件开发: 'sw', 平台运营: 'op' }[e.part] || 'sw';
      const owners = (e.owners || []).length
        ? e.owners.map((o) => `<span class="mini-owner">${o}</span>`).join('')
        : '<span class="no-owner">未指定负责人</span>';
      return `<div class="item">
        <span class="tag ${cls}">${e.part}</span>
        <div class="info">
          <b>${e.title}</b>
          <span>${e.start} ~ ${e.end}${e.desc ? ' · ' + e.desc : ''}</span>
          <span class="info-owners">${owners}</span>
        </div>
        <div class="item-actions">
          <button class="edit" data-id="${e.id}">编辑</button>
          <button class="del" data-id="${e.id}">删除</button>
        </div>
      </div>`;
    })
    .join('');

  list.querySelectorAll('.edit').forEach((btn) => {
    btn.addEventListener('click', () => startEdit(events, Number(btn.dataset.id)));
  });
  list.querySelectorAll('.del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('确定删除该事件？')) return;
      const res = await authFetch(`/api/events?id=${btn.dataset.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) { await refresh(); loadList(); }
    });
  });
}

function startEdit(events, id) {
  const ev = events.find((e) => e.id === id);
  if (!ev) return;
  state.editingId = id;
  state.eventOwners = [...(ev.owners || [])];
  document.querySelector('#title').value = ev.title;
  document.querySelector('#part').value = ev.part;
  document.querySelector('#start').value = ev.start;
  document.querySelector('#end').value = ev.end;
  document.querySelector('#desc').value = ev.desc || '';
  document.querySelector('#formErr').textContent = '';
  renderEventOwners();
  openModal(true);
}

checkAuth();
renderEventOwners();