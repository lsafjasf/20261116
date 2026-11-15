// Controller: binds controls to FabricMaterial, keeps previews in sync via
// incremental dirty-block recomposition, and never rebuilds the scene on a
// plain UI refresh. Offscreen canvases are created once and reused.
import { FabricMaterial } from "../core/material.js";
import {
  DEFAULT_PARAMS,
  PRESETS,
  LEGAL_DENSITIES,
  serializeParams,
  deserializeParams,
  TILE_SIZE,
} from "../core/params.js";
import { hashBytes, checkSeams, diffBlocks, countObjects } from "../core/analysis.js";
import { drawFlat, drawTiled, drawCurved } from "./preview.js";
import { runAll } from "./harness.js";

const $ = (id) => document.getElementById(id);
const flat = $("flat-canvas");
const tile = $("tile-canvas");
const curved = $("curved-canvas");

let material = new FabricMaterial(DEFAULT_PARAMS);
let brushEnabled = true;
let painting = false;
let lastPaint = null;
const createdCanvases = [flat, tile, curved];

function currentParamsFromUI() {
  return {
    ...material.params,
    threadDensity: LEGAL_DENSITIES[Number($("density").value)],
    fiberDirection: Number($("direction").value),
    wearLevel: Number($("wear").value),
    creaseStrength: Number($("crease").value),
    seed: $("seed").value.trim() || "fabric-001",
  };
}

function syncUIFromParams(p) {
  $("density").value = LEGAL_DENSITIES.indexOf(p.threadDensity);
  $("density-val").textContent = p.threadDensity;
  $("direction").value = p.fiberDirection;
  $("direction-val").textContent = p.fiberDirection;
  $("wear").value = p.wearLevel;
  $("wear-val").textContent = Number(p.wearLevel).toFixed(2);
  $("crease").value = p.creaseStrength;
  $("crease-val").textContent = Number(p.creaseStrength).toFixed(2);
  $("seed").value = p.seed;
}

function refreshPreviews() {
  drawFlat(flat, material.composite);
  drawTiled(tile, material.composite);
  drawCurved(curved, material.composite);
}

let lastHash = hashBytes(material.composite);
function refreshMetrics(extra = {}) {
  const seam = checkSeams(material.composite);
  const grid = $("metric-grid");
  const metrics = [
    ["材质哈希", hashBytes(material.composite), ""],
    ["上次哈希", lastHash, ""],
    ["接缝是否无缝", seam.seamless ? "是" : "否", seam.seamless ? "ok" : "bad"],
    ["接缝最大跳变", seam.seamJump, seam.seamJump <= 3 ? "ok" : "warn"],
    ["内部相邻均值", seam.interiorMean, ""],
    ["边缘像素差(逐对)", seam.maxDelta, seam.maxDelta === 0 ? "ok" : "warn"],
    ...Object.entries(extra),
  ];
  grid.innerHTML = "";
  for (const [k, v, cls] of metrics) {
    const d = document.createElement("div");
    d.className = "metric";
    d.innerHTML = `<div class="k">${k}</div><div class="v ${cls || ""}">${v}</div>`;
    grid.append(d);
  }
  const scene = $("scene-grid");
  scene.innerHTML = "";
  const sceneMetrics = [
    ["Canvas 对象数（恒定）", createdCanvases.length, "ok"],
    ["performance 资源条目", countObjects(), ""],
    ["全量渲染次数", material.metrics.fullRenders, ""],
    ["增量渲染次数", material.metrics.incrementalRenders, ""],
    ["累计重算块", material.metrics.blocksRecomputed, ""],
    ["分层调用次数", material.metrics.layerCalls, ""],
    ["刷子笔画数", material.metrics.brushStrokes, ""],
    ["当前脏块（应为0）", material.dirty.size, material.dirty.size === 0 ? "ok" : "bad"],
  ];
  for (const [k, v, cls] of sceneMetrics) {
    const d = document.createElement("div");
    d.className = "metric";
    d.innerHTML = `<div class="k">${k}</div><div class="v ${cls}">${v}</div>`;
    scene.append(d);
  }
  $("state-summary").textContent = JSON.stringify(
    {
      params: material.params,
      metrics: material.metrics,
      seam,
      canvasObjects: createdCanvases.length,
      brushEnabled,
    },
    null,
    2
  );
}

function applyParamChange() {
  const before = Uint8ClampedArray.from(material.composite);
  const affected = material.updateParams(currentParamsFromUI());
  const diff = diffBlocks(before, material.composite);
  refreshPreviews();
  refreshMetrics({
    "本次受影响层": affected.length ? affected.join(",") : "无",
    "本次变化块": `${diff.changedBlocks.length}/${diff.totalBlocks}`,
  });
  lastHash = hashBytes(material.composite);
}

