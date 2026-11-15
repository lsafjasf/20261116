// 应用主逻辑：状态管理、持久化、回退、渲染与交互。
import { simulateVision, evaluatePair, VISION_MODES } from './color.js';
import {
  generateScheme, regenerateUnlocked, collectWarnings, exportCssVariables,
  createSnapshot, serializeState, deserializeState,
} from './palette.js';

const STORAGE_KEY = 'brand-palette-checker:v1';
const SNAPSHOT_KEY = 'brand-palette-checker:snapshots';
const VISION_LABELS = { normal: '普通视觉', protan: '红色弱', deutan: '绿色弱', tritan: '蓝黄色弱' };
const USE_LABELS = { smallText: '小字', button: '按钮', chart: '图表系列' };

const $ = (sel) => document.querySelector(sel);

// ---------- 通知 ----------
function notify(message) {
  const el = document.createElement('div');
  el.className = 'notice';
  el.textContent = `⚠ ${message}`;
  $('#notices').appendChild(el);
  setTimeout(() => el.remove(), 12000);
}

// ---------- 默认状态 ----------
function defaultState(seeds = [20261116, 20261117]) {
  return {
    version: 1,
    activeScheme: 0,
    visionMode: 'normal',
    schemes: [generateScheme('Alpha', seeds[0]), generateScheme('Beta', seeds[1])],
  };
}

// ---------- 异步加载预设（失败自动回退）----------
async function loadPresetsWithFallback() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch('presets.json', { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.seeds) || data.seeds.length < 2) throw new Error('bad presets');
    return data.seeds;
  } catch (err) {
    notify(`预设请求失败（${err.message}），已回退到内置默认参数。`);
    return [20261116, 20261117];
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 缓存读取（损坏自动回退）----------
function loadStateWithFallback(fallback) {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    notify(`本地缓存不可读（${err.message}），已回退到默认工程。`);
    return fallback;
  }
  if (raw === null) return fallback;
  try {
    return deserializeState(raw);
  } catch (err) {
    notify(`本地缓存已损坏（${err.message}），已回退到默认工程，旧缓存已清除。`);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* 忽略 */ }
    return fallback;
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, serializeState(state));
  } catch (err) {
    notify(`状态写入缓存失败（${err.message}），本次更改不会被保存。`);
  }
}

// ---------- 快照 ----------
function readSnapshots() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    notify(`快照缓存损坏（${err.message}），快照列表已重置。`);
    return [];
  }
}

function saveSnapshot(snapshot) {
  const list = readSnapshots();
  list.unshift(snapshot);
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(list.slice(0, 10)));
  } catch (err) {
    notify(`快照保存失败（${err.message}）。`);
  }
  renderSnapshots();
}

// ---------- 缩略图（失败自动回退占位）----------
function renderThumbnail(scheme) {
  const wrap = $('#thumb-wrap');
  wrap.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = '缩略图：';
  wrap.appendChild(label);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 80;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    const ordered = scheme.order.map((id) => scheme.colors.find((c) => c.id === id));
    ordered.forEach((c, i) => {
      ctx.fillStyle = simulateVision(c.hex, state.visionMode);
      ctx.fillRect((i * canvas.width) / ordered.length, 0, canvas.width / ordered.length, 80);
    });
    const url = canvas.toDataURL('image/png');
    if (!url.startsWith('data:image/')) throw new Error('toDataURL failed');
    const img = document.createElement('img');
    img.alt = '方案缩略图';
    img.src = url;
    wrap.appendChild(img);
  } catch (err) {
    const ph = document.createElement('div');
    ph.className = 'thumb-fallback';
    ph.textContent = '缩略图不可用';
    wrap.appendChild(ph);
    notify(`缩略图生成失败（${err.message}），已显示占位内容。`);
  }
}

// ---------- 全局状态 ----------
let state = null;

function activeScheme() {
  return state.schemes[state.activeScheme];
}

