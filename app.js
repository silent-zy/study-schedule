/* 课程表 Web App —— 纯静态 + GitHub 私有仓库同步 */
'use strict';

const STATUS = [
  { key: 'none',      label: '默认',   badge: '' },
  { key: 'done',      label: '已完成', badge: '✓' },
  { key: 'undone',    label: '未完成', badge: '✕' },
  { key: 'doing',     label: '进行中', badge: '▶' },
  { key: 'cancelled', label: '已取消', badge: '⊘' },
];
/* 长按 / 右键菜单里的状态（“默认”不做按钮，“清除标记”即取消状态） */
const MENU_STATUS = [
  { key: 'done',      label: '已完成' },
  { key: 'undone',    label: '未完成' },
  { key: 'doing',     label: '进行中' },
  { key: 'cancelled', label: '已取消' },
  { key: 'none',      label: '清除标记' },
];
const WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const MONTHS = [
  { y: 2026, m: 6 }, { y: 2026, m: 7 }, { y: 2026, m: 8 },
  { y: 2026, m: 9 }, { y: 2026, m: 10 }, { y: 2026, m: 11 }, { y: 2026, m: 12 },
];

/* 江苏省考笔试日期 */
const EXAM_DATE = new Date(2026, 11, 5); // 2026-12-05

const LS_CFG = 'ss_config';
const LS_CACHE = 'ss_cache';
const DEFAULT_MONTH = { y: 2026, m: 9 };
const LONG_PRESS = 500;                    // 长按判定（毫秒）
const CELL_TIP = '点击标记已完成，再点取消；长按或右键选其他状态';

let state = {
  config: null,        // {owner,repo,branch,path,token}
  data: { version: 1, updatedAt: null, days: {} },
  sha: null,
  current: DEFAULT_MONTH,
  editing: null,       // {date, ts}
};

/* ---------- 工具 ---------- */
const $ = (id) => document.getElementById(id);
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}
function syncDot(cls) {
  const d = $('syncDot'); if (!d) return;
  d.className = 'sync-dot' + (cls ? ' ' + cls : '');
}
/* 把 HTTP 状态码翻译成看得懂的话 */
function friendly(err) {
  const s = err && err.status;
  if (s === 401) return 'Token 无效，请到「设置」重新填写';
  if (s === 403) return 'Token 权限不足（需 Contents 读写）或已限流';
  if (s === 404) return '找不到仓库或文件路径，请检查「设置」';
  if (s === 409) return '数据冲突（已自动重试）';
  if (s === 422) return '文件路径或参数有误';
  return (err && err.message) || '同步失败';
}
function loadConfig() {
  try { state.config = JSON.parse(localStorage.getItem(LS_CFG)) || null; } catch { state.config = null; }
}
function saveConfig() { localStorage.setItem(LS_CFG, JSON.stringify(state.config)); }
function utf8ToBase64(str) { return btoa(unescape(encodeURIComponent(str))); }
function base64ToUtf8(b) { return decodeURIComponent(escape(atob(b))); }
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function iso(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
function parseTs(ts) { const [h] = ts.split(':'); return parseInt(h, 10); }
function statusMeta(key) { return STATUS.find((s) => s.key === key) || STATUS[0]; }
function getRec(date, ts) { return (state.data.days[date] || {})[ts] || null; }

/* ---------- 倒计时 ---------- */
function renderCountdown() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((EXAM_DATE - today) / 86400000);
  const box = $('countdown');
  if (diff > 0) {
    $('cdNum').textContent = diff;
    box.classList.remove('passed');
  } else if (diff === 0) {
    $('cdNum').textContent = '开考';
    box.classList.add('passed');
  } else {
    $('cdNum').textContent = '已结束';
    box.classList.add('passed');
  }
}

/* ---------- GitHub API ---------- */
async function ghGet(path) {
  const { owner, repo, branch, token } = state.config;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) { const e = new Error('读取失败 ' + res.status); e.status = res.status; throw e; }
  const j = await res.json();
  return { content: base64ToUtf8(j.content), sha: j.sha };
}
async function ghPut(path, content, sha, message) {
  const { owner, repo, branch, token } = state.config;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const body = { message, content: utf8ToBase64(content), branch };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const e = new Error('保存失败 ' + res.status); e.status = res.status; throw e; }
  const j = await res.json();
  return j.content.sha;
}

