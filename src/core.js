export const LAYER_ORDER = Object.freeze([
  "background",
  "grid",
  "axes",
  "area",
  "line",
  "scatter",
  "annotations",
  "header",
  "legend"
]);

export const PALETTE = Object.freeze([
  "#2367d1",
  "#e1773d",
  "#16836f",
  "#8d59c7",
  "#c84069",
  "#8c6b36",
  "#4d7d9b",
  "#a34d8b"
]);

export const DEFAULT_SPEC = Object.freeze({
  width: 960,
  height: 520,
  padding: 24,
  title: "未命名图表",
  subtitle: "",
  xLabel: "",
  yLabel: "",
  xAxis: { type: "linear", tickCount: 7 },
  yAxis: { type: "linear", tickCount: 6 },
  series: [],
  background: "#ffffff",
  fontFamily: "'AtlasNoto', 'Noto Sans SC', system-ui, sans-serif",
  fontSize: 12,
  exportScale: 2,
  layerOrder: LAYER_ORDER
});

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

export function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function estimateTextWidth(text, fontSize = 12, weight = 500) {
  const source = String(text ?? "");
  let width = 0;
  for (const char of source) {
    const code = char.codePointAt(0);
    if (code >= 0x2e80) width += 1;
    else if (/[MW@%]/.test(char)) width += 0.9;
    else if (/[ilI.,:;'|!]/.test(char)) width += 0.31;
    else if (/\s/.test(char)) width += 0.34;
    else if (/[0-9]/.test(char)) width += 0.59;
    else if (/[A-Z]/.test(char)) width += 0.68;
    else width += 0.56;
  }
  const weightFactor = weight >= 650 ? 1.08 : weight <= 450 ? 0.98 : 1;
  return Math.ceil(width * fontSize * weightFactor);
}

export function fitText(text, maxWidth, fontSize = 12, weight = 500) {
  const source = String(text ?? "");
  if (estimateTextWidth(source, fontSize, weight) <= maxWidth) return source;
  const ellipsis = "…";
  const chars = [...source];
  while (chars.length > 0) {
    const candidate = `${chars.join("")}${ellipsis}`;
    if (estimateTextWidth(candidate, fontSize, weight) <= maxWidth) return candidate;
    chars.pop();
  }
  return ellipsis;
}

export function textBox(text, centerX, centerY, options = {}) {
  const fontSize = options.fontSize ?? 12;
  const weight = options.weight ?? 500;
  const anchor = options.anchor ?? "middle";
  const width = estimateTextWidth(text, fontSize, weight) + (options.padX ?? 0) * 2;
  const height = fontSize * 1.22 + (options.padY ?? 0) * 2;
  let left = centerX - width / 2;
  if (anchor === "start") left = centerX;
  if (anchor === "end") left = centerX - width;
  return {
    x: left,
    y: centerY - height / 2,
    width,
    height,
    cx: left + width / 2,
    cy: centerY
  };
}

export function boxesOverlap(a, b, gap = 0) {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  );
}

export function boxesAreClear(candidate, boxes, gap = 2) {
  return boxes.every((box) => !boxesOverlap(candidate, box, gap));
}

export function formatTick(value, axisType = "linear") {
  if (!isFiniteNumber(value)) return "";
  const absolute = Math.abs(value);
  if (axisType === "log") {
    if (absolute >= 1e9) return `${round(value / 1e9, 2)}G`;
    if (absolute >= 1e6) return `${round(value / 1e6, 2)}M`;
    if (absolute >= 1e3) return `${round(value / 1e3, 2)}k`;
    if (absolute >= 1) return String(round(value, 2));
    return String(round(value, 4));
  }
  if (absolute >= 1e7) return `${round(value / 1e6, 1)}e6`;
  if (absolute >= 1e5) return `${round(value / 1e3, 0)}k`;
  if (absolute >= 1e3) return `${round(value / 1e3, 1)}k`;
  if (absolute > 0 && absolute < 0.01) return value.toExponential(1);
  if (absolute > 0 && absolute < 0.1) return String(round(value, 3));
  if (absolute > 0 && absolute < 1) return String(round(value, 2));
  return String(round(value, 2));
}

function sanitizeColor(value, index) {
  return typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value)
    ? value
    : PALETTE[index % PALETTE.length];
}

function normalizeDomain(input, type, warnings, axisName) {
  if (!Array.isArray(input) || input.length !== 2) return null;
  let [min, max] = input;
  if (!isFiniteNumber(min) || !isFiniteNumber(max) || min >= max) {
    warnings.push(`${axisName} 轴显式范围无效，已改为自动范围`);
    return null;
  }
  if (type === "log" && (min <= 0 || max <= 0)) {
    warnings.push(`${axisName} 轴对数范围必须大于 0，已改为自动范围`);
    return null;
  }
  return [min, max];
}

