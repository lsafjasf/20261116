import {
  FORMATS,
  buildBeatPoints,
  createDefaultState,
  deepClone,
  normalizePath,
  samplePath,
  sampleSpatialFrame,
  sanitizeState,
  stateForPathExport,
  summarizeSpatialProbes
} from "./model.js";
import { SpatialMonitorEngine } from "./audio-engine.js";
import { renderOffline } from "./render.js";

const $ = (selector) => document.querySelector(selector);
const canvas = $("#stage");
const context = canvas.getContext("2d");

let state = createDefaultState();
let savedSnapshot = null;
let scrubTime = 0;
let lastExports = [];
let exportSequence = 0;
let selectedSource = null;
let dragState = null;
let canvasMetrics = null;
let operationBusy = false;
const recording = {
  active: false,
  startedAt: 0,
  points: [],
  preview: { x: 0, y: 0, z: 0 },
  lastRecordedAt: -1,
  frame: null
};

function createEngine() {
  return new SpatialMonitorEngine((diagnostics) => updateDiagnostics(diagnostics));
}

let engine = createEngine();

function ensureEngine() {
  if (engine.destroyed) {
    engine = createEngine();
  }
  return engine;
}

function setState(nextState, options = {}) {
  state = sanitizeState(nextState);
  if (options.resetTime !== false) {
    scrubTime = 0;
  }
  syncControls();
  drawStage();
}

function syncControls() {
  $("#durationInput").value = state.duration;
  $("#durationValue").textContent = `${state.duration.toFixed(1)} s`;
  $("#bpmInput").value = state.bpm;
  $("#bpmValue").textContent = state.bpm;
  $("#stageDuration").textContent = state.duration.toFixed(2);
  $("#bpmReadout").textContent = state.bpm;
  $("#pathPointCount").textContent = `${state.path.length} 路径点`;
  $("#topFormatText").textContent = FORMATS[state.format].label;
  $("#formatChannels").textContent = `${FORMATS[state.format].channels} CH`;

  document.querySelectorAll(".format-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.format === state.format);
  });
  renderBeatTicks();
  renderSourceList();
}

function renderBeatTicks() {
  const beats = buildBeatPoints(state.duration, state.bpm);
  const ticks = $("#beatTicks");
  ticks.replaceChildren();
  for (const beat of beats) {
    const tick = document.createElement("i");
    tick.className = `beat-tick${beat.index % 4 === 0 ? " accent" : ""}`;
    tick.title = `${beat.time.toFixed(3)} s`;
    ticks.append(tick);
  }
}

function renderSourceList() {
  const list = $("#sourceList");
  list.replaceChildren();
  state.sources.forEach((source, index) => {
    const card = document.createElement("div");
    card.className = `source-card${selectedSource === index ? " active" : ""}`;
    card.dataset.index = String(index);
    const head = document.createElement("div");
    head.className = "source-card-head";
    const dot = document.createElement("i");
    dot.className = "source-card-dot";
    dot.style.background = source.color;
    const name = document.createElement("span");
    name.className = "source-card-name";
    name.textContent = `S${index + 1} ${source.name}`;
    head.append(dot, name);
    const meta = document.createElement("div");
    meta.className = "source-card-meta";
    const position = document.createElement("span");
    position.textContent = `x ${source.x.toFixed(1)} · y ${source.y.toFixed(1)}`;
    const frequency = document.createElement("span");
    frequency.textContent = `${source.frequency} Hz`;
    meta.append(position, frequency);
    card.append(head, meta);
    card.addEventListener("click", () => {
      selectedSource = index;
      renderSourceList();
      drawStage();
    });
    list.append(card);
  });
}

function diagnosticsClass(status) {
  if (status === "running") return "running";
  if (["interrupted", "error", "destroyed"].includes(status)) return "error";
  return "";
}

function statusText(diagnostics) {
  if (recording.active) return "录制路径";
  return {
    idle: "空闲",
    starting: "启动中",
    running: "监听中",
    stopping: "停止中",
    ending: "结束中",
    stopped: "已停止",
    ended: "播放完成",
    interrupted: "输入中断",
    destroyed: "节点已销毁"
  }[diagnostics.status] ?? diagnostics.status;
}

