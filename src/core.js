export const APP_VERSION = 4;

const TAU = Math.PI * 2;

export function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

export function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

export function hash2i(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

export function periodicNoise(x, y, period, seed = 0) {
  const px = x * period;
  const py = y * period;
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const tx = smoothstep(px - x0);
  const ty = smoothstep(py - y0);
  const ix0 = mod(x0, period);
  const iy0 = mod(y0, period);
  const ix1 = mod(x0 + 1, period);
  const iy1 = mod(y0 + 1, period);
  const a = hash2i(ix0, iy0, seed);
  const b = hash2i(ix1, iy0, seed);
  const c = hash2i(ix0, iy1, seed);
  const d = hash2i(ix1, iy1, seed);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

export function fbm(x, y, period, seed = 0, octaves = 4) {
  let sum = 0;
  let weight = 0.55;
  let total = 0;
  let p = period;
  for (let i = 0; i < octaves; i += 1) {
    sum += periodicNoise(x, y, p, seed + i * 97) * weight;
    total += weight;
    weight *= 0.5;
    p *= 2;
  }
  return sum / total;
}

export function periodicWorley(x, y, cells, seed = 0) {
  const gx = x * cells;
  const gy = y * cells;
  const baseX = Math.floor(gx);
  const baseY = Math.floor(gy);
  let d1 = 4;
  let d2 = 4;
  let cellX = 0;
  let cellY = 0;
  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      const rawX = baseX + ox;
      const rawY = baseY + oy;
      const wx = mod(rawX, cells);
      const wy = mod(rawY, cells);
      const cx = rawX + 0.18 + hash2i(wx, wy, seed) * 0.64;
      const cy = rawY + 0.18 + hash2i(wx, wy, seed + 31) * 0.64;
      const dx = gx - cx;
      const dy = gy - cy;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < d1) {
        d2 = d1;
        d1 = distance;
        cellX = wx;
        cellY = wy;
      } else if (distance < d2) {
        d2 = distance;
      }
    }
  }
  return { d1, d2, edge: d2 - d1, cellX, cellY };
}

export function periodicSignal(x, y, periodX, periodY, phase = 0) {
  return Math.sin((x * periodX + y * periodY + phase) * TAU);
}

export function hexToRgb(hex) {
  const value = String(hex || "#000000").replace("#", "");
  const full = value.length === 3 ? value.split("").map((part) => part + part).join("") : value;
  const parsed = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(parsed)) return [0, 0, 0];
  return [(parsed >> 16) & 255, (parsed >> 8) & 255, parsed & 255];
}

