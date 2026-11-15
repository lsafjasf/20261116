import { DEFAULT_PARAMS, normalizeParams } from "./vectorizer.js";

export const PROJECT_VERSION = 1;

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeColor(value, fallback = "#17191c") {
  return /^#[0-9a-f]{6}$/i.test(value || "") ? value.toLowerCase() : fallback;
}

export function normalizeKeyframe(input = {}, fallbackTime = 0) {
  return {
    time: clamp(Number.isFinite(Number(input.time)) ? Number(input.time) : fallbackTime, 0, 1),
    x: Number.isFinite(Number(input.x)) ? Number(input.x) : 0,
    y: Number.isFinite(Number(input.y)) ? Number(input.y) : 0,
    scale: Number.isFinite(Number(input.scale)) ? clamp(Number(input.scale), 0.05, 20) : 1,
    rotation: Number.isFinite(Number(input.rotation)) ? Number(input.rotation) : 0,
    opacity: Number.isFinite(Number(input.opacity)) ? clamp(Number(input.opacity), 0, 1) : 1
  };
}

export function normalizeKeyframes(keyframes) {
  const list = Array.isArray(keyframes) && keyframes.length
    ? keyframes.map((keyframe, index) => normalizeKeyframe(keyframe, index === 0 ? 0 : 1))
    : [normalizeKeyframe({ time: 0 }), normalizeKeyframe({ time: 1 })];
  list.sort((a, b) => a.time - b.time);
  if (!list.some((keyframe) => keyframe.time === 0)) list.unshift(normalizeKeyframe({ time: 0 }));
  if (!list.some((keyframe) => keyframe.time === 1)) list.push(normalizeKeyframe({ time: 1 }));
  return list;
}

function normalizePath(path, index) {
  if (!path || typeof path.d !== "string" || !path.d.startsWith("M")) {
    throw new Error(`图层路径 ${index + 1} 缺少有效的 SVG path 数据`);
  }
  const points = Array.isArray(path.points)
    ? path.points
      .filter((point) => Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)))
      .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
    : [];
  return {
    id: String(path.id || `path-${index + 1}`),
    d: path.d,
    points,
    nodeCount: Number.isFinite(Number(path.nodeCount)) ? Number(path.nodeCount) : points.length,
    area: Number.isFinite(Number(path.area)) ? Number(path.area) : 0
  };
}

export function normalizeLayer(layer, index) {
  if (!layer || typeof layer !== "object") throw new Error(`图层 ${index + 1} 数据无效`);
  const normalizedParams = normalizeParams({ ...DEFAULT_PARAMS, ...(layer.params || {}) }).params;
  return {
    id: String(layer.id || `layer-${index + 1}`),
    name: String(layer.name || `图层 ${index + 1}`),
    color: safeColor(layer.color),
    visible: layer.visible !== false,
    locked: Boolean(layer.locked),
    opacity: Number.isFinite(Number(layer.opacity)) ? clamp(Number(layer.opacity), 0, 1) : 1,
    order: Number.isFinite(Number(layer.order)) ? Number(layer.order) : index,
    params: normalizedParams,
    paths: Array.isArray(layer.paths) ? layer.paths.map(normalizePath) : [],
    keyframes: normalizeKeyframes(layer.keyframes),
    source: layer.source ? clone(layer.source) : null
  };
}

export function normalizeProject(input) {
  if (!input || typeof input !== "object") throw new Error("工程数据为空或格式不正确");
  if (!Array.isArray(input.layers)) throw new Error("工程缺少图层列表");
  if (!Number.isFinite(Number(input.width)) || !Number.isFinite(Number(input.height))) {
    throw new Error("工程缺少有效画布尺寸");
  }
  const layers = input.layers
    .map(normalizeLayer)
    .sort((a, b) => a.order - b.order)
    .map((layer, index) => ({ ...layer, order: index }));
  if (!layers.length) throw new Error("工程至少需要保留一个图层");
  const activeLayerId = layers.some((layer) => layer.id === input.activeLayerId)
    ? input.activeLayerId
    : layers[0]?.id || null;
  return {
    version: PROJECT_VERSION,
    id: String(input.id || `project-${Date.now()}`),
    name: String(input.name || "未命名线稿"),
    width: Math.round(Number(input.width)),
    height: Math.round(Number(input.height)),
    sampleId: String(input.sampleId || "crossing-speck-v1"),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
    time: clamp(Number.isFinite(Number(input.time)) ? Number(input.time) : 0, 0, 1),
    layers,
    activeLayerId,
    comparison: input.comparison && typeof input.comparison === "object"
      ? clone(input.comparison)
      : null
  };
}

export function createProjectFromResult(result, sample, options = {}) {
  const now = new Date().toISOString();
  const layer = {
    id: options.layerId || "layer-ink",
    name: options.name || "墨线主体",
    color: options.color || "#17191c",
    visible: true,
    locked: false,
    opacity: 1,
    order: 0,
    params: result.params,
    paths: result.paths.map((path, index) => ({ ...path, id: `ink-${index + 1}` })),
    keyframes: [
      normalizeKeyframe({ time: 0 }),
      normalizeKeyframe({ time: 1 })
    ],
    source: {
      kind: "vectorized-sample",
      sampleId: sample.id,
      signature: result.signature
    }
  };
  return normalizeProject({
    version: PROJECT_VERSION,
    id: options.id || "uid631-crossing-project",
    name: options.projectName || "交叉线稿 · 清理工程",
    width: result.width,
    height: result.height,
    sampleId: sample.id,
    createdAt: now,
    updatedAt: now,
    time: 0,
    layers: [layer],
    activeLayerId: layer.id,
    comparison: null
  });
}