function updateDiagnostics(diagnostics) {
  $("#metricNodes").textContent = diagnostics.activeNodes;
  $("#metricContexts").textContent = diagnostics.activeContexts;
  $("#metricListeners").textContent = diagnostics.listeners;
  $("#metricSources").textContent = diagnostics.scheduledSources;
  $("#runtimeStatus").textContent = diagnostics.status;
  $("#runtimeReason").textContent = diagnostics.reason;
  $("#tailRms").textContent = diagnostics.lastStopTailRms === null
    ? "—"
    : diagnostics.lastStopTailRms.toExponential(2);
  $("#topStatusText").textContent = statusText(diagnostics);
  $("#footerEngine").textContent = `engine: ${diagnostics.status} / ${diagnostics.contextState}`;

  const visualClass = recording.active ? "recording" : diagnosticsClass(diagnostics.status);
  $("#topStatusDot").className = `status-dot ${visualClass}`;
  $("#stateDot").className = `state-dot ${visualClass}`;
  $("#playButton").innerHTML = diagnostics.status === "running" ? "<span>↻</span> 重新监听" : "<span>▶</span> 监听路径";
  $("#stopButton").disabled = !["running", "starting"].includes(diagnostics.status);

  if (diagnostics.status === "ended") {
    scrubTime = state.duration;
  }
}

function worldToCanvas(x, y) {
  if (!canvasMetrics) {
    return { x: 0, y: 0 };
  }
  return {
    x: canvasMetrics.left + ((x + 5.4) / 10.8) * canvasMetrics.width,
    y: canvasMetrics.top + ((4.1 - y) / 8.2) * canvasMetrics.height
  };
}

function canvasToWorld(x, y) {
  if (!canvasMetrics) {
    return { x: 0, y: 0 };
  }
  return {
    x: Math.max(-5.2, Math.min(5.2, ((x - canvasMetrics.left) / canvasMetrics.width) * 10.8 - 5.4)),
    y: Math.max(-3.9, Math.min(3.9, 4.1 - ((y - canvasMetrics.top) / canvasMetrics.height) * 8.2))
  };
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const paddingX = Math.max(28, rect.width * 0.055);
  const paddingY = Math.max(30, rect.height * 0.065);
  canvasMetrics = {
    width: rect.width - paddingX * 2,
    height: rect.height - paddingY * 2 - 30,
    left: paddingX,
    top: paddingY,
    cssWidth: rect.width,
    cssHeight: rect.height
  };
}

function currentTime() {
  if (recording.active) {
    return Math.min(state.duration, (performance.now() - recording.startedAt) / 1000);
  }
  if (engine.status === "running") {
    return Math.min(state.duration, engine.getPlaybackTime());
  }
  return scrubTime;
}

function drawGrid() {
  const width = canvasMetrics.cssWidth;
  const height = canvasMetrics.cssHeight;
  context.clearRect(0, 0, width, height);

  const vignette = context.createRadialGradient(width / 2, height / 2, 20, width / 2, height / 2, width * 0.7);
  vignette.addColorStop(0, "rgba(75, 130, 109, 0.08)");
  vignette.addColorStop(1, "rgba(4, 12, 10, 0)");
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);

  context.save();
  context.strokeStyle = "rgba(140, 232, 196, 0.075)";
  context.lineWidth = 1;
  for (let ring = 1; ring <= 3; ring += 1) {
    context.beginPath();
    context.ellipse(width / 2, height / 2 + 6, ring * width * 0.1, ring * width * 0.1, 0, 0, Math.PI * 2);
    context.stroke();
  }
  context.setLineDash([4, 7]);
  context.beginPath();
  context.moveTo(width / 2, 20);
  context.lineTo(width / 2, height - 28);
  context.moveTo(24, height / 2);
  context.lineTo(width - 24, height / 2);
  context.stroke();
  context.restore();

  context.fillStyle = "rgba(159, 198, 186, 0.38)";
  context.font = "8px SFMono-Regular, Consolas, monospace";
  context.textAlign = "center";
  context.fillText("FRONT", width / 2, 14);
  context.fillText("REAR", width / 2, height - 6);
  context.save();
  context.translate(12, height / 2);
  context.rotate(-Math.PI / 2);
  context.fillText("LEFT", 0, 0);
  context.restore();
  context.save();
  context.translate(width - 12, height / 2);
  context.rotate(Math.PI / 2);
  context.fillText("RIGHT", 0, 0);
  context.restore();
}

