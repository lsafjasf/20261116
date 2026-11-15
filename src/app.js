import {
  createBrushLayer,
  createMaterialLayer,
  defaultScene,
  interpolateKeyframes,
  mod,
  nearestWrappedPoint,
  normalizeScene,
  sceneDigest,
  stableHash
} from "./core.js";
import {
  buildComparisonReport,
  buildTileCheck,
  canvasDataUrl,
  canvasToBlob,
  clearMaterialCache,
  clearThumbnailCache,
  compareCanvases,
  drawBrushLayer,
  measureSeams,
  renderLayerThumbnail,
  renderScene,
  resizeCanvas
} from "./renderer.js";
import {
  consumeReloadCheck,
  createSnapshot,
  downloadBlob,
  downloadText,
  loadProject,
  prepareReloadCheck,
  readSnapshots,
  saveProject
} from "./store.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const previewCanvas = $("#previewCanvas");
const canvasShell = $("#canvasShell");
const previewContext = previewCanvas.getContext("2d");

let scene;
let compositeCanvas;
let renderToken = 0;
let saveTimer = 0;
let lastSavedAt = null;
let painting = null;
let panning = null;
let pointerInside = false;
let pointerScreen = { x: 0, y: 0 };
let previewMetrics = null;
let forceThumbnailFallback = false;
let failNextAsync = false;
let thumbnailStatus = "ready";
let history = [];
let future = [];
let exporting = false;
let testRunning = false;

const boot = loadProject();
scene = normalizeScene(boot.scene || defaultScene());
compositeCanvas = renderScene(scene, 1024);

function clone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function formatHex(value) {
  return String(value || "#000000").toLowerCase();
}

function setSaveState(text, state = "ok") {
  const element = $("#saveState");
  element.textContent = text;
  element.dataset.state = state;
}

function toast(message, type = "info", duration = 4200) {
  const stack = $("#toastStack");
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.innerHTML = `<span class="toast-icon">${type === "error" ? "!" : type === "success" ? "✓" : "i"}</span><span>${message}</span>`;
  stack.append(node);
  window.setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(4px)";
    window.setTimeout(() => node.remove(), 220);
  }, duration);
}

function setDiagnostic(message, state = "idle") {
  const element = $("#diagnosticStatus");
  element.className = `diagnostic-status ${state}`;
  element.querySelector("span").textContent = message;
}

function setExportStatus(message, state = "ok") {
  const element = $("#exportStatus");
  element.className = `export-status ${state === "ok" ? "" : state}`;
  element.querySelector("span:last-child").textContent = message;
}

function scheduleSave() {
  setSaveState("有未保存更改", "pending");
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveNow(false), 420);
}

function saveNow(explicit = true) {
  const result = saveProject(scene);
  if (!result.ok) {
    setSaveState("本地存储不可用", "error");
    if (explicit) toast(`工程未能保存：${result.error || "存储被禁用"}`, "error");
    return false;
  }
  lastSavedAt = result.at;
  setSaveState(explicit ? "工程已保存" : "已自动保存");
  if (explicit) toast("工程与当前坐标、颜色、图层顺序已保存", "success", 2600);
  return true;
}

function pushHistory() {
  const serialized = JSON.stringify(scene);
  if (history.at(-1) !== serialized) history.push(serialized);
  if (history.length > 40) history.shift();
  future = [];
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $("#undoBtn").disabled = history.length === 0;
  $("#redoBtn").disabled = future.length === 0;
}

function restoreScene(serialized) {
  scene = normalizeScene(JSON.parse(serialized));
  compositeCanvas = renderScene(scene, 1024);
  syncUI();
  drawViewport();
  scheduleSave();
}

function undo() {
  if (!history.length) return;
  future.push(JSON.stringify(scene));
  restoreScene(history.pop());
  updateHistoryButtons();
}

function redo() {
  if (!future.length) return;
  history.push(JSON.stringify(scene));
  restoreScene(future.pop());
  updateHistoryButtons();
}

function selectedLayer() {
  return scene.layers.find((layer) => layer.id === scene.selectedLayerId) || scene.layers[0];
}

function selectedMaterial() {
  const selected = selectedLayer();
  if (selected?.type === "material") return selected;
  return scene.layers.find((layer) => layer.type === "material") || null;
}

function activeBrushLayer() {
  const selected = selectedLayer();
  if (selected?.type === "brush" && selected.visible) return selected;
  let brush = scene.layers.find((layer) => layer.type === "brush" && layer.visible);
  if (!brush) {
    brush = createBrushLayer(scene.layers.filter((layer) => layer.type === "brush").length + 1);
    scene.layers.push(brush);
  }
  scene.selectedLayerId = brush.id;
  return brush;
}

function setTool(tool) {
  scene.tool = tool === "hand" ? "hand" : "brush";
  $$(".tool-btn").forEach((button) => button.classList.toggle("active", button.dataset.tool === scene.tool));
  previewCanvas.classList.toggle("hand", scene.tool === "hand");
  drawViewport();
  scheduleSave();
}

function setZoom(value) {
  scene.view.zoom = Math.min(2, Math.max(0.25, value));
  $("#zoomRange").value = String(Math.round(scene.view.zoom * 100));
  $("#zoomLabel").textContent = `${Math.round(scene.view.zoom * 100)}%`;
  drawViewport();
  scheduleSave();
}

function rotateBy(degrees) {
  scene.view.rotation = mod(scene.view.rotation + degrees + 180, 360) - 180;
  syncViewControls();
  drawViewport();
  scheduleSave();
}

function syncViewControls() {
  $("#zoomRange").value = String(Math.round(scene.view.zoom * 100));
  $("#zoomLabel").textContent = `${Math.round(scene.view.zoom * 100)}%`;
  $("#rotationLabel").textContent = `${Math.round(scene.view.rotation)}°`;
  $("#tileToggle").classList.toggle("active", scene.view.tiling);
  $("#seamToggle").classList.toggle("active", scene.view.seam);
}

function makeCompositeThumbnail() {
  const canvas = document.createElement("canvas");
  canvas.width = 78;
  canvas.height = 78;
  const context = canvas.getContext("2d");
  context.drawImage(compositeCanvas, 0, 0, 78, 78);
  return canvas;
}

function makeLayerThumbnail(layer, fallback = forceThumbnailFallback) {
  try {
    if (fallback) throw new Error("缩略图缓存被强制失效");
    const canvas = renderLayerThumbnail(layer, scene, false);
    const copy = document.createElement("canvas");
    copy.width = 78;
    copy.height = 78;
    copy.getContext("2d").drawImage(canvas, 0, 0, 78, 78);
    return { canvas: copy, fallback: false };
  } catch {
    return { canvas: makeCompositeThumbnail(), fallback: true };
  }
}

