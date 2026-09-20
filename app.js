/* 课程表 Web App —— 纯静态 + GitHub 私有仓库同步 */
'use strict';

const STATUS = [
  { key: 'none',      label: '默认',   badge: '' },
  { key: 'done',      label: '已完成', badge: '✓' },
  { key: 'undone',    label: '未完成', badge: '✕' },
  { key: 'doing',     label: '进行中', badge: '▶' },
  { key: 'cancelled', label: '已取消', badge: '⊘' },
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
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
}
function syncDot(cls) {
  const d = $('syncDot'); if (!d) return;
  d.className = 'sync-dot' + (cls ? ' ' + cls : '');
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
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('读取失败 ' + res.status);
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
  if (!res.ok) {
    if (res.status === 409) throw new Error('数据已过期，请先刷新再试');
    throw new Error('保存失败 ' + res.status);
  }
  const j = await res.json();
  return j.content.sha;
}

/* ---------- 数据加载 / 保存 ---------- */
async function loadData() {
  if (state.config && state.config.token) {
    try {
      const r = await ghGet(state.config.path);
      if (r) {
        state.data = JSON.parse(r.content);
        state.sha = r.sha;
        cacheData();
        return;
      }
    } catch (e) { console.warn(e); }
  }
  const res = await fetch('./' + (state.config ? state.config.path : 'schedule.json'), { cache: 'no-store' });
  if (res.ok) {
    state.data = await res.json();
    if (state.config && state.config.token) {
      try { const r = await ghGet(state.config.path); if (r) state.sha = r.sha; } catch {}
    }
    cacheData();
    return;
  }
  throw new Error('无法加载数据，请检查设置或先部署 schedule.json');
}
function cacheData() { localStorage.setItem(LS_CACHE, JSON.stringify({ data: state.data, sha: state.sha })); }
function restoreCache() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_CACHE));
    if (c && c.data) { state.data = c.data; state.sha = c.sha; return true; }
  } catch {}
  return false;
}
async function saveData(silent) {
  if (!state.config || !state.config.token) {
    if (!silent) { toast('请先到「设置」填写 GitHub Token'); openSettings(); }
    syncDot('err');
    return;
  }
  state.data.updatedAt = new Date().toISOString();
  const content = JSON.stringify(state.data, null, 2);
  syncDot('busy');
  try {
    state.sha = await ghPut(state.config.path, content, state.sha, 'update schedule ' + new Date().toLocaleString('zh-CN'));
    cacheData();
    syncDot('ok');
    if (!silent) toast('已保存 ✓');
  } catch (e) {
    syncDot('err');
    toast(e.message || '保存失败');
  }
}

/* ---------- 月份标签 ---------- */
function renderMonthTabs() {
  const nav = $('monthTabs');
  nav.innerHTML = '';
  const nowY = new Date().getFullYear(), nowM = new Date().getMonth() + 1;
  MONTHS.forEach((mo, i) => {
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
    const rec = state.data.days[key];
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
          row += `<td><div class="cell st-${st}" data-date="${cell}" data-ts="${ts}" title="点击切换状态">`
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

  container.querySelectorAll('.cell').forEach((el) => {
    el.addEventListener('click', (ev) => {
      const date = el.dataset.date, ts = el.dataset.ts;
      if (ev.target.closest('[data-edit]')) {
        ev.stopPropagation();
        openEdit(date, ts);
        return;
      }
      if (el.classList.contains('empty')) {
        openEdit(date, ts);       // 空白格：添加内容
      } else {
        cycleStatus(date, ts, el); // 有内容：一键切换状态
      }
    });
  });
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 状态一键切换 ---------- */
function cycleStatus(date, ts, el) {
  const rec = getRec(date, ts);
  if (!rec) return;
  const i = STATUS.findIndex((s) => s.key === (rec.status || 'none'));
  const next = STATUS[(i + 1) % STATUS.length].key;
  rec.status = next;
  if (!state.data.days[date]) state.data.days[date] = {};
  state.data.days[date][ts] = rec;
  // 即时更新该格
  el.classList.remove('st-none', 'st-done', 'st-undone', 'st-doing', 'st-cancelled');
  el.classList.add('st-' + next);
  const badge = el.querySelector('.cell-badge');
  if (badge) badge.textContent = statusMeta(next).badge;
  el.classList.remove('just'); void el.offsetWidth; el.classList.add('just');
  saveData(true); // 静默保存
}

/* ---------- 内容编辑 ---------- */
function openEdit(date, ts) {
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
  if (text) {
    state.data.days[date][ts] = { text, status: keepStatus };
  } else {
    delete state.data.days[date][ts];
    if (Object.keys(state.data.days[date]).length === 0) delete state.data.days[date];
  }
  closeEdit();
  renderMonth();
  await saveData(false);
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
async function boot(reload) {
  if (!state.config || !state.config.token) {
    try { await loadData(); renderMonth(); }
    catch (e) { toast('先到「设置」填好仓库与 Token'); openSettings(); }
    return;
  }
  try {
    if (reload || !restoreCache()) await loadData();
    renderMonth();
    syncDot('ok');
  } catch (e) {
    toast(e.message || '加载失败');
    syncDot('err');
    openSettings();
  }
}

/* ---------- 事件绑定 ---------- */
$('btnRefresh').addEventListener('click', async () => { await boot(true); toast('已刷新'); });
$('btnSettings').addEventListener('click', openSettings);
$('btnCfgCancel').addEventListener('click', closeSettings);
$('btnCfgSave').addEventListener('click', saveSettings);
$('btnEditCancel').addEventListener('click', closeEdit);
$('btnEditSave').addEventListener('click', saveEdit);
$('btnEditDelete').addEventListener('click', deleteEdit);

loadConfig();
renderCountdown();
renderMonthTabs();
boot(false);
setInterval(renderCountdown, 60000);
