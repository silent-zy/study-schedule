/* 课程表 Web App —— 纯静态 + GitHub 私有仓库同步 */
'use strict';

const STATUS = [
  { key: 'none',      label: '默认',   cls: 'st-none' },
  { key: 'done',      label: '已完成', cls: 'st-done' },
  { key: 'undone',    label: '未完成', cls: 'st-undone' },
  { key: 'doing',     label: '进行中', cls: 'st-doing' },
  { key: 'cancelled', label: '已取消', cls: 'st-cancelled' },
];
const WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const MONTHS = [
  { y: 2026, m: 6 }, { y: 2026, m: 7 }, { y: 2026, m: 8 },
  { y: 2026, m: 9 }, { y: 2026, m: 10 }, { y: 2026, m: 11 }, { y: 2026, m: 12 },
];

const LS_CFG = 'ss_config';
const LS_CACHE = 'ss_cache';

let state = {
  config: null,        // {owner,repo,branch,path,token}
  data: { version: 1, updatedAt: null, days: {} },
  sha: null,
  current: { y: 2026, m: 9 },
  editing: null,       // {date, ts}
  editStatus: 'none',
};

/* ---------- 工具 ---------- */
const $ = (id) => document.getElementById(id);
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
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
  if (!res.ok) throw new Error('保存失败 ' + res.status);
  const j = await res.json();
  return j.content.sha;
}

