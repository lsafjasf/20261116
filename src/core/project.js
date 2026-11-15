export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_STORAGE_KEY = "frame-lock.project.v1";
export const SNAPSHOT_STORAGE_KEY = "frame-lock.snapshots.v1";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function deepClone(value) {
  return structuredClone(value);
}

export function createDefaultProject() {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "neon-orbit",
    name: "霓虹轨道 / Neon Orbit",
    durationMs: 120_000,
    fps: 30,
    canvas: {
      width: 960,
      height: 540,
      background: "#07101f",
    },
    layers: [
      {
        id: "backplate",
        name: "深空底板",
        shape: "rect",
        visible: true,
        x: 0,
        y: 0,
        width: 960,
        height: 540,
        rotation: 0,
        opacity: 1,
        color: "#0a1a30",
        keyframes: [
          { timeMs: 0, x: 0, y: 0, width: 960, height: 540, rotation: 0, opacity: 1, color: "#0a1a30" },
          { timeMs: 120_000, x: 0, y: 0, width: 960, height: 540, rotation: 0, opacity: 1, color: "#12314b" },
        ],
      },
      {
        id: "orbit-ring",
        name: "轨道环",
        shape: "ring",
        visible: true,
        x: 284,
        y: 90,
        width: 392,
        height: 392,
        rotation: 0,
        opacity: 0.9,
        color: "#41d9c7",
        keyframes: [
          { timeMs: 0, x: 284, y: 90, width: 392, height: 392, rotation: -12, opacity: 0.75, color: "#41d9c7" },
          { timeMs: 40_000, x: 304, y: 70, width: 352, height: 352, rotation: 18, opacity: 1, color: "#63e6a7" },
          { timeMs: 80_000, x: 284, y: 90, width: 392, height: 392, rotation: 42, opacity: 0.85, color: "#41d9c7" },
          { timeMs: 120_000, x: 284, y: 90, width: 392, height: 392, rotation: 348, opacity: 0.75, color: "#41d9c7" },
        ],
      },
      {
        id: "sun",
        name: "主星",
        shape: "ellipse",
        visible: true,
        x: 385,
        y: 191,
        width: 190,
        height: 190,
        rotation: 0,
        opacity: 1,
        color: "#ffb454",
        keyframes: [
          { timeMs: 0, x: 385, y: 191, width: 190, height: 190, rotation: 0, opacity: 1, color: "#ffb454" },
          { timeMs: 60_000, x: 398, y: 164, width: 164, height: 164, rotation: 24, opacity: 0.86, color: "#ff7a59" },
          { timeMs: 120_000, x: 385, y: 191, width: 190, height: 190, rotation: 0, opacity: 1, color: "#ffb454" },
        ],
      },
      {
        id: "satellite",
        name: "卫星",
        shape: "ellipse",
        visible: true,
        x: 760,
        y: 104,
        width: 76,
        height: 76,
        rotation: 0,
        opacity: 1,
        color: "#f4f1de",
        keyframes: [
          { timeMs: 0, x: 760, y: 104, width: 76, height: 76, rotation: 0, opacity: 1, color: "#f4f1de" },
          { timeMs: 30_000, x: 641, y: 74, width: 66, height: 66, rotation: 90, opacity: 0.92, color: "#d8f3dc" },
          { timeMs: 60_000, x: 494, y: 108, width: 76, height: 76, rotation: 180, opacity: 1, color: "#f4f1de" },
          { timeMs: 90_000, x: 647, y: 370, width: 66, height: 66, rotation: 270, opacity: 0.92, color: "#d8f3dc" },
          { timeMs: 120_000, x: 760, y: 104, width: 76, height: 76, rotation: 360, opacity: 1, color: "#f4f1de" },
        ],
      },
      {
        id: "caption",
        name: "时间字幕",
        shape: "caption",
        visible: true,
        x: 54,
        y: 442,
        width: 420,
        height: 54,
        rotation: 0,
        opacity: 1,
        color: "#9bc1d9",
        keyframes: [
          { timeMs: 0, x: 54, y: 442, width: 420, height: 54, rotation: 0, opacity: 1, color: "#9bc1d9" },
          { timeMs: 120_000, x: 54, y: 442, width: 420, height: 54, rotation: 0, opacity: 1, color: "#9bc1d9" },
        ],
      },
    ],
  };
}

