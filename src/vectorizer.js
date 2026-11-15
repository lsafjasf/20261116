const ALGORITHM_VERSION = "inktrace-v13";

export const PARAM_BOUNDS = Object.freeze({
  threshold: { min: 8, max: 235, step: 1 },
  smoothing: { min: 0, max: 100, step: 1 },
  merge: { min: 0, max: 16, step: 0.5 },
  minRegion: { min: 0, max: 240, step: 1 }
});

export const DEFAULT_PARAMS = Object.freeze({
  threshold: 172,
  smoothing: 46,
  merge: 3,
  minRegion: 28
});

export const PARAM_PRESETS = Object.freeze({
  default: {
    name: "默认参数",
    description: "兼顾细线与噪点清理的日常设置。",
    params: DEFAULT_PARAMS
  },
  boundary: {
    name: "边界参数",
    description: "所有参数处于允许范围边缘；细线保护仍必须生效。",
    params: { threshold: 235, smoothing: 100, merge: 16, minRegion: 240 }
  },
  exception: {
    name: "异常参数",
    description: "故意越界；钳制后仍应生成可恢复结果并明确提示。",
    params: { threshold: 999, smoothing: -30, merge: 99, minRegion: 100000 }
  }
});

const PARAM_LABELS = {
  threshold: "阈值",
  smoothing: "平滑度",
  merge: "节点合并",
  minRegion: "最小区域"
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finiteNumber(value, fallback) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeParams(input = {}) {
  const warnings = [];
  const params = {};
  for (const [key, bounds] of Object.entries(PARAM_BOUNDS)) {
    const raw = input[key];
    const fallback = DEFAULT_PARAMS[key];
    const numeric = finiteNumber(raw, fallback);
    const value = clamp(numeric, bounds.min, bounds.max);
    const rounded = bounds.step < 1 ? Math.round(value * 2) / 2 : Math.round(value);
    params[key] = rounded;
    if (raw === undefined || raw === null || raw === "") {
      if (input !== DEFAULT_PARAMS) {
        warnings.push(`${PARAM_LABELS[key]} 缺失，已使用默认值 ${fallback}`);
      }
    } else if (numeric !== rounded) {
      warnings.push(`${PARAM_LABELS[key]} 超出范围 [${bounds.min}, ${bounds.max}]，已钳制为 ${rounded}`);
    }
  }
  return { params, warnings };
}

export function buildSignature(sample, params, options = {}) {
  const sampleId = options.sampleId || sample?.id || "custom";
  return [
    ALGORITHM_VERSION,
    sampleId,
    params.threshold,
    params.smoothing,
    params.merge,
    params.minRegion
  ].join(":");
}

function componentStats(width, height, safeMask) {
  const size = safeMask.length;
  const seen = new Uint8Array(size);
  const queue = new Int32Array(size);
  const components = [];
  for (let start = 0; start < size; start += 1) {
    if (!safeMask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    const pixels = [];
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = (index / width) | 0;
      pixels.push(index);
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x + 1 < width ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y + 1 < height ? index + width : -1
      ];
      for (const next of neighbors) {
        if (next >= 0 && safeMask[next] && !seen[next]) {
          seen[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    components.push({ pixels, area, minX, minY, maxX, maxY });
  }
  return components;
}

function isLineLike(component) {
  const spanX = component.maxX - component.minX + 1;
  const spanY = component.maxY - component.minY + 1;
  const span = Math.max(spanX, spanY);
  const minorSpan = Math.min(spanX, spanY);
  const fill = component.area / (spanX * spanY);
  return span >= 11 && component.area >= 6 && (minorSpan <= 3.5 || fill <= 0.3);
}

function buildMask(sample, params) {
  const { width, height, gray } = sample;
  const coreMask = new Uint8Array(gray.length);
  const safeMask = new Uint8Array(gray.length);
  const guardThreshold = clamp(Math.max(params.threshold, 208), 0, 238);
  for (let index = 0; index < gray.length; index += 1) {
    const value = gray[index];
    coreMask[index] = value <= params.threshold ? 1 : 0;
    safeMask[index] = value <= guardThreshold ? 1 : 0;
  }

  const components = componentStats(width, height, safeMask);
  const keep = new Uint8Array(gray.length);
  const decisions = [];
  let filteredComponents = 0;
  for (const component of components) {
    let coreArea = 0;
    for (const index of component.pixels) coreArea += coreMask[index];
    const lineLike = isLineLike(component);
    const largeEnough = component.area >= params.minRegion;
    const keepComponent = params.minRegion <= 1 || largeEnough || lineLike;
    decisions.push({
      area: component.area,
      coreArea,
      lineLike,
      kept: keepComponent
    });
    if (keepComponent) {
      for (const index of component.pixels) keep[index] = 1;
    } else {
      filteredComponents += 1;
    }
  }

  let fallbackApplied = false;
  let keptPixels = 0;
  for (let index = 0; index < keep.length; index += 1) keptPixels += keep[index];
  if (keptPixels === 0 && components.length > 0) {
    const strongest = [...components].sort((a, b) => {
      if (b.area !== a.area) return b.area - a.area;
      return a.minY - b.minY || a.minX - b.minX;
    })[0];
    for (const index of strongest.pixels) keep[index] = 1;
    keptPixels = strongest.area;
    fallbackApplied = true;
  }

  return {
    mask: keep,
    coreMask,
    safeMask,
    guardThreshold,
    filteredComponents,
    componentCount: components.length,
    fallbackApplied,
    decisions
  };
}

export function buildMaskForInspection(sample, paramsInput = DEFAULT_PARAMS) {
  const { params, warnings } = normalizeParams(paramsInput);
  const result = buildMask(sample, params);
  return { ...result, params, warnings };
}

function addEdge(edges, outgoing, startKey, endKey, startX, startY, endX, endY) {
  const edge = edges.length;
  edges.push({ startKey, endKey, startX, startY, endX, endY });
  const list = outgoing.get(startKey);
  if (list) list.push(edge);
  else outgoing.set(startKey, [edge]);
}

function collectBoundaryEdges(mask, width, height) {
  const edges = [];
  const outgoing = new Map();
  const rowStride = width + 1;
  const keyOf = (x, y) => y * rowStride + x;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) continue;
      if (y === 0 || !mask[index - width]) {
        addEdge(edges, outgoing, keyOf(x, y), keyOf(x + 1, y), x, y, x + 1, y);
      }
      if (x === width - 1 || !mask[index + 1]) {
        addEdge(edges, outgoing, keyOf(x + 1, y), keyOf(x + 1, y + 1), x + 1, y, x + 1, y + 1);
      }
      if (y === height - 1 || !mask[index + width]) {
        addEdge(edges, outgoing, keyOf(x + 1, y + 1), keyOf(x, y + 1), x + 1, y + 1, x, y + 1);
      }
      if (x === 0 || !mask[index - 1]) {
        addEdge(edges, outgoing, keyOf(x, y + 1), keyOf(x, y), x, y + 1, x, y);
      }
    }
  }
  return { edges, outgoing };
}

function direction(startX, startY, endX, endY) {
  if (endX > startX) return 0;
  if (endY > startY) return 1;
  if (endX < startX) return 2;
  return 3;
}

function chooseNextEdge(edges, candidates, previousEdge, used) {
  const available = candidates.filter((edgeIndex) => !used[edgeIndex]);
  if (available.length <= 1) return available[0] ?? -1;
  const incoming = direction(
    previousEdge.startX,
    previousEdge.startY,
    previousEdge.endX,
    previousEdge.endY
  );
  let best = available[0];
  let bestTurn = 5;
  for (const edgeIndex of available) {
    const edge = edges[edgeIndex];
    const outgoingDirection = direction(edge.startX, edge.startY, edge.endX, edge.endY);
    const turn = (outgoingDirection - incoming + 4) % 4;
    if (turn < bestTurn) {
      best = edgeIndex;
      bestTurn = turn;
    }
  }
  return best;
}

function traceLoops(mask, width, height) {
  const { edges, outgoing } = collectBoundaryEdges(mask, width, height);
  const used = new Uint8Array(edges.length);
  const loops = [];
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    if (used[edgeIndex]) continue;
    const startEdge = edges[edgeIndex];
    const points = [{ x: startEdge.startX, y: startEdge.startY }];
    let currentIndex = edgeIndex;
    let currentEdge = startEdge;
    let guard = 0;
    while (guard <= edges.length + 2) {
      guard += 1;
      if (used[currentIndex]) break;
      used[currentIndex] = 1;
      points.push({ x: currentEdge.endX, y: currentEdge.endY });
      if (currentEdge.endKey === startEdge.startKey) break;
      const candidates = outgoing.get(currentEdge.endKey) || [];
      const next = chooseNextEdge(edges, candidates, currentEdge, used);
      if (next < 0) break;
      currentIndex = next;
      currentEdge = edges[currentIndex];
    }
    if (points.length > 4) {
      const last = points[points.length - 1];
      const first = points[0];
      if (last.x === first.x && last.y === first.y) points.pop();
      loops.push(points);
    }
  }
  return loops;
}

function squaredSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  }
  const t = clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy),
    0,
    1
  );
  const x = start.x + t * dx;
  const y = start.y + t * dy;
  return (point.x - x) ** 2 + (point.y - y) ** 2;
}

function simplifyOpen(points, toleranceSq, firstIndex, lastIndex, keep) {
  if (lastIndex <= firstIndex + 1) return;
  let maxDistance = -1;
  let split = -1;
  for (let index = firstIndex + 1; index < lastIndex; index += 1) {
    const distance = squaredSegmentDistance(
      points[index],
      points[firstIndex],
      points[lastIndex]
    );
    if (distance > maxDistance) {
      maxDistance = distance;
      split = index;
    }
  }
  if (maxDistance > toleranceSq) {
    keep[split] = 1;
    simplifyOpen(points, toleranceSq, firstIndex, split, keep);
    simplifyOpen(points, toleranceSq, split, lastIndex, keep);
  }
}

function simplifyClosed(points, tolerance) {
  if (points.length <= 3) return points;
  let farthest = 0;
  let maxDistance = -1;
  for (let index = 1; index < points.length; index += 1) {
    const distance = (points[index].x - points[0].x) ** 2 + (points[index].y - points[0].y) ** 2;
    if (distance > maxDistance) {
      maxDistance = distance;
      farthest = index;
    }
  }
  const extended = [...points, points[0]];
  const keep = new Uint8Array(extended.length);
  keep[0] = 1;
  keep[farthest] = 1;
  keep[extended.length - 1] = 1;
  const toleranceSq = tolerance * tolerance;
  simplifyOpen(extended, toleranceSq, 0, farthest, keep);
  simplifyOpen(extended, toleranceSq, farthest, extended.length - 1, keep);
  const simplified = [];
  for (let index = 0; index < points.length; index += 1) {
    if (keep[index]) simplified.push(points[index]);
  }
  return simplified.length >= 3 ? simplified : points;
}