function renderLayerList() {
  const list = $("#layerList");
  list.textContent = "";
  $("#layerCount").textContent = String(scene.layers.length);
  let fallbackCount = 0;
  [...scene.layers].reverse().forEach((layer) => {
    const item = document.createElement("div");
    item.className = `layer-item${layer.id === scene.selectedLayerId ? " active" : ""}`;
    item.dataset.layerId = layer.id;
    item.draggable = true;
    const subtitle = layer.type === "material"
      ? `${layer.kind === "fabric" ? "FABRIC" : "STONE"} · ${layer.visible ? "VISIBLE" : "HIDDEN"}`
      : `BRUSH · ${layer.strokes.length} 笔`;
    item.innerHTML = `
      <span class="layer-grip" title="拖动调整图层顺序"><i></i><i></i><i></i></span>
      <span class="layer-thumb"></span>
      <span class="layer-copy"><b>${layer.name}</b><small>${subtitle}</small></span>
      <button class="layer-eye${layer.visible ? "" : " off"}" data-action="visibility" title="${layer.visible ? "隐藏" : "显示"}图层">
        <svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>
      </button>`;
    const thumb = makeLayerThumbnail(layer);
    if (thumb.fallback) {
      fallbackCount += 1;
      thumb.canvas.className = "thumb-fallback-canvas";
    }
    item.querySelector(".layer-thumb").append(thumb.canvas);
    list.append(item);
  });
  thumbnailStatus = fallbackCount ? "fallback" : "ready";
  if (fallbackCount && !forceThumbnailFallback) {
    setDiagnostic(`${fallbackCount} 个缩略图失效，已从主纹理重建`, "warn");
  }
}

function syncMaterialControls() {
  const material = selectedMaterial();
  const brushSelected = selectedLayer()?.type === "brush";
  $("#materialControls").hidden = !material;
  $("#brushControls").hidden = false;
  if (!material) return;
  const isStone = material.kind === "stone";
  $("#materialKindLabel").textContent = isStone ? "STONE / SEAMLESS" : "FABRIC / SEAMLESS";
  $("#stoneControls").hidden = !isStone;
  $("#fabricControls").hidden = isStone;
  if (isStone) {
    const params = material.params;
    $("#stoneScale").value = String(params.scale);
    $("#stoneContrast").value = String(Math.round(params.contrast * 100));
    $("#stoneGrain").value = String(Math.round(params.grain * 100));
    $("#stoneWeather").value = String(Math.round(params.weather * 100));
    $("#stoneScaleOut").textContent = Number(params.scale).toFixed(1);
    $("#stoneContrastOut").textContent = `${Math.round(params.contrast * 100)}%`;
    $("#stoneGrainOut").textContent = `${Math.round(params.grain * 100)}%`;
    $("#stoneWeatherOut").textContent = `${Math.round(params.weather * 100)}%`;
  } else {
    const params = material.params;
    $("#fabricThreads").value = String(params.threads);
    $("#fabricSlub").value = String(Math.round(params.slub * 100));
    $("#fabricWrinkle").value = String(Math.round(params.wrinkle * 100));
    $("#fabricContrast").value = String(Math.round(params.contrast * 100));
    $("#fabricThreadsOut").textContent = String(params.threads);
    $("#fabricSlubOut").textContent = `${Math.round(params.slub * 100)}%`;
    $("#fabricWrinkleOut").textContent = `${Math.round(params.wrinkle * 100)}%`;
    $("#fabricContrastOut").textContent = `${Math.round(params.contrast * 100)}%`;
  }
  $("#colorBase").value = material.palette.base;
  $("#colorVein").value = material.palette.vein;
  $("#colorAccent").value = material.palette.accent;
  $("#selectedLayerName").textContent = brushSelected ? selectedLayer().name : material.name;
  $("#selectedLayerMeta").textContent = brushSelected ? "BRUSH / SYNC" : "PROCEDURAL";
  $("#selectedLayerMeta").style.color = brushSelected ? "#7fb69c" : "";
}

function syncBrushControls() {
  const brush = scene.brush;
  $("#brushSize").value = String(brush.size);
  $("#brushHardness").value = String(Math.round(brush.hardness * 100));
  $("#brushOpacity").value = String(Math.round(brush.opacity * 100));
  $("#brushColor").value = formatHex(brush.color);
  $("#brushSizeOut").textContent = `${Math.round(brush.size)} px`;
  $("#brushHardnessOut").textContent = `${Math.round(brush.hardness * 100)}%`;
  $("#brushOpacityOut").textContent = `${Math.round(brush.opacity * 100)}%`;
  $("#brushCursorBadge").textContent = `Ø ${Math.round(brush.size)} px · 跨边界同步`;
  $$(".swatch").forEach((swatch) => {
    swatch.classList.toggle("active", formatHex(swatch.dataset.color) === formatHex(brush.color));
  });
}

function formatTime(value) {
  const seconds = Math.round(value * 0.12);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function syncTimeline() {
  const time = scene.currentTime;
  $("#playheadRange").value = String(time);
  $("#playhead").style.left = `${time}%`;
  $("#currentTime").textContent = formatTime(time);
  const interpolation = interpolateKeyframes(scene.keyframes, time);
  $("#keyframeHint").innerHTML = `${Math.round(time)}% · ${interpolation.label || "插值"}<br>风化 ${Math.round((interpolation.weather || 0) * 100)}% · 竹节 ${Math.round((interpolation.slub || 0) * 100)}%`;
  const list = $("#keyframeList");
  list.textContent = "";
  [...scene.keyframes].sort((a, b) => a.time - b.time).forEach((frame) => {
    const button = document.createElement("button");
    const active = Math.abs(frame.time - time) < 4;
    button.className = `keyframe-card${active ? " active" : ""}`;
    button.dataset.time = String(frame.time);
    button.innerHTML = `<b>${frame.label}</b><small>${Math.round(frame.time)}% · W${Math.round((frame.weather || 0) * 100)}</small>`;
    button.addEventListener("click", () => {
      scene.currentTime = frame.time;
      syncTimeline();
      invalidatePreview();
      scheduleSave();
    });
    list.append(button);
  });
}

function formatSnapshotTime(iso) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function syncSnapshots() {
  const snapshots = readSnapshots();
  const list = $("#snapshotList");
  list.textContent = "";
  if (!snapshots.length) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = "导出前会自动创建工程快照";
    list.append(empty);
    return;
  }
  snapshots.slice(0, 5).forEach((snapshot) => {
    const button = document.createElement("button");
    button.className = "snapshot-item";
    button.dataset.snapshotId = snapshot.id;
    button.innerHTML = `
      <span class="snapshot-icon">${snapshot.size}</span>
      <span class="snapshot-copy"><b>${snapshot.reason}</b><small>${formatSnapshotTime(snapshot.createdAt)} · ${snapshot.digest}</small></span>
      <span class="mini-link">载入</span>`;
    button.addEventListener("click", () => loadSnapshot(snapshot));
    list.append(button);
  });
}

