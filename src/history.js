// Store 运行时：订阅者、撤销/重做栈、localStorage 持久化与恢复。

import {
  CORRUPT_KEY,
  HISTORY_LIMIT,
  isEphemeral,
  LAST_GOOD_KEY,
  STORAGE_KEY,
} from './store-constants.js';
import { initialState, reducer } from './store.js';

const PERSIST_DEBOUNCE_MS = 250;
const GROUP_WINDOW_MS = 300;
const GROUPABLE = new Set(['nudge']);

export function createStore(storage = globalThis.localStorage) {
  let state = initialState();
  let undoStack = [];
  let redoStack = [];
  const listeners = new Set();
  let persistTimer = 0;
  let transaction = null; // { baseline, depth, pushed }
  let lastGroup = { type: null, at: 0 };
  let persistGeneration = 0;

  function emit() {
    listeners.forEach((fn) => fn(state));
  }

  function schedulePersist() {
    if (!storage) return;
    globalThis.clearTimeout(persistTimer);
    const generation = persistGeneration;
    persistTimer = globalThis.setTimeout(() => {
      if (generation === persistGeneration) persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  function persistNow() {
    if (!storage) return;
    globalThis.clearTimeout(persistTimer);
    persistGeneration += 1; // 使任何排队中的旧防抖回调失效
    const snapshot = JSON.stringify({
      version: 1,
      state,
      undoStack: undoStack.slice(-HISTORY_LIMIT),
      redoStack: redoStack.slice(-HISTORY_LIMIT),
    });
    try {
      storage.setItem(STORAGE_KEY, snapshot);
      storage.setItem(LAST_GOOD_KEY, snapshot);
      const savedAt = new Date().toISOString();
      state = { ...state, savedAt };
    } catch (err) {
      state = { ...state, lastError: { message: `写入存储失败：${err.message}`, at: Date.now() } };
    }
  }

  function pushHistory(prev) {
    undoStack.push(prev);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
  }

  function shouldGroup(command) {
    const now = Date.now();
    const grouped = GROUPABLE.has(command.type) &&
      lastGroup.type === command.type && now - lastGroup.at < GROUP_WINDOW_MS;
    lastGroup = { type: command.type, at: now };
    return grouped;
  }

  function dispatch(command) {
    const next = reducer(state, command);
    if (next === state) return;
    const ephemeral = isEphemeral(command.type);
    if (!ephemeral) {
      if (shouldGroup(command) && undoStack.length > 0) {
        // 连续同类微调：沿用最近一个撤销条目，不新增快照。
      } else if (transaction) {
        // 事务内首个非瞬时命令：压入一次事务基线，后续命令复用该条目。
        if (!transaction.pushed) {
          pushHistory(transaction.baseline);
          transaction.pushed = true;
        }
      } else {
        pushHistory(state);
      }
    }
    state = next;
    emit();
    schedulePersist();
  }

  // beginTransaction/commit 包裹一笔连续操作（如一次拖拽/一串方向键），
  // 整笔操作在撤销栈中只占一个条目。鼠标与键盘路径使用同一机制。
  function beginTransaction() {
    if (transaction) {
      transaction.depth += 1;
      return;
    }
    transaction = { baseline: state, pushed: false, depth: 1 };
  }

  function commitTransaction() {
    if (!transaction) return;
    transaction.depth -= 1;
    if (transaction.depth <= 0) transaction = null;
  }

  function cancelTransaction() {
    transaction = null;
  }

  function undo() {
    const prev = undoStack.pop();
    if (!prev) return;
    redoStack.push(state);
    lastGroup = { type: null, at: 0 };
    state = { ...prev, lastAction: 'undo' };
    emit();
    schedulePersist();
  }

  function redo() {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(state);
    lastGroup = { type: null, at: 0 };
    state = { ...next, lastAction: 'redo' };
    emit();
    schedulePersist();
  }

  function getState() {
    return state;
  }

  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }

  function subscribe(fn) {
    listeners.add(fn);
    fn(state);
    return () => listeners.delete(fn);
  }

  function restore() {
    if (!storage) return { ok: true, corruptRaw: null };
    let raw = null;
    try {
      raw = storage.getItem(STORAGE_KEY);
      if (!raw) return { ok: true, corruptRaw: null };
      const parsed = JSON.parse(raw);
      const restored = validateRestored(parsed.state);
      state = restored;
      undoStack = Array.isArray(parsed.undoStack)
        ? parsed.undoStack.slice(-HISTORY_LIMIT).map(validateRestored)
        : [];
      redoStack = Array.isArray(parsed.redoStack)
        ? parsed.redoStack.slice(-HISTORY_LIMIT).map(validateRestored)
        : [];
      emit();
      return { ok: true, corruptRaw: null };
    } catch (err) {
      // 恢复失败：保留可读原始快照，尝试 last-good，再退回到初始空白状态。
      try { storage.setItem(CORRUPT_KEY, raw ?? String(err)); } catch { /* 忽略 */ }
      let fallback = initialState();
      let goodRaw = null;
      try {
        goodRaw = storage.getItem(LAST_GOOD_KEY);
        if (goodRaw) fallback = validateRestored(JSON.parse(goodRaw).state);
      } catch { /* last-good 同样损坏时使用空白状态 */ }
      fallback = {
        ...fallback,
        lastError: { message: `状态恢复失败：${err.message}，已保留原始快照`, at: Date.now() },
      };
      state = fallback;
      undoStack = [];
      redoStack = [];
      emit();
      schedulePersist();
      return { ok: false, corruptRaw: raw, goodRaw, error: err };
    }
  }

  return {
    dispatch, undo, redo, getState, canUndo, canRedo, subscribe, restore, persistNow,
    beginTransaction, commitTransaction, cancelTransaction,
  };
}

function validateRestored(value) {
  const base = initialState();
  if (!value || typeof value !== 'object' || value.version !== 1) {
    throw new Error('版本号不匹配或数据不是对象');
  }
  if (!Array.isArray(value.elements)) throw new Error('elements 不是数组');
  const elements = value.elements.map((el, i) => {
    if (!el || typeof el.x1 !== 'number' || typeof el.y1 !== 'number' ||
        typeof el.x2 !== 'number' || typeof el.y2 !== 'number') {
      throw new Error(`第 ${i} 个元素坐标无效`);
    }
    if (!['rect', 'ellipse', 'line'].includes(el.type)) throw new Error(`第 ${i} 个元素类型无效`);
    return { ...el };
  });
  return {
    ...base,
    ...value,
    elements,
    view: { ...base.view, ...(value.view || {}) },
    canvasSize: { ...base.canvasSize, ...(value.canvasSize || {}) },
    cursor: { ...base.cursor, ...(value.cursor || {}) },
    draft: value.draft ?? null,
    selectedId: value.selectedId ?? null,
  };
}