/* ---------- 数据加载 / 缓存 ---------- */
async function loadData() {
  if (state.config && state.config.token) {
    const r = await ghGet(state.config.path);   // 失败会抛出，交由上层提示
    if (r) {
      state.data = JSON.parse(r.content);
      state.sha = r.sha;
      cacheData();
      return;
    }
  }
  const res = await fetch('./' + (state.config ? state.config.path : 'schedule.json'), { cache: 'no-store' });
  if (!res.ok) throw new Error('无法加载数据，请检查设置或先部署 schedule.json');
  state.data = await res.json();
  cacheData();
}
function cacheData() { localStorage.setItem(LS_CACHE, JSON.stringify({ data: state.data, sha: state.sha })); }
function restoreCache() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_CACHE));
    if (c && c.data) { state.data = c.data; state.sha = c.sha; return true; }
  } catch {}
  return false;
}

/* ================= 保存队列：串行 + 合并 + 冲突自动重试 =================
   要点：
   1) 所有修改都进队列，同一时刻只有一个请求在飞 —— 杜绝并发互相顶掉。
   2) 每次写之前重新 GET 一次，拿最新 sha 做「读-改-写」—— 不再依赖本地缓存的旧 sha。
   3) 万一仍撞上 409，重新拉取后自动重试，最多 3 次。
   4) 本地改动以补丁（patch）形式叠加到远端最新数据上，多设备也不会互相覆盖。
   ====================================================================== */
const SAVE_DEBOUNCE = 350;
let pendingPatch = [];      // [{date, ts, value}]  value=null 表示删除
let running = false;
let waiters = [];
let debounceTimer = null;

function applyPatch(data, p) {
  const { date, ts, value } = p;
  if (!data.days) data.days = {};
  if (value === null) {
    if (data.days[date]) {
      delete data.days[date][ts];
      if (!Object.keys(data.days[date]).length) delete data.days[date];
    }
  } else {
    (data.days[date] = data.days[date] || {})[ts] = { text: value.text, status: value.status };
  }
}

function enqueue(patch) {
  pendingPatch.push(patch);
  const p = new Promise((res, rej) => waiters.push({ res, rej }));
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(kick, SAVE_DEBOUNCE);   // 连点合并成一次写入
  return p;
}

function resolveWaiters(ok, err) {
  const ws = waiters; waiters = [];
  ws.forEach((w) => (ok ? w.res() : w.rej(err)));
}

function kick() {
  debounceTimer = null;
  if (running) return;
  if (!pendingPatch.length) { resolveWaiters(true); return; }
  running = true;
  syncDot('busy');
  runLoop();
}

async function runLoop() {
  let err = null;
  try {
    while (pendingPatch.length) {
      const batch = pendingPatch.splice(0, pendingPatch.length);
      try {
        await pushBatch(batch);
        syncDot('ok');
      } catch (e) {
        pendingPatch.unshift(...batch);   // 失败：放回队列，等下次触发重试
        throw e;
      }
    }
  } catch (e) { err = e; syncDot('err'); }
  running = false;
  resolveWaiters(!err, err);
}

async function pushBatch(batch) {
  if (!state.config || !state.config.token) throw new Error('请先到「设置」填写 GitHub Token');
  const path = state.config.path;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await ghGet(path);                                  // 每次都用最新 sha
    const remote = r ? JSON.parse(r.content) : { version: 1, updatedAt: null, days: {} };
    batch.forEach((p) => applyPatch(remote, p));
    remote.updatedAt = new Date().toISOString();
    try {
      const sha = await ghPut(path, JSON.stringify(remote, null, 2), r ? r.sha : null,
        'update schedule ' + new Date().toLocaleString('zh-CN'));
      state.data = remote; state.sha = sha; cacheData();
      return;
    } catch (e) {
      if (e.status === 409) continue;                             // 撞车 → 重取重试
      throw e;
    }
  }
  const e = new Error('保存冲突，请稍后重试'); e.status = 409; throw e;
}

/* 等待队列清空（给“刷新/保存”用） */
function whenIdle() {
  if (!running && !pendingPatch.length && !debounceTimer) return Promise.resolve();
  return new Promise((res, rej) => waiters.push({ res, rej }));
}
/* 立即触发一次刷写（不等 debounce） */
function flushNow() { clearTimeout(debounceTimer); debounceTimer = null; kick(); return whenIdle(); }