function normalizeAxis(input, fallback, axisName, warnings) {
  const raw = input && typeof input === "object" ? input : {};
  const type = raw.type === "log" ? "log" : raw.type === "linear" ? "linear" : fallback.type;
  if (raw.type && raw.type !== type) warnings.push(`${axisName} 轴类型无效，已使用线性轴`);
  return {
    type,
    tickCount: clamp(Math.round(Number(raw.tickCount) || fallback.tickCount), 2, 16),
    domain: normalizeDomain(raw.domain, type, warnings, axisName),
    label: typeof raw.label === "string" ? raw.label : ""
  };
}

function normalizeSeries(raw, index, axes, warnings) {
  const source = raw && typeof raw === "object" ? raw : {};
  const type = ["line", "area", "scatter"].includes(source.type) ? source.type : "line";
  if (source.type && source.type !== type) {
    warnings.push(`系列 ${index + 1} 类型无效，已使用折线`);
  }
  const points = [];
  let missing = 0;
  let invalid = 0;
  for (const [pointIndex, point] of (Array.isArray(source.data) ? source.data : []).entries()) {
    if (point == null || point.y == null || point.x == null) {
      missing += 1;
      points.push({ x: point?.x ?? null, y: null, missing: true, sourceIndex: pointIndex });
      continue;
    }
    const x = Number(point.x);
    const y = Number(point.y);
    const invalidX = !isFiniteNumber(x) || (axes.x.type === "log" && x <= 0);
    const invalidY = !isFiniteNumber(y) || (axes.y.type === "log" && y <= 0);
    if (invalidX || invalidY) {
      invalid += 1;
      points.push({ x: null, y: null, invalid: true, sourceIndex: pointIndex });
      continue;
    }
    points.push({
      x,
      y,
      sourceIndex: pointIndex,
      label: typeof point.label === "string" ? point.label : "",
      radius: isFiniteNumber(point.radius) ? clamp(point.radius, 2, 8) : null
    });
  }
  return {
    id: typeof source.id === "string" && source.id ? source.id : `series-${index + 1}`,
    name: typeof source.name === "string" && source.name ? source.name : `系列 ${index + 1}`,
    type,
    color: sanitizeColor(source.color, index),
    points,
    missing,
    invalid,
    opacity: clamp(Number(source.opacity) || 1, 0.05, 1)
  };
}

function uniqueSeriesIds(series, warnings) {
  const seen = new Set();
  for (const item of series) {
    if (seen.has(item.id)) {
      warnings.push(`系列 id ${item.id} 重复，已自动重命名`);
      let suffix = 2;
      while (seen.has(`${item.id}-${suffix}`)) suffix += 1;
      item.id = `${item.id}-${suffix}`;
    }
    seen.add(item.id);
  }
}

export function normalizeSpec(input = {}) {
  const warnings = [];
  const raw = input && typeof input === "object" ? input : {};
  const width = clamp(Number(raw.width) || DEFAULT_SPEC.width, 320, 2400);
  const height = clamp(Number(raw.height) || DEFAULT_SPEC.height, 220, 1600);
  if (raw.width && width !== raw.width) warnings.push(`画布宽度已限制为 ${width}px`);
  if (raw.height && height !== raw.height) warnings.push(`画布高度已限制为 ${height}px`);
  const requestedPadding = Number(raw.padding) || DEFAULT_SPEC.padding;
  const paddingCap = Math.min(48, Math.max(12, Math.floor(Math.min(width, height) * 0.085)));
  const padding = clamp(requestedPadding, 12, paddingCap);
  if (Math.abs(requestedPadding - padding) > 0.5) warnings.push(`内边距已限制为 ${round(padding)}px`);
  const xAxis = normalizeAxis(raw.xAxis, DEFAULT_SPEC.xAxis, "X", warnings);
  const yAxis = normalizeAxis(raw.yAxis, DEFAULT_SPEC.yAxis, "Y", warnings);
  const series = (Array.isArray(raw.series) ? raw.series : []).map((item, index) =>
    normalizeSeries(item, index, { x: xAxis, y: yAxis }, warnings)
  );
  uniqueSeriesIds(series, warnings);
  const layerOrder = Array.isArray(raw.layerOrder)
    ? LAYER_ORDER.filter((layer) => raw.layerOrder.includes(layer))
    : [...LAYER_ORDER];
  for (const layer of LAYER_ORDER) {
    if (!layerOrder.includes(layer)) layerOrder.push(layer);
  }
  const background = typeof raw.background === "string" && /^#[0-9a-f]{3,8}$/i.test(raw.background)
    ? raw.background
    : "#ffffff";
  return {
    width,
    height,
    padding: round(padding),
    title: typeof raw.title === "string" ? raw.title : DEFAULT_SPEC.title,
    subtitle: typeof raw.subtitle === "string" ? raw.subtitle : "",
    xLabel: xAxis.label || (typeof raw.xLabel === "string" ? raw.xLabel : ""),
    yLabel: yAxis.label || (typeof raw.yLabel === "string" ? raw.yLabel : ""),
    xAxis,
    yAxis,
    series,
    background,
    fontFamily: typeof raw.fontFamily === "string" ? raw.fontFamily : DEFAULT_SPEC.fontFamily,
    fontSize: clamp(Number(raw.fontSize) || DEFAULT_SPEC.fontSize, 10, 18),
    exportScale: clamp(Number(raw.exportScale) || 2, 1, 4),
    layerOrder,
    warnings
  };
}

