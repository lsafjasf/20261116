import { bindExportDialog, bindHelpDialog } from './dialogs.js';
import { handleCanvasKeydown } from './keyboard.js';
import { bindMouse } from './mouse.js';
import { render } from './renderer.js';
import { createStore } from './history.js';
import { CORRUPT_KEY, LAST_GOOD_KEY, STORAGE_KEY } from './store-constants.js';
import { TOOLS } from './store.js';

const canvasEl = document.getElementById('canvas');
const stage = document.getElementById('stage');
const cursorEl = document.getElementById('cursor');
const announceEl = document.getElementById('live-announce');
const statusList = document.getElementById('status-list');
const storageSnapshot = document.getElementById('storage-snapshot');
const restoreErrorBox = document.getElementById('restore-error-box');

const store = createStore(localStorage);

function announce(message) {
  announceEl.textContent = `${new Date().toLocaleTimeString()} ${message}`;
}

const exportDialog = bindExportDialog(store, announce);
const helpDialog = bindHelpDialog();

bindMouse(canvasEl, store);

canvasEl.addEventListener('keydown', (event) => {
  handleCanvasKeydown(event, store, {
    announce,
    openExport: () => exportDialog.open(),
  });
});

canvasEl.addEventListener('focus', () => canvasEl.classList.add('focus-strong'));
canvasEl.addEventListener('blur', () => canvasEl.classList.remove('focus-strong'));

// 全局快捷键：F 聚焦画布、F1/? 帮助、Ctrl+E 导出（焦点不在画布时也可用）。
document.addEventListener('keydown', (event) => {
  if (!exportDialog.isOpen && !helpDialog.isOpen && (event.key === 'F1' ||
      (event.shiftKey && event.key === '?'))) {
    event.preventDefault();
    helpDialog.open();
    return;
  }
  if (event.target === canvasEl) return;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'e') {
    event.preventDefault();
    exportDialog.open();
  } else if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) store.redo(); else store.undo();
  } else if (mod && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    store.redo();
  } else if (event.key.toLowerCase() === 'f' && !mod) {
    const tag = event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    event.preventDefault();
    canvasEl.focus();
  }
});

// 工具栏按钮 -> 同一套 command。
document.querySelectorAll('[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => {
    store.dispatch({ type: 'set-tool', tool: btn.dataset.tool });
    canvasEl.focus();
  });
});
document.getElementById('btn-zoom-in').addEventListener('click', () => {
  store.dispatch({ type: 'zoom', zoom: store.getState().view.zoom + 0.1 });
  canvasEl.focus();
});
document.getElementById('btn-zoom-out').addEventListener('click', () => {
  store.dispatch({ type: 'zoom', zoom: store.getState().view.zoom - 0.1 });
  canvasEl.focus();
});
document.getElementById('btn-zoom-reset').addEventListener('click', () => {
  store.dispatch({ type: 'reset-view' });
  canvasEl.focus();
});
document.getElementById('btn-undo').addEventListener('click', () => {
  store.undo();
  canvasEl.focus();
});
document.getElementById('btn-redo').addEventListener('click', () => {
  store.redo();
  canvasEl.focus();
});
document.getElementById('btn-export').addEventListener('click', () => exportDialog.open());
document.getElementById('btn-help').addEventListener('click', () => helpDialog.open());

// 画布尺寸随容器变化。
const resizeObserver = new ResizeObserver((entries) => {
  const rect = entries[0].contentRect;
  store.dispatch({
    type: 'set-canvas-size',
    size: { width: Math.round(rect.width), height: Math.round(rect.height) },
  });
});
resizeObserver.observe(canvasEl);

// 页面隐藏/关闭前强制落盘，避免防抖窗口内丢失未提交内容。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') store.persistNow();
});
window.addEventListener('pagehide', () => store.persistNow());

// ---- 恢复与错误快照展示 ----
const restoreResult = store.restore();
if (!restoreResult.ok) {
  restoreErrorBox.hidden = false;
  document.getElementById('restore-error-msg').textContent =
    store.getState().lastError?.message ?? '未知恢复错误';
  document.getElementById('corrupt-snapshot').textContent = restoreResult.corruptRaw ?? '(空)';
  announce('检测到损坏的本地状态，已保留快照并回退到可用状态');
}

// ---- 渲染与状态面板 ----
const STATUS_KEYS = [
  ['tool', '当前工具'],
  ['elements', '元素数量'],
  ['selectedId', '选中对象'],
  ['cursor', '光标(文档坐标)'],
  ['draft', '进行中草稿'],
  ['view', '视图 缩放/平移'],
  ['lastAction', '最近命令'],
  ['lastError', '失败提示'],
  ['savedAt', '最近落盘'],
];

function formatValue(key, value) {
  if (key === 'elements') return String(value.length);
  if (key === 'cursor') return `x=${value.x}, y=${value.y}`;
  if (key === 'view') return `zoom=${value.zoom}, pan=(${value.panX}, ${value.panY})`;
  if (key === 'draft') return value ? `${value.kind}:${value.type ?? ''}` : '无';
  if (key === 'lastError') return value ? value.message : '无';
  if (value === null || value === undefined) return '无';
  return String(value);
}

function syncStatusPanel(state) {
  if (statusList.children.length === 0) {
    for (const [key, label] of STATUS_KEYS) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.dataset.key = key;
      statusList.append(dt, dd);
    }
  }
  for (const [key] of STATUS_KEYS) {
    const dd = statusList.querySelector(`dd[data-key="${key}"]`);
    const text = formatValue(key, state[key]);
    if (dd.textContent !== text) {
      dd.textContent = text;
      dd.classList.remove('flash');
      void dd.offsetWidth;
      dd.classList.add('flash');
    }
  }
  storageSnapshot.textContent = localStorage.getItem(LAST_GOOD_KEY)
    ?? localStorage.getItem(STORAGE_KEY) ?? '(尚未写入)';
}

function syncToolbar(state) {
  document.querySelectorAll('[data-tool]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.tool === state.tool));
  });
  document.getElementById('btn-undo').disabled = !store.canUndo();
  document.getElementById('btn-redo').disabled = !store.canRedo();
}

store.subscribe((state) => {
  render(state, { stage, cursor: cursorEl });
  syncStatusPanel(state);
  syncToolbar(state);
});

// 测试钩子：便于自动化核对输入/存储/渲染三者一致性。
window.__app = {
  store,
  getState: () => store.getState(),
  persistNow: () => store.persistNow(),
  storageKeys: { STORAGE_KEY, LAST_GOOD_KEY, CORRUPT_KEY },
  TOOLS,
};
