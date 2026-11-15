import {
  ALGORITHM_VERSION,
  PARAM_PRESETS,
  DEFAULT_PARAMS,
  PARAM_BOUNDS,
  normalizeParams,
  resultWithoutMask,
  vectorizeSample
} from "./vectorizer.js";
import {
  createCrossingSample,
  rasterFromImageData
} from "./samples.js";
import {
  addResultLayer,
  createProjectFromResult,
  deleteLayer,
  deserializeProject,
  duplicateLayer,
  interpolateKeyframe,
  layerToVectorResult,
  moveLayer,
  normalizeProject,
  projectFingerprint,
  replaceLayerGeometry,
  serializeProject,
  upsertKeyframe
} from "./project.js";
import {
  buildSceneSvg,
  exportSvgDocument,
  svgDataUrl
} from "./svg.js";
import {
  clearSavedProject,
  loadProject,
  readSnapshots,
  saveProject,
  writeSnapshot
} from "./storage.js";
import {
  attachThumbnailFallback,
  vectorizeWithRecovery
} from "./async-vectorize.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  sourceCanvas: $("#sourceCanvas"),
  sourcePreviewCanvas: $("#sourcePreviewCanvas"),
  svgPreview: $("#svgPreview"),
  nodeOverlay: $("#nodeOverlay"),
  stageViewport: $("#stageViewport"),
  canvasWrap: $("#canvasWrap"),
  stageEmpty: $("#stageEmpty"),
  viewportBadge: $("#viewportBadge"),
  projectName: $("#projectName"),
  saveState: $("#saveState"),
  previewSize: $("#previewSize"),
  zoomSelect: $("#zoomSelect"),
  vectorViewButton: $("#vectorViewButton"),
  sourceViewButton: $("#sourceViewButton"),
  nodeToggleButton: $("#nodeToggleButton"),
  pathInspector: $("#pathInspector"),
  selectedPathLabel: $("#selectedPathLabel"),
  metricNodes: $("#metricNodes"),
  metricNodesDelta: $("#metricNodesDelta"),
  metricPaths: $("#metricPaths"),
  metricThin: $("#metricThin"),
  metricNoise: $("#metricNoise"),
  metricFiltered: $("#metricFiltered"),
  metricCompleteness: $("#metricCompleteness"),
  completenessBar: $("#completenessBar"),
  thinCheck: $("#thinCheck"),
  noiseCheck: $("#noiseCheck"),
  keyframeCheck: $("#keyframeCheck"),
  parityChip: $("#parityChip"),
  layerList: $("#layerList"),
  layerColor: $("#layerColor"),
  layerColorValue: $("#layerColorValue"),
  layerOpacity: $("#layerOpacity"),
  layerOpacityValue: $("#layerOpacityValue"),
  snapshotList: $("#snapshotList"),
  snapshotCount: $("#snapshotCount"),
  noticeList: $("#noticeList"),
  toastStack: $("#toastStack"),
  timelineLayerName: $("#timelineLayerName"),
  frameReadout: $("#frameReadout"),
  timeRange: $("#timeRange"),
  keyframeMarkers: $("#keyframeMarkers"),
  frameX: $("#frameX"),
  frameY: $("#frameY"),
  frameScale: $("#frameScale"),
  frameRotation: $("#frameRotation"),
  frameOpacity: $("#frameOpacity"),
  comparisonModal: $("#comparisonModal"),
  comparisonGrid: $("#comparisonGrid"),
  comparisonSummary: $("#comparisonSummary"),
  downloadReportButton: $("#downloadReportButton"),
  applyDefaultResultButton: $("#applyDefaultResultButton")
};

const params = {
  threshold: { range: $("#thresholdRange"), output: $("#thresholdValue"), digits: 0 },
  smoothing: { range: $("#smoothingRange"), output: $("#smoothingValue"), digits: 0 },
  merge: { range: $("#mergeRange"), output: $("#mergeValue"), digits: 1 },
  minRegion: { range: $("#minRegionRange"), output: $("#minRegionValue"), digits: 0 }
};

const state = {
  sample: createCrossingSample(),
  project: null,
  currentResult: null,
  time: 0,
  selectedPathId: null,
  showNodes: false,
  view: "vector",
  zoom: "fit",
  displayScale: 1,
  notices: [],
  comparison: null,
  busy: false,
  activePreset: "default",
  saveTimer: null,
  vectorTimer: null,
  storageFailureNotified: false,
  currentRequest: 0
};

function activeLayer() {
  return state.project?.layers.find((layer) => layer.id === state.project.activeLayerId)
    || state.project?.layers[0]
    || null;
}

function activeLayerIndex() {
  return state.project?.layers.findIndex((layer) => layer.id === state.project.activeLayerId) ?? -1;
}

function formatClock(date = new Date()) {
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function downloadText(filename, text, type = "application/json") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toast(notice) {
  const node = document.createElement("div");
  node.className = `toast is-${notice.level || "info"}`;
  node.innerHTML = `<div><strong>${escapeHtml(notice.title)}</strong><span>${escapeHtml(notice.message)}</span></div>`;
  elements.toastStack.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(5px)";
    setTimeout(() => node.remove(), 220);
  }, 4200);
}

function pushNotice(notice) {
  const normalized = {
    level: notice.level || "warning",
    title: notice.title || "系统提示",
    message: notice.message || "",
    time: formatClock()
  };
  const recent = state.notices[0];
  if (!recent || recent.title !== normalized.title || recent.message !== normalized.message) {
    state.notices.unshift(normalized);
    state.notices = state.notices.slice(0, 12);
    renderNotices();
    toast(normalized);
  }
}

function renderNotices() {
  if (!state.notices.length) {
    elements.noticeList.innerHTML = '<div class="notice-empty">暂无异常 · 所有服务正常</div>';
    return;
  }
  elements.noticeList.innerHTML = state.notices.map((notice) => (
    `<div class="notice-item ${notice.level === "success" ? "is-info" : ""}">
      <strong>${escapeHtml(notice.title)} · ${escapeHtml(notice.time)}</strong>
      <span>${escapeHtml(notice.message)}</span>
    </div>`
  )).join("");
}

