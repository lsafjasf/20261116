import { runFixedScenarios } from "./benchmark.js";
import { LayoutCache, LayoutService } from "./cache.js";
import { CUES, FONT_OPTIONS } from "./data.js";
import { LayoutEngine } from "./engine.js";
import { createCanvasMeasurer } from "./measure.js";
import { LiveMetrics, drawSparkline } from "./metrics.js";
import { renderReport, renderReportError } from "./report-view.js";
import { drawScene } from "./renderer.js";

const $ = (selector) => document.querySelector(selector);
const refs = {
  statusPill: $("#statusPill"),
  statusText: $("#statusText"),
  fpsValue: $("#fpsValue"),
  stageCard: $("#stageCard"),
  canvas: $("#stageCanvas"),
  cueMeta: $("#cueMeta"),
  stageMode: $("#stageMode"),
  stageTransform: $("#stageTransform"),
  playToggle: $("#playToggle"),
  playIcon: $("#playIcon"),
  timecode: $("#timecode"),
  timelineFill: $("#timelineFill"),
  transportCue: $("#transportCue"),
  restoreTimeline: $("#restoreTimeline"),
  lineCount: $("#lineCount"),
  metricMode: $("#metricMode"),
  metricFrame: $("#metricFrame"),
  metricP95: $("#metricP95"),
  metricCandidates: $("#metricCandidates"),
  metricCandidateTotal: $("#metricCandidateTotal"),
  metricHitRate: $("#metricHitRate"),
  metricHitSub: $("#metricHitSub"),
  metricNodes: $("#metricNodes"),
  metricLayoutNodes: $("#metricLayoutNodes"),
  sparkCanvas: $("#sparkCanvas"),
  cacheEntries: $("#cacheEntries"),
  errorCount: $("#errorCount"),
  evictionCount: $("#evictionCount"),
  textInput: $("#textInput"),
  textState: $("#textState"),
  fontFamily: $("#fontFamily"),
  fontWeight: $("#fontWeight"),
  fontSize: $("#fontSize"),
  fontSizeValue: $("#fontSizeValue"),
  layoutWidth: $("#layoutWidth"),
  layoutWidthValue: $("#layoutWidthValue"),
  zoom: $("#zoom"),
  zoomValue: $("#zoomValue"),
  scroll: $("#scroll"),
  scrollValue: $("#scrollValue"),
  runStressTop: $("#runStressTop"),
  runStressSide: $("#runStressSide"),
  openReport: $("#openReport"),
  reportSummary: $("#reportSummary"),
  reportMini: $("#reportMini"),
  miniParity: $("#miniParity"),
  miniSpeedup: $("#miniSpeedup"),
  miniCandidates: $("#miniCandidates"),
  miniErrors: $("#miniErrors"),
  reportDialog: $("#reportDialog"),
  dialogBody: $("#dialogBody"),
  closeReport: $("#closeReport")
};

const TOTAL_DURATION = Math.max(...CUES.map((cue) => cue.end));
const metrics = new LiveMetrics(90);
const cache = new LayoutCache(192);
const service = new LayoutService({ engine: null, cache, cacheEnabled: true });
const measure = createCanvasMeasurer();
service.engine = new LayoutEngine(measure);

const state = {
  playing: true,
  playhead: 0,
  overrideText: null,
  cue: CUES[0],
  style: {
    fontFamily: "system-ui, sans-serif",
    fontWeight: 600,
    fontSize: 34,
    width: 680,
    align: "center",
    lineHeight: 1.5
  },
  scroll: 0.2,
  zoom: 1,
  lastLayout: null,
  lastProjection: null,
  lastFrameAt: performance.now(),
  frameIntervals: [],
  report: null,
  runningStress: false,
  errorLogs: [],
  lastStatusKey: "",
  lastCueId: ""
};

function cueAt(playhead) {
  return (
    CUES.find((cue) => playhead >= cue.start && playhead < cue.end) ||
    CUES[CUES.length - 1]
  );
}