export function validateProject(project) {
  if (!project || typeof project !== "object") {
    throw new TypeError("project must be an object");
  }
  if (project.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new RangeError(`unsupported project schema: ${project.schemaVersion}`);
  }
  if (!Number.isFinite(project.durationMs) || project.durationMs <= 0) {
    throw new RangeError("project duration must be greater than zero");
  }
  if (!Number.isInteger(project.fps) || project.fps < 1 || project.fps > 240) {
    throw new RangeError("project fps is out of range");
  }
  if (!project.canvas || !Number.isInteger(project.canvas.width) || !Number.isInteger(project.canvas.height)) {
    throw new RangeError("project canvas is invalid");
  }
  if (!HEX_COLOR.test(project.canvas.background)) {
    throw new RangeError("project background color is invalid");
  }
  if (!Array.isArray(project.layers) || project.layers.length === 0) {
    throw new RangeError("project must contain at least one layer");
  }
  const ids = new Set();
  for (const layer of project.layers) {
    if (!layer.id || ids.has(layer.id)) throw new Error("layer ids must be unique");
    ids.add(layer.id);
    if (!HEX_COLOR.test(layer.color)) throw new RangeError(`invalid layer color: ${layer.id}`);
    if (!["rect", "ellipse", "ring", "caption"].includes(layer.shape)) {
      throw new RangeError(`invalid layer shape: ${layer.id}`);
    }
    if (!Array.isArray(layer.keyframes)) throw new TypeError(`layer keyframes must be an array: ${layer.id}`);
    for (const keyframe of layer.keyframes) {
      if (!Number.isFinite(keyframe.timeMs) || keyframe.timeMs < 0 || keyframe.timeMs > project.durationMs) {
        throw new RangeError(`keyframe time is out of range: ${layer.id}`);
      }
      if (!HEX_COLOR.test(keyframe.color)) throw new RangeError(`invalid keyframe color: ${layer.id}`);
    }
  }
  return project;
}

export function normalizeProject(project) {
  const clone = deepClone(project);
  for (const layer of clone.layers) {
    layer.keyframes.sort((a, b) => a.timeMs - b.timeMs);
  }
  return validateProject(clone);
}

export function loadProject(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(PROJECT_STORAGE_KEY);
    return raw ? normalizeProject(JSON.parse(raw)) : createDefaultProject();
  } catch {
    return createDefaultProject();
  }
}

export function saveProject(project, storage = globalThis.localStorage) {
  storage?.setItem(PROJECT_STORAGE_KEY, JSON.stringify(project));
}

export function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

export function mixColor(from, to, amount) {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const channel = (left, right) =>
    Math.round(left + (right - left) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(a.r, b.r)}${channel(a.g, b.g)}${channel(a.b, b.b)}`;
}

const NUMERIC_FIELDS = ["x", "y", "width", "height", "rotation", "opacity"];

export function interpolateLayer(layer, timeMs) {
  const keys = layer.keyframes;
  if (!keys?.length) {
    return {
      x: layer.x,
      y: layer.y,
      width: layer.width,
      height: layer.height,
      rotation: layer.rotation,
      opacity: layer.opacity,
      color: layer.color,
    };
  }
  if (timeMs <= keys[0].timeMs) return { ...keys[0] };
  if (timeMs >= keys[keys.length - 1].timeMs) return { ...keys[keys.length - 1] };

  let rightIndex = keys.findIndex((keyframe) => keyframe.timeMs >= timeMs);
  if (rightIndex < 0) rightIndex = keys.length - 1;
  const left = keys[rightIndex - 1];
  const right = keys[rightIndex];
  const span = Math.max(1, right.timeMs - left.timeMs);
  const amount = Math.min(1, Math.max(0, (timeMs - left.timeMs) / span));
  const state = {};
  for (const field of NUMERIC_FIELDS) {
    state[field] = left[field] + (right[field] - left[field]) * amount;
  }
  state.color = mixColor(left.color, right.color, amount);
  return state;
}

export function upsertKeyframe(project, layerId, timeMs, patch) {
  const next = deepClone(project);
  const layer = next.layers.find((item) => item.id === layerId);
  if (!layer) throw new Error(`layer not found: ${layerId}`);
  const state = { ...interpolateLayer(layer, timeMs), ...patch };
  for (const field of NUMERIC_FIELDS) {
    layer[field] = state[field];
  }
  layer.color = state.color;
  const existing = layer.keyframes.find((keyframe) => Math.abs(keyframe.timeMs - timeMs) < 0.5);
  if (existing) {
    Object.assign(existing, { ...state, timeMs });
  } else {
    layer.keyframes.push({ ...state, timeMs });
    layer.keyframes.sort((a, b) => a.timeMs - b.timeMs);
  }
  return normalizeProject(next);
}

export function reorderLayer(project, layerId, direction) {
  const next = deepClone(project);
  const index = next.layers.findIndex((layer) => layer.id === layerId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= next.layers.length) return next;
  [next.layers[index], next.layers[target]] = [next.layers[target], next.layers[index]];
  return next;
}

export function createSnapshot(project, ui, reason = "before-export") {
  return {
    schemaVersion: 1,
    reason,
    createdAt: new Date().toISOString(),
    project: deepClone(project),
    ui: deepClone(ui),
    fingerprint: projectFingerprint(project),
  };
}

export function projectFingerprint(project) {
  const text = JSON.stringify(project);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function persistSnapshot(snapshot, storage = globalThis.localStorage, limit = 10) {
  let snapshots = [];
  try {
    snapshots = JSON.parse(storage?.getItem(SNAPSHOT_STORAGE_KEY) || "[]");
  } catch {
    snapshots = [];
  }
  snapshots.unshift(snapshot);
  storage?.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshots.slice(0, limit)));
  return snapshot;
}