function loadSnapshot(snapshot) {
  pushHistory();
  scene = normalizeScene(clone(snapshot.scene));
  forceThumbnailFallback = false;
  compositeCanvas = renderScene(scene, 1024);
  syncUI();
  drawViewport();
  updateSeamMetric(compositeCanvas);
  scheduleSave();
  toast(`已载入快照 ${formatSnapshotTime(snapshot.createdAt)}，未改动图层顺序与关键帧`, "success");
}

function syncUI() {
  $("#projectName").textContent = scene.name;
  syncViewControls();
  syncMaterialControls();
  syncBrushControls();
  syncTimeline();
  syncSnapshots();
  renderLayerList();
  updateCoordinate();
  updateHistoryButtons();
  $("#tileToggle").classList.toggle("active", scene.view.tiling);
  $("#seamToggle").classList.toggle("active", scene.view.seam);
  $("#export512").classList.toggle("active", scene.exportSize === 512);
  $("#export1024").classList.toggle("active", scene.exportSize === 1024);
}

function makeEmergencyCanvas(size = 1024) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, "#746f66");
  gradient.addColorStop(1, "#4f4c46");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  context.strokeStyle = "rgba(237,228,212,.35)";
  context.lineWidth = Math.max(1, size / 512);
  context.setLineDash([size / 18, size / 36]);
  context.strokeRect(size * 0.08, size * 0.08, size * 0.84, size * 0.84);
  context.fillStyle = "rgba(20,18,15,.7)";
  context.fillRect(size * 0.2, size * 0.44, size * 0.6, size * 0.12);
  context.fillStyle = "#ede4d4";
  context.textAlign = "center";
  context.font = `${Math.round(size * 0.032)}px monospace`;
  context.fillText("安全回退材质", size / 2, size * 0.515);
  return canvas;
}

function applyComposite(canvas) {
  compositeCanvas = canvas;
  drawViewport();
  updateSeamMetric(canvas);
}

async function rebuildPreview(token, shouldFail = false) {
  try {
    if (shouldFail) {
      await new Promise((resolve) => setTimeout(resolve, 320));
      throw new Error("异步纹理请求超时，结果已丢弃");
    }
    const next = renderScene(scene, 1024);
    if (token !== renderToken) return;
    applyComposite(next);
    $("#renderMode").textContent = "实时预览 · 1024 基准";
    setExportStatus("预览与导出使用同一归一化场景", "ok");
  } catch (error) {
    if (token !== renderToken) return;
    try {
      const fallback = renderScene(scene, 1024, { quiet: true });
      applyComposite(fallback);
      $("#renderMode").textContent = "同步回退渲染 · 已恢复";
      setDiagnostic("异步请求失效 → 已回退到同步安全渲染", "error");
      setExportStatus("异步请求失效，已自动回退；画面仍可导出", "error");
      toast(`${error.message}。已自动切换同步回退，未保留旧画面。`, "error", 5200);
    } catch (fallbackError) {
      applyComposite(makeEmergencyCanvas(1024));
      $("#renderMode").textContent = "安全材质占位 · 参数仍可编辑";
      setDiagnostic("同步回退也失败，已加载安全材质占位", "error");
      toast(`回退通道异常：${fallbackError.message}。已显示安全占位而非空白。`, "error", 6000);
    }
  }
}

function invalidatePreview(options = {}) {
  const token = ++renderToken;
  const shouldFail = options.failAsync ?? failNextAsync;
  if (options.failAsync) failNextAsync = false;
  $("#renderMode").textContent = shouldFail ? "异步请求进行中…" : "正在重建无缝材质…";
  const delay = shouldFail ? 0 : 16;
  window.setTimeout(() => {
    rebuildPreview(token, shouldFail).then(() => {
      if (options.refreshThumbs) {
        renderLayerList();
        syncSnapshots();
      }
    });
  }, delay);
}

function getViewGeometry(width = canvasShell.clientWidth, height = canvasShell.clientHeight) {
  const isTiling = scene.view.tiling;
  const fit = Math.min(width, height) * (isTiling ? 0.35 : 0.72);
  const tile = fit * scene.view.zoom;
  return {
    cx: width / 2 + scene.view.panX,
    cy: height / 2 + scene.view.panY,
    tile,
    isTiling,
    radians: scene.view.rotation * Math.PI / 180
  };
}

function drawViewport() {
  const rect = canvasShell.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  if (previewCanvas.width !== Math.round(width * dpr) || previewCanvas.height !== Math.round(height * dpr)) {
    previewCanvas.width = Math.round(width * dpr);
    previewCanvas.height = Math.round(height * dpr);
  }
  previewContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  previewContext.clearRect(0, 0, width, height);
  previewContext.imageSmoothingEnabled = true;
  previewContext.imageSmoothingQuality = "high";
  const geometry = getViewGeometry(width, height);
  previewContext.save();
  previewContext.translate(geometry.cx, geometry.cy);
  previewContext.rotate(geometry.radians);
  previewContext.shadowColor = "rgba(0,0,0,.52)";
  previewContext.shadowBlur = 24;
  previewContext.shadowOffsetY = 6;
  if (geometry.isTiling) {
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        previewContext.drawImage(
          compositeCanvas,
          (x - 0.5) * geometry.tile,
          (y - 0.5) * geometry.tile,
          geometry.tile,
          geometry.tile
        );
      }
    }
  } else {
    previewContext.drawImage(compositeCanvas, -geometry.tile / 2, -geometry.tile / 2, geometry.tile, geometry.tile);
  }
  previewContext.shadowColor = "transparent";
  if (scene.view.seam) {
    previewContext.strokeStyle = "rgba(225,169,113,.45)";
    previewContext.lineWidth = 1;
    previewContext.setLineDash([3, 5]);
    if (geometry.isTiling) {
      previewContext.strokeRect(-geometry.tile, -geometry.tile, geometry.tile * 2, geometry.tile * 2);
      previewContext.strokeStyle = "rgba(225,169,113,.2)";
      previewContext.strokeRect(-geometry.tile / 2, -geometry.tile / 2, geometry.tile, geometry.tile);
    } else {
      previewContext.strokeRect(-geometry.tile / 2, -geometry.tile / 2, geometry.tile, geometry.tile);
    }
    previewContext.setLineDash([]);
  }
  if (pointerInside && scene.tool === "brush") {
    const u = scene.cursor.u;
    const v = scene.cursor.v;
    const radius = Math.max(2.5, scene.brush.size / 1024 * geometry.tile * 0.5);
    const centers = geometry.isTiling
      ? [[-geometry.tile / 2, -geometry.tile / 2], [geometry.tile / 2, -geometry.tile / 2], [-geometry.tile / 2, geometry.tile / 2], [geometry.tile / 2, geometry.tile / 2]]
      : [[0, 0]];
    for (const [cx, cy] of centers) {
      previewContext.beginPath();
      previewContext.arc(cx + (u - 0.5) * geometry.tile, cy + (v - 0.5) * geometry.tile, radius, 0, Math.PI * 2);
      previewContext.strokeStyle = geometry.isTiling ? "rgba(225,178,123,.34)" : "rgba(235,226,211,.72)";
      previewContext.lineWidth = 1;
      previewContext.stroke();
    }
  }
  previewContext.restore();
}