function smoothLoopPoints(points, smoothing) {
  if (smoothing <= 0 || points.length < 4) return points;
  const sigma = 0.2 + (smoothing / 100) * 2.0;
  const radius = Math.max(1, Math.ceil(sigma * 2.4));
  const weights = [];
  let weightSum = 0;
  for (let offset = -radius; offset <= radius; offset += 1) {
    const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
    weights.push(weight);
    weightSum += weight;
  }
  return points.map((_, index) => {
    let x = 0;
    let y = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const point = points[(index + offset + points.length) % points.length];
      const weight = weights[offset + radius] / weightSum;
      x += point.x * weight;
      y += point.y * weight;
    }
    return { x, y };
  });
}

function polygonArea(points) {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

function signedPolygonArea(points) {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return twiceArea / 2;
}

function loopBounds(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const intersects = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y))
        / (previousPoint.y - currentPoint.y || Number.EPSILON)
        + currentPoint.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function boundsContain(outer, inner) {
  return outer.minX <= inner.minX + 0.01
    && outer.minY <= inner.minY + 0.01
    && outer.maxX >= inner.maxX - 0.01
    && outer.maxY >= inner.maxY - 0.01;
}

function groupNestedLoops(loops) {
  const infos = loops.map((points, index) => {
    const bounds = loopBounds(points);
    return {
      index,
      points,
      bounds,
      area: Math.abs(signedPolygonArea(points)),
      parent: null
    };
  }).filter((info) => info.area >= 1.2);
  infos.sort((a, b) => b.area - a.area);
  for (let index = 0; index < infos.length; index += 1) {
    const info = infos[index];
    let parent = null;
    for (let candidateIndex = 0; candidateIndex < index; candidateIndex += 1) {
      const candidate = infos[candidateIndex];
      if (!boundsContain(candidate.bounds, info.bounds)) continue;
      if (!pointInPolygon(info.points[0], candidate.points)) continue;
      if (!parent || candidate.area < parent.area) parent = candidate;
    }
    info.parent = parent;
  }
  const rootOf = (info) => {
    let current = info;
    while (current.parent) current = current.parent;
    return current;
  };
  const groups = new Map();
  for (const info of infos) {
    const root = rootOf(info);
    const group = groups.get(root) || [];
    group.push(info);
    groups.set(root, group);
  }
  return [...groups.entries()]
    .map(([root, members]) => ({ root, members }))
    .sort((a, b) => b.root.area - a.root.area);
}

