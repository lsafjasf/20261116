import { LAYER_ORDER, boxesOverlap, clone } from "./core.js";
import { buildChartLayout, snapshotCoordinates } from "./layout.js";
import { renderChartSVG } from "./svg.js";
import { getScenario, SCENARIOS, chartToSpec } from "./scenarios.js";

export const STORAGE_KEY = "atlas-chart-studio:state:v1";
export const SNAPSHOT_KEY = "atlas-chart-studio:snapshots:v1";
export const CACHE_FAILURE_FLAG = "atlas-chart-studio:cache-failure";
export const STATE_VERSION = 1;

let memorySnapshots = [];

export function createInitialState(scenarioId = "default") {
  const scenario = getScenario(scenarioId);
  return {
    version: STATE_VERSION,
    scenarioId: scenario.id,
    layerOrder: [...LAYER_ORDER],
    charts: clone(scenario.charts),
    updatedAt: new Date().toISOString()
  };
}

export function selectedFrame(chart) {
  return chart.frames[Math.max(0, Math.min(chart.selectedFrame ?? 0, chart.frames.length - 1))];
}

export function renderChart(chart, state) {
  const specInput = chartToSpec(chart, state.layerOrder);
  const { spec, layout, warnings } = buildChartLayout(specInput);
  const svg = renderChartSVG(layout, spec, { idPrefix: chart.id });
  return { spec, layout, warnings, svg, frame: selectedFrame(chart), chart };
}

function validChart(chart) {
  return Boolean(
    chart &&
    typeof chart.id === "string" &&
    Array.isArray(chart.frames) &&
    chart.frames.length > 0 &&
    chart.frames.every((frame) =>
      frame &&
      typeof frame.id === "string" &&
      Array.isArray(frame.series)
    )
  );
}

export function validateState(candidate) {
  if (!candidate || typeof candidate !== "object") return false;
  if (candidate.version !== STATE_VERSION) return false;
  if (!SCENARIOS.some((scenario) => scenario.id === candidate.scenarioId)) return false;
  if (!Array.isArray(candidate.charts) || candidate.charts.length !== 3) return false;
  if (!candidate.charts.every(validChart)) return false;
  if (!Array.isArray(candidate.layerOrder)) return false;
  return LAYER_ORDER.every((layer) => candidate.layerOrder.includes(layer));
}

export function loadState() {
  try {
    if (sessionStorage.getItem(CACHE_FAILURE_FLAG) === "1") {
      sessionStorage.removeItem(CACHE_FAILURE_FLAG);
      localStorage.removeItem(STORAGE_KEY);
      throw new Error("用户触发的缓存读取故障");
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { state: createInitialState(), notice: null, source: "default" };
    const parsed = JSON.parse(raw);
    if (!validateState(parsed)) {
      localStorage.removeItem(STORAGE_KEY);
      throw new Error("缓存结构校验失败");
    }
    return { state: parsed, notice: null, source: "cache" };
  } catch (error) {
    return {
      state: createInitialState(),
      source: "fallback",
      notice: {
        kind: "warn",
        title: "缓存不可用，已恢复默认工程",
        detail: `${error.message}；未显示旧内容，也未停留在空白画面。`
      }
    };
  }
}

export function saveState(state) {
  const payload = { ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return { ok: true, state: payload };
  } catch (error) {
    return { ok: false, error, state: payload };
  }
}

export function armCacheFailure() {
  sessionStorage.setItem(CACHE_FAILURE_FLAG, "1");
}

function collectLayoutLabels(layout) {
  const labels = [];
  if (layout.header.title) labels.push({ role: "title", box: layout.header.title.bbox });
  if (layout.header.subtitle) labels.push({ role: "subtitle", box: layout.header.subtitle.bbox });
  for (const item of layout.legend.items) labels.push({ role: "legend", box: item.bbox });
  for (const tick of layout.ticks.x) labels.push({ role: "tick-x", box: tick.bbox });
  for (const tick of layout.ticks.y) labels.push({ role: "tick-y", box: tick.bbox });
  for (const annotation of layout.annotations) labels.push({ role: "annotation", box: annotation.bbox });
  if (layout.axes.x) labels.push({ role: "axis-x", box: layout.axes.x.bbox });
  if (layout.axes.y) labels.push({ role: "axis-y", box: layout.axes.y.bbox });
  if (layout.emptyState) labels.push({ role: "empty", box: layout.emptyState.bbox });
  return labels;
}

export function exportSnapshot(state, charts, reason = "before-export") {
  const createdAt = new Date().toISOString();
  const id = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const snapshot = {
    id,
    version: STATE_VERSION,
    reason,
    createdAt,
    scenarioId: state.scenarioId,
    layerOrder: [...state.layerOrder],
    state: clone(state),
    charts: charts.map(({ chart, layout, frame }) => ({
      id: chart.id,
      title: chart.title,
      frame: { id: frame.id, label: frame.label, index: chart.selectedFrame },
      keyframes: chart.frames.map((item) => ({ id: item.id, label: item.label })),
      layerOrder: [...state.layerOrder],
      colors: Object.fromEntries(frame.series.map((series) => [series.id, series.color])),
      layoutHash: layout.hash,
      dimensions: { width: layout.width, height: layout.height },
      coordinates: snapshotCoordinates(layout),
      labels: collectLayoutLabels(layout),
      warnings: layout.warnings
    }))
  };
  const existing = loadSnapshots(false);
  const next = [snapshot, ...existing].slice(0, 8);
  memorySnapshots = next;
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(next));
    return { snapshot, persisted: true, snapshots: next };
  } catch (error) {
    return { snapshot, persisted: false, error, snapshots: next };
  }
}