function markSaving() {
  elements.saveState.classList.add("is-saving");
  elements.saveState.lastChild.textContent = "正在保存";
}

function persistProject({ quiet = false } = {}) {
  if (!state.project) return;
  clearTimeout(state.saveTimer);
  markSaving();
  state.saveTimer = setTimeout(() => {
    const result = saveProject(state.project, localStorage);
    elements.saveState.classList.remove("is-saving");
    elements.saveState.lastChild.textContent = result.ok ? "已保存到本机" : "存储不可用";
    if (!result.ok && !state.storageFailureNotified) {
      state.storageFailureNotified = true;
      pushNotice({
        level: "warning",
        title: "本地存储回退",
        message: `${result.error.message}；当前编辑仍在内存中，请及时导出工程快照。`
      });
    } else if (result.ok && !quiet) {
      elements.saveState.classList.remove("is-saving");
    }
  }, 160);
}

function commitProject(project, { quiet = false } = {}) {
  state.project = normalizeProject(project);
  persistProject({ quiet });
  renderAll();
}

function setParamsInControls(values) {
  for (const [key, control] of Object.entries(params)) {
    const bounds = PARAM_BOUNDS[key];
    const value = Math.min(bounds.max, Math.max(bounds.min, Number(values[key])));
    control.range.value = String(value);
    control.output.textContent = Number(value).toFixed(control.digits);
    if (key === "minRegion") control.output.innerHTML = `${Number(value).toFixed(0)} <small>px²</small>`;
    const progress = ((value - bounds.min) / (bounds.max - bounds.min)) * 100;
    control.range.style.setProperty("--range-progress", `${progress}%`);
  }
}

function readParamsFromControls() {
  return {
    threshold: Number(params.threshold.range.value),
    smoothing: Number(params.smoothing.range.value),
    merge: Number(params.merge.range.value),
    minRegion: Number(params.minRegion.range.value)
  };
}

function setActivePreset(preset) {
  state.activePreset = preset;
  $$(".preset-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.preset === preset);
  });
}