export function rgbToHex(rgb) {
  return `#${rgb.map((value) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
}

export function mixRgb(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function stableHash(input) {
  let hash = 2166136261;
  const text = typeof input === "string" ? input : canonicalJson(input);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function nearestWrappedPoint(previous, point) {
  return {
    x: point.x + Math.round(previous.x - point.x),
    y: point.y + Math.round(previous.y - point.y)
  };
}

export function sceneDigest(scene) {
  return stableHash({
    version: scene.version,
    layers: scene.layers.map((layer) => layer.type === "brush"
      ? {
          id: layer.id,
          name: layer.name,
          type: layer.type,
          visible: layer.visible,
          opacity: layer.opacity,
          strokes: layer.strokes
        }
      : {
          id: layer.id,
          name: layer.name,
          type: layer.type,
          kind: layer.kind,
          visible: layer.visible,
          opacity: layer.opacity,
          seed: layer.seed,
          params: layer.params,
          palette: layer.palette
        }),
    keyframes: scene.keyframes,
    currentTime: scene.currentTime,
    cursor: scene.cursor,
    view: scene.view,
    brush: scene.brush,
    exportSize: scene.exportSize
  });
}

export function defaultScene() {
  return {
    version: APP_VERSION,
    name: "石灰岩 · 风化面",
    createdAt: "2026-11-16T00:00:00.000Z",
    exportSize: 1024,
    tool: "brush",
    selectedLayerId: "material-stone",
    layers: [
      {
        id: "material-stone",
        name: "石材 · 基底",
        type: "material",
        kind: "stone",
        visible: true,
        opacity: 1,
        seed: 4107,
        params: { scale: 8, contrast: 0.64, grain: 0.35, weather: 0.26 },
        palette: { base: "#9b9589", vein: "#504b43", accent: "#c39b68" }
      },
      {
        id: "brush-surface",
        name: "手工修饰",
        type: "brush",
        visible: true,
        opacity: 1,
        strokes: []
      }
    ],
    keyframes: [
      { id: "keyframe-1", time: 0, label: "沉积面", weather: 0.08, slub: 0.18 },
      { id: "keyframe-2", time: 50, label: "风蚀面", weather: 0.32, slub: 0.28 },
      { id: "keyframe-3", time: 100, label: "深风化", weather: 0.72, slub: 0.42 }
    ],
    currentTime: 50,
    brush: { size: 28, hardness: 0.65, opacity: 0.55, color: "#d8b074" },
    cursor: { u: 0.5, v: 0.5 },
    view: { zoom: 1, rotation: 0, panX: 0, panY: 0, tiling: false, seam: true }
  };
}

export function createMaterialLayer(kind = "stone", scene = defaultScene()) {
  const stone = kind === "stone";
  const token = stableHash(`${kind}-${Date.now()}-${Math.random()}`);
  return {
    id: `material-${kind}-${token.slice(0, 5)}`,
    name: stone ? "石材 · 基底" : "布纹 · 基底",
    type: "material",
    kind,
    visible: true,
    opacity: 1,
    seed: Number.parseInt(token.slice(0, 4), 16) % 9000,
    params: stone
      ? { scale: 8, contrast: 0.64, grain: 0.35, weather: 0.26 }
      : { threads: 44, slub: 0.34, wrinkle: 0.34, contrast: 0.46 },
    palette: stone
      ? { ...scene.layers.find((layer) => layer.kind === "stone")?.palette || { base: "#9b9589", vein: "#504b43", accent: "#c39b68" } }
      : { base: "#77786c", vein: "#373a33", accent: "#c9b89c" }
  };
}

export function createBrushLayer(index = 1) {
  return {
    id: `brush-${stableHash(`brush-${Date.now()}-${index}`)}`,
    name: index > 1 ? `手工修饰 ${index}` : "手工修饰",
    type: "brush",
    visible: true,
    opacity: 1,
    strokes: []
  };
}

export function interpolateKeyframes(keyframes, time) {
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  if (!sorted.length) return { weather: 0.22, slub: 0.24 };
  if (time <= sorted[0].time) return { ...sorted[0] };
  if (time >= sorted.at(-1).time) return { ...sorted.at(-1) };
  const rightIndex = sorted.findIndex((frame) => frame.time >= time);
  const left = sorted[rightIndex - 1];
  const right = sorted[rightIndex];
  const t = (time - left.time) / Math.max(1, right.time - left.time);
  return {
    ...left,
    weather: lerp(left.weather, right.weather, t),
    slub: lerp(left.slub, right.slub, t)
  };
}

export function normalizeScene(input) {
  const base = defaultScene();
  if (!input || typeof input !== "object") return base;
  const scene = { ...base, ...input };
  scene.layers = Array.isArray(input.layers) && input.layers.length
    ? input.layers.map((layer, index) => ({
        id: String(layer.id || `layer-${index}`),
        name: String(layer.name || "未命名图层"),
        type: layer.type === "brush" ? "brush" : "material",
        kind: layer.kind === "fabric" ? "fabric" : "stone",
        visible: layer.visible !== false,
        opacity: clamp(Number(layer.opacity ?? 1), 0, 1),
        seed: Number.isFinite(layer.seed) ? layer.seed : 1000 + index,
        params: { ...(layer.params || {}) },
        palette: { ...(layer.palette || {}) },
        strokes: Array.isArray(layer.strokes)
          ? layer.strokes.map((stroke) => ({
              ...stroke,
              points: Array.isArray(stroke.points) ? stroke.points.map((point) => ({ ...point })) : []
            }))
          : []
      }))
    : base.layers;
  scene.keyframes = Array.isArray(input.keyframes) && input.keyframes.length ? input.keyframes : base.keyframes;
  scene.currentTime = clamp(Number(scene.currentTime ?? 50), 0, 100);
  scene.exportSize = [512, 1024].includes(Number(scene.exportSize)) ? Number(scene.exportSize) : 1024;
  scene.tool = scene.tool === "hand" ? "hand" : "brush";
  scene.brush = { ...base.brush, ...(input.brush || {}) };
  scene.cursor = { ...base.cursor, ...(input.cursor || {}) };
  scene.view = { ...base.view, ...(input.view || {}) };
  scene.selectedLayerId = scene.layers.some((layer) => layer.id === scene.selectedLayerId)
    ? scene.selectedLayerId
    : scene.layers[0].id;
  return scene;
}
