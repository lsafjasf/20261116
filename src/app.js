import {
  FIELD_DEFS, defaultConfig, validateConfig, hashConfig, canonicalJSON,
} from './storage.js';
import {
  KEYS, loadState, persistConfig, saveRaw, readRaw, rebuildAfterRecovery,
} from './persistence.js';
import { buildControls, syncControls, readFieldValue, renderCharacter, buildDiff } from './ui-components.js';

const SAVE_DEBOUNCE_MS = 400;
const UNDO_LIMIT = 30;
const labelMap = Object.fromEntries(FIELD_DEFS.map((d) => [d.key, d.label]));

const els = {
  svg: document.getElementById('characterSvg'),
  animationNote: document.getElementById('animationNote'),
  statusList: document.getElementById('statusList'),
  inlineError: document.getElementById('inlineError'),
  toast: document.getElementById('toast'),
  exportBtn: document.getElementById('exportBtn'),
  importBtn: document.getElementById('importBtn'),
  rollbackBtn: document.getElementById('rollbackBtn'),
  undoBtn: document.getElementById('undoBtn'),
  recoverBtn: document.getElementById('recoverBtn'),
  modal: document.getElementById('importModal'),
  importText: document.getElementById('importText'),
  importParseError: document.getElementById('importParseError'),
  diffView: document.getElementById('diffView'),
  confirmImportBtn: document.getElementById('confirmImportBtn'),
  cancelImportBtn: document.getElementById('cancelImportBtn'),
  exportArea: document.getElementById('exportArea'),
  previewScroll: document.getElementById('previewScroll'),
};

const state = {
  config: defaultConfig(),
  source: 'default',
  saveBlocked: false,
  currentHash: '',
  storedHash: '',
  lastSaveAt: '—',
  lastSaveError: '',
  pendingIncoming: null,
  undoStack: [],
  saveTimer: null,
  modalOpener: null,
};

const sessionDefaults = {
  dirtyDraft: null,
  selectedKey: null,
  scroll: { x: 0, y: 0, previewX: 0, previewY: 0 },
  modalOpen: false,
  modalText: '',
  exportOpen: false,
};
let session = structuredClone(sessionDefaults);

function showToast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('toast-error', isError);
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { els.toast.hidden = true; }, 3200);
}

function showInlineError(message) {
  state.lastSaveError = message || '';
  els.inlineError.hidden = !message;
  els.inlineError.textContent = message || '';
  renderStatus();
}

function snapshotSession() {
  const draft = state.dirty ? structuredClone(state.config) : null;
  session.dirtyDraft = draft;
  session.scroll = {
    x: document.documentElement.scrollLeft || document.body.scrollLeft || 0,
    y: document.documentElement.scrollTop || document.body.scrollTop || 0,
    previewX: els.previewScroll.scrollLeft,
    previewY: els.previewScroll.scrollTop,
  };
  const active = document.activeElement;
  session.selectedKey = active && active.dataset ? active.dataset.fieldKey || null : null;
  saveRaw(KEYS.session, session, sessionStorage);
}