function drawSampleToCanvas(sample, canvas) {
  canvas.width = sample.width;
  canvas.height = sample.height;
  const context = canvas.getContext("2d", { alpha: false });
  const image = context.createImageData(sample.width, sample.height);
  for (let index = 0; index < sample.gray.length; index += 1) {
    const offset = index * 4;
    const value = Math.round(sample.gray[index]);
    image.data[offset] = value;
    image.data[offset + 1] = value;
    image.data[offset + 2] = value;
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

function updateCanvasScale() {
  if (!state.project) return;
  const width = state.project.width;
  const height = state.project.height;
  const availableWidth = Math.max(260, elements.stageViewport.clientWidth - 58);
  const availableHeight = Math.max(180, elements.stageViewport.clientHeight - 58);
  let displayWidth;
  if (state.zoom === "fit") {
    displayWidth = Math.min(availableWidth, availableHeight * (width / height), width * 1.15);
  } else {
    displayWidth = width * Number(state.zoom);
  }
  elements.canvasWrap.style.width = `${Math.round(displayWidth)}px`;
  state.displayScale = displayWidth / width;
  elements.previewSize.textContent = `${width} × ${height}`;
}

function renderNodeOverlay() {
  const layer = activeLayer();
  if (!state.showNodes || state.view !== "vector" || !layer) {
    elements.nodeOverlay.hidden = true;
    elements.nodeOverlay.innerHTML = "";
    return;
  }
  const paths = state.selectedPathId
    ? layer.paths.filter((path) => path.id === state.selectedPathId)
    : layer.paths;
  const radius = Math.max(0.25, 2.9 / Math.max(state.displayScale, 0.5));
  const circles = paths.flatMap((path) => path.points.map((point) => (
    `<circle cx="${point.x}" cy="${point.y}" r="${radius.toFixed(2)}" fill="#fbfaf6" stroke="#d9573f" stroke-width="${(1.1 / Math.max(state.displayScale, 0.5)).toFixed(2)}" vector-effect="non-scaling-stroke"/>`
  ))).join("");
  elements.nodeOverlay.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${state.project.width} ${state.project.height}" preserveAspectRatio="none">${circles}</svg>`;
  elements.nodeOverlay.hidden = false;
}

function renderScene() {
  if (!state.project) return;
  updateCanvasScale();
  if (state.view === "source") {
    elements.svgPreview.hidden = true;
    elements.sourcePreviewCanvas.hidden = false;
    elements.nodeOverlay.hidden = true;
    elements.vectorViewButton.classList.remove("is-active");
    elements.sourceViewButton.classList.add("is-active");
    elements.viewportBadge.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg><span>栅格源图 · 仅对照</span>';
    return;
  }
  elements.svgPreview.hidden = false;
  elements.sourcePreviewCanvas.hidden = true;
  elements.vectorViewButton.classList.add("is-active");
  elements.sourceViewButton.classList.remove("is-active");
  elements.viewportBadge.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg><span>纯矢量 · 10× 无栅格</span>';
  const scene = buildSceneSvg(state.project, { time: state.time });
  elements.svgPreview.innerHTML = scene.svg;
  if (state.selectedPathId) {
    const selected = elements.svgPreview.querySelector(`[data-path-id="${CSS.escape(state.selectedPathId)}"]`);
    selected?.classList.add("is-selected");
  }
  renderNodeOverlay();
}

function numericWithSup(value, suffix = "%") {
  return `${Number(value).toFixed(1)}<sup>${suffix}</sup>`;
}

function renderMetrics() {
  const layer = activeLayer();
  if (!layer) return;
  const nodeCount = layer.paths.reduce((sum, path) => sum + path.nodeCount, 0);
  const metrics = state.currentResult?.metrics;
  const defaultRun = state.comparison?.items?.find((item) => item.preset === "default");
  elements.metricNodes.textContent = String(nodeCount);
  if (defaultRun && defaultRun.nodeCount > 0) {
    const delta = ((nodeCount - defaultRun.nodeCount) / defaultRun.nodeCount) * 100;
    elements.metricNodesDelta.textContent = `较默认 ${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`;
  } else {
    elements.metricNodesDelta.textContent = "路径锚点 / 可编辑";
  }
  elements.metricPaths.textContent = String(layer.paths.length);
  elements.metricThin.innerHTML = numericWithSup(metrics?.thinLineCoverage ?? 100);
  elements.metricNoise.innerHTML = numericWithSup(metrics?.noiseRemoved ?? 100);
  elements.metricFiltered.textContent = `${state.currentResult?.filteredComponents ?? 0} 个连通域`;
  elements.metricCompleteness.innerHTML = numericWithSup(metrics?.completeness ?? 100);
  elements.completenessBar.style.width = `${Math.max(0, Math.min(100, metrics?.completeness ?? 100))}%`;
  elements.thinCheck.textContent = (metrics?.thinLineCoverage ?? 100) >= 90 ? "通过" : "需检查";
  elements.thinCheck.className = (metrics?.thinLineCoverage ?? 100) >= 90 ? "status-good" : "";
  elements.noiseCheck.textContent = (metrics?.noiseRemoved ?? 100) >= 90 ? "通过" : "需检查";
  elements.noiseCheck.className = (metrics?.noiseRemoved ?? 100) >= 90 ? "status-good" : "";
}

function layerThumbnail(layer) {
  const miniProject = {
    ...state.project,
    layers: [{ ...layer, visible: true }],
    activeLayerId: layer.id
  };
  try {
    return svgDataUrl(buildSceneSvg(miniProject, { time: 0 }).svg);
  } catch {
    return "";
  }
}

function eyeIcon(visible) {
  return visible
    ? '<svg viewBox="0 0 18 18"><path d="M2.4 9s2.2-4 6.6-4 6.6 4 6.6 4-2.2 4-6.6 4S2.4 9 2.4 9Z" fill="none" stroke="currentColor" stroke-width="1.25"/><circle cx="9" cy="9" r="2" fill="none" stroke="currentColor" stroke-width="1.25"/></svg>'
    : '<svg viewBox="0 0 18 18"><path d="M3 3 15 15M6.5 5.4A7.7 7.7 0 0 1 9 5c4.4 0 6.6 4 6.6 4a11 11 0 0 1-2.1 2.4M4.2 6.3A10 10 0 0 0 2.4 9s2.2 4 6.6 4c.9 0 1.7-.2 2.4-.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
}

function renderLayers() {
  if (!state.project) return;
  const layers = [...state.project.layers].sort((a, b) => b.order - a.order);
  elements.layerList.innerHTML = layers.map((layer) => {
    const thumb = layerThumbnail(layer);
    const nodes = layer.paths.reduce((sum, path) => sum + path.nodeCount, 0);
    return `<div class="layer-item ${layer.id === state.project.activeLayerId ? "is-active" : ""}" data-layer-id="${escapeHtml(layer.id)}" tabindex="0">
      <span class="layer-swatch" style="background:${escapeHtml(layer.color)}"></span>
      <img class="layer-thumb" data-thumb-label="${escapeHtml(layer.name)}" src="${thumb}" alt="${escapeHtml(layer.name)} 缩略图">
      <span class="layer-copy">
        <strong>${escapeHtml(layer.name)}</strong>
        <small>${nodes} 节点 · ${layer.paths.length} 路径</small>
      </span>
      <button class="layer-visibility ${layer.visible ? "" : "is-hidden"}" data-action="visibility" type="button" aria-label="${layer.visible ? "隐藏" : "显示"}${escapeHtml(layer.name)}">${eyeIcon(layer.visible)}</button>
    </div>`;
  }).join("");
  elements.layerList.querySelectorAll(".layer-thumb").forEach((image) => {
    attachThumbnailFallback(image, pushNotice, image.dataset.thumbLabel);
  });
  const layer = activeLayer();
  if (layer) {
    elements.layerColor.value = layer.color;
    elements.layerColorValue.textContent = layer.color.toUpperCase();
    elements.layerOpacity.value = String(Math.round(layer.opacity * 100));
    elements.layerOpacityValue.textContent = `${Math.round(layer.opacity * 100)}%`;
  }
}

function formatReadout(time) {
  const seconds = time;
  const whole = Math.floor(seconds);
  const centiseconds = Math.round((seconds - whole) * 100);
  return `00:${String(whole).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function renderTimeline() {
  const layer = activeLayer();
  if (!layer) return;
  const frame = interpolateKeyframe(layer, state.time);
  elements.timelineLayerName.textContent = layer.name;
  elements.frameReadout.textContent = formatReadout(state.time);
  elements.timeRange.value = String(Math.round(state.time * 1000));
  elements.frameX.value = frame.x.toFixed(1);
  elements.frameY.value = frame.y.toFixed(1);
  elements.frameScale.value = frame.scale.toFixed(2);
  elements.frameRotation.value = frame.rotation.toFixed(1);
  elements.frameOpacity.value = frame.opacity.toFixed(2);
  elements.keyframeMarkers.innerHTML = layer.keyframes.map((keyframe) => (
    `<button class="keyframe-marker ${Math.abs(keyframe.time - state.time) < 0.002 ? "is-current" : ""}" type="button" data-time="${keyframe.time}" style="left:${keyframe.time * 100}%" title="关键帧 ${(keyframe.time * 100).toFixed(0)}%"></button>`
  )).join("");
}

function renderProjectName() {
  if (!state.project) return;
  elements.projectName.textContent = state.project.name;
  document.title = `${state.project.name} · InkTrace Studio`;
}

function renderAll() {
  renderProjectName();
  renderScene();
  renderMetrics();
  renderLayers();
  renderTimeline();
  renderSnapshots();
}

function analyzeLayer(layer) {
  if (!layer) return null;
  const analysis = vectorizeSample(state.sample, layer.params);
  return {
    ...layerToVectorResult(layer),
    metrics: analysis.metrics,
    filteredComponents: analysis.filteredComponents,
    componentCount: analysis.componentCount,
    fallbackApplied: analysis.fallbackApplied,
    warnings: analysis.warnings
  };
}

function applyVectorResult(result, options = {}) {
  state.currentResult = result;
  setParamsInControls(result.params);
  if (result.warnings?.length) {
    pushNotice({
      level: "warning",
      title: "参数已自动钳制",
      message: result.warnings.join("；")
    });
  }
  if (!state.project || options.resetProject) {
    state.project = createProjectFromResult(result, state.sample, {
      id: options.projectId || "uid631-crossing-project",
      projectName: state.sample.id === "crossing-speck-v1"
        ? "交叉线稿 · 清理工程"
        : "导入线稿 · 矢量化工程"
    });
  } else {
    state.project = replaceLayerGeometry(state.project, state.project.activeLayerId, result);
  }
  state.selectedPathId = null;
  if (options.preset) setActivePreset(options.preset);
  commitProject(state.project);
}

async function runVectorization(rawParams, options = {}) {
  if (!state.sample) return;
  const request = ++state.currentRequest;
  state.busy = true;
  elements.stageEmpty.hidden = false;
  const normalizedPreview = normalizeParams(rawParams).params;
  setParamsInControls(normalizedPreview);
  try {
    const outcome = await vectorizeWithRecovery(state.sample, rawParams, {
      notify: pushNotice,
      storage: localStorage,
      timeoutMs: options.timeoutMs || 4000,
      workerFactory: options.workerFactory
    });
    if (request !== state.currentRequest) return;
    const result = outcome.result;
    if (!result?.paths?.length) {
      throw new Error("矢量化返回空路径");
    }
    applyVectorResult(result, options);
    if (!options.quiet) {
      const via = outcome.source === "cache" ? "缓存" : outcome.recovered ? "本地回退" : "Worker";
      toast({
        level: "success",
        title: "矢量化完成",
        message: `${result.nodeCount} 个节点 · ${result.paths.length} 条路径 · ${via}`
      });
    }
  } catch (error) {
    if (request !== state.currentRequest) return;
    try {
      const fallback = resultWithoutMask(vectorizeSample(state.sample, rawParams));
      pushNotice({
        level: "warning",
        title: "矢量化自动回退",
        message: `${error.message}；已改用同步主线程并生成可编辑结果。`
      });
      applyVectorResult(fallback, options);
    } catch (fatal) {
      pushNotice({
        level: "warning",
        title: "矢量化失败",
        message: `${fatal.message}。已保留当前工程画面，不会清空画布。`
      });
    }
  } finally {
    if (request === state.currentRequest) {
      state.busy = false;
      elements.stageEmpty.hidden = true;
    }
  }
}

function scheduleAutoVectorize() {
  clearTimeout(state.vectorTimer);
  state.vectorTimer = setTimeout(() => {
    setActivePreset("custom");
    runVectorization(readParamsFromControls(), { preset: "custom", quiet: true });
  }, 320);
}

function renderSnapshots() {
  const result = readSnapshots(localStorage);
  const snapshots = result.value || [];
  elements.snapshotCount.textContent = String(snapshots.length);
  if (result.error) {
    pushNotice({
      level: "warning",
      title: "快照索引已回退",
      message: `${result.error.message}；列表已按空快照处理，工程画面不受影响。`
    });
  }
  if (!snapshots.length) {
    elements.snapshotList.innerHTML = '<div class="empty-list">尚未建立快照</div>';
    return;
  }
  elements.snapshotList.innerHTML = snapshots.map((snapshot) => {
    const layerCount = Array.isArray(snapshot.project?.layers) ? snapshot.project.layers.length : 0;
    const reason = snapshot.reason === "pre-export" ? "导出前自动" : snapshot.reason === "restore-point" ? "恢复点" : "手动";
    return `<div class="snapshot-item">
      <strong>${escapeHtml(snapshot.label || "工程快照")}</strong>
      <small>${escapeHtml(reason)} · ${layerCount} 图层 · ${formatClock(new Date(snapshot.createdAt))}</small>
      <button type="button" data-snapshot-id="${escapeHtml(snapshot.id)}">恢复</button>
    </div>`;
  }).join("");
}

function createSnapshot(label, reason) {
  if (!state.project) return null;
  const result = writeSnapshot(state.project, label, localStorage, reason);
  if (!result.ok) {
    pushNotice({
      level: "warning",
      title: "快照写入回退",
      message: `${result.error.message}；已继续当前操作，请使用“载入工程”备份。`
    });
    return null;
  }
  renderSnapshots();
  if (result.warning) {
    pushNotice({
      level: "warning",
      title: "旧快照索引已绕过",
      message: `${result.warning}；已写入新的有效快照。`
    });
  }
  return result.snapshot;
}

function restoreSnapshot(snapshotId) {
  const snapshots = readSnapshots(localStorage).value || [];
  const snapshot = snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) {
    pushNotice({
      level: "warning",
      title: "快照不可用",
      message: "快照索引失效，已保留当前工程，请从 JSON 工程文件恢复。"
    });
    return;
  }
  try {
    const restored = normalizeProject(snapshot.project);
    state.project = restored;
    state.time = restored.time || 0;
    state.currentResult = analyzeLayer(activeLayer());
    state.selectedPathId = null;
    setParamsInControls(activeLayer()?.params || DEFAULT_PARAMS);
    commitProject(restored);
    toast({ level: "success", title: "快照已恢复", message: "图层顺序、关键帧、坐标与颜色均已还原。" });
  } catch (error) {
    pushNotice({
      level: "warning",
      title: "快照恢复失败",
      message: `${error.message}；当前工程未被覆盖。`
    });
  }
}

function exportCurrentSvg() {
  if (!state.project) return;
  const snapshot = createSnapshot(
    `导出前 · ${formatClock()}`,
    "pre-export"
  );
  const documentText = exportSvgDocument(state.project, state.time);
  if (/<image\b|data:image\//i.test(documentText)) {
    pushNotice({
      level: "warning",
      title: "导出检查失败",
      message: "检测到位图节点，已中止导出以避免 10× 放大锯齿。"
    });
    return;
  }
  const safeName = state.project.name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "inktrace";
  downloadText(`${safeName}.svg`, documentText, "image/svg+xml");
  toast({
    level: "success",
    title: "SVG 已导出",
    message: `${snapshot ? "工程快照已保留" : "快照存储不可用"} · 纯路径 · 10× 可无损缩放`
  });
}

function verifyRoundTrip() {
  if (!state.project) return;
  try {
    const before = state.project;
    const serialized = serializeProject(before);
    const after = deserializeProject(serialized);
    const sameProject = projectFingerprint(before) === projectFingerprint(after);
    const sameScene = buildSceneSvg(before, { time: state.time }).svg
      === buildSceneSvg(after, { time: state.time }).svg;
    const exportDocument = exportSvgDocument(before, state.time);
    const vectorOnly = !/<image\b|data:image\//i.test(exportDocument);
    const keyframesPreserved = before.layers.every((layer) => {
      const restored = after.layers.find((item) => item.id === layer.id);
      return restored && JSON.stringify(restored.keyframes) === JSON.stringify(layer.keyframes);
    });
    const passed = sameProject && sameScene && vectorOnly && keyframesPreserved;
    elements.parityChip.textContent = passed ? "一致" : "需修复";
    elements.parityChip.className = `status-chip ${passed ? "good" : ""}`;
    elements.keyframeCheck.textContent = keyframesPreserved ? "通过" : "失败";
    elements.keyframeCheck.className = keyframesPreserved ? "status-good" : "";
    toast({
      level: passed ? "success" : "warning",
      title: passed ? "往返校验通过" : "往返校验失败",
      message: passed
        ? "工程序列化前后场景一致；导出为纯矢量，关键帧未改变。"
        : "检测到工程或渲染差异，请查看回退记录。"
    });
    if (!passed) {
      pushNotice({
        level: "warning",
        title: "工程往返校验异常",
        message: `项目 ${sameProject ? "一致" : "不一致"}，场景 ${sameScene ? "一致" : "不一致"}，矢量 ${vectorOnly ? "通过" : "失败"}。`
      });
    }
  } catch (error) {
    pushNotice({
      level: "warning",
      title: "往返校验失败",
      message: `${error.message}；当前工程保持不变。`
    });
  }
}

function comparisonItemMarkup(item, defaultNodes) {
  const result = item.result;
  let preview = "";
  try {
    const miniProject = createProjectFromResult(result, state.sample, {
      layerId: `compare-${item.preset}`,
      name: item.name,
      projectName: item.name
    });
    preview = buildSceneSvg(miniProject, { time: 0 }).svg;
  } catch (error) {
    preview = `<div class="empty-list">${escapeHtml(error.message)}</div>`;
  }
  const nodes = result.nodeCount;
  const delta = defaultNodes > 0 ? ((nodes - defaultNodes) / defaultNodes) * 100 : 0;
  const warnings = result.warnings || [];
  const params = result.params;
  return `<article class="comparison-card ${item.preset === "exception" ? "is-exception" : ""}">
    <div class="comparison-visual">
      <span class="preset-flag">${escapeHtml(item.name)}</span>
      ${preview}
    </div>
    <div class="comparison-body">
      <h3>${escapeHtml(item.name)}</h3>
      <p>${escapeHtml(PARAM_PRESETS[item.preset]?.description || "自定义参数结果")}</p>
      <div class="comparison-stats">
        <div><span>节点</span><b>${nodes}</b></div>
        <div><span>视觉完整度</span><b>${result.metrics.completeness.toFixed(1)}%</b></div>
        <div><span>节点差</span><b>${delta > 0 ? "+" : ""}${delta.toFixed(1)}%</b></div>
      </div>
      <div class="param-pills">
        <span>T ${params.threshold}</span>
        <span>S ${params.smoothing}</span>
        <span>M ${params.merge}</span>
        <span>R ${params.minRegion}</span>
        <span>${result.paths.length} 路径</span>
      </div>
      ${warnings.length ? `<div class="recovery-note">${escapeHtml(warnings.join("；"))}</div>` : ""}
    </div>
  </article>`;
}

function buildComparisonReport() {
  if (!state.comparison) return null;
  return {
    schema: "inktrace-comparison-v1",
    generatedAt: state.comparison.generatedAt,
    algorithm: state.comparison.algorithm,
    sample: {
      id: state.sample.id,
      width: state.sample.width,
      height: state.sample.height,
      note: "交叉线、0.9px 细线与 12 个孤立斑点；固定 seed 631。"
    },
    summary: state.comparison.summary,
    tests: state.comparison.items.map((item) => ({
      preset: item.preset,
      name: item.name,
      params: item.result.params,
      nodeCount: item.result.nodeCount,
      pathCount: item.result.paths.length,
      completeness: item.result.metrics.completeness,
      thinLineCoverage: item.result.metrics.thinLineCoverage,
      noiseRemoved: item.result.metrics.noiseRemoved,
      filteredComponents: item.result.filteredComponents,
      fallbackApplied: item.result.fallbackApplied,
      warnings: item.result.warnings,
      source: item.source
    }))
  };
}

async function runComparison() {
  if (state.busy) {
    toast({ level: "warning", title: "正在计算", message: "请等待当前矢量化完成后再运行对比。" });
    return;
  }
  elements.comparisonModal.hidden = false;
  elements.comparisonGrid.innerHTML = '<div class="comparison-loading"><span class="spinner"></span>正在生成三组可重复结果…</div>';
  elements.comparisonSummary.textContent = "正在计算默认、边界与异常参数…";
  elements.applyDefaultResultButton.disabled = true;
  const items = [];
  for (const preset of ["default", "boundary", "exception"]) {
    const definition = PARAM_PRESETS[preset];
    try {
      const outcome = await vectorizeWithRecovery(state.sample, definition.params, {
        notify: pushNotice,
        storage: localStorage,
        timeoutMs: 4000
      });
      items.push({
        preset,
        name: definition.name,
        source: outcome.source,
        result: {
          ...outcome.result,
          warnings: outcome.result.warnings || []
        }
      });
    } catch (error) {
      const fallback = resultWithoutMask(vectorizeSample(state.sample, definition.params));
      fallback.warnings = [...(fallback.warnings || []), `异步失败后同步回退：${error.message}`];
      pushNotice({
        level: "warning",
        title: `${definition.name}回退`,
        message: `${error.message}；已使用同步算法补齐该组结果。`
      });
      items.push({ preset, name: definition.name, source: "main-thread-fallback", result: fallback });
    }
    const defaultNodes = items.find((item) => item.preset === "default")?.result.nodeCount || 0;
    elements.comparisonGrid.innerHTML = items
      .map((item) => comparisonItemMarkup(item, defaultNodes))
      .join("");
  }
  const defaultResult = items.find((item) => item.preset === "default")?.result;
  const boundaryResult = items.find((item) => item.preset === "boundary")?.result;
  const exceptionResult = items.find((item) => item.preset === "exception")?.result;
  const reduction = defaultResult && boundaryResult && defaultResult.nodeCount
    ? ((defaultResult.nodeCount - boundaryResult.nodeCount) / defaultResult.nodeCount) * 100
    : 0;
  const summary = `默认 ${defaultResult?.nodeCount ?? 0} 节点 → 边界 ${boundaryResult?.nodeCount ?? 0} 节点（${reduction.toFixed(1)}% 减少）；异常组 ${exceptionResult?.warnings?.length ?? 0} 项钳制提示，细线覆盖 ${exceptionResult?.metrics?.thinLineCoverage?.toFixed(1) ?? "—"}%。`;
  state.comparison = {
    generatedAt: new Date().toISOString(),
    algorithm: `${ALGORITHM_VERSION} / seed-631`,
    items,
    summary
  };
  elements.comparisonSummary.textContent = summary;
  elements.applyDefaultResultButton.disabled = !defaultResult;
  if (exceptionResult?.warnings?.length) {
    pushNotice({
      level: "warning",
      title: "异常参数已回退",
      message: exceptionResult.warnings.join("；")
    });
  }
  if (state.project) {
    state.project = normalizeProject({
      ...state.project,
      comparison: {
        generatedAt: state.comparison.generatedAt,
        summary,
        nodes: items.map((item) => ({ preset: item.preset, nodeCount: item.result.nodeCount }))
      }
    });
    persistProject({ quiet: true });
  }
}

function applyDefaultComparisonResult() {
  const defaultItem = state.comparison?.items?.find((item) => item.preset === "default");
  if (!defaultItem) {
    pushNotice({
      level: "warning",
      title: "默认结果不可用",
      message: "对比尚未完成，已保留当前图层。"
    });
    return;
  }
  applyVectorResult(defaultItem.result, { preset: "default" });
  elements.comparisonModal.hidden = true;
  toast({ level: "success", title: "默认结果已应用", message: "当前图层几何已更新，关键帧和颜色保持不变。" });
}

function reportDownload() {
  const report = buildComparisonReport();
  if (!report) {
    pushNotice({
      level: "warning",
      title: "报告尚未生成",
      message: "请先运行三组参数对比，再下载报告。"
    });
    return;
  }
  downloadText("inktrace-comparison-report.json", JSON.stringify(report, null, 2));
}

function updateSourceCanvases() {
  drawSampleToCanvas(state.sample, elements.sourceCanvas);
  drawSampleToCanvas(state.sample, elements.sourcePreviewCanvas);
}

async function handleImageUpload(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () => reject(new Error("图片解码失败"));
      candidate.src = url;
    });
    const maxSide = 960;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);
    state.sample = rasterFromImageData(imageData);
    updateSourceCanvases();
    state.project = null;
    state.currentResult = null;
    await runVectorization(DEFAULT_PARAMS, {
      resetProject: true,
      preset: "default",
      quiet: true,
      projectId: `uploaded-${Date.now()}`
    });
    toast({ level: "success", title: "图片已导入", message: "已按默认参数生成新工程，可继续调整。" });
  } catch (error) {
    pushNotice({
      level: "warning",
      title: "图片导入已回退",
      message: `${error.message}；继续使用当前线稿，画布未被清空。`
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function restoreBuiltInSample() {
  state.sample = createCrossingSample();
  updateSourceCanvases();
  state.project = null;
  state.currentResult = null;
  setActivePreset("default");
  await runVectorization(DEFAULT_PARAMS, { resetProject: true, preset: "default", quiet: true });
  toast({ level: "success", title: "内置样例已恢复", message: "交叉线与 12 个孤立斑点重新载入。" });
}

function importProjectFile(file) {
  if (!file) return;
  file.text().then((text) => {
    try {
      const previous = state.project;
      const project = deserializeProject(text);
      if (previous) createSnapshot("载入工程前 · 自动", "restore-point");
      state.project = project;
      state.time = project.time || 0;
      state.currentResult = analyzeLayer(activeLayer());
      state.selectedPathId = null;
      setParamsInControls(activeLayer()?.params || DEFAULT_PARAMS);
      commitProject(project);
      toast({
        level: "success",
        title: "工程已载入",
        message: `${project.layers.length} 个图层、${project.layers.reduce((sum, layer) => sum + layer.keyframes.length, 0)} 个关键帧已恢复。`
      });
    } catch (error) {
      pushNotice({
        level: "warning",
        title: "工程载入失败",
        message: `${error.message}；当前工程保持不变。`
      });
    }
  }).catch((error) => {
    pushNotice({
      level: "warning",
      title: "工程读取失败",
      message: `${error.message}；当前工程保持不变。`
    });
  });
}

function setTime(time) {
  if (!state.project) return;
  state.time = Math.min(1, Math.max(0, Number(time)));
  state.project.time = state.time;
  state.project.updatedAt = new Date().toISOString();
  renderScene();
  renderTimeline();
  persistProject({ quiet: true });
}

function changeActiveLayer(patch) {
  const layer = activeLayer();
  if (!layer) return;
  Object.assign(layer, patch);
  state.project.updatedAt = new Date().toISOString();
  state.project = normalizeProject(state.project);
  persistProject({ quiet: true });
  renderAll();
}

function bindEvents() {
  for (const [key, control] of Object.entries(params)) {
    control.range.addEventListener("input", () => {
      control.output.textContent = Number(control.range.value).toFixed(control.digits);
      if (key === "minRegion") {
        control.output.innerHTML = `${Number(control.range.value).toFixed(0)} <small>px²</small>`;
      }
      const bounds = PARAM_BOUNDS[key];
      const progress = ((Number(control.range.value) - bounds.min) / (bounds.max - bounds.min)) * 100;
      control.range.style.setProperty("--range-progress", `${progress}%`);
      scheduleAutoVectorize();
    });
  }

  $("#vectorizeButton").addEventListener("click", () => {
    clearTimeout(state.vectorTimer);
    const preset = Object.entries(PARAM_PRESETS).find(([, definition]) => (
      Object.entries(definition.params).every(([key, value]) => Number(params[key].range.value) === Math.min(PARAM_BOUNDS[key].max, Math.max(PARAM_BOUNDS[key].min, value)))
    ))?.[0] || "custom";
    runVectorization(readParamsFromControls(), { preset });
  });

  $("#resetParamsButton").addEventListener("click", () => {
    setParamsInControls(DEFAULT_PARAMS);
    setActivePreset("default");
    runVectorization(DEFAULT_PARAMS, { preset: "default" });
  });

  $$(".preset-button").forEach((button) => {
    button.addEventListener("click", () => {
      const preset = button.dataset.preset;
      const definition = PARAM_PRESETS[preset];
      setActivePreset(preset);
      setParamsInControls(normalizeParams(definition.params).params);
      runVectorization(definition.params, { preset });
    });
  });

  $("#compareButton").addEventListener("click", runComparison);
  $("#closeComparisonButton").addEventListener("click", () => {
    elements.comparisonModal.hidden = true;
  });
  elements.comparisonModal.addEventListener("click", (event) => {
    if (event.target === elements.comparisonModal) elements.comparisonModal.hidden = true;
  });
  elements.downloadReportButton.addEventListener("click", reportDownload);
  elements.applyDefaultResultButton.addEventListener("click", applyDefaultComparisonResult);

  $("#snapshotButton").addEventListener("click", () => {
    const snapshot = createSnapshot(`手动快照 · ${formatClock()}`, "manual");
    if (snapshot) {
      toast({ level: "success", title: "快照已建立", message: "图层、关键帧、坐标与颜色已冻结。" });
    }
  });
  $("#exportButton").addEventListener("click", exportCurrentSvg);
  $("#downloadProjectButton").addEventListener("click", () => {
    if (!state.project) return;
    const safeName = state.project.name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "inktrace";
    downloadText(`${safeName}.project.json`, serializeProject(state.project));
    toast({ level: "success", title: "工程文件已下载", message: "图层顺序、关键帧、坐标和颜色均已写入 JSON。" });
  });
  $("#verifyButton").addEventListener("click", verifyRoundTrip);
  $("#clearNoticesButton").addEventListener("click", () => {
    state.notices = [];
    renderNotices();
  });
  $("#importProjectButton").addEventListener("click", () => $("#projectFileInput").click());
  $("#projectFileInput").addEventListener("change", (event) => {
    importProjectFile(event.target.files?.[0]);
    event.target.value = "";
  });
  $("#uploadButton").addEventListener("click", () => $("#imageFileInput").click());
  $("#imageFileInput").addEventListener("change", (event) => {
    handleImageUpload(event.target.files?.[0]);
    event.target.value = "";
  });
  $("#restoreSampleButton").addEventListener("click", restoreBuiltInSample);

  $("#projectNameButton").addEventListener("click", () => {
    if (!state.project) return;
    const nextName = window.prompt("工程名称", state.project.name);
    if (nextName?.trim()) {
      changeActiveLayer({});
      state.project.name = nextName.trim().slice(0, 80);
      state.project.updatedAt = new Date().toISOString();
      commitProject(state.project);
    }
  });

  elements.svgPreview.addEventListener("click", (event) => {
    const path = event.target.closest("[data-path-id]");
    if (!path) return;
    state.selectedPathId = path.dataset.pathId;
    $$(".preview-surface svg path").forEach((node) => node.classList.remove("is-selected"));
    path.classList.add("is-selected");
    const layer = activeLayer();
    const selected = layer?.paths.find((item) => item.id === state.selectedPathId);
    elements.pathInspector.hidden = false;
    elements.selectedPathLabel.textContent = selected
      ? `${selected.nodeCount} 节点 · ${selected.area.toFixed(1)} px²`
      : "—";
    renderNodeOverlay();
  });

  elements.vectorViewButton.addEventListener("click", () => {
    state.view = "vector";
    renderScene();
  });
  elements.sourceViewButton.addEventListener("click", () => {
    state.view = "source";
    renderScene();
  });
  elements.nodeToggleButton.addEventListener("click", () => {
    state.showNodes = !state.showNodes;
    elements.nodeToggleButton.classList.toggle("is-active", state.showNodes);
    renderNodeOverlay();
  });
  elements.zoomSelect.addEventListener("change", () => {
    state.zoom = elements.zoomSelect.value;
    updateCanvasScale();
    renderNodeOverlay();
    if (state.zoom === "10") {
      toast({ level: "success", title: "1000% 视图", message: "SVG 仍由路径绘制，不会出现位图放大锯齿。" });
    }
  });

  elements.layerList.addEventListener("click", (event) => {
    const item = event.target.closest("[data-layer-id]");
    if (!item) return;
    const layerId = item.dataset.layerId;
    if (event.target.closest('[data-action="visibility"]')) {
      const layer = state.project.layers.find((candidate) => candidate.id === layerId);
      if (!layer) return;
      layer.visible = !layer.visible;
      state.project.updatedAt = new Date().toISOString();
      commitProject(state.project);
      return;
    }
    if (state.project.activeLayerId !== layerId) {
      state.project.activeLayerId = layerId;
      state.currentResult = analyzeLayer(activeLayer());
      state.selectedPathId = null;
      setParamsInControls(activeLayer()?.params || DEFAULT_PARAMS);
      persistProject({ quiet: true });
      renderAll();
    }
  });
  elements.layerList.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const item = event.target.closest("[data-layer-id]");
    if (!item) return;
    event.preventDefault();
    item.click();
  });

  $("#duplicateLayerButton").addEventListener("click", () => {
    try {
      state.project = duplicateLayer(state.project, state.project.activeLayerId);
      state.currentResult = analyzeLayer(activeLayer());
      commitProject(state.project);
      toast({ level: "success", title: "图层已复制", message: "副本保留路径、颜色和关键帧。" });
    } catch (error) {
      pushNotice({ level: "warning", title: "复制图层失败", message: error.message });
    }
  });
  $("#moveLayerUpButton").addEventListener("click", () => {
    state.project = moveLayer(state.project, state.project.activeLayerId, -1);
    commitProject(state.project);
  });
  $("#moveLayerDownButton").addEventListener("click", () => {
    state.project = moveLayer(state.project, state.project.activeLayerId, 1);
    commitProject(state.project);
  });
  $("#deleteLayerButton").addEventListener("click", () => {
    try {
      state.project = deleteLayer(state.project, state.project.activeLayerId);
      state.currentResult = analyzeLayer(activeLayer());
      commitProject(state.project);
    } catch (error) {
      pushNotice({ level: "warning", title: "无法删除图层", message: error.message });
    }
  });

  elements.layerColor.addEventListener("input", () => {
    const layer = activeLayer();
    if (!layer) return;
    layer.color = elements.layerColor.value;
    elements.layerColorValue.textContent = layer.color.toUpperCase();
    renderScene();
  });
  elements.layerColor.addEventListener("change", () => {
    state.project = normalizeProject(state.project);
    persistProject();
    renderLayers();
  });
  elements.layerOpacity.addEventListener("input", () => {
    const layer = activeLayer();
    if (!layer) return;
    layer.opacity = Number(elements.layerOpacity.value) / 100;
    elements.layerOpacityValue.textContent = `${elements.layerOpacity.value}%`;
    renderScene();
  });
  elements.layerOpacity.addEventListener("change", () => {
    state.project = normalizeProject(state.project);
    persistProject();
    renderLayers();
  });

  elements.timeRange.addEventListener("input", () => setTime(Number(elements.timeRange.value) / 1000));
  elements.keyframeMarkers.addEventListener("click", (event) => {
    const marker = event.target.closest("[data-time]");
    if (marker) setTime(Number(marker.dataset.time));
  });
  $("#addKeyframeButton").addEventListener("click", () => {
    try {
      state.project = upsertKeyframe(state.project, state.project.activeLayerId, state.time);
      commitProject(state.project);
      toast({ level: "success", title: "关键帧已添加", message: `时间 ${Math.round(state.time * 100)}% 已记录当前变换。` });
    } catch (error) {
      pushNotice({ level: "warning", title: "关键帧添加失败", message: error.message });
    }
  });
  const frameInputs = [
    [elements.frameX, "x"],
    [elements.frameY, "y"],
    [elements.frameScale, "scale"],
    [elements.frameRotation, "rotation"],
    [elements.frameOpacity, "opacity"]
  ];
  for (const [input, key] of frameInputs) {
    input.addEventListener("change", () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) {
        renderTimeline();
        return;
      }
      try {
        state.project = upsertKeyframe(state.project, state.project.activeLayerId, state.time, { [key]: value });
        commitProject(state.project);
      } catch (error) {
        pushNotice({ level: "warning", title: "关键帧更新失败", message: error.message });
      }
    });
  }

  elements.snapshotList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-snapshot-id]");
    if (!button) return;
    restoreSnapshot(button.dataset.snapshotId);
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      runVectorization(readParamsFromControls());
    }
    if (event.key === "Escape") elements.comparisonModal.hidden = true;
  });

  window.addEventListener("resize", () => {
    updateCanvasScale();
    renderNodeOverlay();
  });
  window.addEventListener("beforeunload", () => {
    if (!state.project) return;
    state.project.time = state.time;
    saveProject(state.project, localStorage);
  });
}

async function initialize() {
  updateSourceCanvases();
  setParamsInControls(DEFAULT_PARAMS);
  setActivePreset("default");
  renderNotices();
  bindEvents();

  const loaded = loadProject(localStorage);
  if (loaded.error) {
    pushNotice({
      level: "warning",
      title: "已恢复默认工程",
      message: `本地工程读取失败：${loaded.error.message}。正在重建默认样例。`
    });
  } else if (loaded.value) {
    try {
      const project = normalizeProject(loaded.value);
      state.project = project;
      state.time = project.time || 0;
      state.currentResult = analyzeLayer(activeLayer());
      setParamsInControls(activeLayer()?.params || DEFAULT_PARAMS);
      renderAll();
      toast({
        level: "success",
        title: "工程已恢复",
        message: `${project.layers.length} 个图层与 ${project.layers.reduce((sum, layer) => sum + layer.keyframes.length, 0)} 个关键帧已重新载入。`
      });
    } catch (error) {
      pushNotice({
        level: "warning",
        title: "工程缓存已回退",
        message: `${error.message}；旧工程不会继续显示，将重建默认样例。`
      });
      clearSavedProject(localStorage);
    }
  }

  if (!state.project) {
    await runVectorization(DEFAULT_PARAMS, {
      resetProject: true,
      preset: "default",
      quiet: true
    });
    if (!state.project) {
      const fallback = resultWithoutMask(vectorizeSample(state.sample, DEFAULT_PARAMS));
      applyVectorResult(fallback, { preset: "default", resetProject: true });
      pushNotice({
        level: "warning",
        title: "启动回退完成",
        message: "异步流程不可用，已用同步矢量化建立可编辑工程。"
      });
    }
  }
  renderAll();
}

initialize().catch((error) => {
  elements.stageEmpty.hidden = false;
  elements.stageEmpty.querySelector("strong").textContent = "初始化失败，已启用安全回退";
  elements.stageEmpty.querySelector("small").textContent = error.message;
  pushNotice({
    level: "warning",
    title: "初始化异常",
    message: `${error.message}；请刷新或载入工程快照。`
  });
});