function eventToUV(clientX, clientY) {
  const rect = canvasShell.getBoundingClientRect();
  const geometry = getViewGeometry(rect.width, rect.height);
  const dx = clientX - rect.left - geometry.cx;
  const dy = clientY - rect.top - geometry.cy;
  const cos = Math.cos(-geometry.radians);
  const sin = Math.sin(-geometry.radians);
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  return {
    u: mod(localX / geometry.tile + 0.5, 1),
    v: mod(localY / geometry.tile + 0.5, 1)
  };
}

function updateCoordinate(uv = scene.cursor) {
  $("#coordU").textContent = Number(uv.u).toFixed(3);
  $("#coordV").textContent = Number(uv.v).toFixed(3);
}

function updateSeamMetric(canvas) {
  try {
    previewMetrics = measureSeams(canvas);
    const element = $("#seamMetric");
    element.textContent = `H ${previewMetrics.horizontal} · V ${previewMetrics.vertical} · R ${previewMetrics.ratio}`;
    element.style.color = previewMetrics.passes ? "var(--green)" : "var(--danger)";
    $("#continuityMetric").textContent = previewMetrics.passes ? "四边通过" : "需复查";
    $("#continuityMetric").className = previewMetrics.passes ? "ok" : "";
  } catch (error) {
    $("#seamMetric").textContent = "检测失败";
    $("#continuityMetric").textContent = "回退可用";
  }
}

function applyPreset(kind) {
  const material = selectedMaterial();
  if (!material) {
    addMaterialLayer(kind);
    return;
  }
  pushHistory();
  const isStone = kind === "stone";
  material.kind = kind;
  material.name = isStone ? "石材 · 基底" : "布纹 · 基底";
  material.params = isStone
    ? { scale: 8, contrast: 0.64, grain: 0.35, weather: 0.26 }
    : { threads: 44, slub: 0.34, wrinkle: 0.34, contrast: 0.46 };
  material.palette = isStone
    ? { base: "#9b9589", vein: "#504b43", accent: "#c39b68" }
    : { base: "#807a6e", vein: "#3d4038", accent: "#c8b696" };
  scene.selectedLayerId = material.id;
  scene.name = isStone ? "石灰岩 · 风化面" : "亚麻布 · 平纹";
  $$(".preset-card").forEach((button) => {
    button.classList.toggle("active", button.id === (isStone ? "presetStone" : "presetFabric"));
  });
  syncUI();
  invalidatePreview({ refreshThumbs: true });
  scheduleSave();
  toast(`已切换为${isStone ? "石灰岩" : "亚麻布"}周期场，所有波形在 U/V 边界取模`, "success", 3000);
}

function addMaterialLayer(kind) {
  pushHistory();
  const layer = createMaterialLayer(kind, scene);
  scene.layers.unshift(layer);
  scene.selectedLayerId = layer.id;
  syncUI();
  invalidatePreview({ refreshThumbs: true });
  scheduleSave();
}

function addBrushLayer() {
  pushHistory();
  const layer = createBrushLayer(scene.layers.filter((item) => item.type === "brush").length + 1);
  scene.layers.push(layer);
  scene.selectedLayerId = layer.id;
  syncUI();
  scheduleSave();
  toast("已添加跨边界刷痕层", "success", 2200);
}

function selectLayer(id) {
  if (!scene.layers.some((layer) => layer.id === id)) return;
  scene.selectedLayerId = id;
  renderLayerList();
  syncMaterialControls();
  scheduleSave();
}

function toggleLayer(id) {
  const layer = scene.layers.find((item) => item.id === id);
  if (!layer) return;
  pushHistory();
  layer.visible = !layer.visible;
  renderLayerList();
  syncMaterialControls();
  invalidatePreview({ refreshThumbs: true });
  scheduleSave();
}

function reorderLayer(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  const uiLayers = [...scene.layers].reverse();
  const fromIndex = uiLayers.findIndex((layer) => layer.id === fromId);
  if (fromIndex < 0) return;
  const [moved] = uiLayers.splice(fromIndex, 1);
  const targetIndex = uiLayers.findIndex((layer) => layer.id === toId);
  uiLayers.splice(targetIndex < 0 ? uiLayers.length : targetIndex, 0, moved);
  pushHistory();
  scene.layers = uiLayers.reverse();
  renderLayerList();
  scheduleSave();
  toast("图层顺序已更新并写入工程", "success", 2200);
}

function setBrushValue(key, value) {
  scene.brush[key] = value;
  syncBrushControls();
  drawViewport();
  scheduleSave();
}

function updateMaterialParameter(key, value) {
  const material = selectedMaterial();
  if (!material) return;
  pushHistory();
  material.params[key] = value;
  const outputMap = {
    scale: ["#stoneScaleOut", Number(value).toFixed(1)],
    contrast: ["#stoneContrastOut", `${Math.round(value * 100)}%`],
    grain: ["#stoneGrainOut", `${Math.round(value * 100)}%`],
    weather: ["#stoneWeatherOut", `${Math.round(value * 100)}%`],
    threads: ["#fabricThreadsOut", String(value)],
    slub: ["#fabricSlubOut", `${Math.round(value * 100)}%`],
    wrinkle: ["#fabricWrinkleOut", `${Math.round(value * 100)}%`]
  };
  if (outputMap[key]) $(outputMap[key][0]).textContent = outputMap[key][1];
  invalidatePreview({ refreshThumbs: true });
  scheduleSave();
}

function updateMaterialColor(key, value) {
  const material = selectedMaterial();
  if (!material) return;
  pushHistory();
  material.palette[key] = formatHex(value);
  invalidatePreview({ refreshThumbs: true });
  scheduleSave();
}

function handlePointerDown(event) {
  if (event.button !== 0) return;
  previewCanvas.setPointerCapture?.(event.pointerId);
  const uv = eventToUV(event.clientX, event.clientY);
  scene.cursor = { u: uv.u, v: uv.v };
  updateCoordinate();
  pointerInside = true;
  pointerScreen = { x: event.clientX, y: event.clientY };
  if (scene.tool === "hand" || event.altKey) {
    panning = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: scene.view.panX,
      panY: scene.view.panY
    };
    previewCanvas.classList.add("hand");
    return;
  }
  const layer = activeBrushLayer();
  pushHistory();
  const stroke = {
    id: `stroke-${stableHash(`${Date.now()}-${uv.u}-${uv.v}`)}`,
    color: formatHex(scene.brush.color),
    size: Number(scene.brush.size),
    hardness: Number(scene.brush.hardness),
    opacity: Number(scene.brush.opacity),
    points: [{ x: uv.u, y: uv.v }]
  };
  layer.strokes.push(stroke);
  painting = { layer, stroke, pointerId: event.pointerId };
  previewCanvas.classList.add("painting");
  syncMaterialControls();
  renderLayerList();
  invalidatePreview({ refreshThumbs: false });
}