function renderStatus() {
  const saveState = state.saveBlocked
    ? '<span class="status-warn">已封锁（等待恢复）</span>'
    : state.lastSaveError
      ? '<span class="status-danger">写入失败</span>'
      : '<span class="status-ok">正常自动保存</span>';
  const rows = [
    ['加载来源', state.source],
    ['内存哈希', state.currentHash],
    ['存储哈希', state.storedHash || '（尚未写入）'],
    ['哈希一致', state.storedHash && state.storedHash === state.currentHash
      ? '<span class="status-ok">一致</span>' : '<span class="status-warn">不一致/未落盘</span>'],
    ['保存状态', saveState],
    ['上次保存', state.lastSaveAt],
    ['未提交修改', state.dirty ? '<span class="status-warn">有（草稿已暂存 sessionStorage）</span>' : '无'],
    ['回滚可用', state.rollbackAvailable ? '<span class="status-ok">是</span>' : '否'],
    ['撤销深度', String(state.undoStack.length)],
    ['当前字段值', canonicalJSON(state.config)],
  ];
  if (state.lastSaveError) rows.push(['失败原因', `<span class="status-danger">${escapeHtml(state.lastSaveError)}</span>`]);
  els.statusList.innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderAll() {
  syncControls(refs, state.config);
  renderCharacter(els.svg, state.config);
  els.animationNote.textContent =
    `速度=${state.config.animation.speed} 弹跳=${state.config.animation.bounce}px 挥摆=${state.config.animation.swing}°`;
  els.undoBtn.disabled = state.undoStack.length === 0;
  els.recoverBtn.disabled = !state.saveBlocked;
  renderStatus();
}

async function refreshHashes() {
  state.currentHash = await hashConfig(state.config);
  const stored = readRaw(KEYS.current, null, localStorage);
  if (stored && validateConfig(stored).ok) {
    state.storedHash = await hashConfig(stored);
  } else {
    state.storedHash = '';
  }
  renderStatus();
}

function scheduleSave() {
  state.dirty = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(commitSave, SAVE_DEBOUNCE_MS);
  snapshotSession();
  renderStatus();
}

async function commitSave() {
  clearTimeout(state.saveTimer);
  if (state.saveBlocked) {
    showInlineError('当前存储槽损坏，自动保存已暂停；点击“恢复保存”或刷新使用可读快照。');
    return;
  }
  const result = persistConfig(state.config);
  if (!result.ok) {
    showInlineError(result.error);
    showToast(result.error, true);
    return;
  }
  state.dirty = false;
  state.lastSaveAt = new Date().toLocaleTimeString();
  showInlineError('');
  showToast('配置已自动保存');
  await refreshHashes();
  session.dirtyDraft = null;
  saveRaw(KEYS.session, session, sessionStorage);
}

function applyEdit(def, value, { recordUndo = true } = {}) {
  if (state.config[def.group][def.key] === value) return;
  if (recordUndo) {
    state.undoStack.push(structuredClone(state.config));
    if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
  }
  state.config[def.group][def.key] = value;
  renderAll();
  scheduleSave();
}

function undoLast() {
  const previous = state.undoStack.pop();
  if (!previous) {
    showToast('没有可撤销的修改', true);
    return;
  }
  state.config = previous;
  renderAll();
  clearTimeout(state.saveTimer);
  persistAndReport('已撤销最后一次修改');
}

function attemptRecovery() {
  const result = rebuildAfterRecovery(state.config);
  if (!result.ok) {
    showInlineError(`恢复失败，可读快照仍保留：${result.error}`);
    showToast('恢复失败，最后可读快照未被覆盖', true);
    return;
  }
  state.saveBlocked = false;
  state.dirty = false;
  showInlineError('');
  showToast('存储已用当前可读配置重建');
  refreshHashes();
}

window.characterApp = {
  getState: () => ({
    config: structuredClone(state.config),
    source: state.source,
    saveBlocked: state.saveBlocked,
    dirty: Boolean(state.dirty),
    currentHash: state.currentHash,
    storedHash: state.storedHash,
    undoDepth: state.undoStack.length,
    rollbackAvailable: Boolean(state.rollbackAvailable),
  }),
  commitSave,
  attemptRecovery,
  validateConfig,
  hashConfig,
};

function openExport() {
  els.exportArea.textContent = JSON.stringify(state.config, null, 2);
  els.exportArea.hidden = false;
  session.exportOpen = true;
  snapshotSession();
  els.exportArea.focus();
}

function closeExport() {
  els.exportArea.hidden = true;
  session.exportOpen = false;
  snapshotSession();
  els.exportBtn.focus();
}

function openImportModal() {
  state.modalOpener = document.activeElement;
  els.modal.hidden = false;
  session.modalOpen = true;
  els.importText.value = session.modalText || '';
  els.importParseError.hidden = true;
  state.pendingIncoming = null;
  els.confirmImportBtn.disabled = true;
  els.diffView.textContent = '';
  snapshotSession();
  els.importText.focus();
  validateImportDraft();
}

function closeImportModal({ keepDraft = true } = {}) {
  if (keepDraft) session.modalText = els.importText.value;
  els.modal.hidden = true;
  session.modalOpen = false;
  snapshotSession();
  if (state.modalOpener && state.modalOpener.focus) state.modalOpener.focus();
}

function validateImportDraft() {
  session.modalText = els.importText.value;
  snapshotSession();
  const text = els.importText.value.trim();
  if (!text) {
    state.pendingIncoming = null;
    els.confirmImportBtn.disabled = true;
    els.importParseError.hidden = true;
    els.diffView.textContent = '';
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    state.pendingIncoming = null;
    els.confirmImportBtn.disabled = true;
    els.importParseError.textContent = `JSON 解析失败：${err.message}`;
    els.importParseError.hidden = false;
    return;
  }
  const checked = validateConfig(parsed);
  if (!checked.ok) {
    state.pendingIncoming = null;
    els.confirmImportBtn.disabled = true;
    els.importParseError.textContent = checked.error;
    els.importParseError.hidden = false;
    return;
  }
  els.importParseError.hidden = true;
  state.pendingIncoming = checked.value;
  const changes = buildDiff(els.diffView, state.config, checked.value, labelMap);
  els.confirmImportBtn.disabled = changes === 0;
  if (changes === 0) showToast('导入内容与当前配置相同');
}

function confirmImport() {
  if (!state.pendingIncoming) {
    showToast('没有可导入的有效配置', true);
    return;
  }
  const backup = structuredClone(state.config);
  const backupResult = saveRaw(KEYS.backupBeforeImport, backup);
  if (!backupResult.ok) {
    showInlineError(`导入中止，备份失败：${backupResult.error}`);
    showToast('导入中止：无法创建回滚备份', true);
    return;
  }
  state.undoStack.push(structuredClone(state.config));
  state.config = structuredClone(state.pendingIncoming);
  state.rollbackAvailable = true;
  els.rollbackBtn.disabled = false;
  session.modalText = '';
  closeImportModal({ keepDraft: false });
  renderAll();
  persistAndReport('导入配置已保存');
}

function rollbackImport() {
  const backup = readRaw(KEYS.backupBeforeImport, null, localStorage);
  const checked = backup && validateConfig(backup);
  if (!checked || !checked.ok) {
    showInlineError('回滚失败：导入前备份缺失或损坏，当前配置保持不变。');
    showToast('回滚失败，当前配置未改动', true);
    return;
  }
  state.undoStack.push(structuredClone(state.config));
  state.config = checked.value;
  state.rollbackAvailable = false;
  els.rollbackBtn.disabled = true;
  renderAll();
  persistAndReport('已回滚到导入前的配置');
}

async function persistAndReport(message) {
  if (state.saveBlocked) {
    attemptRecovery();
    return;
  }
  const result = persistConfig(state.config);
  if (!result.ok) {
    showInlineError(result.error);
    showToast(result.error, true);
    return;
  }
  state.dirty = false;
  state.lastSaveAt = new Date().toLocaleTimeString();
  showInlineError('');
  showToast(message);
  await refreshHashes();
}

function trapModalFocus(event) {
  if (event.key !== 'Tab' || els.modal.hidden) return;
  const focusables = els.modal.querySelectorAll('button, textarea, [tabindex]:not([tabindex="-1"])');
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

const refs = buildControls(document, (def, input) => {
  const value = readFieldValue(def, input);
  applyEdit(def, value);
});

function restoreScrollAndFocus() {
  document.documentElement.scrollLeft = session.scroll.x;
  document.documentElement.scrollTop = session.scroll.y;
  document.body.scrollLeft = session.scroll.x;
  document.body.scrollTop = session.scroll.y;
  els.previewScroll.scrollLeft = session.scroll.previewX;
  els.previewScroll.scrollTop = session.scroll.previewY;
  if (session.selectedKey && refs[session.selectedKey]) {
    refs[session.selectedKey].focus();
  }
}

async function init() {
  const loaded = loadState();
  state.source = loaded.source;
  state.saveBlocked = loaded.saveBlocked;
  if (loaded.config) state.config = loaded.config;
  if (loaded.notes.length) {
    showInlineError(loaded.notes.join(' '));
  }
  state.rollbackAvailable = Boolean(readRaw(KEYS.backupBeforeImport, null, localStorage));
  els.rollbackBtn.disabled = !state.rollbackAvailable;

  session = { ...structuredClone(sessionDefaults), ...readRaw(KEYS.session, sessionDefaults, sessionStorage) };
  if (session.dirtyDraft && validateConfig(session.dirtyDraft).ok) {
    state.config = session.dirtyDraft;
    state.dirty = true;
    if (!state.saveBlocked) {
      const flushed = persistConfig(state.config);
      if (flushed.ok) {
        state.dirty = false;
        session.dirtyDraft = null;
        state.lastSaveAt = new Date().toLocaleTimeString();
      } else {
        showInlineError(flushed.error);
      }
    }
  }

  renderAll();
  await refreshHashes();

  els.exportBtn.addEventListener('click', openExport);
  els.importBtn.addEventListener('click', openImportModal);
  els.rollbackBtn.addEventListener('click', rollbackImport);
  els.undoBtn.addEventListener('click', undoLast);
  els.recoverBtn.addEventListener('click', attemptRecovery);
  els.confirmImportBtn.addEventListener('click', confirmImport);
  els.cancelImportBtn.addEventListener('click', () => closeImportModal());
  els.importText.addEventListener('input', validateImportDraft);
  els.exportArea.addEventListener('click', (e) => { if (e.target === els.exportArea) closeExport(); });
  els.modal.addEventListener('click', (e) => { if (e.target === els.modal) closeImportModal(); });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!els.exportArea.hidden) { closeExport(); return; }
      if (!els.modal.hidden) { closeImportModal(); }
    }
    trapModalFocus(event);
  });

  document.addEventListener('focusin', snapshotSession);
  window.addEventListener('scroll', snapshotSession, { passive: true });
  els.previewScroll.addEventListener('scroll', snapshotSession, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      snapshotSession();
      if (state.dirty && !state.saveBlocked) persistConfig(state.config);
    }
  });
  window.addEventListener('beforeunload', () => {
    snapshotSession();
    if (state.dirty && !state.saveBlocked) persistConfig(state.config);
  });

  if (session.modalOpen) openImportModal();
  if (session.exportOpen) {
    els.exportArea.hidden = false;
    els.exportArea.textContent = JSON.stringify(state.config, null, 2);
  }
  setTimeout(restoreScrollAndFocus, 0);
}

init().catch((err) => {
  showInlineError(`应用初始化失败：${err.message}`);
});