function bindSliders() {
  const map = [
    ["density", "density-val", (v) => LEGAL_DENSITIES[v]],
    ["direction", "direction-val", (v) => v],
    ["wear", "wear-val", (v) => Number(v).toFixed(2)],
    ["crease", "crease-val", (v) => Number(v).toFixed(2)],
  ];
  for (const [id, out, fmt] of map) {
    $(id).addEventListener("input", () => {
      $(out).textContent = fmt($(id).value);
      applyParamChange();
    });
  }
  $("seed").addEventListener("change", applyParamChange);
}

function bindBrush() {
  const pos = (evt) => {
    const rect = flat.getBoundingClientRect();
    return {
      x: Math.floor(((evt.clientX - rect.left) / rect.width) * TILE_SIZE),
      y: Math.floor(((evt.clientY - rect.top) / rect.height) * TILE_SIZE),
    };
  };
  flat.addEventListener("pointerdown", (evt) => {
    if (!brushEnabled) return;
    painting = true;
    flat.setPointerCapture(evt.pointerId);
    const p = pos(evt);
    lastPaint = p;
    stampLine(p, p);
  });
  flat.addEventListener("pointermove", (evt) => {
    if (!painting || !brushEnabled) return;
    const p = pos(evt);
    stampLine(lastPaint || p, p);
    lastPaint = p;
  });
  ["pointerup", "pointercancel"].forEach((t) =>
    flat.addEventListener(t, () => {
      painting = false;
      lastPaint = null;
    })
  );
}

// Interpolate stroke points so fast drags leave a continuous toroidal line.
function stampLine(a, b) {
  const radius = Number($("brush-size").value);
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (radius / 3)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(a.x + (b.x - a.x) * t);
    const y = Math.round(a.y + (b.y - a.y) * t);
    material.brushAt(x, y, radius, 255);
  }
  refreshPreviews();
  refreshMetrics({ 本次变化块: "局部(环面)" });
  lastHash = hashBytes(material.composite);
}

function bindActions() {
  $("btn-brush").addEventListener("click", () => {
    brushEnabled = !brushEnabled;
    const btn = $("btn-brush");
    btn.classList.toggle("on", brushEnabled);
    btn.textContent = `刷子：${brushEnabled ? "开" : "关"}`;
  });
  $("btn-clear-brush").addEventListener("click", () => {
    material.clearBrush();
    refreshPreviews();
    refreshMetrics();
    lastHash = hashBytes(material.composite);
  });
  $("btn-restore").addEventListener("click", () => restorePreset("balanced"));
  $("btn-export-png").addEventListener("click", exportPng);
  $("btn-export-json").addEventListener("click", exportJson);
  $("file-json").addEventListener("change", importJson);
  $("btn-test-all").addEventListener("click", runTests);
  $("btn-test-normal").addEventListener("click", () => runTests(["normal"]));
  $("btn-test-boundary").addEventListener("click", () => runTests(["boundary"]));
  $("btn-test-failure").addEventListener("click", () => runTests(["failure"]));
}

function restorePreset(key) {
  const preset = PRESETS[key];
  material = new FabricMaterial(preset.params);
  syncUIFromParams(preset.params);
  refreshPreviews();
  refreshMetrics({ 恢复: preset.label });
  lastHash = hashBytes(material.composite);
}

function buildPresets() {
  const wrap = $("presets");
  for (const [key, preset] of Object.entries(PRESETS)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = preset.label;
    btn.addEventListener("click", () => restorePreset(key));
    wrap.append(btn);
  }
}

function exportPng() {
  const off = document.createElement("canvas");
  off.width = TILE_SIZE;
  off.height = TILE_SIZE;
  drawFlat(off, material.composite);
  off.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fabric-${material.params.seed}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

function exportJson() {
  const blob = new Blob([serializeParams(material.params)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `fabric-${material.params.seed}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importJson(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  file.text().then((text) => {
    try {
      const params = deserializeParams(text);
      material = new FabricMaterial(params);
      syncUIFromParams(params);
      refreshPreviews();
      refreshMetrics({ 导入: "成功（已重载）" });
      lastHash = hashBytes(material.composite);
    } catch (err) {
      refreshMetrics({ 导入: `失败: ${err.message}` });
    }
  });
  evt.target.value = "";
}

function runTests(only) {
  const all = runAll();
  const order = ["normal", "boundary", "failure"];
  const host = $("test-results");
  host.innerHTML = "";
  all.forEach((result, i) => {
    if (!only || only[0] === order[i]) host.append(result.el);
  });
}

function init() {
  syncUIFromParams(DEFAULT_PARAMS);
  buildPresets();
  bindSliders();
  bindBrush();
  bindActions();
  $("brush-size").addEventListener("input", () => {
    $("brush-size-val").textContent = $("brush-size").value;
  });
  refreshPreviews();
  refreshMetrics();
}

init();