function handlePointerMove(event) {
  pointerInside = true;
  pointerScreen = { x: event.clientX, y: event.clientY };
  if (panning) {
    scene.view.panX = panning.panX + event.clientX - panning.startX;
    scene.view.panY = panning.panY + event.clientY - panning.startY;
    drawViewport();
    scheduleSave();
    return;
  }
  const uv = eventToUV(event.clientX, event.clientY);
  scene.cursor = { u: uv.u, v: uv.v };
  updateCoordinate();
  if (painting) {
    const previous = painting.stroke.points.at(-1);
    const next = nearestWrappedPoint(previous, { x: uv.u, y: uv.v });
    if (Math.hypot(next.x - previous.x, next.y - previous.y) > 0.0007) {
      painting.stroke.points.push(next);
      invalidatePreview({ refreshThumbs: false });
    }
  }
  drawViewport();
  scheduleSave();
}

function handlePointerUp(event) {
  if (painting) {
    const uv = eventToUV(event.clientX, event.clientY);
    const previous = painting.stroke.points.at(-1);
    const next = nearestWrappedPoint(previous, { x: uv.u, y: uv.v });
    if (Math.hypot(next.x - previous.x, next.y - previous.y) > 0.0007) painting.stroke.points.push(next);
    const finished = painting;
    painting = null;
    previewCanvas.classList.remove("painting");
    previewCanvas.releasePointerCapture?.(finished.pointerId);
    renderLayerList();
    invalidatePreview({ refreshThumbs: true });
    saveNow(false);
  }
  if (panning) {
    panning = null;
    previewCanvas.classList.remove("hand");
    scheduleSave();
  }
}

function handlePointerLeave() {
  if (painting || panning) return;
  pointerInside = false;
  drawViewport();
}

function materialKind() {
  return selectedMaterial()?.kind === "fabric" ? "fabric" : "stone";
}

function timestampName() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

function prepareExportSnapshot(reason, size) {
  const result = createSnapshot(scene, reason, size);
  if (!result.stored) {
    downloadText(JSON.stringify(result.snapshot, null, 2), `seamlab-snapshot-${result.snapshot.id}.json`);
    toast("本机快照存储失败，已自动下载 JSON 快照；导出继续。", "error", 5200);
  }
  syncSnapshots();
  return result.snapshot;
}

function renderForExport(size, options = {}) {
  try {
    return renderScene(scene, size);
  } catch (error) {
    clearMaterialCache();
    clearThumbnailCache();
    const fallback = renderScene(scene, size, { quiet: true });
    setDiagnostic("导出缓存失效 → 已清空并重建", "warn");
    if (!options.silent) toast(`导出缓存失效，已清空旧缓存并从参数重建：${error.message}`, "error", 5500);
    return fallback;
  }
}

async function exportTexture(size, options = {}) {
  if (exporting) return null;
  exporting = true;
  setExportStatus(`正在构建 ${size}×${size}…`, "busy");
  if (!options.skipSnapshot) prepareExportSnapshot(options.reason || `${size} 导出前自动留档`, size);
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const canvas = renderForExport(size);
    const blob = await canvasToBlob(canvas);
    if (!options.noDownload) {
      downloadBlob(blob, `seamlab-${materialKind()}-${size}-${timestampName()}.png`);
    }
    const metrics = measureSeams(canvas);
    window.__SEAMLAB_LAST_EXPORT__ = { size, canvas, metrics, at: Date.now() };
    setExportStatus(`${size}×${size} 已导出 · 接缝比 ${metrics.ratio} · 快照已保留`, "ok");
    toast(`${size}×${size} PNG 已导出，导出前工程快照已保留`, "success", 3200);
    return { canvas, blob, metrics };
  } catch (error) {
    setExportStatus(`导出失败：${error.message}`, "error");
    toast(`导出失败：${error.message}。工程未改动，请重试。`, "error", 5200);
    return null;
  } finally {
    exporting = false;
  }
}

async function exportBothSizes() {
  if (exporting) return [];
  const snapshot = prepareExportSnapshot("512 + 1024 双尺寸导出前留档", 1024);
  const results = [];
  for (const size of [512, 1024]) {
    const result = await exportTexture(size, { skipSnapshot: true, reason: snapshot.reason });
    if (result) results.push(result);
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  if (results.length === 2) {
    const maxDelta = Math.abs(results[0].metrics.ratio - results[1].metrics.ratio);
    setExportStatus(`512 / 1024 均已导出 · 同源场景 · 接缝比差 ${maxDelta.toFixed(2)}`, "ok");
    toast("双尺寸导出完成；工程快照含图层顺序、关键帧、坐标与颜色。", "success", 4600);
  }
  return results;
}

async function exportTileCheck() {
  if (exporting) return null;
  exporting = true;
  try {
    prepareExportSnapshot("2×2 平铺检查前留档", scene.exportSize);
    setExportStatus("正在生成无间隙 2×2 平铺检查…", "busy");
    const source = renderForExport(scene.exportSize);
    const tiled = buildTileCheck(source);
    const blob = await canvasToBlob(tiled);
    downloadBlob(blob, `seamlab-${materialKind()}-tile2x2-${timestampName()}.png`);
    const metrics = measureSeams(source);
    setExportStatus(`2×2 检查已导出 · 接缝比 ${metrics.ratio}，无中间缝隙`, "ok");
    toast(`2×2 平铺图已导出；四边接缝比 ${metrics.ratio}${metrics.passes ? "，通过" : "，需复查"}`, metrics.passes ? "success" : "info");
    return { canvas: tiled, metrics };
  } catch (error) {
    setExportStatus(`平铺检查失败：${error.message}`, "error");
    toast(`平铺检查生成失败，已保留快照：${error.message}`, "error");
    return null;
  } finally {
    exporting = false;
  }
}

async function exportComparison() {
  if (exporting) return null;
  exporting = true;
  try {
    prepareExportSnapshot("512 / 1024 重采样对比前留档", 512);
    setExportStatus("正在比较直接 512 与 1024 缩小版本…", "busy");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const direct = renderForExport(512, { silent: true });
    const large = renderForExport(1024, { silent: true });
    const downscaled = resizeCanvas(large, 512);
    const metrics = compareCanvases(direct, downscaled);
    const report = buildComparisonReport(direct, downscaled, metrics);
    const reportBlob = await canvasToBlob(report);
    downloadBlob(reportBlob, `seamlab-compare-512-${timestampName()}.png`);
    const json = {
      generatedAt: new Date().toISOString(),
      sceneDigest: sceneDigest(scene),
      direct: "512 normalized scene",
      comparison: "1024 normalized scene box-filtered to 512",
      metrics,
      seams: { direct512: measureSeams(direct), source1024: measureSeams(large) }
    };
    downloadText(JSON.stringify(json, null, 2), `seamlab-compare-${timestampName()}.json`);
    window.__SEAMLAB_LAST_COMPARE__ = { metrics, direct, downscaled, report, json };
    setExportStatus(`对比完成 · MAE ${metrics.mae} · PSNR ${metrics.psnr} dB · ${metrics.passes ? "通过" : "复查"}`, metrics.passes ? "ok" : "error");
    toast(`重采样对比：MAE ${metrics.mae}/255，变化像素 ${metrics.changedPercent}%`, metrics.passes ? "success" : "error", 5200);
    return { metrics, report };
  } catch (error) {
    setExportStatus(`对比失败：${error.message}`, "error");
    toast(`重采样对比失败：${error.message}`, "error");
    return null;
  } finally {
    exporting = false;
  }
}

function simulateCacheFailure() {
  const materialCount = clearMaterialCache();
  clearThumbnailCache();
  forceThumbnailFallback = false;
  setDiagnostic(`材质缓存 ${materialCount} 项已判定失效，正在按参数重建`, "warn");
  toast("材质缓存失效：旧内容已丢弃，现从工程参数重新生成。", "error", 4600);
  invalidatePreview({ refreshThumbs: true });
}

function simulateThumbnailFailure() {
  clearThumbnailCache();
  forceThumbnailFallback = true;
  renderLayerList();
  setDiagnostic("缩略图缓存失效 → 已从主纹理重建缩略图", "warn");
  toast("缩略图缓存失效：已自动从主纹理重建，未显示破图或空白。", "error", 4600);
  window.setTimeout(() => {
    forceThumbnailFallback = false;
    renderLayerList();
  }, 1400);
}

function simulateAsyncFailure() {
  setDiagnostic("异步纹理请求被强制中断，等待回退…", "warn");
  invalidatePreview({ failAsync: true, refreshThumbs: true });
}

function canvasVariance(canvas) {
  const data = canvas.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height).data;
  let min = 255;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 40) {
    const luminance = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
    min = Math.min(min, luminance);
    max = Math.max(max, luminance);
    sum += luminance;
  }
  return { range: max - min, mean: sum / (data.length / 40) };
}