function formatNumber(value) {
  const rounded = round(value, 2);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function smoothPath(points, smoothing) {
  if (points.length < 3) return "";
  if (smoothing <= 0) {
    return `M${formatNumber(points[0].x)} ${formatNumber(points[0].y)}${points
      .slice(1)
      .map((point) => `L${formatNumber(point.x)} ${formatNumber(point.y)}`)
      .join("")}Z`;
  }
  const amount = (smoothing / 100) * 0.45;
  const before = (index) => {
    const current = points[index];
    const previous = points[(index - 1 + points.length) % points.length];
    return {
      x: current.x + (previous.x - current.x) * amount,
      y: current.y + (previous.y - current.y) * amount
    };
  };
  const after = (index) => {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    return {
      x: current.x + (next.x - current.x) * amount,
      y: current.y + (next.y - current.y) * amount
    };
  };
  const start = after(points.length - 1);
  const commands = [`M${formatNumber(start.x)} ${formatNumber(start.y)}`];
  for (let index = 0; index < points.length; index += 1) {
    const entry = before(index);
    const control = points[index];
    const exit = after(index);
    commands.push(`L${formatNumber(entry.x)} ${formatNumber(entry.y)}`);
    commands.push(`Q${formatNumber(control.x)} ${formatNumber(control.y)} ${formatNumber(exit.x)} ${formatNumber(exit.y)}`);
  }
  commands.push("Z");
  return commands.join("");
}

function roundPoint(point) {
  return { x: round(point.x, 2), y: round(point.y, 2) };
}

function rasterizeLoops(loops, width, height) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const scanY = y + 0.5;
    const intersections = [];
    for (const loop of loops) {
      for (let index = 0; index < loop.length; index += 1) {
        const start = loop[index];
        const end = loop[(index + 1) % loop.length];
        if ((start.y > scanY) === (end.y > scanY)) continue;
        const x = start.x + ((scanY - start.y) * (end.x - start.x)) / (end.y - start.y);
        intersections.push(x);
      }
    }
    intersections.sort((a, b) => a - b);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const from = Math.max(0, Math.ceil(intersections[index] - 0.5));
      const to = Math.min(width - 1, Math.ceil(intersections[index + 1] - 0.5) - 1);
      for (let x = from; x <= to; x += 1) mask[y * width + x] = 1;
    }
  }
  return mask;
}