export function layerToVectorResult(layer) {
  return {
    params: { ...layer.params },
    paths: layer.paths,
    nodeCount: layer.paths.reduce((sum, path) => sum + path.nodeCount, 0),
    pathCount: layer.paths.length,
    signature: layer.source?.signature || null
  };
}

export function replaceLayerGeometry(project, layerId, result) {
  const next = clone(project);
  const layer = next.layers.find((item) => item.id === layerId);
  if (!layer) throw new Error("找不到要更新的图层");
  layer.params = { ...result.params };
  layer.paths = result.paths.map((path, index) => ({
    ...clone(path),
    id: `${layerId}-path-${index + 1}`
  }));
  layer.source = {
    ...(layer.source || {}),
    kind: "vectorized-sample",
    signature: result.signature
  };
  next.updatedAt = new Date().toISOString();
  return normalizeProject(next);
}

export function addResultLayer(project, result, options = {}) {
  const next = clone(project);
  const id = options.id || `layer-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
  const layer = normalizeLayer({
    id,
    name: options.name || `结果 ${next.layers.length + 1}`,
    color: options.color || "#17191c",
    visible: options.visible !== false,
    opacity: 1,
    order: next.layers.length,
    params: result.params,
    paths: result.paths.map((path, index) => ({ ...path, id: `${id}-path-${index + 1}` })),
    keyframes: [normalizeKeyframe({ time: 0 }), normalizeKeyframe({ time: 1 })],
    source: {
      kind: "vectorized-sample",
      sampleId: project.sampleId,
      signature: result.signature
    }
  }, next.layers.length);
  next.layers.push(layer);
  next.activeLayerId = id;
  next.updatedAt = new Date().toISOString();
  return normalizeProject(next);
}

export function duplicateLayer(project, layerId) {
  const source = project.layers.find((layer) => layer.id === layerId);
  if (!source) throw new Error("找不到要复制的图层");
  const next = clone(project);
  const id = `layer-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
  const copy = {
    ...clone(source),
    id,
    name: `${source.name} 副本`,
    order: next.layers.length,
    paths: source.paths.map((path, index) => ({ ...clone(path), id: `${id}-path-${index + 1}` }))
  };
  next.layers.push(copy);
  next.activeLayerId = id;
  next.updatedAt = new Date().toISOString();
  return normalizeProject(next);
}

export function moveLayer(project, layerId, direction) {
  const next = clone(project);
  next.layers.sort((a, b) => a.order - b.order);
  const index = next.layers.findIndex((layer) => layer.id === layerId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= next.layers.length) return normalizeProject(next);
  [next.layers[index], next.layers[target]] = [next.layers[target], next.layers[index]];
  next.layers = next.layers.map((layer, order) => ({ ...layer, order }));
  next.updatedAt = new Date().toISOString();
  return normalizeProject(next);
}

export function deleteLayer(project, layerId) {
  if (project.layers.length <= 1) throw new Error("工程至少需要保留一个图层");
  const next = clone(project);
  next.layers = next.layers
    .filter((layer) => layer.id !== layerId)
    .map((layer, order) => ({ ...layer, order }));
  if (next.activeLayerId === layerId) next.activeLayerId = next.layers[0]?.id || null;
  next.updatedAt = new Date().toISOString();
  return normalizeProject(next);
}

export function interpolateKeyframe(layer, time) {
  const keyframes = normalizeKeyframes(layer.keyframes);
  const clampedTime = clamp(time, 0, 1);
  let before = keyframes[0];
  let after = keyframes[keyframes.length - 1];
  for (let index = 1; index < keyframes.length; index += 1) {
    if (keyframes[index].time >= clampedTime) {
      before = keyframes[index - 1];
      after = keyframes[index];
      break;
    }
  }
  if (after.time === before.time) return { ...before };
  const progress = (clampedTime - before.time) / (after.time - before.time);
  const ease = progress * progress * (3 - 2 * progress);
  const blend = (key) => before[key] + (after[key] - before[key]) * ease;
  return {
    time: clampedTime,
    x: blend("x"),
    y: blend("y"),
    scale: blend("scale"),
    rotation: blend("rotation"),
    opacity: blend("opacity")
  };
}

export function upsertKeyframe(project, layerId, time, patch = {}) {
  const next = clone(project);
  const layer = next.layers.find((item) => item.id === layerId);
  if (!layer) throw new Error("找不到图层");
  const normalizedTime = Math.round(clamp(time, 0, 1) * 1000) / 1000;
  let keyframe = layer.keyframes.find((item) => Math.abs(item.time - normalizedTime) < 0.0005);
  if (!keyframe) {
    const current = interpolateKeyframe(layer, normalizedTime);
    keyframe = normalizeKeyframe({ ...current, time: normalizedTime });
    layer.keyframes.push(keyframe);
  }
  Object.assign(keyframe, normalizeKeyframe({ ...keyframe, ...patch, time: keyframe.time }));
  layer.keyframes.sort((a, b) => a.time - b.time);
  next.updatedAt = new Date().toISOString();
  return normalizeProject(next);
}

export function serializeProject(project) {
  return JSON.stringify(normalizeProject(project), null, 2);
}

export function deserializeProject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`工程 JSON 解析失败：${error.message}`);
  }
  return normalizeProject(parsed);
}

export function projectFingerprint(project) {
  return JSON.stringify({
    layers: project.layers.map((layer) => ({
      id: layer.id,
      order: layer.order,
      color: layer.color,
      keyframes: layer.keyframes,
      paths: layer.paths.map((path) => path.d)
    }))
  });
}