function resultLine(name, passed, detail) {
  return { name, passed, detail };
}

async function runParameterTests() {
  if (testRunning) return null;
  testRunning = true;
  setDiagnostic("正在运行默认 / 边界 / 异常三组参数测试…", "warn");
  const startedAt = performance.now();
  try {
    const defaultDemo = normalizeScene(defaultScene());
    const default512 = renderScene(defaultDemo, 512, { quiet: true });
    const default1024 = renderScene(defaultDemo, 1024, { quiet: true });
    const defaultDown = resizeCanvas(default1024, 512);
    const defaultSeam = measureSeams(default512);
    const defaultCompare = compareCanvases(default512, defaultDown);
    const defaultResult = resultLine(
      "默认参数",
      defaultSeam.passes && defaultCompare.passes,
      `8 晶胞 / 64% 对比 / 35% 颗粒 / 26% 风化 · 接缝 ${defaultSeam.ratio} · MAE ${defaultCompare.mae}`
    );

    const boundaryDemo = normalizeScene(defaultScene());
    const boundaryStone = boundaryDemo.layers.find((layer) => layer.kind === "stone");
    boundaryStone.params = { scale: 14, contrast: 1, grain: 1, weather: 1 };
    const fabric = createMaterialLayer("fabric", boundaryDemo);
    fabric.params = { threads: 96, slub: 1, wrinkle: 1, contrast: 1 };
    boundaryDemo.layers = [fabric];
    const brushLayer = createBrushLayer(1);
    brushLayer.strokes = [{
      id: "boundary-stroke",
      color: "#d8b074",
      size: 160,
      hardness: 1,
      opacity: 1,
      points: [
        { x: 0.97, y: 0.06 },
        { x: 1.035, y: 0.12 },
        { x: 1.02, y: 0.98 },
        { x: 0.01, y: 1.025 }
      ]
    }];
    boundaryDemo.layers.push(brushLayer);
    const boundaryCanvas = renderScene(boundaryDemo, 512, { quiet: true });
    const boundarySeam = measureSeams(boundaryCanvas);
    const boundaryVariance = canvasVariance(boundaryCanvas);
    const boundaryResult = resultLine(
      "边界参数",
      boundarySeam.passes && boundaryVariance.range > 12,
      `96 纬密 / 100% 对比 / 160px 跨角笔刷 · 接缝 ${boundarySeam.ratio} · 动态范围 ${boundaryVariance.range.toFixed(1)}`
    );

    const invalid = normalizeScene({ layers: [], keyframes: null, brush: null, view: null });
    clearMaterialCache();
    clearThumbnailCache();
    const corruptScene = {
      ...normalizeScene(defaultScene()),
      layers: [{
        ...defaultDemo.layers[0],
        params: { scale: "invalid", contrast: 0.6, grain: 0.3, weather: 0.2 },
        palette: { base: "not-a-color", vein: "#444444", accent: "#aa8844" }
      }]
    };
    const fallbackCanvas = renderScene(corruptScene, 256, { quiet: true });
    const fallbackVariance = canvasVariance(fallbackCanvas);
    const invalidDigestA = sceneDigest(invalid);
    const invalidDigestB = sceneDigest(normalizeScene(JSON.parse(JSON.stringify(invalid))));
    simulateAsyncFailure();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const fallbackVisible = compositeCanvas.width === 1024 && $("#renderMode").textContent.includes("回退");
    const exceptionResult = resultLine(
      "异常参数",
      fallbackVisible && fallbackVariance.range > 8 && invalidDigestA === invalidDigestB,
      `损坏缓存→参数重建 · 异步超时→同步回退 · 非法颜色/尺度被归一化 · 快照摘要稳定`
    );

    const results = [defaultResult, boundaryResult, exceptionResult];
    const passed = results.every((result) => result.passed);
    const elapsed = Math.round(performance.now() - startedAt);
    const report = { passed, elapsed, results, at: new Date().toISOString(), sceneDigest: sceneDigest(scene) };
    window.__SEAMLAB_TESTS__ = report;
    setDiagnostic(
      `${results.map((result) => `${result.name} ${result.passed ? "PASS" : "FAIL"}`).join(" · ")} · ${elapsed} ms`,
      passed ? "idle" : "error"
    );
    toast(
      passed
        ? `三组参数测试全部通过（${elapsed} ms）：默认、边界、异常回退。`
        : `参数测试存在失败项，详见诊断状态与 __SEAMLAB_TESTS__。`,
      passed ? "success" : "error",
      6200
    );
    if (passed) {
      $("#renderMode").textContent = "参数验收通过 · 同步渲染";
      invalidatePreview({ refreshThumbs: true });
    }
    return report;
  } catch (error) {
    setDiagnostic(`参数测试异常：${error.message}`, "error");
    toast(`参数测试失败：${error.message}`, "error");
    return { passed: false, error: error.message };
  } finally {
    testRunning = false;
  }
}