function drawPath() {
  const points = recording.active ? recording.points : state.path;
  if (!points.length) {
    return;
  }
  const projected = points.map((point) => worldToCanvas(point.x, point.y));
  const gradient = context.createLinearGradient(0, 0, canvasMetrics.cssWidth, canvasMetrics.cssHeight);
  gradient.addColorStop(0, "rgba(127, 174, 255, 0.52)");
  gradient.addColorStop(0.5, "rgba(140, 232, 196, 0.9)");
  gradient.addColorStop(1, "rgba(242, 189, 114, 0.62)");

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(140, 232, 196, 0.11)";
  context.lineWidth = 9;
  context.beginPath();
  projected.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.stroke();

  context.strokeStyle = gradient;
  context.lineWidth = 1.8;
  context.setLineDash([2, 5]);
  context.beginPath();
  projected.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.stroke();
  context.setLineDash([]);

  const stride = Math.max(1, Math.floor(projected.length / 28));
  projected.forEach((point, index) => {
    if (index % stride !== 0 && index !== projected.length - 1) {
      return;
    }
    context.fillStyle = index === 0 ? "rgba(127, 174, 255, 0.9)" : "rgba(140, 232, 196, 0.44)";
    context.beginPath();
    context.arc(point.x, point.y, index === 0 ? 2.8 : 1.4, 0, Math.PI * 2);
    context.fill();
  });
  context.restore();
}

function drawBeatMarkers() {
  const beats = buildBeatPoints(state.duration, state.bpm);
  const y = canvasMetrics.cssHeight - 24;
  context.save();
  context.font = "7px SFMono-Regular, Consolas, monospace";
  context.textAlign = "center";
  beats.forEach((beat) => {
    const x = canvasMetrics.left + (beat.time / state.duration) * canvasMetrics.width;
    context.strokeStyle = beat.index % 4 === 0
      ? "rgba(140, 232, 196, 0.34)"
      : "rgba(140, 232, 196, 0.12)";
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x, y + (beat.index % 4 === 0 ? 9 : 5));
    context.stroke();
  });
  context.restore();
}