/* ---------- 月份标签 ---------- */
function renderMonthTabs() {
  const nav = $('monthTabs');
  nav.innerHTML = '';
  const nowY = new Date().getFullYear(), nowM = new Date().getMonth() + 1;
  MONTHS.forEach((mo) => {
    const b = document.createElement('button');
    b.className = 'mtab' + (mo.y === state.current.y && mo.m === state.current.m ? ' active' : '');
    const isNow = mo.y === nowY && mo.m === nowM;
    b.innerHTML = `${mo.m}月${isNow ? '<span class="now">本月</span>' : ''}`;
    b.onclick = () => { state.current = mo; renderMonthTabs(); renderMonth(); };
    nav.appendChild(b);
  });
}

/* ---------- 渲染 ---------- */
function mondayOf(y, m, d) {
  const dt = new Date(y, m - 1, d);
  const day = (dt.getDay() + 6) % 7;
  dt.setDate(dt.getDate() - day);
  return dt;
}
function renderMonth() {
  const { y, m } = state.current;
  const daysInMonth = new Date(y, m, 0).getDate();
  const tsSet = new Set();
  const monthDays = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const key = iso(y, m, d);
    monthDays.push(key);
    const rec = (state.data.days || {})[key];
    if (rec) Object.keys(rec).forEach((ts) => tsSet.add(ts));
  }
  const tsList = [...tsSet].sort((a, b) => parseTs(a) - parseTs(b));

  const weeks = {};
  monthDays.forEach((key) => {
    const [yy, mm, dd] = key.split('-').map(Number);
    const mon = mondayOf(yy, mm, dd);
    const wk = iso(mon.getFullYear(), mon.getMonth() + 1, mon.getDate());
    (weeks[wk] = weeks[wk] || []).push(key);
  });

  const container = $('weeks');
  container.innerHTML = '';
  Object.keys(weeks).sort().forEach((wk) => {
    const dates = weeks[wk];
    const card = document.createElement('div');
    card.className = 'week';
    const start = dates[0], end = dates[dates.length - 1];
    card.innerHTML = `<div class="week-title">${start.slice(5)} ~ ${end.slice(5)}</div><div class="table-scroll"></div>`;
    const table = document.createElement('table');

    const thead = document.createElement('tr');
    thead.innerHTML = '<th class="ts">时间段</th>' + WEEK.map((w, i) => {
      const cell = dates[i];
      if (!cell) return `<th></th>`;
      const [, mm, dd] = cell.split('-');
      const inMonth = Number(mm) === m;
      return `<th class="${inMonth ? '' : 'out'}">${w}<span class="d">${Number(mm)}/${Number(dd)}</span></th>`;
    }).join('');
    table.appendChild(thead);

    if (tsList.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="ts">—</td><td colspan="7" style="text-align:center;color:var(--muted);padding:18px;font-size:13px;">本月暂无安排</td>`;
      table.appendChild(tr);
    }

    tsList.forEach((ts) => {
      const tr = document.createElement('tr');
      let row = `<td class="ts">${ts}</td>`;
      WEEK.forEach((_, i) => {
        const cell = dates[i];
        if (!cell) { row += '<td></td>'; return; }
        const rec = getRec(cell, ts);
        const st = rec ? (rec.status || 'none') : 'none';
        const txt = rec ? (rec.text || '') : '';
        if (txt) {
          const meta = statusMeta(st);
          row += `<td><div class="cell st-${st}" data-date="${cell}" data-ts="${ts}" title="${CELL_TIP}">`
               + `<span class="cell-badge">${meta.badge}</span>`
               + `<span class="cell-text">${escapeHtml(txt)}</span>`
               + `<button class="cell-edit" data-edit="1" title="修改内容">✎</button></div></td>`;
        } else {
          row += `<td><div class="cell empty" data-date="${cell}" data-ts="${ts}" title="点击添加内容">＋</div></td>`;
        }
      });
      tr.innerHTML = row;
      table.appendChild(tr);
    });
    card.querySelector('.table-scroll').appendChild(table);
    container.appendChild(card);
  });

  container.querySelectorAll('.cell').forEach(bindCell);
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 格子交互：单击=已完成/取消，长按（或右键）=选其他状态 ---------- */
function bindCell(el) {
  const date = el.dataset.date, ts = el.dataset.ts;

  // 空白格：点击 = 添加内容
  if (el.classList.contains('empty')) {
    el.addEventListener('click', () => openEdit(date, ts));
    return;
  }

  // ✎：改内容（不触发状态切换）
  const editBtn = el.querySelector('[data-edit]');
  if (editBtn) {
    editBtn.addEventListener('click', (ev) => { ev.stopPropagation(); openEdit(date, ts); });
  }

  let timer = null, longFired = false, sx = 0, sy = 0;
  const cancelTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  el.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('[data-edit]')) return;
    cancelTimer();
    longFired = false;
    sx = ev.clientX; sy = ev.clientY;
    timer = setTimeout(() => { timer = null; longFired = true; openStatusMenu(el); }, LONG_PRESS);
  });
  el.addEventListener('pointerup', cancelTimer);
  el.addEventListener('pointerleave', cancelTimer);
  el.addEventListener('pointercancel', cancelTimer);
  el.addEventListener('pointermove', (ev) => {
    if (Math.abs(ev.clientX - sx) > 10 || Math.abs(ev.clientY - sy) > 10) cancelTimer();
  });

  el.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-edit]')) return;
    if (longFired) { longFired = false; return; }   // 这次是长按，已被菜单接管
    toggleDone(el);
  });

  // 电脑端：右键直接出菜单
  el.addEventListener('contextmenu', (ev) => {
    if (ev.target.closest('[data-edit]')) return;
    ev.preventDefault();
    cancelTimer();
    openStatusMenu(el);
  });
}

/* 单击：已完成 ↔ 取消 */
function toggleDone(el) {
  const date = el.dataset.date, ts = el.dataset.ts;
  const rec = getRec(date, ts);
  if (!rec) return;
  const cur = rec.status || 'none';
  setStatus(date, ts, cur === 'done' ? 'none' : 'done', el);
}

/* 设定状态（本地先变，改动进队列异步同步） */
function setStatus(date, ts, status, el) {
  const rec = getRec(date, ts);
  if (!rec) return;
  rec.status = status;
  if (!state.data.days[date]) state.data.days[date] = {};
  state.data.days[date][ts] = rec;
  el.classList.remove('st-none', 'st-done', 'st-undone', 'st-doing', 'st-cancelled');
  el.classList.add('st-' + status);
  const badge = el.querySelector('.cell-badge');
  if (badge) badge.textContent = statusMeta(status).badge;
  el.classList.remove('just'); void el.offsetWidth; el.classList.add('just');
  enqueue({ date, ts, value: { text: rec.text || '', status } })
    .catch((e) => toast('同步失败：' + friendly(e)));
}

/* ---------- 状态选择菜单 ---------- */
let menuCell = null;
function openStatusMenu(el) {
  closeStatusMenu();
  const date = el.dataset.date, ts = el.dataset.ts;
  const cur = (getRec(date, ts) || {}).status || 'none';
  const box = $('statusMenu');
  box.innerHTML = `<div class="sm-title">${date} ${ts}</div>` + MENU_STATUS.map((s) =>
    `<button class="sm-btn sm-${s.key}${cur === s.key ? ' active' : ''}" data-key="${s.key}">${s.label}${cur === s.key ? '  ✓' : ''}</button>`
  ).join('');
  box.classList.remove('hidden');
  $('statusBackdrop').classList.remove('hidden');
  // 贴着格子定位，超出视口则翻转/夹紧
  const r = el.getBoundingClientRect();
  const bw = box.offsetWidth, bh = box.offsetHeight;
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - bw - 8));
  let top = r.bottom + 6;
  if (top + bh > window.innerHeight - 8) top = Math.max(8, r.top - bh - 6);
  box.style.left = left + 'px';
  box.style.top = top + 'px';
  box.querySelectorAll('.sm-btn').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setStatus(date, ts, b.dataset.key, el);
      closeStatusMenu();
    });
  });
  menuCell = el;
  window.addEventListener('scroll', closeStatusMenu, { passive: true });
  window.addEventListener('resize', closeStatusMenu);
}
function closeStatusMenu() {
  const box = $('statusMenu');
  if (!box || box.classList.contains('hidden')) return;
  box.classList.add('hidden');
  $('statusBackdrop').classList.add('hidden');
  menuCell = null;
  window.removeEventListener('scroll', closeStatusMenu);
  window.removeEventListener('resize', closeStatusMenu);
}

/* ---------- 内容编辑 ---------- */
function openEdit(date, ts) {
  closeStatusMenu();
  state.editing = { date, ts };
  const rec = getRec(date, ts);
  $('editTitle').textContent = `${date}  ${ts}`;
  $('editText').value = rec ? (rec.text || '') : '';
  $('editModal').classList.remove('hidden');
  setTimeout(() => $('editText').focus(), 60);
}
function closeEdit() { $('editModal').classList.add('hidden'); state.editing = null; }
async function saveEdit() {
  if (!state.editing) return;
  const { date, ts } = state.editing;
  const text = $('editText').value.trim();
  const old = getRec(date, ts);
  const keepStatus = old ? (old.status || 'none') : 'none';
  if (!state.data.days[date]) state.data.days[date] = {};
  let value;
  if (text) {
    state.data.days[date][ts] = { text, status: keepStatus };
    value = { text, status: keepStatus };
  } else {
    delete state.data.days[date][ts];
    if (Object.keys(state.data.days[date]).length === 0) delete state.data.days[date];
    value = null;
  }
  closeEdit();
  renderMonth();
  try {
    await flushNow();                                   // 内容修改：等真正写回再提示
    toast('已保存 ✓');
  } catch (e) {
    toast('保存失败：' + friendly(e));
  }
}
function deleteEdit() { $('editText').value = ''; saveEdit(); }

/* ---------- 设置 ---------- */
function openSettings() {
  if (state.config) {
    $('cfgOwner').value = state.config.owner || '';
    $('cfgRepo').value = state.config.repo || '';
    $('cfgBranch').value = state.config.branch || 'main';
    $('cfgPath').value = state.config.path || 'schedule.json';
    $('cfgToken').value = state.config.token || '';
  }
  $('settingsModal').classList.remove('hidden');
}
function closeSettings() { $('settingsModal').classList.add('hidden'); }
function saveSettings() {
  state.config = {
    owner: $('cfgOwner').value.trim(),
    repo: $('cfgRepo').value.trim(),
    branch: $('cfgBranch').value.trim() || 'main',
    path: $('cfgPath').value.trim() || 'schedule.json',
    token: $('cfgToken').value.trim(),
  };
  saveConfig();
  closeSettings();
  toast('设置已保存，正在加载…');
  boot(true);
}

/* ---------- 启动 ---------- */
let lastSync = 0;
async function boot(reload) {
  // 先用缓存秒开，再拉最新（每次都刷 sha，避免用旧 sha 去写）
  const had = restoreCache();
  if (had) renderMonth();

  if (!state.config || !state.config.token) {
    try { await loadData(); renderMonth(); }
    catch (e) { toast('先到「设置」填好仓库与 Token'); openSettings(); }
    return;
  }
  try {
    await loadData();
    renderMonth();
    syncDot('ok');
    lastSync = Date.now();
  } catch (e) {
    if (had) { syncDot('err'); toast('离线中，先显示本地缓存（' + friendly(e) + '）'); }
    else { syncDot('err'); toast(friendly(e)); openSettings(); }
  }
}

/* ---------- 事件绑定 ---------- */
$('btnRefresh').addEventListener('click', async () => {
  try { await flushNow(); } catch { /* 未保存的先尝试写回 */ }
  await boot(true);
  toast('已刷新');
});
$('btnSettings').addEventListener('click', openSettings);
$('btnCfgCancel').addEventListener('click', closeSettings);
$('btnCfgSave').addEventListener('click', saveSettings);
$('btnEditCancel').addEventListener('click', closeEdit);
$('btnEditSave').addEventListener('click', saveEdit);
$('btnEditDelete').addEventListener('click', deleteEdit);
$('statusBackdrop').addEventListener('click', closeStatusMenu);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeStatusMenu(); });

/* 切回本页时自动同步一次（多设备场景：手机改完，切回电脑自动刷新） */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!state.config || !state.config.token) return;
  if (running || pendingPatch.length || debounceTimer) return;
  if (Date.now() - lastSync < 5000) return;
  loadData().then(() => { renderMonth(); syncDot('ok'); lastSync = Date.now(); }).catch(() => {});
});
/* 关页面前尽量把未保存的改动写回 */
window.addEventListener('beforeunload', () => { if (pendingPatch.length) flushNow(); });

loadConfig();
renderCountdown();
renderMonthTabs();
boot(false);
setInterval(renderCountdown, 60000);
