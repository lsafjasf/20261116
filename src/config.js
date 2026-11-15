export const DEFAULT_CONFIG = Object.freeze({
  width: 1024,
  height: 1024,
  cell: 128,
  padding: 8,
});

export const DEFAULT_VIEW = Object.freeze({
  sampler: "nearest",
  zoom: 8,
  showGrid: true,
  guard: 1,
});

export const SHAPE_NAMES = [
  "裂隙叶",
  "潮汐星",
  "回声刃",
  "夜航滴",
  "棱镜花",
  "低语环",
  "残响爪",
  "折光核",
  "月蚀符",
  "浮游体",
  "断层冠",
  "静默刺",
];

export const PALETTE = [
  "#79f2d0",
  "#77b7ff",
  "#c69bff",
  "#ffb36b",
  "#ff7f9f",
  "#d9ef72",
  "#7fe7ff",
  "#ffd36f",
];

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashBytes(bytes) {
  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function hashString(text) {
  return hashBytes(new TextEncoder().encode(text));
}

export function hashCanvas(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  return hashBytes(pixels);
}

export function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[clamp(Math.floor((sorted.length - 1) * ratio), 0, sorted.length - 1)];
}

export function formatHash(hash) {
  return (hash || "--------").slice(0, 8);
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