function drawSources() {
  state.sources.forEach((source, index) => {
    const point = worldToCanvas(source.x, source.y);
    const isSelected = selectedSource === index;
    context.save();
    context.shadowColor = source.color;
    context.shadowBlur = isSelected ? 24 : 12;
    context.fillStyle = `${source.color}1c`;
    context.strokeStyle = isSelected ? source.color : `${source.color}aa`;
    context.lineWidth = isSelected ? 2 : 1;
    context.beginPath();
    context.arc(point.x, point.y, isSelected ? 16 : 13, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.shadowBlur = 0;
    context.fillStyle = source.color;
    context.beginPath();
    context.arc(point.x, point.y, 3.2, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "rgba(237, 246, 241, 0.9)";
    context.font = "600 9px SFMono-Regular, Consolas, monospace";
    context.textAlign = "center";
    context.fillText(`S${index + 1}`, point.x, point.y - 20);
    context.fillStyle = "rgba(166, 199, 189, 0.72)";
    context.font = "7px SFMono-Regular, Consolas, monospace";
    context.fillText(`${source.frequency} Hz`, point.x, point.y + 25);
    if (isSelected) {
      context.strokeStyle = `${source.color}55`;
      context.setLineDash([2, 4]);
      context.beginPath();
      context.arc(point.x, point.y, 24, 0, Math.PI * 2);
      context.stroke();
    }
    context.restore();
  });
}

function drawListener() {
  let point;
  if (recording.active) {
    point = recording.preview;
  } else if (engine.status === "running") {
    point = samplePath(state.path, state.duration, currentTime());
  } else {
    point = samplePath(state.path, state.duration, scrubTime);
  }
  const projected = worldToCanvas(point.x, point.y);
  context.save();
  context.translate(projected.x, projected.y);
  context.fillStyle = "rgba(140, 232, 196, 0.1)";
  context.strokeStyle = "rgba(140, 232, 196, 0.9)";
  context.lineWidth = 1.4;
  context.beginPath();
  context.arc(0, 0, 13, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.fillStyle = "#dffff2";
  context.beginPath();
  context.arc(0, 0, 3.2, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "rgba(140, 232, 196, 0.55)";
  context.lineWidth = 1;
  context.beginPath();
  context.arc(0, 0, 19, -0.65, 0.65);
  context.stroke();
  context.beginPath();
  context.arc(0, 0, 19, Math.PI - 0.65, Math.PI + 0.65);
  context.stroke();
  context.fillStyle = "rgba(140, 232, 196, 0.78)";
  context.font = "600 7px SFMono-Regular, Consolas, monospace";
  context.textAlign = "center";
  context.fillText("L", 0, 2.5);
  context.restore();
}

function drawStage() {
  resizeCanvas();
  drawGrid();
  drawPath();
  drawBeatMarkers();
  drawSources();
  drawListener();
}

function canvasPointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function findSourceAt(position) {
  return state.sources.findIndex((source) => {
    const point = worldToCanvas(source.x, source.y);
    return Math.hypot(point.x - position.x, point.y - position.y) < 23;
  });
}

function findListenerAt(position) {
  const point = samplePath(state.path, state.duration, currentTime());
  const projected = worldToCanvas(point.x, point.y);
  return Math.hypot(projected.x - position.x, projected.y - position.y) < 25;
}

function beginPointerDrag(event) {
  const position = canvasPointerPosition(event);
  const sourceIndex = findSourceAt(position);
  if (sourceIndex >= 0) {
    selectedSource = sourceIndex;
    dragState = { type: "source", index: sourceIndex };
    renderSourceList();
    return;
  }

  const world = canvasToWorld(position.x, position.y);
  selectedSource = null;
  dragState = { type: "listener" };
  recording.preview = { ...world, z: 0 };
  if (!recording.active && engine.status !== "running") {
    scrubTime = 0;
  }
  renderSourceList();
}

function movePointerDrag(event) {
  if (!dragState) {
    return;
  }
  const position = canvasPointerPosition(event);
  const world = canvasToWorld(position.x, position.y);
  if (dragState.type === "source") {
    const source = state.sources[dragState.index];
    source.x = Number(world.x.toFixed(2));
    source.y = Number(world.y.toFixed(2));
  } else if (dragState.type === "listener") {
    recording.preview = { ...world, z: 0 };
    if (recording.active) {
      recordPointerPoint(world);
    }
  }
}

function endPointerDrag() {
  dragState = null;
}

function recordPointerPoint(world) {
  const elapsed = Math.min(
    state.duration,
    (performance.now() - recording.startedAt) / 1000
  );
  const last = recording.points.at(-1);
  if (last && elapsed - last.time < 0.025 && Math.hypot(world.x - last.x, world.y - last.y) < 0.035) {
    return;
  }
  recording.points.push({
    time: Number(Math.max(elapsed, (last?.time ?? -1) + 0.001).toFixed(4)),
    x: Number(world.x.toFixed(3)),
    y: Number(world.y.toFixed(3)),
    z: 0
  });
  recording.lastRecordedAt = elapsed;
}

function beginRecording() {
  if (engine.status === "running" || engine.status === "starting") {
    engine.stop("切换到路径录制", "stopped");
  }
  const start = samplePath(state.path, state.duration, 0);
  recording.active = true;
  recording.startedAt = performance.now();
  recording.points = [{ time: 0, x: start.x, y: start.y, z: 0 }];
  recording.preview = { ...start };
  recording.lastRecordedAt = 0;
  state.path = [recording.points[0]];
  scrubTime = 0;
  $("#recordButton").classList.add("active");
  $("#recordButton").innerHTML = "<i></i> 停止录制";
  $("#recordBadge").classList.add("visible");
  $("#transportHint").textContent = "正在采样监听位置：在画布中拖动监听者，录制将在路径时长结束时自动停止。";
  updateDiagnostics(engine.getDiagnostics());
  runRecordingFrame();
}

function finishRecording() {
  if (!recording.active) {
    return;
  }
  recording.active = false;
  if (recording.frame !== null) {
    cancelAnimationFrame(recording.frame);
    recording.frame = null;
  }
  const final = recording.preview;
  if (recording.points.length === 0 || recording.points.at(-1).time < state.duration) {
    recording.points.push({
      time: state.duration,
      x: final.x,
      y: final.y,
      z: 0
    });
  }
  state.path = normalizePath(recording.points, state.duration);
  recording.points = [];
  scrubTime = 0;
  $("#recordButton").classList.remove("active");
  $("#recordButton").innerHTML = "<i></i> 录制路径";
  $("#recordBadge").classList.remove("visible");
  $("#transportHint").textContent = "路径录制完成。停止后可以继续布置声源，或监听并离线导出。";
  syncControls();
  updateDiagnostics(engine.getDiagnostics());
}

function runRecordingFrame() {
  if (!recording.active) {
    return;
  }
  const elapsed = Math.min(state.duration, (performance.now() - recording.startedAt) / 1000);
  if (elapsed - recording.lastRecordedAt >= 0.04) {
    recordPointerPoint(recording.preview);
  }
  $("#stageTime").textContent = elapsed.toFixed(2);
  $("#pathPointCount").textContent = `${recording.points.length} 路径点`;
  drawStage();
  if (elapsed >= state.duration) {
    finishRecording();
    return;
  }
  recording.frame = requestAnimationFrame(runRecordingFrame);
}

function toggleRecording() {
  if (recording.active) {
    finishRecording();
  } else {
    beginRecording();
  }
}

function renderFrame() {
  const now = currentTime();
  $("#stageTime").textContent = now.toFixed(2);
  if (!recording.active && engine.status === "running") {
    scrubTime = now;
  }
  drawStage();
  requestAnimationFrame(renderFrame);
}

async function playPath() {
  if (recording.active) {
    finishRecording();
  }
  operationBusy = true;
  $("#playButton").classList.add("button-busy");
  try {
    const activeEngine = ensureEngine();
    scrubTime = 0;
    await activeEngine.start(state);
    return activeEngine.getDiagnostics();
  } finally {
    operationBusy = false;
    $("#playButton").classList.remove("button-busy");
    updateDiagnostics(engine.getDiagnostics());
  }
}

async function stopPath(reason = "手动停止", finalStatus = "stopped") {
  const diagnostics = await engine.stop(reason, finalStatus);
  if (finalStatus !== "ended") {
    scrubTime = 0;
  }
  return diagnostics;
}

function addExportEntry({ badge, title, subtitle, success = true }) {
  const log = $("#exportLog");
  log.querySelector(".empty-log")?.remove();
  const entry = document.createElement("div");
  entry.className = "export-entry";
  const formatBadge = document.createElement("span");
  formatBadge.className = "format-badge";
  formatBadge.textContent = badge;
  const main = document.createElement("div");
  main.className = "export-main";
  main.textContent = title;
  const sub = document.createElement("div");
  sub.className = "export-sub";
  sub.textContent = subtitle;
  main.append(sub);
  const icon = document.createElement("span");
  icon.className = "export-ok";
  icon.textContent = success ? "✓" : "!";
  entry.append(formatBadge, main, icon);
  log.prepend(entry);
  while (log.children.length > 7) {
    log.lastElementChild.remove();
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function exportMetadata(result, filename) {
  return {
    kind: "wav",
    format: result.format,
    channels: result.channels,
    sampleRate: result.sampleRate,
    frames: result.frames,
    duration: result.duration,
    checksum: result.checksum,
    bytes: result.wav.size,
    filename,
    renderEngine: result.renderEngine,
    renderedAt: result.renderedAt
  };
}

async function comparePcm16(left, right) {
  const leftBuffer = await left.arrayBuffer();
  const rightBuffer = await right.arrayBuffer();
  if (leftBuffer.byteLength !== rightBuffer.byteLength || leftBuffer.byteLength < 44) {
    return { match: false, maxDelta: Infinity, mismatchSamples: Infinity, firstMismatch: -1 };
  }
  const leftSamples = new Int16Array(leftBuffer, 44);
  const rightSamples = new Int16Array(rightBuffer, 44);
  if (leftSamples.length !== rightSamples.length) {
    return { match: false, maxDelta: Infinity, mismatchSamples: Infinity, firstMismatch: -1 };
  }
  let maxDelta = 0;
  let mismatchSamples = 0;
  let firstMismatch = -1;
  for (let index = 0; index < leftSamples.length; index += 1) {
    const delta = Math.abs(leftSamples[index] - rightSamples[index]);
    if (delta > 0) {
      mismatchSamples += 1;
      if (firstMismatch < 0) {
        firstMismatch = index;
      }
      maxDelta = Math.max(maxDelta, delta);
    }
  }
  return {
    match: maxDelta <= 1,
    maxDelta,
    mismatchSamples,
    firstMismatch
  };
}

async function exportWav(format = state.format, options = {}) {
  const safeFormat = FORMATS[format] ? format : state.format;
  const result = await renderOffline(state, { format: safeFormat });
  const filename = `spatial-path-${safeFormat}-${state.duration.toFixed(1)}s.wav`;
  const metadata = {
    ...exportMetadata(result, filename),
    sequence: ++exportSequence
  };
  lastExports.unshift(metadata);
  lastExports = lastExports.slice(0, 12);
  if (options.download !== false) {
    downloadBlob(result.wav, filename);
  }
  addExportEntry({
    badge: safeFormat === "binaural" ? "2CH" : "4CH",
    title: `${filename}`,
    subtitle: `${metadata.duration.toFixed(3)} s · ${metadata.sampleRate} Hz · ${metadata.bytes.toLocaleString()} B · ${metadata.checksum.slice(0, 12)}`
  });
  return metadata;
}

function buildPathJson() {
  return JSON.stringify(stateForPathExport(state), null, 2);
}

function exportPathJson(options = {}) {
  const json = buildPathJson();
  const blob = new Blob([json], { type: "application/json" });
  const filename = "spatial-path.json";
  if (options.download !== false) {
    downloadBlob(blob, filename);
  }
  const payload = JSON.parse(json);
  const metadata = {
    kind: "json",
    filename,
    bytes: blob.size,
    duration: payload.duration,
    points: payload.listenerPath.length,
    beats: payload.beatPoints.length,
    format: payload.format,
    schema: payload.schema
  };
  lastExports.unshift(metadata);
  lastExports = lastExports.slice(0, 12);
  addExportEntry({
    badge: "JSON",
    title: filename,
    subtitle: `${metadata.points} 路径点 · ${metadata.beats} 节拍点 · ${metadata.bytes.toLocaleString()} B`
  });
  return metadata;
}

async function verifyBothFormats() {
  const results = [];
  for (const format of ["binaural", "quad"]) {
    const first = await renderOffline(state, { format });
    const second = await renderOffline(state, { format });
    const expectedChannels = FORMATS[format].channels;
    const durationMatch = Math.abs(first.duration - state.duration) <= 1 / first.sampleRate;
    const channelsMatch = first.channels === expectedChannels;
    const pcmComparison = await comparePcm16(first.wav, second.wav);
    const replayMatch = pcmComparison.match;
    const bitExact = first.checksum === second.checksum;
    const passed = durationMatch && channelsMatch && replayMatch;
    const metadata = {
      ...exportMetadata(first, `verify-${format}.wav`),
      order: results.length,
      durationMatch,
      channelsMatch,
      replayMatch,
      bitExact,
      replayMaxDelta: pcmComparison.maxDelta,
      replayMismatchSamples: pcmComparison.mismatchSamples,
      passed,
      secondChecksum: second.checksum
    };
    lastExports.unshift(metadata);
    results.push(metadata);
    addExportEntry({
      badge: format === "binaural" ? "2CH" : "4CH",
      title: `${format} 验证 ${passed ? "通过" : "失败"}`,
      subtitle: `${first.duration.toFixed(3)} s · ${first.channels} ch · 重放 Δ≤1 LSB · ${pcmComparison.mismatchSamples} 样本微差`,
      success: passed
    });
  }
  return results;
}

function captureSnapshot() {
  const snapshotState = sanitizeState(deepClone(state));
  return {
    schema: "spatial-audio-snapshot",
    version: 1,
    capturedAt: new Date().toISOString(),
    state: snapshotState,
    beatPoints: buildBeatPoints(snapshotState.duration, snapshotState.bpm),
    spatialProbes: summarizeSpatialProbes(snapshotState)
  };
}

function saveSnapshot() {
  savedSnapshot = captureSnapshot();
  $("#snapshotBadge").textContent = "已保存";
  $("#snapshotBadge").classList.add("saved");
  $("#restoreSnapshotButton").disabled = false;
  $("#snapshotResult").className = "snapshot-result";
  $("#snapshotResult").textContent = `快照已保存：${savedSnapshot.beatPoints.length} 个节拍点，${savedSnapshot.state.path.length} 个路径点。`;
  return deepClone(savedSnapshot);
}

function restoreSnapshot(input = savedSnapshot) {
  if (!input?.state) {
    throw new Error("没有可恢复的快照");
  }
  if (recording.active) {
    finishRecording();
  }
  setState(input.state);
  scrubTime = 0;
  $("#snapshotResult").className = "snapshot-result";
  $("#snapshotResult").textContent = `已恢复 ${new Date(input.capturedAt).toLocaleTimeString("zh-CN")} 的参数快照。`;
  return deepClone(state);
}

function compareProbeSets(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

async function runSnapshotSelfCheck() {
  const snapshot = saveSnapshot();
  const originalBeats = deepClone(snapshot.beatPoints);
  const originalProbes = deepClone(snapshot.spatialProbes);
  const originalDuration = snapshot.state.duration;

  const perturbed = deepClone(state);
  perturbed.duration = Math.max(1, Number((state.duration - 0.8).toFixed(1)));
  perturbed.bpm = state.bpm === 120 ? 96 : state.bpm + 13;
  perturbed.format = state.format === "binaural" ? "quad" : "binaural";
  perturbed.sources[0].x = -perturbed.sources[0].x;
  perturbed.sources[1].gain = Math.max(0.1, perturbed.sources[1].gain - 0.2);
  perturbed.path = perturbed.path.map((point) => ({ ...point, x: -point.x }));
  setState(perturbed);

  restoreSnapshot(snapshot);
  const restored = captureSnapshot();
  const beatsMatch = JSON.stringify(originalBeats) === JSON.stringify(restored.beatPoints);
  const spatialMatch = compareProbeSets(originalProbes, restored.spatialProbes);
  const durationEqual = restored.state.duration === originalDuration;
  const rendered = await renderOffline(restored.state, { format: "binaural" });
  const exportDurationEqual = Math.abs(rendered.duration - originalDuration) <= 1 / rendered.sampleRate;
  const passed = beatsMatch && spatialMatch && durationEqual && exportDurationEqual;
  const result = {
    passed,
    beatsMatch,
    spatialMatch,
    durationEqual,
    exportDurationEqual,
    expectedDuration: originalDuration,
    exportDuration: rendered.duration,
    beatCount: restored.beatPoints.length,
    probeCount: restored.spatialProbes.length,
    checksum: rendered.checksum
  };
  const detail = [
    `节拍点 ${beatsMatch ? "一致" : "不一致"}`,
    `声像/增益 ${spatialMatch ? "一致" : "不一致"}`,
    `参数时长 ${durationEqual ? "一致" : "不一致"}`,
    `WAV 时长 ${rendered.duration.toFixed(3)} s ${exportDurationEqual ? "一致" : "不一致"}`
  ].join(" · ");
  $("#snapshotResult").className = `snapshot-result ${passed ? "success" : "failure"}`;
  $("#snapshotResult").textContent = `${passed ? "自检通过" : "自检失败"}：${detail}`;
  addExportEntry({
    badge: "CHECK",
    title: `快照恢复自检 ${passed ? "通过" : "失败"}`,
    subtitle: `${result.beatCount} 节拍点 · ${result.probeCount} 声像/增益采样 · ${result.exportDuration.toFixed(3)} s`,
    success: passed
  });
  return result;
}

function showError(error) {
  addExportEntry({
    badge: "ERR",
    title: "操作未完成",
    subtitle: error instanceof Error ? error.message : String(error),
    success: false
  });
  $("#runtimeReason").textContent = error instanceof Error ? error.message : String(error);
}

function configureState(patch) {
  if (!patch || typeof patch !== "object") {
    throw new Error("配置必须是对象");
  }
  const next = {
    ...deepClone(state),
    ...deepClone(patch)
  };
  setState(next);
  return deepClone(state);
}

document.querySelectorAll(".format-button").forEach((button) => {
  button.addEventListener("click", () => {
    if (engine.status === "running" || engine.status === "starting") {
      engine.stop("格式已切换", "stopped");
    }
    setState({ ...deepClone(state), format: button.dataset.format });
  });
});

$("#durationInput").addEventListener("input", (event) => {
  setState({
    ...deepClone(state),
    duration: Number(event.target.value)
  });
});

$("#bpmInput").addEventListener("input", (event) => {
  setState({
    ...deepClone(state),
    bpm: Number(event.target.value)
  });
});

$("#playButton").addEventListener("click", () => {
  playPath().catch(showError);
});

$("#stopButton").addEventListener("click", () => {
  stopPath("手动停止", "stopped").catch(showError);
});

$("#recordButton").addEventListener("click", toggleRecording);

$("#exportWavButton").addEventListener("click", () => {
  exportWav(state.format).catch(showError);
});

$("#exportJsonButton").addEventListener("click", () => {
  try {
    exportPathJson();
  } catch (error) {
    showError(error);
  }
});

$("#verifyButton").addEventListener("click", async () => {
  const button = $("#verifyButton");
  button.disabled = true;
  button.textContent = "正在双渲染验证…";
  try {
    await verifyBothFormats();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent = "验证双格式 · 时长 / 声道 / 重放一致性";
  }
});

$("#saveSnapshotButton").addEventListener("click", () => {
  try {
    saveSnapshot();
  } catch (error) {
    showError(error);
  }
});

$("#restoreSnapshotButton").addEventListener("click", () => {
  try {
    restoreSnapshot();
  } catch (error) {
    showError(error);
  }
});

$("#selfCheckButton").addEventListener("click", async () => {
  const button = $("#selfCheckButton");
  button.disabled = true;
  button.textContent = "正在恢复并检查…";
  try {
    await runSnapshotSelfCheck();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent = "运行快照一致性自检 →";
  }
});

canvas.addEventListener("pointerdown", (event) => {
  beginPointerDrag(event);
  canvas.setPointerCapture?.(event.pointerId);
  drawStage();
});

canvas.addEventListener("pointermove", (event) => {
  movePointerDrag(event);
  if (dragState) {
    drawStage();
  }
});

canvas.addEventListener("pointerup", (event) => {
  endPointerDrag();
  canvas.releasePointerCapture?.(event.pointerId);
});

canvas.addEventListener("pointercancel", endPointerDrag);
window.addEventListener("resize", drawStage);

window.spatialStudio = {
  getState: () => deepClone(state),
  configure: (patch) => configureState(patch),
  setState: (nextState) => {
    setState(nextState);
    return deepClone(state);
  },
  getDiagnostics: () => engine.getDiagnostics(),
  getBeatPoints: () => buildBeatPoints(state.duration, state.bpm),
  sampleFrame: (time) => sampleSpatialFrame(state, time),
  getSpatialProbes: () => summarizeSpatialProbes(state),
  play: () => playPath(),
  stop: (reason = "API 停止", finalStatus = "stopped") => stopPath(reason, finalStatus),
  interrupt: (reason = "自动测试") => engine.inputInterruption(reason),
  destroy: () => engine.destroy(),
  saveSnapshot: () => saveSnapshot(),
  getSnapshot: () => deepClone(savedSnapshot),
  restoreSnapshot: (snapshot) => restoreSnapshot(snapshot ?? savedSnapshot),
  runSnapshotSelfCheck: () => runSnapshotSelfCheck(),
  exportWav: (format = state.format) => exportWav(format),
  exportJson: () => exportPathJson(),
  verifyBothFormats: () => verifyBothFormats(),
  getLastExports: () => deepClone(lastExports),
  getPathJson: () => buildPathJson(),
  getRenderEngine: () => "OfflineAudioContext"
};

window.__spatialStudio = window.spatialStudio;

syncControls();
updateDiagnostics(engine.getDiagnostics());
requestAnimationFrame(renderFrame);
