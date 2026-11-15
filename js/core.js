export const STORAGE_KEY = "framecraft.editor.v3";
export const STATE_VERSION = 3;
export const MAX_LOGS = 80;
export const MAX_HISTORY = 30;

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function shortHash(value) {
  const text = typeof value === "string" ? value : stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function makeWave(seed = 220, count = 54) {
  return Array.from({ length: count }, (_, index) => {
    const base = Math.sin((index + seed / 31) * 0.58) * 0.38;
    const detail = Math.sin((index + 3) * 1.91 + seed / 100) * 0.22;
    return Number((0.26 + Math.abs(base + detail)).toFixed(3));
  });
}

const INITIAL_IMAGE_STYLE = {
  brightness: 112,
  blur: 0,
  warmth: 12,
  note: "保留霓虹层次"
};

const INITIAL_AUDIO_STYLE = {
  frequency: 220,
  duration: 7.2,
  texture: "空气感"
};

const INITIAL_EXPORT_DRAFT = {
  name: "城市呼吸-精剪",
  format: "webm",
  quality: "高"
};

export function createInitialState() {
  const now = Date.now();
  return {
    version: STATE_VERSION,
    title: "城市呼吸 · 预热片",
    clips: [
      {
        id: "clip-image",
        kind: "image",
        name: "城市夜景",
        start: 0,
        duration: 4.8,
        style: clone(INITIAL_IMAGE_STYLE),
        resourceId: null
      },
      {
        id: "clip-audio",
        kind: "audio",
        name: "环境底噪",
        start: 0.4,
        duration: 7.2,
        style: clone(INITIAL_AUDIO_STYLE),
        wave: makeWave(220),
        resourceId: null
      }
    ],
    selectedId: "clip-image",
    drafts: {
      image: clone(INITIAL_IMAGE_STYLE),
      audio: clone(INITIAL_AUDIO_STYLE),
      export: clone(INITIAL_EXPORT_DRAFT)
    },
    modules: {
      image: emptyModule(),
      audio: emptyModule(),
      export: emptyModule()
    },
    resources: {},
    faults: { image: false, audio: false, export: false, persistent: false },
    logs: [
      {
        id: `log-${now}-boot`,
        at: now,
        level: "info",
        module: "系统",
        stage: "载入",
        message: "工程与草稿已从本地存储恢复。",
        attempt: 0
      }
    ],
    history: { past: [], future: [] },
    view: {
      timelineScroll: 0,
      inspectorScroll: 0,
      logScroll: 0,
      zoom: 1,
      timelineFocused: false
    },
    meta: {
      revision: 1,
      savedAt: now,
      storageHash: "--------",
      lastSavedLabel: "刚刚",
      lastAction: "已载入本地工程"
    }
  };
}

function emptyModule() {
  return {
    status: "ready",
    stage: "待处理",
    attempt: 0,
    operationKey: null,
    resourceId: null,
    error: null,
    snapshot: null,
    startedAt: null,
    completedAt: null
  };
}

function mergeDefaults(defaultValue, storedValue) {
  if (storedValue === undefined) return clone(defaultValue);
  if (Array.isArray(defaultValue)) return Array.isArray(storedValue) ? clone(storedValue) : clone(defaultValue);
  if (defaultValue && typeof defaultValue === "object") {
    if (!storedValue || typeof storedValue !== "object" || Array.isArray(storedValue)) return clone(defaultValue);
    const merged = {};
    for (const key of Object.keys(defaultValue)) merged[key] = mergeDefaults(defaultValue[key], storedValue[key]);
    for (const key of Object.keys(storedValue)) {
      if (!(key in merged)) merged[key] = clone(storedValue[key]);
    }
    return merged;
  }
  return storedValue;
}

function normalizeState(state) {
  state.version = STATE_VERSION;
  if (!Array.isArray(state.clips) || state.clips.length === 0) state.clips = createInitialState().clips;
  if (!state.clips.some((clip) => clip.id === state.selectedId)) state.selectedId = state.clips[0]?.id || null;
  for (const id of ["image", "audio", "export"]) {
    state.modules[id] = mergeDefaults(emptyModule(), state.modules?.[id]);
    state.drafts[id] = mergeDefaults(createInitialState().drafts[id], state.drafts?.[id]);
  }
  state.history = mergeDefaults({ past: [], future: [] }, state.history);
  state.history.past = state.history.past.slice(-MAX_HISTORY);
  state.history.future = state.history.future.slice(0, MAX_HISTORY);
  state.logs = Array.isArray(state.logs) ? state.logs.slice(-MAX_LOGS) : [];
  state.resources = state.resources && typeof state.resources === "object" ? state.resources : {};
  for (const moduleId of ["image", "audio", "export"]) {
    const module = state.modules[moduleId];
    if (module.status !== "running") continue;
    const clip = moduleId === "audio"
      ? state.clips.find((item) => item.kind === "audio")
      : state.clips.find((item) => item.id === state.selectedId);
    const snapshot = module.snapshot || {
      moduleId,
      moduleName: moduleId,
      objectId: clip?.id || null,
      objectName: clip?.name || "工程时间线",
      selectedId: state.selectedId,
      draft: clone(state.drafts[moduleId]),
      committed: clone(clip?.style || null),
      resourceId: module.resourceId,
      resourceReuses: state.resources[module.resourceId]?.reuses || 0,
      timeline: state.clips.map((item) => ({ id: item.id, name: item.name, kind: item.kind, duration: item.duration })),
      capturedAt: Date.now()
    };
    module.snapshot = snapshot;
    module.status = "error";
    module.error = {
      code: "INTERRUPTED_BY_REFRESH",
      message: "上次处理在页面刷新时中断",
      stage: module.stage || "处理中断",
      advice: "参数与资源键已保留。确认设置后点击重试，会复用已分配资源。",
      attempt: module.attempt || 0,
      at: Date.now(),
      snapshot
    };
    state.logs.push({
      id: `log-${Date.now()}-interrupted-${moduleId}`,
      at: Date.now(),
      level: "error",
      module: moduleId,
      stage: "刷新恢复",
      attempt: module.attempt || 0,
      message: "检测到中断的运行态，已转换为可重试的安全快照。",
      resourceId: module.resourceId || null,
      operationKey: module.operationKey || null
    });
  }
  state.view = mergeDefaults(createInitialState().view, state.view);
  state.meta = mergeDefaults(createInitialState().meta, state.meta);
  return state;
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { state: createInitialState(), warning: null };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("存储内容不是对象");
    return { state: normalizeState(mergeDefaults(createInitialState(), parsed)), warning: null };
  } catch (error) {
    const fallback = createInitialState();
    fallback.logs.push({
      id: `log-${Date.now()}-recovery`,
      at: Date.now(),
      level: "error",
      module: "系统",
      stage: "恢复存储",
      message: `本地存储损坏，已使用安全默认工程：${String(error.message || error)}`,
      attempt: 0
    });
    return { state: fallback, warning: "本地存储无法读取，已载入可读安全快照。" };
  }
}