function bindEvents() {
  $$(".tool-btn").forEach((button) => {
    button.addEventListener("click", () => setTool(button.dataset.tool));
  });
  $("#presetStone").addEventListener("click", () => applyPreset("stone"));
  $("#presetFabric").addEventListener("click", () => applyPreset("fabric"));
  $("#addStoneLayer").addEventListener("click", () => addMaterialLayer("stone"));
  $("#addFabricLayer").addEventListener("click", () => addMaterialLayer("fabric"));
  $("#addBrushLayer").addEventListener("click", addBrushLayer);

  $("#layerList").addEventListener("click", (event) => {
    const item = event.target.closest(".layer-item");
    if (!item) return;
    if (event.target.closest("[data-action='visibility']")) {
      event.stopPropagation();
      toggleLayer(item.dataset.layerId);
      return;
    }
    selectLayer(item.dataset.layerId);
  });

  let draggedLayerId = null;
  $("#layerList").addEventListener("dragstart", (event) => {
    const item = event.target.closest(".layer-item");
    if (!item) return;
    draggedLayerId = item.dataset.layerId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedLayerId);
  });
  $("#layerList").addEventListener("dragover", (event) => {
    if (dragIdActive(event)) event.preventDefault();
  });
  $("#layerList").addEventListener("drop", (event) => {
    const item = event.target.closest(".layer-item");
    if (!item) return;
    event.preventDefault();
    reorderLayer(draggedLayerId || event.dataTransfer.getData("text/plain"), item.dataset.layerId);
    draggedLayerId = null;
  });

  $("#seamToggle").addEventListener("click", () => {
    scene.view.seam = !scene.view.seam;
    syncViewControls();
    drawViewport();
    scheduleSave();
  });
  $("#tileToggle").addEventListener("click", () => {
    scene.view.tiling = !scene.view.tiling;
    syncViewControls();
    drawViewport();
    scheduleSave();
  });
  $("#zoomRange").addEventListener("input", (event) => setZoom(Number(event.target.value) / 100));
  $("#zoomOut").addEventListener("click", () => setZoom(scene.view.zoom - 0.15));
  $("#zoomIn").addEventListener("click", () => setZoom(scene.view.zoom + 0.15));
  $("#rotateLeft").addEventListener("click", () => rotateBy(-15));
  $("#rotateRight").addEventListener("click", () => rotateBy(15));
  $("#resetView").addEventListener("click", () => {
    scene.view.zoom = 1;
    scene.view.rotation = 0;
    scene.view.panX = 0;
    scene.view.panY = 0;
    syncViewControls();
    drawViewport();
    scheduleSave();
  });

  const stoneInputs = {
    stoneScale: { key: "scale", read: (value) => Number(value), write: (value) => Number(value).toFixed(1) },
    stoneContrast: { key: "contrast", read: (value) => Number(value) / 100, write: (value) => `${Math.round(value * 100)}%` },
    stoneGrain: { key: "grain", read: (value) => Number(value) / 100, write: (value) => `${Math.round(value * 100)}%` },
    stoneWeather: { key: "weather", read: (value) => Number(value) / 100, write: (value) => `${Math.round(value * 100)}%` }
  };
  Object.entries(stoneInputs).forEach(([id, config]) => {
    $(`#${id}`).addEventListener("input", (event) => {
      const value = config.read(event.target.value);
      $(`#${id}Out`).textContent = config.write(value);
      updateMaterialParameter(config.key, value);
    });
  });
  const fabricInputs = {
    fabricThreads: { key: "threads", read: (value) => Number(value) },
    fabricSlub: { key: "slub", read: (value) => Number(value) / 100 },
    fabricWrinkle: { key: "wrinkle", read: (value) => Number(value) / 100 },
    fabricContrast: { key: "contrast", read: (value) => Number(value) / 100 }
  };
  Object.entries(fabricInputs).forEach(([id, config]) => {
    $(`#${id}`).addEventListener("input", (event) => {
      updateMaterialParameter(config.key, config.read(event.target.value));
    });
  });
  $("#colorBase").addEventListener("input", (event) => updateMaterialColor("base", event.target.value));
  $("#colorVein").addEventListener("input", (event) => updateMaterialColor("vein", event.target.value));
  $("#colorAccent").addEventListener("input", (event) => updateMaterialColor("accent", event.target.value));

  $("#brushSize").addEventListener("input", (event) => setBrushValue("size", Number(event.target.value)));
  $("#brushHardness").addEventListener("input", (event) => setBrushValue("hardness", Number(event.target.value) / 100));
  $("#brushOpacity").addEventListener("input", (event) => setBrushValue("opacity", Number(event.target.value) / 100));
  $("#brushColor").addEventListener("input", (event) => setBrushValue("color", formatHex(event.target.value)));
  $$(".swatch").forEach((swatch) => {
    swatch.addEventListener("click", () => setBrushValue("color", swatch.dataset.color));
  });

  $("#playheadRange").addEventListener("input", (event) => {
    scene.currentTime = Number(event.target.value);
    syncTimeline();
    invalidatePreview({ refreshThumbs: true });
    scheduleSave();
  });
  $("#keyframeTrack").addEventListener("click", (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    scene.currentTime = Math.min(100, Math.max(0, (event.clientX - rect.left) / rect.width * 100));
    syncTimeline();
    invalidatePreview({ refreshThumbs: true });
    scheduleSave();
  });
  $("#addKeyframe").addEventListener("click", () => {
    pushHistory();
    const time = Math.round(scene.currentTime);
    const interpolation = interpolateKeyframes(scene.keyframes, time);
    const existing = scene.keyframes.find((frame) => Math.abs(frame.time - time) < 0.5);
    if (existing) {
      existing.label = `状态 ${time}%`;
    } else {
      scene.keyframes.push({
        id: `keyframe-${stableHash(`${Date.now()}-${time}`)}`,
        time,
        label: `状态 ${time}%`,
        weather: interpolation.weather,
        slub: interpolation.slub
      });
    }
    scene.keyframes.sort((a, b) => a.time - b.time);
    syncTimeline();
    scheduleSave();
    toast(`已添加 ${time}% 参数关键帧`, "success", 2400);
  });

  $("#export512").addEventListener("click", () => {
    scene.exportSize = 512;
    $("#export512").classList.add("active");
    $("#export1024").classList.remove("active");
    setExportStatus("已选择 512×512；可单击导出或使用双尺寸导出", "ok");
    scheduleSave();
  });
  $("#export1024").addEventListener("click", () => {
    scene.exportSize = 1024;
    $("#export1024").classList.add("active");
    $("#export512").classList.remove("active");
    setExportStatus("已选择 1024×1024；可单击导出或使用双尺寸导出", "ok");
    scheduleSave();
  });
  $("#quickExport").addEventListener("click", () => exportTexture(scene.exportSize));
  $("#exportBoth").addEventListener("click", exportBothSizes);
  $("#exportTile").addEventListener("click", exportTileCheck);
  $("#exportCompare").addEventListener("click", exportComparison);

  $("#failureCache").addEventListener("click", simulateCacheFailure);
  $("#failureThumb").addEventListener("click", simulateThumbnailFailure);
  $("#failureAsync").addEventListener("click", simulateAsyncFailure);
  $("#runParamTests").addEventListener("click", async () => {
    const button = $("#runParamTests");
    button.disabled = true;
    button.textContent = "测试运行中…";
    await runParameterTests();
    button.disabled = false;
    button.textContent = "运行默认 / 边界 / 异常参数测试";
  });

  $("#saveBtn").addEventListener("click", () => saveNow(true));
  $("#reloadBtn").addEventListener("click", () => {
    if (!saveNow(false)) {
      toast("保存失败，已取消重载以避免丢失当前工程。", "error");
      return;
    }
    prepareReloadCheck(scene);
    location.reload();
  });
  $("#undoBtn").addEventListener("click", undo);
  $("#redoBtn").addEventListener("click", redo);

  previewCanvas.addEventListener("pointerdown", handlePointerDown);
  previewCanvas.addEventListener("pointermove", handlePointerMove);
  previewCanvas.addEventListener("pointerup", handlePointerUp);
  previewCanvas.addEventListener("pointercancel", handlePointerUp);
  previewCanvas.addEventListener("pointerleave", handlePointerLeave);
  previewCanvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    setZoom(scene.view.zoom * (event.deltaY < 0 ? 1.08 : 0.93));
  }, { passive: false });

  document.addEventListener("keydown", (event) => {
    const tag = event.target.tagName;
    const editing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if (event.ctrlKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveNow(true);
      return;
    }
    if (editing) return;
    if (event.key.toLowerCase() === "b") setTool("brush");
    if (event.key.toLowerCase() === "h") setTool("hand");
  });

  new ResizeObserver(() => drawViewport()).observe(canvasShell);
  window.addEventListener("pagehide", () => saveProject(scene));
}

