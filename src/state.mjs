// 文档状态、撤销/重做历史与持久化

export const STORAGE_KEY = 'focus-creator:v1';
export const LAST_GOOD_KEY = 'focus-creator:last-good';
const HISTORY_LIMIT = 100;
const COALESCE_WINDOW_MS = 900;

export function createInitialDoc() {
  return {
    version: 1,
    texts: [],
    shapes: [
      { id: 'shape-seed-1', kind: 'rect', x: 80, y: 70, w: 180, h: 110, fill: '#3d6fb4' },
      { id: 'shape-seed-2', kind: 'ellipse', x: 360, y: 140, w: 140, h: 140, fill: '#b45a8f' },
    ],
    timeline: [
      { id: 'key-seed-1', t: 0, label: '起始帧' },
      { id: 'key-seed-2', t: 60, label: '过渡帧' },
    ],
  };
}

export function createInitialUi() {
  return {
    selectedShapeId: 'shape-seed-1',
    selectedKeyId: 'key-seed-1',
    scroll: { canvas: { left: 0, top: 0 }, sidebar: { left: 0, top: 0 } },
    modalDraft: null, // { textId, title, body, dirty }
  };
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export class History {
  constructor(doc, onChange = null) {
    this.past = [];   // { label, at, coalesceKey, snapshot }
    this.future = []; // { label, snapshot }
    this.doc = doc;
    this.onChange = onChange;
  }

  // 在修改前压入当前快照；coalesceKey 相同且在时间窗内则合并为一次撤销
  commit(label, mutate, coalesceKey = null) {
    const now = Date.now();
    const last = this.past[this.past.length - 1];
    const canCoalesce =
      coalesceKey !== null &&
      last &&
      last.coalesceKey === coalesceKey &&
      now - last.at <= COALESCE_WINDOW_MS;
    if (!canCoalesce) {
      this.past.push({
        label,
        at: now,
        coalesceKey,
        snapshot: clone(this.doc),
      });
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
    } else {
      last.at = now;
    }
    this.future = [];
    mutate(this.doc); // this.doc 与应用层 doc 为同一引用，修改即时生效
  }

  undo() {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ label: entry.label, snapshot: clone(this.doc) });
    this.doc = entry.snapshot;
    this.onChange?.(this.doc);
    return entry.label;
  }

  redo() {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({
      label: entry.label,
      at: Date.now(),
      coalesceKey: null,
      snapshot: clone(this.doc),
    });
    this.doc = entry.snapshot;
    this.onChange?.(this.doc);
    return entry.label;
  }

  // 拖拽等场景：外部已直接修改 doc，凭拖拽前快照补一条历史
  commitExternal(label, beforeSnapshot) {
    this.past.push({
      label,
      at: Date.now(),
      coalesceKey: null,
      snapshot: beforeSnapshot,
    });
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }
  topLabels(n = 3) {
    return {
      past: this.past.slice(-n).map((e) => e.label).reverse(),
      future: this.future.slice(-n).map((e) => e.label).reverse(),
    };
  }
}

// ---- 持久化 ----

export class Storage {
  constructor(backend = globalThis.localStorage) {
    this.backend = backend;
    this.forceWriteFail = false;
    this.lastError = null;
    this.lastSavedAt = null;
    this.lastBytes = 0;
    this.saveCount = 0;
    this.readOnly = false;
  }

  save(payload) {
    if (this.readOnly) {
      this.lastError = '存储处于只读模式（快照损坏待修复），本次写入被拒绝';
      throw new Error(this.lastError);
    }
    const raw = JSON.stringify({ ...payload, savedAt: new Date().toISOString() });
    if (this.forceWriteFail) {
      this.lastError = '模拟写入失败：磁盘配额/权限异常（内存状态仍保留）';
      throw new Error(this.lastError);
    }
    this.backend.setItem(STORAGE_KEY, raw);
    // last-good 独立键，供损坏恢复使用
    this.backend.setItem(LAST_GOOD_KEY, raw);
    this.lastError = null;
    this.lastSavedAt = new Date();
    this.lastBytes = new Blob([raw]).size;
    this.saveCount += 1;
  }

  load() {
    const raw = this.backend.getItem(STORAGE_KEY);
    if (!raw) return { ok: true, payload: null };
    try {
      const payload = JSON.parse(raw);
      if (!payload || typeof payload !== 'object' || !payload.doc) {
        throw new Error('快照结构不完整');
      }
      return { ok: true, payload, raw };
    } catch (err) {
      this.readOnly = true; // 锁定写入，保留损坏现场
      return { ok: false, error: err.message, raw };
    }
  }

  loadLastGood() {
    const raw = this.backend.getItem(LAST_GOOD_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  clear() {
    this.backend.removeItem(STORAGE_KEY);
    this.backend.removeItem(LAST_GOOD_KEY);
    this.lastError = null;
  }

  corrupt() {
    // 写入无法解析的内容，模拟外部破坏
    this.backend.setItem(
      STORAGE_KEY,
      '{__corrupt:true, "note":"故意损坏的快照", "at":"' + new Date().toISOString() + '"',
    );
  }
}