export function persist(state, label = "已自动保存") {
  state.meta.revision += 1;
  state.meta.savedAt = Date.now();
  state.meta.lastAction = label;
  try {
    const serialized = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, serialized);
    state.meta.storageHash = shortHash(serialized);
    state.meta.lastSavedLabel = formatClock(state.meta.savedAt);
    return { ok: true, hash: state.meta.storageHash };
  } catch (error) {
    state.meta.storageHash = "未保存";
    state.meta.lastSavedLabel = "本地存储不可用";
    addLog(state, {
      level: "error",
      module: "系统",
      stage: "本地存储",
      message: `写入失败，内存快照仍可继续编辑：${String(error.message || error)}`
    });
    return { ok: false, hash: null };
  }
}

export function addLog(state, entry) {
  state.logs.push({
    id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    at: Date.now(),
    level: entry.level || "info",
    module: entry.module || "系统",
    stage: entry.stage || "未知阶段",
    attempt: entry.attempt || 0,
    message: entry.message || "",
    resourceId: entry.resourceId || null,
    operationKey: entry.operationKey || null
  });
  if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
}

export function projectSnapshot(state) {
  return clone({
    title: state.title,
    clips: state.clips,
    selectedId: state.selectedId
  });
}

export function recordProjectChange(state, label, mutate) {
  const before = projectSnapshot(state);
  mutate();
  state.history.past.push(before);
  if (state.history.past.length > MAX_HISTORY) state.history.past.shift();
  state.history.future = [];
  state.meta.lastAction = label;
}

function applyProjectSnapshot(state, snapshot) {
  const currentSelection = state.selectedId;
  state.title = snapshot.title;
  state.clips = clone(snapshot.clips);
  if (state.clips.some((clip) => clip.id === currentSelection)) {
    state.selectedId = currentSelection;
  } else if (state.clips.some((clip) => clip.id === snapshot.selectedId)) {
    state.selectedId = snapshot.selectedId;
  } else {
    state.selectedId = state.clips[0]?.id || null;
  }
}

export function undo(state) {
  if (state.history.past.length === 0) return false;
  state.history.future.unshift(projectSnapshot(state));
  applyProjectSnapshot(state, state.history.past.pop());
  state.meta.lastAction = "已撤销上一步工程修改";
  return true;
}

export function redo(state) {
  if (state.history.future.length === 0) return false;
  state.history.past.push(projectSnapshot(state));
  applyProjectSnapshot(state, state.history.future.shift());
  state.meta.lastAction = "已重做工程修改";
  return true;
}

export function ensureResource(state, kind, idempotencyKey, details = {}) {
  const id = `res_${kind}_${shortHash(idempotencyKey)}`;
  const existing = state.resources[id];
  if (existing) {
    existing.reuses = (existing.reuses || 0) + 1;
    existing.lastUsedAt = Date.now();
    return { resource: existing, deduplicated: true };
  }
  const resource = {
    id,
    kind,
    label: details.label || `${kind} resource`,
    idempotencyKey,
    count: 1,
    reuses: 0,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    signature: shortHash(details.payload || idempotencyKey)
  };
  state.resources[id] = resource;
  return { resource, deduplicated: false };
}

export function formatClock(timestamp = Date.now()) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}

export function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const remaining = (total % 60).toFixed(1).padStart(4, "0");
  return `${String(minutes).padStart(2, "0")}:${remaining}`;
}

export function selectedClip(state) {
  return state.clips.find((clip) => clip.id === state.selectedId) || state.clips[0] || null;
}

export function resourceCount(state) {
  return Object.keys(state.resources).length;
}

export function reuseCount(state) {
  return Object.values(state.resources).reduce((sum, resource) => sum + (resource.reuses || 0), 0);
}

export function draftHash(state) {
  return shortHash({
    drafts: state.drafts,
    selectedId: state.selectedId,
    title: state.title
  });
}