/* ---------- 数据加载 / 保存 ---------- */
async function loadData() {
  // 优先用 Token 经 API 读（最权威）；失败再试静态文件
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
  // 静态兜底（首次部署 / 无 Token 只读）
  const res = await fetch('./' + (state.config ? state.config.path : 'schedule.json'), { cache: 'no-store' });
  if (res.ok) {
    state.data = await res.json();
    // 尝试拿 sha 以便之后能写
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
async function saveData() {
  if (!state.config || !state.config.token) { toast('请先到「设置」填写 GitHub Token'); openSettings(); return; }
  state.data.updatedAt = new Date().toISOString();
  const content = JSON.stringify(state.data, null, 2);
  try {
    state.sha = await ghPut(state.config.path, content, state.sha, 'update schedule ' + new Date().toLocaleString('zh-CN'));
    cacheData();
    toast('已保存到仓库 ✓');
  } catch (e) {
    toast(e.message || '保存失败');
  }
}

/* ---------- 渲染 ---------- */
function buildMonthOptions() {
  const sel = $('monthSel');
  sel.innerHTML = '';
  MONTHS.forEach((mo, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = `${mo.y}年${mo.m}月`;
    sel.appendChild(o);
  });
  // 默认当前月（2026-09）
  const idx = MONTHS.findIndex((m) => m.y === 2026 && m.m === 9);
  sel.value = idx >= 0 ? idx : 0;
  state.current = MONTHS[idx >= 0 ? idx : 0];
}
function mondayOf(y, m, d) {
  const dt = new Date(y, m - 1, d);
  const day = (dt.getDay() + 6) % 7; // 周一=0
  dt.setDate(dt.getDate() - day);
  return dt;
}
function renderMonth() {
  const { y, m } = state.current;
  const daysInMonth = new Date(y, m, 0).getDate();
  // 收集本月出现过的时间段
  const tsSet = new Set();
  const monthDays = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const key = iso(y, m, d);
    monthDays.push(key);
    const rec = state.data.days[key];
    if (rec) Object.keys(rec).forEach((ts) => tsSet.add(ts));
  }
  const tsList = [...tsSet].sort((a, b) => parseTs(a) - parseTs(b));

  // 按周分组
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
    const t1 = start.slice(5), t2 = end.slice(5);
    card.innerHTML = `<div class="week-title">${t1} ~ ${t2}</div><div class="table-scroll"></div>`;
    const table = document.createElement('table');

    // 表头
    const thead = document.createElement('tr');
    thead.innerHTML = '<th class="ts">时间段</th>' + WEEK.map((w, i) => {
      const cell = dates[i];
      if (!cell) return `<th></th>`;
      const [, mm, dd] = cell.split('-');
      const inMonth = Number(mm) === m;
      return `<th class="${inMonth ? '' : 'out'}">${w}<span class="d">${Number(mm)}/${Number(dd)}</span></th>`;
    }).join('');
    table.appendChild(thead);

    // 时间段行
    tsList.forEach((ts) => {
      const tr = document.createElement('tr');
      let row = `<td class="ts">${ts}</td>`;
      WEEK.forEach((_, i) => {
        const cell = dates[i];
        if (!cell) { row += '<td></td>'; return; }
        const rec = (state.data.days[cell] || {})[ts];
        const st = rec ? rec.status : 'none';
        const txt = rec ? rec.text : '';
        const cellCls = txt ? STATUS.find((s) => s.key === st).cls : 'empty';
        row += `<td><div class="cell ${cellCls}" data-date="${cell}" data-ts="${ts}">${txt ? escapeHtml(txt) : '＋'}</div></td>`;
      });
      tr.innerHTML = row;
      table.appendChild(tr);
    });
    card.querySelector('.table-scroll').appendChild(table);
    container.appendChild(card);
  });

  // 绑定点击
  container.querySelectorAll('.cell').forEach((el) => {
    el.addEventListener('click', () => openEdit(el.dataset.date, el.dataset.ts));
  });
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 编辑 ---------- */
function openEdit(date, ts) {
  state.editing = { date, ts };
  const rec = (state.data.days[date] || {})[ts];
  state.editStatus = rec ? rec.status : 'none';
  $('editTitle').textContent = `${date}  ${ts}`;
  $('editText').value = rec ? rec.text : '';
  renderStatusOpts();
  $('editModal').classList.remove('hidden');
}
function renderStatusOpts() {
  const box = $('editStatus');
  box.innerHTML = '';
  STATUS.forEach((s) => {
    const d = document.createElement('div');
    d.className = 'status-opt s-' + s.key + (state.editStatus === s.key ? ' active' : '');
    d.textContent = s.label;
    d.onclick = () => { state.editStatus = s.key; renderStatusOpts(); };
    box.appendChild(d);
  });
}
function closeEdit() { $('editModal').classList.add('hidden'); state.editing = null; }
async function saveEdit() {
  if (!state.editing) return;
  const { date, ts } = state.editing;
  const text = $('editText').value.trim();
  if (!state.data.days[date]) state.data.days[date] = {};
  if (text) {
    state.data.days[date][ts] = { text, status: state.editStatus };
  } else {
    delete state.data.days[date][ts];
    if (Object.keys(state.data.days[date]).length === 0) delete state.data.days[date];
  }
  closeEdit();
  renderMonth();
  await saveData();
}
function deleteEdit() {
  $('editText').value = '';
  state.editStatus = 'none';
  saveEdit();
}

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
    // 仍尝试静态加载（只读）
    try { await loadData(); renderMonth(); }
    catch (e) { toast('先到「设置」填好仓库与 Token'); openSettings(); }
    return;
  }
  try {
    if (reload || !restoreCache()) await loadData();
    renderMonth();
  } catch (e) {
    toast(e.message || '加载失败');
    openSettings();
  }
}

/* ---------- 事件绑定 ---------- */
$('monthSel').addEventListener('change', (e) => { state.current = MONTHS[Number(e.target.value)]; renderMonth(); });
$('btnRefresh').addEventListener('click', async () => { await boot(true); toast('已刷新'); });
$('btnSettings').addEventListener('click', openSettings);
$('btnCfgCancel').addEventListener('click', closeSettings);
$('btnCfgSave').addEventListener('click', saveSettings);
$('btnEditCancel').addEventListener('click', closeEdit);
$('btnEditSave').addEventListener('click', saveEdit);
$('btnEditDelete').addEventListener('click', deleteEdit);

loadConfig();
buildMonthOptions();
boot(false);