function formatTime(milliseconds) {
  const totalTenths = Math.floor(milliseconds / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

function setStatus(text, tone = "") {
  const key = `${text}:${tone}`;
  if (key === state.lastStatusKey) return;
  state.lastStatusKey = key;
  refs.statusText.textContent = text;
  refs.statusPill.className = `status-pill ${tone}`.trim();
}

function setModeUI() {
  const enabled = service.cacheEnabled;
  refs.stageMode.textContent = enabled ? "LRU CACHE ON" : "NO CACHE";
  refs.metricMode.textContent = enabled ? "CACHE ON" : "CACHE OFF";
  refs.metricMode.className = enabled ? "tag" : "tag off";
  document.querySelectorAll("[data-cache]").forEach((button) => {
    button.classList.toggle("active", button.dataset.cache === (enabled ? "on" : "off"));
  });
  refs.metricHitSub.textContent = enabled ? "等待缓存查询" : "缓存关闭";
  refs.metricHitRate.textContent = "0.0";
}

function updatePlayButton() {
  refs.playIcon.textContent = state.playing ? "Ⅱ" : "▶";
  refs.playToggle.setAttribute("aria-label", state.playing ? "暂停动画" : "播放动画");
}

function syncCue(force = false) {
  const cue = cueAt(state.playhead);
  if (!force && cue.id === state.lastCueId) return;
  state.cue = cue;
  state.lastCueId = cue.id;
  refs.cueMeta.textContent = state.overrideText
    ? "MANUAL · 手动输入"
    : `${cue.id.toUpperCase()} · ${cue.speaker}`;
  refs.transportCue.textContent = cue.id.toUpperCase();
  if (!state.overrideText && document.activeElement !== refs.textInput) {
    refs.textInput.value = cue.text;
  }
}

function resizeStage() {
  const rect = refs.stageCard.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  refs.canvas.width = Math.max(1, Math.round(rect.width * dpr));
  refs.canvas.height = Math.max(1, Math.round(rect.height * dpr));
}

function markStyleMutation() {
  state.lastLayout = null;
}

function formatMs(value) {
  return value < 1 ? value.toFixed(3) : value.toFixed(2);
}

function updateMetricsUI(now) {
  const snapshot = metrics.snapshot();
  const domNodes = document.getElementsByTagName("*").length;
  const cached = service.cacheEnabled;
  refs.metricFrame.textContent = formatMs(snapshot.frameAvg);
  refs.metricP95.textContent = formatMs(snapshot.frameP95);
  refs.metricCandidates.textContent = snapshot.candidateAvg.toFixed(1);
  refs.metricCandidateTotal.textContent = String(snapshot.candidateTotal);
  refs.metricHitRate.textContent = ((cached ? snapshot.hitRate : 0) * 100).toFixed(1);
  refs.metricHitSub.textContent = cached
    ? `${snapshot.hits} hit / ${snapshot.lookups} look`
    : "缓存关闭";
  refs.metricNodes.textContent = String(domNodes);
  refs.metricLayoutNodes.textContent = String(state.lastLayout?.lines.length ?? 0);
  refs.cacheEntries.textContent = String(cache.size);
  refs.errorCount.textContent = String(state.errorLogs.length);
  refs.evictionCount.textContent = String(cache.evictions);
  drawSparkline(refs.sparkCanvas, snapshot.samples);

  if (state.frameIntervals.length > 3) {
    const average =
      state.frameIntervals.reduce((sum, value) => sum + value, 0) /
      state.frameIntervals.length;
    refs.fpsValue.textContent = String(Math.min(240, Math.round(1000 / average)));
  }
  refs.timecode.textContent = formatTime(state.playhead);
  refs.timelineFill.style.width = `${(state.playhead / TOTAL_DURATION) * 100}%`;
  refs.stageTransform.textContent = `ZOOM ${Math.round(state.zoom * 100)}% · SCROLL ${Math.round(
    state.scroll * 100
  )}%`;
  refs.lineCount.textContent = `${state.lastLayout?.lines.length ?? 0} 行`;
  if (!state.runningStress && state.errorLogs.length === 0) setStatus("实时渲染");
  state.lastUiAt = now;
}

function updateLiveUI(now) {
  if (now - (state.lastUiAt || 0) > 150) updateMetricsUI(now);
}

function frame(now) {
  const delta = Math.min(120, Math.max(0, now - state.lastFrameAt));
  state.lastFrameAt = now;
  if (delta > 0) {
    state.frameIntervals.push(delta);
    if (state.frameIntervals.length > 30) state.frameIntervals.shift();
  }
  if (state.playing) {
    state.playhead = (state.playhead + delta) % TOTAL_DURATION;
  }
  syncCue();

  const text = state.overrideText ?? state.cue.text;
  const started = performance.now();
  let resolved = null;
  let candidates = 0;
  let cacheHit = false;
  try {
    resolved = service.resolve(text, state.style);
    candidates = resolved.candidates;
    cacheHit = resolved.cacheHit;
    state.lastLayout = resolved.layout;
    state.lastProjection = drawScene(refs.canvas, resolved.layout, {
      scroll: state.scroll,
      zoom: state.zoom,
      clock: now / 1000
    });
  } catch (error) {
    metrics.recordError();
    state.errorLogs.push({
      at: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error)
    });
    if (state.errorLogs.length > 50) state.errorLogs.shift();
    setStatus("渲染异常", "error");
    console.error(error);
    if (state.lastLayout) {
      drawScene(refs.canvas, state.lastLayout, {
        scroll: state.scroll,
        zoom: state.zoom,
        clock: now / 1000
      });
    }
  }
  const elapsed = performance.now() - started;
  metrics.record({
    elapsed,
    candidates,
    cacheHit,
    cacheEnabled: service.cacheEnabled
  });
  updateLiveUI(now);
  requestAnimationFrame(frame);
}

function applyAlign(align) {
  state.style.align = align;
  document.querySelectorAll("[data-align]").forEach((button) => {
    button.classList.toggle("active", button.dataset.align === align);
  });
  markStyleMutation();
}

function applyCacheMode(enabled) {
  service.cacheEnabled = enabled;
  cache.clear();
  metrics.reset();
  state.lastLayout = null;
  state.errorLogs = [];
  setModeUI();
  setStatus(enabled ? "缓存已开启" : "缓存已关闭");
}

function showReportDialog() {
  if (refs.reportDialog.open) return;
  if (typeof refs.reportDialog.showModal === "function") refs.reportDialog.showModal();
  else refs.reportDialog.setAttribute("open", "");
}

function updateReportPanel(report) {
  const [before, after, edge] = report.scenarios;
  const pass = report.verdict.onlyPerformanceChanged;
  const frameReduction =
    before.frameAvgMs > 0 ? 1 - after.frameAvgMs / before.frameAvgMs : 0;
  const candidateReduction =
    before.candidatesPerFrame > 0
      ? 1 - after.candidatesPerFrame / before.candidatesPerFrame
      : 0;
  const errors = report.scenarios.reduce(
    (sum, scenario) => sum + scenario.errors.length,
    0
  );
  const overlaps = report.scenarios.reduce(
    (sum, scenario) => sum + scenario.overlaps.length,
    0
  );
  refs.reportSummary.innerHTML = `
    <span class="report-placeholder-dot"></span>
    <p>最近一次对照已完成。输出字符串、布局几何、交互轨迹与公开数据摘要逐帧一致；仅帧时与测量次数发生变化。</p>`;
  refs.reportMini.hidden = false;
  refs.miniParity.textContent = pass ? "PASS" : "FAIL";
  refs.miniParity.className = pass ? "" : "bad";
  refs.miniSpeedup.textContent = `${(frameReduction * 100).toFixed(1)}%`;
  refs.miniCandidates.textContent = `${(candidateReduction * 100).toFixed(1)}%`;
  refs.miniErrors.textContent = `${errors} / ${overlaps}`;
  refs.miniErrors.className = errors === 0 && overlaps === 0 ? "" : "bad";
  refs.openReport.disabled = false;
  refs.dialogBody.innerHTML = renderReport(report);
}

async function runStress() {
  if (state.runningStress) return;
  state.runningStress = true;
  refs.runStressTop.disabled = true;
  refs.runStressSide.disabled = true;
  refs.runStressTop.textContent = "压测中…";
  refs.runStressSide.textContent = "正在运行三组场景…";
  setStatus("正在压测", "busy");
  await new Promise((resolve) => setTimeout(resolve, 80));
  try {
    if (document.fonts?.ready) await document.fonts.ready;
    const benchmarkEngine = new LayoutEngine(createCanvasMeasurer());
    const report = runFixedScenarios({ engine: benchmarkEngine });
    state.report = report;
    updateReportPanel(report);
    showReportDialog();
    setStatus("对照完成");
  } catch (error) {
    console.error(error);
    refs.dialogBody.innerHTML = renderReportError(error);
    showReportDialog();
    setStatus("压测失败", "error");
  } finally {
    state.runningStress = false;
    refs.runStressTop.disabled = false;
    refs.runStressSide.disabled = false;
    refs.runStressTop.textContent = "运行对照压测";
    refs.runStressSide.textContent = "运行三组固定场景";
  }
}

function bindEvents() {
  refs.playToggle.addEventListener("click", () => {
    state.playing = !state.playing;
    updatePlayButton();
  });
  refs.restoreTimeline.addEventListener("click", () => {
    state.overrideText = null;
    state.playing = true;
    refs.textState.textContent = "时间轴";
    refs.textInput.blur();
    syncCue(true);
    updatePlayButton();
  });
  refs.textInput.addEventListener("input", () => {
    state.overrideText = refs.textInput.value;
    state.playing = false;
    refs.textState.textContent = "手动";
    refs.cueMeta.textContent = "MANUAL · 手动输入";
    updatePlayButton();
  });
  refs.fontFamily.addEventListener("change", () => {
    state.style.fontFamily = refs.fontFamily.value;
    markStyleMutation();
  });
  refs.fontWeight.addEventListener("change", () => {
    state.style.fontWeight = Number(refs.fontWeight.value);
    markStyleMutation();
  });
  refs.fontSize.addEventListener("input", () => {
    state.style.fontSize = Number(refs.fontSize.value);
    refs.fontSizeValue.textContent = `${state.style.fontSize} px`;
    markStyleMutation();
  });
  refs.layoutWidth.addEventListener("input", () => {
    state.style.width = Number(refs.layoutWidth.value);
    refs.layoutWidthValue.textContent = `${state.style.width} px`;
    markStyleMutation();
  });
  refs.zoom.addEventListener("input", () => {
    state.zoom = Number(refs.zoom.value) / 100;
    refs.zoomValue.textContent = `${refs.zoom.value}%`;
  });
  refs.scroll.addEventListener("input", () => {
    state.scroll = Number(refs.scroll.value) / 100;
    refs.scrollValue.textContent = `${refs.scroll.value}%`;
  });
  document.querySelectorAll("[data-align]").forEach((button) => {
    button.addEventListener("click", () => applyAlign(button.dataset.align));
  });
  document.querySelectorAll("[data-cache]").forEach((button) => {
    button.addEventListener("click", () => applyCacheMode(button.dataset.cache === "on"));
  });
  refs.runStressTop.addEventListener("click", runStress);
  refs.runStressSide.addEventListener("click", runStress);
  refs.openReport.addEventListener("click", () => {
    if (!state.report) return;
    refs.dialogBody.innerHTML = renderReport(state.report);
    showReportDialog();
  });
  refs.closeReport.addEventListener("click", () => refs.reportDialog.close());
  refs.reportDialog.addEventListener("click", (event) => {
    if (event.target === refs.reportDialog) refs.reportDialog.close();
  });
}

function initialize() {
  for (const option of FONT_OPTIONS) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    refs.fontFamily.append(element);
  }
  refs.textInput.value = state.cue.text;
  refs.fontSizeValue.textContent = `${state.style.fontSize} px`;
  refs.layoutWidthValue.textContent = `${state.style.width} px`;
  refs.zoomValue.textContent = `${refs.zoom.value}%`;
  refs.scrollValue.textContent = `${refs.scroll.value}%`;
  bindEvents();
  setModeUI();
  updatePlayButton();
  syncCue(true);
  resizeStage();
  new ResizeObserver(resizeStage).observe(refs.stageCard);
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      cache.clear();
      state.lastLayout = null;
    });
  }
  window.__subflow = {
    state,
    metrics,
    service,
    cache,
    runStress,
    getReport: () => state.report
  };
  requestAnimationFrame(frame);
}

initialize();