// ---------- 渲染 ----------
function orderedColors(scheme) {
  return scheme.order.map((id) => scheme.colors.find((c) => c.id === id)).filter(Boolean);
}

function renderTabs() {
  const nav = $('#scheme-tabs');
  nav.innerHTML = '';
  state.schemes.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.textContent = `方案 ${s.name}`;
    btn.className = i === state.activeScheme ? 'active' : '';
    btn.addEventListener('click', () => {
      state.activeScheme = i;
      persist();
      renderAll();
    });
    nav.appendChild(btn);
  });
}

function renderSwatches() {
  const list = $('#swatch-list');
  list.innerHTML = '';
  const scheme = activeScheme();
  orderedColors(scheme).forEach((c) => {
    const li = document.createElement('li');
    li.className = 'swatch-item';

    const chip = document.createElement('span');
    chip.className = 'swatch-chip';
    chip.style.background = simulateVision(c.hex, state.visionMode);

    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = c.role;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = c.hex;
    input.setAttribute('aria-label', '颜色值');
    input.addEventListener('change', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(input.value.trim())) {
        c.hex = input.value.trim().toLowerCase();
        persist();
        renderAll();
      } else {
        notify(`"${input.value}" 不是合法颜色，已还原。`);
        input.value = c.hex;
      }
    });

    const lock = document.createElement('button');
    lock.className = 'lock';
    lock.textContent = c.locked ? '🔒' : '🔓';
    lock.title = c.locked ? '已锁定（重生成时保持不变）' : '未锁定';
    lock.addEventListener('click', () => {
      c.locked = !c.locked;
      persist();
      renderAll();
    });

    li.append(chip, role, input, lock);
    list.appendChild(li);
  });
}

function renderPreview() {
  const stage = $('#preview-stage');
  stage.innerHTML = '';
  $('#preview-mode-tag').textContent = `（${VISION_LABELS[state.visionMode]}模拟）`;
  const scheme = activeScheme();
  orderedColors(scheme).forEach((c, i) => {
    const pos = scheme.positions[i] ?? { x: 8 + i * 18, y: 30 };
    const chip = document.createElement('div');
    chip.className = 'preview-chip';
    chip.style.left = `${pos.x}%`;
    chip.style.top = `${pos.y}%`;
    chip.style.zIndex = String(i + 1); // 图层顺序
    chip.style.background = simulateVision(c.hex, state.visionMode);
    chip.style.setProperty('--dur', `${scheme.keyframes.duration}s`);
    chip.style.setProperty('--amp', String(scheme.keyframes.amplitude));
    chip.textContent = c.hex;
    stage.appendChild(chip);
  });
  renderThumbnail(scheme);
}

function badge(okValue) {
  const span = document.createElement('span');
  span.className = `badge ${okValue ? 'ok' : 'bad'}`;
  span.textContent = okValue ? '适合' : '不适合';
  return span;
}

function renderPairs() {
  const tbody = $('#pair-table tbody');
  tbody.innerHTML = '';
  const scheme = activeScheme();
  const colors = orderedColors(scheme);
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const ev = evaluatePair(colors[i].hex, colors[j].hex, state.visionMode);
      const tr = document.createElement('tr');
      const combo = document.createElement('td');
      for (const c of [colors[i], colors[j]]) {
        const dot = document.createElement('span');
        dot.className = 'pair-dot';
        dot.style.background = simulateVision(c.hex, state.visionMode);
        combo.appendChild(dot);
      }
      combo.append(`${colors[i].role} × ${colors[j].role}`);
      const cells = [combo];
      const contrast = document.createElement('td');
      contrast.textContent = ev.contrast.toFixed(2);
      const de = document.createElement('td');
      de.textContent = ev.deltaE.toFixed(1);
      cells.push(contrast, de);
      for (const use of ['smallText', 'button', 'chart']) {
        const td = document.createElement('td');
        td.appendChild(badge(ev[use]));
        cells.push(td);
      }
      tr.append(...cells);
      tbody.appendChild(tr);
    }
  }
}