function dragIdActive(event) {
  return Boolean(event.dataTransfer?.types?.includes("text/plain"));
}

function init() {
  bindEvents();
  const material = selectedMaterial();
  $$(".preset-card").forEach((button) => {
    button.classList.toggle("active", button.id === (material?.kind === "fabric" ? "presetFabric" : "presetStone"));
  });
  syncUI();
  drawViewport();
  updateSeamMetric(compositeCanvas);
  setTool(scene.tool);
  if (boot.error) {
    toast(`本地工程缓存损坏，已自动回退到默认工程：${boot.error}`, "error", 5600);
    setDiagnostic("工程缓存损坏 → 默认工程回退成功", "warn");
  } else if (boot.restored) {
    const check = consumeReloadCheck(scene);
    if (check?.ok) {
      toast(`工程重载校验通过：图层顺序、关键帧、坐标和颜色摘要 ${check.current} 一致。`, "success", 5600);
      setDiagnostic(`重载摘要校验通过 · ${check.current}`, "idle");
    } else if (check && !check.ok) {
      toast(`工程重载摘要不一致（${check.previous || "无记录"} → ${check.current}），已从保存工程恢复。`, "error", 5600);
      setDiagnostic("重载摘要不一致，请检查快照", "error");
    } else {
      toast("已从本机恢复上次工程与视图坐标", "success", 3000);
    }
  }
  window.setTimeout(() => invalidatePreview({ refreshThumbs: true }), 20);
}

window.SeamLab = {
  version: "1.0.0",
  getScene: () => clone(scene),
  getDigest: () => sceneDigest(scene),
  getState: () => ({
    digest: sceneDigest(scene),
    scene: clone(scene),
    metrics: previewMetrics,
    thumbnails: thumbnailStatus,
    renderMode: $("#renderMode").textContent,
    savedAt: lastSavedAt
  }),
  setScene: (next, options = {}) => {
    if (options.history !== false) pushHistory();
    scene = normalizeScene(next);
    forceThumbnailFallback = false;
    compositeCanvas = renderScene(scene, 1024);
    syncUI();
    drawViewport();
    updateSeamMetric(compositeCanvas);
    if (options.save !== false) saveNow(false);
    invalidatePreview({ refreshThumbs: true });
    return sceneDigest(scene);
  },
  save: saveNow,
  reloadCheck: () => {
    saveNow(false);
    prepareReloadCheck(scene);
    location.reload();
  },
  previewDataUrl: () => canvasDataUrl(compositeCanvas),
  renderDataUrl: (size = 1024, options = {}) => {
    const canvas = renderForExport(Number(size), { silent: options.silent });
    return options.withMetrics ? { dataUrl: canvasDataUrl(canvas), metrics: measureSeams(canvas) } : canvasDataUrl(canvas);
  },
  tileDataUrl: (size = 1024) => canvasDataUrl(buildTileCheck(renderForExport(Number(size))), "image/png"),
  comparison: () => {
    const direct = renderForExport(512, { silent: true });
    const large = renderForExport(1024, { silent: true });
    const downscaled = resizeCanvas(large, 512);
    const metrics = compareCanvases(direct, downscaled);
    const report = buildComparisonReport(direct, downscaled, metrics);
    return {
      metrics,
      direct: canvasDataUrl(direct),
      downscaled: canvasDataUrl(downscaled),
      report: canvasDataUrl(report),
      seams: { direct: measureSeams(direct), source1024: measureSeams(large) }
    };
  },
  runParameterTests,
  simulateFailure: (kind) => {
    if (kind === "cache") simulateCacheFailure();
    if (kind === "thumbnail") simulateThumbnailFailure();
    if (kind === "async") simulateAsyncFailure();
  },
  snapshots: readSnapshots,
  prepareSnapshot: (reason = "测试导出前留档", size = 1024) => prepareExportSnapshot(reason, size),
  exportBothSizes,
  addBoundaryStroke: () => {
    let layer = scene.layers.find((item) => item.type === "brush");
    if (!layer) {
      layer = createBrushLayer(1);
      scene.layers.push(layer);
    }
    pushHistory();
    layer.strokes.push({
      id: "api-boundary-stroke",
      color: scene.brush.color,
      size: scene.brush.size,
      hardness: scene.brush.hardness,
      opacity: scene.brush.opacity,
      points: [
        { x: 0.96, y: 0.18 },
        { x: 1.03, y: 0.24 },
        { x: 1.03, y: 0.94 },
        { x: 0.04, y: 1.03 },
        { x: -0.02, y: 0.06 }
      ]
    });
    syncUI();
    invalidatePreview({ refreshThumbs: true });
    saveNow(false);
    return layer.strokes.length;
  }
};

init();