function measureMetrics(sample, outputMask, vectorMask) {
  let referenceCount = 0;
  let referenceCovered = 0;
  let referenceCoveredByMask = 0;
  let thinCount = 0;
  let thinCovered = 0;
  let speckCount = 0;
  let speckRemaining = 0;
  let inkPixels = 0;
  let vectorPixels = 0;
  for (let index = 0; index < outputMask.length; index += 1) {
    const output = outputMask[index];
    const vector = vectorMask[index];
    inkPixels += output;
    vectorPixels += vector;
    if (sample.referenceMask?.[index]) {
      referenceCount += 1;
      referenceCovered += vector;
      referenceCoveredByMask += output;
    }
    if (sample.thinLineMask?.[index]) {
      thinCount += 1;
      thinCovered += vector;
    }
    if (sample.speckMask?.[index]) {
      speckCount += 1;
      speckRemaining += vector;
    }
  }
  return {
    completeness: referenceCount ? round((referenceCovered / referenceCount) * 100, 2) : 100,
    maskCompleteness: referenceCount ? round((referenceCoveredByMask / referenceCount) * 100, 2) : 100,
    thinLineCoverage: thinCount ? round((thinCovered / thinCount) * 100, 2) : 100,
    noiseRemoved: speckCount ? round((1 - speckRemaining / speckCount) * 100, 2) : 100,
    inkPixels,
    vectorPixels,
    referencePixels: referenceCount,
    thinPixels: thinCount,
    speckPixels: speckCount
  };
}

export function vectorizeSample(sample, paramsInput = DEFAULT_PARAMS) {
  const normalized = normalizeParams(paramsInput);
  const params = normalized.params;
  const maskResult = buildMask(sample, params);
  const loops = traceLoops(maskResult.mask, sample.width, sample.height);
  const mergeProgress = params.merge / PARAM_BOUNDS.merge.max;
  const tolerance = 0.08 + (mergeProgress ** 0.75) * 0.42;
  const simplifiedLoops = [];
  for (const loop of loops) {
    const area = polygonArea(loop);
    if (area < 1.2) continue;
    const smoothed = smoothLoopPoints(loop, params.smoothing);
    const simplified = simplifyClosed(smoothed, tolerance).map(roundPoint);
    if (simplified.length < 3) continue;
    simplifiedLoops.push(simplified);
  }
  const groups = groupNestedLoops(simplifiedLoops);
  const paths = [];
  for (const group of groups) {
    const d = group.members
      .map((member) => smoothPath(member.points, params.smoothing))
      .filter(Boolean)
      .join("");
    if (!d) continue;
    const points = group.members.flatMap((member) => member.points);
    const nodeCount = points.length;
    paths.push({
      d,
      points,
      nodeCount,
      area: round(group.root.area, 2)
    });
  }
  paths.sort((a, b) => b.area - a.area);
  const vectorMask = rasterizeLoops(simplifiedLoops, sample.width, sample.height);
  const metrics = measureMetrics(sample, maskResult.mask, vectorMask);
  const warnings = [...normalized.warnings];
  if (maskResult.fallbackApplied) {
    warnings.push("最小区域过滤后结果为空，已自动保留最大结构组件");
  }
  return {
    version: ALGORITHM_VERSION,
    signature: buildSignature(sample, params),
    params,
    width: sample.width,
    height: sample.height,
    paths,
    nodeCount: paths.reduce((sum, path) => sum + path.nodeCount, 0),
    pathCount: paths.length,
    componentCount: maskResult.componentCount,
    filteredComponents: maskResult.filteredComponents,
    guardThreshold: maskResult.guardThreshold,
    fallbackApplied: maskResult.fallbackApplied,
    warnings,
    metrics,
    outputMask: maskResult.mask,
    vectorMask
  };
}

export function resultWithoutMask(result) {
  const { outputMask, vectorMask, ...rest } = result;
  void outputMask;
  void vectorMask;
  return rest;
}

export function rasterizeMask(sample, mask) {
  const rgba = new Uint8ClampedArray(sample.width * sample.height * 4);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4;
    const value = mask[index] ? 24 : 255;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  return rgba;
}

export { simplifyClosed, polygonArea, ALGORITHM_VERSION };