function renderWarnings() {
  const list = $('#warning-list');
  list.innerHTML = '';
  const scheme = activeScheme();
  const warnings = collectWarnings(scheme);
  if (warnings.length === 0) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = '当前方案在所有视觉模式下均无警告。';
    list.appendChild(li);
    return;
  }
  for (const w of warnings) {
    const a = scheme.colors.find((c) => c.id === w.a);
    const b = scheme.colors.find((c) => c.id === w.b);
    const li = document.createElement('li');
    const modes = w.modes.map((m) => VISION_LABELS[m]).join('、');
    li.textContent = `${a.role}(${a.hex}) × ${b.role}(${b.hex}) 不适合用作${USE_LABELS[w.use]}（${modes}下不达标）`;
    list.appendChild(li);
  }
}

function renderSnapshots() {
  const list = $('#snapshot-list');
  list.innerHTML = '';
  const snaps = readSnapshots();
  if (snaps.length === 0) {
    const li = document.createElement('li');
    li.textContent = '暂无快照。点击「导出 CSS 变量」时会自动保存导出前的工程快照。';
    list.appendChild(li);
    return;
  }
  snaps.forEach((snap, idx) => {
    const li = document.createElement('li');
    const info = document.createElement('span');
    info.textContent = `${snap.at} — ${snap.label || '未命名'}`;
    const restore = document.createElement('button');
    restore.textContent = '恢复';
    restore.addEventListener('click', () => {
      try {
        state = deserializeState(serializeState(snap.state));
        persist();
        renderAll();
        notify(`已恢复快照（${snap.at}）。`);
      } catch (err) {
        notify(`快照恢复失败（${err.message}），当前工程未改动。`);
      }
    });
    void idx;
    li.append(info, restore);
    list.appendChild(li);
  });
}

function renderAll() {
  $('#vision-mode').value = state.visionMode;
  renderTabs();
  renderSwatches();
  renderPreview();
  renderPairs();
  renderWarnings();
}

// ---------- 导出 ----------
let lastSnapshot = null;

function doExport() {
  persist(); // 导出前确保当前状态已写入缓存
  lastSnapshot = createSnapshot(state, `导出前 — 方案 ${activeScheme().name}`);
  saveSnapshot(lastSnapshot); // 导出前保留工程快照
  const css = state.schemes.map((s) => exportCssVariables(s)).join('\n\n');
  $('#export-output').value = css;
  $('#export-dialog').showModal();
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- 事件 ----------
function bindEvents() {
  $('#vision-mode').addEventListener('change', (e) => {
    const mode = e.target.value;
    if (!VISION_MODES.includes(mode)) {
      notify(`未知视觉模式 "${mode}"，已回退到普通视觉。`);
      state.visionMode = 'normal';
    } else {
      state.visionMode = mode;
    }
    persist();
    renderAll();
  });

  $('#btn-regen').addEventListener('click', () => {
    const i = state.activeScheme;
    state.schemes[i] = regenerateUnlocked(activeScheme(), Math.floor(Math.random() * 2 ** 31));
    persist();
    renderAll();
  });

  $('#btn-export').addEventListener('click', doExport);
  $('#btn-close-export').addEventListener('click', () => $('#export-dialog').close());
  $('#btn-download-css').addEventListener('click', () => {
    download('brand-variables.css', $('#export-output').value, 'text/css');
  });
  $('#btn-download-snapshot').addEventListener('click', () => {
    if (lastSnapshot) download('project-snapshot.json', JSON.stringify(lastSnapshot, null, 2), 'application/json');
  });
}

// ---------- 启动 ----------
async function init() {
  const seeds = await loadPresetsWithFallback();
  state = loadStateWithFallback(defaultState(seeds));
  bindEvents();
  renderAll();
  renderSnapshots();
}

init();