function allValidPoints(series) {
  return series.flatMap((item) =>
    item.points.filter((point) => isFiniteNumber(point.x) && isFiniteNumber(point.y))
  );
}

function linearExtent(values, fallback) {
  if (!values.length) return fallback;
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const span = Math.abs(min || 1) * 0.2;
    min -= span;
    max += span;
  }
  return [min, max];
}

function padLinearDomain([min, max], pad = 0.08) {
  const span = max - min || Math.abs(max || 1);
  return [min - span * pad, max + span * pad];
}

function logExtent(values, fallback) {
  const positive = values.filter((value) => value > 0);
  if (!positive.length) return fallback;
  let min = Math.min(...positive);
  let max = Math.max(...positive);
  if (min === max) {
    min /= 2;
    max *= 2;
  }
  return [min / 1.18, max * 1.18];
}

export function calculateDomains(spec) {
  const points = allValidPoints(spec.series);
  let xDomain = spec.xAxis.domain;
  let yDomain = spec.yAxis.domain;
  if (!xDomain) {
    xDomain = spec.xAxis.type === "log"
      ? logExtent(points.map((point) => point.x), [1, 10])
      : padLinearDomain(linearExtent(points.map((point) => point.x), [0, 10]));
    if (spec.xAxis.type === "linear" &&
        spec.series.some((item) => item.type === "area") && xDomain[0] > 0 && xDomain[0] < xDomain[1]) {
      xDomain[0] = Math.max(0, xDomain[0] - (xDomain[1] - xDomain[0]) * 0.02);
    }
  }
  if (!yDomain) {
    yDomain = spec.yAxis.type === "log"
      ? logExtent(points.map((point) => point.y), [1, 10])
      : padLinearDomain(linearExtent(points.map((point) => point.y), [0, 1]));
    const values = points.map((point) => point.y);
    if (spec.yAxis.type === "linear" &&
        spec.series.some((item) => item.type === "area") &&
        Math.min(...values) >= 0 && yDomain[0] > 0) {
      yDomain[0] = 0;
    }
  }
  return { x: xDomain, y: yDomain };
}

function niceStep(rawStep) {
  if (!(rawStep > 0) || !Number.isFinite(rawStep)) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const fraction = rawStep / 10 ** exponent;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return niceFraction * 10 ** exponent;
}

export function linearTicks(min, max, target = 6) {
  if (!(max > min) || !Number.isFinite(min) || !Number.isFinite(max)) return [];
  const step = niceStep((max - min) / Math.max(2, target));
  const first = Math.ceil(min / step - 1e-9) * step;
  const result = [];
  for (let value = first, index = 0; value <= max + step * 1e-9 && index < 100; index += 1) {
    const normalized = Math.abs(value) < step * 1e-9 ? 0 : value;
    result.push({ value: normalized, label: formatTick(normalized, "linear") });
    value += step;
  }
  return result;
}

export function logTicks(min, max, target = 6) {
  if (!(max > min) || min <= 0) return [];
  const start = Math.floor(Math.log10(min));
  const end = Math.ceil(Math.log10(max));
  const candidates = [];
  for (let exponent = start; exponent <= end; exponent += 1) {
    for (const multiplier of [1, 2, 5]) {
      const value = multiplier * 10 ** exponent;
      if (value >= min * 0.999 && value <= max * 1.001) {
        candidates.push({ value, label: formatTick(value, "log") });
      }
    }
  }
  if (candidates.length <= Math.max(3, target + 2)) return candidates;
  const stride = Math.ceil(candidates.length / Math.max(3, target));
  return candidates.filter((_, index) => index % stride === 0 || index === candidates.length - 1);
}

export function axisTicks(axis, domain) {
  return axis.type === "log"
    ? logTicks(domain[0], domain[1], axis.tickCount)
    : linearTicks(domain[0], domain[1], axis.tickCount);
}

export function makeScale(axis, domain, range) {
  if (axis.type === "log") {
    const logMin = Math.log10(domain[0]);
    const logSpan = Math.log10(domain[1]) - logMin;
    return (value) => range[0] + ((Math.log10(value) - logMin) / logSpan) * (range[1] - range[0]);
  }
  const span = domain[1] - domain[0];
  return (value) => range[0] + ((value - domain[0]) / span) * (range[1] - range[0]);
}

export function pointSegments(series) {
  const segments = [];
  let current = [];
  for (const point of series.points) {
    if (isFiniteNumber(point.x) && isFiniteNumber(point.y)) {
      current.push(point);
    } else if (current.length) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

export function summarizeSeries(series) {
  return {
    id: series.id,
    type: series.type,
    color: series.color,
    total: series.points.length,
    valid: series.points.filter((point) => point.x != null && point.y != null).length,
    missing: series.missing,
    invalid: series.invalid
  };
}