export function loadSnapshots(useMemory = true) {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : memorySnapshots;
  } catch {
    return useMemory ? memorySnapshots : memorySnapshots;
  }
}

export function saveSnapshots(snapshots) {
  memorySnapshots = snapshots;
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots));
    return true;
  } catch {
    return false;
  }
}

export function reportLabelCollisions(layout) {
  const labels = collectLayoutLabels(layout);
  const collisions = [];
  for (let left = 0; left < labels.length; left += 1) {
    for (let right = left + 1; right < labels.length; right += 1) {
      if (boxesOverlap(labels[left].box, labels[right].box, 0)) {
        collisions.push([labels[left].role, labels[right].role]);
      }
    }
  }
  return collisions;
}

export function verifyScenario(scenario) {
  const state = {
    version: STATE_VERSION,
    scenarioId: scenario.id,
    layerOrder: [...LAYER_ORDER],
    charts: clone(scenario.charts)
  };
  const checks = [];
  let labelCount = 0;
  let pointCount = 0;
  let collisionCount = 0;
  for (const chart of state.charts) {
    for (let frameIndex = 0; frameIndex < chart.frames.length; frameIndex += 1) {
      const rendered = renderChart({ ...chart, selectedFrame: frameIndex }, state);
      const collision = reportLabelCollisions(rendered.layout);
      collisionCount += collision.length;
      labelCount += rendered.layout.legend.items.length + rendered.layout.ticks.x.length +
        rendered.layout.ticks.y.length + rendered.layout.annotations.length;
      pointCount += rendered.layout.series.reduce((sum, item) => sum + item.points.length, 0);
      checks.push({
        chartId: chart.id,
        frame: chart.frames[frameIndex].id,
        hash: rendered.layout.hash,
        collisions: collision.length
      });
    }
  }
  const types = new Set(state.charts.flatMap((chart) =>
    chart.frames[0].series.map((series) => series.type)
  ));
  return {
    scenarioId: scenario.id,
    pass: collisionCount === 0 &&
      ["line", "area", "scatter"].every((type) => types.has(type)) &&
      checks.length === 9,
    checkCount: checks.length,
    labelCount,
    pointCount,
    collisionCount,
    checks,
    types: [...types]
  };
}

export function geometryPayload(rendered) {
  return JSON.stringify({
    layoutHash: rendered.layout.hash,
    tickX: rendered.layout.ticks.x.map((tick) => [tick.label, tick.x, tick.y]),
    tickY: rendered.layout.ticks.y.map((tick) => [tick.label, tick.x, tick.cy ?? tick.y]),
    legend: rendered.layout.legend.items.map((item) => [item.name, item.textX, item.textY]),
    annotations: rendered.layout.annotations.map((item) => [item.text, item.textX, item.textY])
  });
}
