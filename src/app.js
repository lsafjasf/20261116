import {
  CollisionScene,
  compareDetection,
  detectBruteForce,
  detectSpatialGrid
} from "./collision-engines.js";
import {
  SCENARIOS,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  createScenarioObjects,
  sceneStats,
  stepMotion
} from "./scenarios.js";
import { SceneRenderer, drawSparkline } from "./renderer.js";
import { benchmarkAllScenarios } from "./benchmark.js";
import { containsPoint } from "./geometry.js";

const byId = (id) => document.getElementById(id);
const dom = {
  canvas: byId("scene-canvas"),
  canvasFrame: byId("canvas-frame"),
  sceneSelect: byId("scene-select"),
  sceneShort: byId("scene-short"),
  sceneTitle: byId("scene-title"),
  sceneDescription: byId("scene-description"),
  engineButtons: Array.from(document.querySelectorAll("[data-engine]")),
  playButton: byId("play-button"),
  playLabel: byId("play-label"),
  stepButton: byId("step-button"),
  resetButton: byId("reset-button"),
  parityBadge: byId("parity-badge"),
  parityLabel: byId("parity-label"),
  pairReadout: byId("pair-readout"),
  timeReadout: byId("time-readout"),
  fpsChip: byId("fps-chip"),
  metricFrame: byId("metric-frame"),
  metricCandidates: byId("metric-candidates"),
  metricPairRatio: byId("metric-pair-ratio"),
  metricDetect: byId("metric-detect"),
  metricNarrow: byId("metric-narrow"),
  metricNodes: byId("metric-nodes"),
  metricCells: byId("metric-cells"),
  metricReuse: byId("metric-reuse"),
  metricIndexTime: byId("metric-index-time"),
  metricContacts: byId("metric-contacts"),
  metricDigest: byId("metric-digest"),
  frameSparkline: byId("frame-sparkline"),
  pruningValue: byId("pruning-value"),
  pruningBar: byId("pruning-bar"),
  pruningDetail: byId("pruning-detail"),
  selectionEmpty: byId("selection-empty"),
  selectionDetail: byId("selection-detail"),
  selectedCount: byId("selected-count"),
  selectedKind: byId("selected-kind"),
  selectedId: byId("selected-id"),
  selectedX: byId("selected-x"),
  selectedY: byId("selected-y"),
  selectedSizeLabel: byId("selected-size-label"),
  selectedSize: byId("selected-size"),
  selectedAngle: byId("selected-angle"),
  indexNote: byId("index-note"),
  scaleDown: byId("scale-down"),
  scaleUp: byId("scale-up"),
  deleteButton: byId("delete-button"),
  cellSize: byId("cell-size"),
  cellSizeOutput: byId("cell-size-output"),
  benchmarkButton: byId("benchmark-button"),
  benchmarkState: byId("benchmark-state"),
  benchmarkBody: byId("benchmark-body"),
  auditButton: byId("audit-button"),
  exportButton: byId("export-button"),
  invariantStrip: byId("invariant-strip"),
  logList: byId("log-list"),
  logCount: byId("log-count"),
  toast: byId("toast")
};

const renderer = new SceneRenderer(dom.canvas);
const state = {
  scenarioId: "after",
  scenario: SCENARIOS.find((entry) => entry.id === "after"),
  strategy: "grid",
  cellSize: 72,
  objects: [],
  scene: null,
  detection: null,
  selectedId: null,
  playing: false,
  dragging: false,
  dragOffsetX: 0,
  dragOffsetY: 0,
  dirty: true,
  frameSamples: [],
  frameEma: 16.7,
  lastFrameAt: 0,
  lastTickAt: 0,
  lastIndexMs: 0,
  lastIndexUpdate: null,
  lastUiAt: 0,
  parity: null,
  benchmarkReport: null,
  benchmarkRunning: false,
  logs: [],
  toastTimer: null,
  startupBenchmarkTimer: null
};

function timestamp() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function log(level, message) {
  const entry = {
    time: timestamp(),
    level,
    message
  };
  state.logs.push(entry);
  if (state.logs.length > 100) state.logs.shift();
  renderLogs();
  if (level === "error") {
    const invariantValues = dom.invariantStrip.querySelectorAll("strong");
    const count = state.logs.filter((item) => item.level === "error").length;
    invariantValues[3].textContent = `${count} 异常`;
    dom.invariantStrip.classList.add("has-error");
  }
}

function renderLogs() {
  dom.logCount.textContent = `${state.logs.length} 条`;
  dom.logCount.classList.toggle("is-error", state.logs.some((entry) => entry.level === "error"));
  if (state.logs.length === 0) {
    dom.logList.innerHTML =
      '<li class="log-empty">尚无运行记录。异常会显示在这里，不写入或破坏场景状态。</li>';
    return;
  }
  dom.logList.innerHTML = state.logs
    .slice(-14)
    .reverse()
    .map(
      (entry) =>
        `<li class="log-entry ${entry.level}"><span class="log-time">${entry.time}</span>` +
        `<i class="log-dot"></i><span>${escapeHtml(entry.message)}</span></li>`
    )
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => dom.toast.classList.remove("is-visible"), 1300);
}

function totalPairCount() {
  const count = state.objects.length;
  return (count * (count - 1)) / 2;
}

function syncSelectedIndex() {
  const selected = state.objects.find((object) => object.id === state.selectedId);
  if (!selected) return;
  const start = performance.now();
  const update = state.scene.update(selected.id);
  state.lastIndexMs = performance.now() - start;
  state.lastIndexUpdate = update;
  dom.indexNote.textContent = update
    ? `索引已同步 · ${update.reused}/${update.added} 个单元复用`
    : "索引已同步";
}

function detectNow() {
  const start = performance.now();
  const detection = state.scene.query(state.strategy);
  const detectionMs = performance.now() - start;
  state.detection = { ...detection, detectionMs };
  state.dirty = false;
  renderer.draw(
    state.objects,
    detection.contacts,
    state.selectedId,
    state.cellSize
  );
  updateUi(true);
  return state.detection;
}

function updateSelectionUi() {
  const selected = state.objects.find((object) => object.id === state.selectedId);
  dom.selectionEmpty.hidden = Boolean(selected);
  dom.selectionDetail.hidden = !selected;
  dom.selectedCount.textContent = selected ? "已选择" : "未选择";
  dom.selectedCount.classList.toggle("muted", !selected);
  if (!selected) return;
  const isCircle = selected.shape === "circle";
  dom.selectedKind.textContent = isCircle ? "圆形" : "旋转矩形";
  dom.selectedId.textContent = `#${String(selected.id).padStart(4, "0")}`;
  dom.selectedX.textContent = selected.x.toFixed(1);
  dom.selectedY.textContent = selected.y.toFixed(1);
  dom.selectedSizeLabel.firstChild.nodeValue = isCircle ? "R " : "W×H ";
  dom.selectedSize.textContent = isCircle
    ? selected.radius.toFixed(1)
    : `${selected.width.toFixed(1)}×${selected.height.toFixed(1)}`;
  dom.selectedAngle.textContent = `${((selected.angle * 180) / Math.PI).toFixed(1)}°`;
}

function updateUi(force = false) {
  const time = performance.now();
  if (!force && time - state.lastUiAt < 80) return;
  state.lastUiAt = time;
  const detection = state.detection;
  if (!detection) return;
  const total = totalPairCount();
  const candidates = detection.candidatePairs;
  const reduction = total > 0 ? Math.max(0, 1 - candidates / total) : 0;
  const contacts = detection.contacts.length;
  const fps = state.frameEma > 0 ? Math.round(1000 / state.frameEma) : 0;
  const grid = state.scene.grid;

  dom.metricFrame.textContent = state.frameEma.toFixed(1);
  dom.metricCandidates.textContent = candidates.toLocaleString("en-US");
  dom.metricPairRatio.textContent = `全对 ${total.toLocaleString("en-US")} · ${
    state.strategy === "grid" ? `减少 ${(reduction * 100).toFixed(1)}%` : "未剪枝"
  }`;
  dom.metricDetect.textContent = detection.detectionMs.toFixed(2);
  dom.metricNarrow.textContent = `窄相 ${detection.narrowPairs.toLocaleString("en-US")} 对`;
  dom.metricNodes.textContent = (detection.occupiedCells || grid.cells.size).toLocaleString("en-US");
  dom.metricCells.textContent =
    state.strategy === "grid"
      ? `${detection.nodeCount.toLocaleString("en-US")} 个索引节点`
      : `${grid.nodeCount.toLocaleString("en-US")} 个待命节点`;
  dom.metricReuse.textContent = (grid.reuseRatio() * 100).toFixed(1);
  dom.metricIndexTime.textContent = `更新 ${state.lastIndexMs.toFixed(2)} ms`;
  dom.metricContacts.textContent = contacts.toLocaleString("en-US");
  dom.metricDigest.textContent = detection.digest;
  dom.pairReadout.textContent = `${candidates.toLocaleString("en-US")} 对`;
  dom.timeReadout.textContent = `${detection.detectionMs.toFixed(2)} ms`;
  dom.pruningValue.textContent = `${(reduction * 100).toFixed(1)}%`;
  dom.pruningBar.style.width = `${Math.max(0, reduction * 100)}%`;
  dom.pruningDetail.textContent =
    state.strategy === "grid"
      ? `候选从 ${total.toLocaleString("en-US")} 降至 ${candidates.toLocaleString("en-US")}，接触保持 ${contacts} 对`
      : "暴力模式：全部对象对进入窄相";
  dom.fpsChip.textContent = `${fps} FPS`;
  dom.fpsChip.classList.toggle("is-error", fps > 0 && fps < 40);
  drawSparkline(dom.frameSparkline, state.frameSamples);
  updateSelectionUi();
}

function applyScenarioCopy() {
  dom.sceneShort.textContent = state.scenario.shortName;
  dom.sceneTitle.textContent = state.scenario.name;
  dom.sceneDescription.textContent = state.scenario.description;
}

function loadScenario(scenarioId, options = {}) {
  const scenario = SCENARIOS.find((entry) => entry.id === scenarioId);
  if (!scenario) throw new Error(`未知场景：${scenarioId}`);
  state.scenarioId = scenario.id;
  state.scenario = scenario;
  state.objects = createScenarioObjects(scenario.id);
  state.scene = new CollisionScene(state.objects, state.cellSize);
  state.selectedId = null;
  state.detection = null;
  state.parity = null;
  state.frameSamples = [];
  state.frameEma = 1000 / 60;
  state.lastIndexMs = 0;
  state.lastIndexUpdate = null;
  state.playing = false;
  state.dirty = true;
  dom.sceneSelect.value = scenario.id;
  applyScenarioCopy();
  setPlaying(false);
  setStrategy(scenario.mode, { silent: true });
  detectNow();
  updateSelectionUi();
  renderParityChecking();
  const stats = sceneStats(state.objects);
  log(
    "info",
    `载入「${scenario.name}」：${stats.total} 个对象（圆 ${stats.circles} / 矩形 ${stats.rectangles}）`
  );
  if (!options.silentAudit) scheduleAudit();
}

function setStrategy(strategy, options = {}) {
  if (strategy !== "brute" && strategy !== "grid") return;
  state.strategy = strategy;
  for (const button of dom.engineButtons) {
    button.classList.toggle("is-active", button.dataset.engine === strategy);
  }
  if (strategy === "grid" && state.scene) {
    state.scene.grid.rebuild(state.objects);
    state.lastIndexMs = 0;
    state.lastIndexUpdate = null;
  }
  state.frameSamples = [];
  state.frameEma = 1000 / 60;
  if (state.scene && !options.silent) {
    detectNow();
    if (!options.silentAudit) scheduleAudit();
    log(
      "info",
      strategy === "grid" ? "宽相切换为空间网格，索引已重建" : "宽相切换为暴力检测，全部对象对参与窄相"
    );
  }
}

function setPlaying(playing) {
  state.playing = Boolean(playing);
  if (state.playing) {
    state.lastTickAt = performance.now();
    state.frameSamples = [];
  }
  dom.playLabel.textContent = state.playing ? "暂停" : "播放";
  dom.playButton.classList.toggle("is-running", state.playing);
  dom.playButton.querySelector(".play-icon").textContent = state.playing ? "Ⅱ" : "▶";
}

function renderParityChecking() {
  dom.parityBadge.classList.remove("is-error");
  dom.parityBadge.classList.add("is-checking");
  dom.parityLabel.textContent = "正在校验";
  dom.invariantStrip.classList.remove("has-error");
}

function renderParityResult(parity) {
  dom.parityBadge.classList.remove("is-checking");
  dom.parityBadge.classList.toggle("is-error", !parity.equal);
  dom.parityLabel.textContent = parity.equal
    ? `一致 · ${parity.bruteCount} 对`
    : `不一致 · 缺 ${parity.missingKeys.length}`;
  dom.invariantStrip.classList.toggle("has-error", !parity.equal);
  const invariantValues = dom.invariantStrip.querySelectorAll("strong");
  invariantValues[2].textContent = parity.equal ? "完全一致" : "检测到差异";
}

function runAudit(options = {}) {
  if (!state.scene || !state.objects.length) return null;
  renderParityChecking();
  try {
    const bruteStart = performance.now();
    const brute = detectBruteForce(state.objects);
    const bruteMs = performance.now() - bruteStart;
    const gridStart = performance.now();
    const indexed = detectSpatialGrid(state.objects, state.scene.grid);
    const gridMs = performance.now() - gridStart;
    const parity = compareDetection(brute, indexed);
    state.parity = {
      ...parity,
      bruteMs,
      gridMs,
      checkedAt: new Date().toISOString(),
      scenarioId: state.scenarioId
    };
    renderParityResult(parity);
    if (!parity.equal) {
      log(
        "error",
        `一致性审计失败：缺失 ${parity.missingKeys.length}，多出 ${parity.extraKeys.length}，接触变化 ${parity.changedContacts.length}`
      );
    } else if (!options.silent) {
      log(
        "info",
        `一致性审计通过：暴力 ${bruteMs.toFixed(2)} ms / 网格 ${gridMs.toFixed(2)} ms，${parity.bruteCount} 对接触`
      );
    }
    return state.parity;
  } catch (error) {
    reportError("一致性审计异常", error);
    dom.parityBadge.classList.remove("is-checking");
    dom.parityBadge.classList.add("is-error");
    dom.parityLabel.textContent = "审计异常";
    return null;
  }
}

function scheduleAudit() {
  clearTimeout(state.auditTimer);
  if (state.playing) return;
  renderParityChecking();
  state.auditTimer = setTimeout(() => runAudit({ silent: false }), 220);
}

function simulateFrame(deltaSeconds) {
  stepMotion(state.objects, deltaSeconds, SCENE_WIDTH, SCENE_HEIGHT);
  const indexStart = performance.now();
  for (const object of state.objects) state.scene.update(object.id);
  state.lastIndexMs = performance.now() - indexStart;
  const detectionStart = performance.now();
  const detection = state.scene.query(state.strategy);
  state.detection = {
    ...detection,
    detectionMs: performance.now() - detectionStart
  };
  state.dirty = false;
  renderer.draw(state.objects, detection.contacts, state.selectedId, state.cellSize);
  updateUi(false);
}

function singleStep() {
  setPlaying(false);
  simulateFrame(1 / 60);
  state.frameEma = 1000 / 60;
  updateUi(true);
  log("info", "单步推进 1/60 s，检测与索引已刷新");
}

function selectObjectAt(point) {
  for (let index = state.objects.length - 1; index >= 0; index -= 1) {
    if (containsPoint(state.objects[index], point.x, point.y)) {
      return state.objects[index];
    }
  }
  return null;
}

function handlePointerDown(event) {
  if (event.button !== 0) return;
  const point = renderer.toScene(event.clientX, event.clientY);
  const object = selectObjectAt(point);
  state.selectedId = object ? object.id : null;
  updateSelectionUi();
  if (!object) {
    state.dirty = true;
    return;
  }
  setPlaying(false);
  state.dragging = true;
  state.dragOffsetX = point.x - object.x;
  state.dragOffsetY = point.y - object.y;
  dom.canvas.classList.add("is-dragging");
  dom.canvas.setPointerCapture(event.pointerId);
}

function handlePointerMove(event) {
  if (!state.dragging || state.selectedId === null) return;
  const object = state.objects.find((entry) => entry.id === state.selectedId);
  if (!object) return;
  const point = renderer.toScene(event.clientX, event.clientY);
  object.x = point.x - state.dragOffsetX;
  object.y = point.y - state.dragOffsetY;
  syncSelectedIndex();
  state.dirty = true;
  updateSelectionUi();
}

function handlePointerUp(event) {
  if (!state.dragging) return;
  state.dragging = false;
  dom.canvas.classList.remove("is-dragging");
  if (dom.canvas.hasPointerCapture(event.pointerId)) {
    dom.canvas.releasePointerCapture(event.pointerId);
  }
  scheduleAudit();
}

function scaleSelected(factor) {
  const object = state.objects.find((entry) => entry.id === state.selectedId);
  if (!object) return;
  if (object.shape === "circle") {
    object.radius = Math.min(2000, Math.max(0.0001, object.radius * factor));
  } else {
    object.width = Math.min(4000, Math.max(0.0001, object.width * factor));
    object.height = Math.min(4000, Math.max(0.0001, object.height * factor));
  }
  syncSelectedIndex();
  state.dirty = true;
  updateSelectionUi();
  setToast(`缩放 ×${factor.toFixed(2)} · 网格已同步`);
  log("info", `缩放对象 #${object.id}，索引复用 ${state.lastIndexUpdate?.reused ?? 0} 个单元`);
  scheduleAudit();
}

function deleteSelected() {
  if (state.selectedId === null) return;
  const id = state.selectedId;
  const removed = state.scene.remove(id);
  if (!removed) return;
  state.objects = state.scene.objects;
  state.selectedId = null;
  state.dirty = true;
  updateSelectionUi();
  setToast(`已删除对象 #${id} · 索引节点已移除`);
  log("info", `删除对象 #${id}，其余 ${state.objects.length} 个对象索引保持同步`);
  scheduleAudit();
}

function formatNumber(value, digits = 0) {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "N/A";
  const sign = bytes > 0 ? "+" : "";
  return `${sign}${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function benchmarkRow(result, strategy) {
  const data = result[strategy];
  const isGrid = strategy === "grid";
  const memory = data.memory
    ? `<strong>${formatNumber(data.memory.endBytes / 1024 / 1024, 1)} MB</strong>` +
      `<small>Δ ${formatBytes(data.memory.deltaBytes)}</small>`
    : "N/A";
  const errors = data.errors.length;
  const output = isGrid
    ? result.outputEqual
      ? `一致 · ${data.contactDigest}`
      : "存在差异"
    : "基准快照";
  return (
    `<tr>` +
    `<td><strong>${escapeHtml(result.scenario.shortName)}</strong>` +
    `<span class="strategy-pill ${isGrid ? "grid" : ""}">${isGrid ? "空间网格" : "暴力检测"}</span>` +
    `<small>${isGrid ? `剪枝 ${(result.pairReduction * 100).toFixed(1)}%` : "全部对象对"}</small></td>` +
    `<td>${data.objects.total}</td>` +
    `<td><strong>${formatNumber(data.averageCandidates)}</strong><small>全对 ${formatNumber(data.totalPairs)}</small></td>` +
    `<td><strong>${data.contactCount}</strong><small>${data.contactDigest}</small></td>` +
    `<td><strong>${data.averageFrameMs.toFixed(2)} ms</strong><small>max ${data.maxFrameMs.toFixed(2)} ms</small></td>` +
    `<td>${memory}</td>` +
    `<td class="${errors ? "result-bad" : "result-good"}">${errors}</td>` +
    `<td class="${isGrid && !result.outputEqual ? "result-bad" : "result-good"}">${output}</td>` +
    `</tr>`
  );
}

function renderBenchmarkReport(report) {
  dom.benchmarkBody.innerHTML = report.results
    .map((result) => `${benchmarkRow(result, "brute")}${benchmarkRow(result, "grid")}`)
    .join("");
  const invariantValues = dom.invariantStrip.querySelectorAll("strong");
  invariantValues[2].textContent = report.allOutputsEqual ? "3/3 完全一致" : "检测到差异";
  const runtimeErrors = state.logs.filter((entry) => entry.level === "error").length;
  const totalErrors = report.totalErrors + runtimeErrors;
  invariantValues[3].textContent = totalErrors === 0 ? "0 异常" : `${totalErrors} 异常`;
  dom.invariantStrip.classList.toggle(
    "has-error",
    !report.allOutputsEqual || totalErrors > 0
  );
}

async function runBenchmarks(options = {}) {
  if (state.benchmarkRunning) return state.benchmarkReport;
  state.benchmarkRunning = true;
  dom.benchmarkButton.disabled = true;
  dom.auditButton.disabled = true;
  dom.benchmarkState.textContent = "准备运行";
  dom.benchmarkState.classList.remove("is-error");
  log("info", `开始三组固定场景基准：每场景 30 帧，网格 ${state.cellSize} px`);
  await new Promise((resolve) => requestAnimationFrame(resolve));

  try {
    const report = await benchmarkAllScenarios({
      frames: 30,
      warmupFrames: 4,
      cellSize: state.cellSize,
      yieldFrame: true,
      onScenarioStart: (scenario) => {
        dom.benchmarkState.textContent = `运行中 · ${scenario.shortName}`;
      },
      onScenarioDone: (result) => {
        log(
          "info",
          `${result.scenario.shortName}：候选 ${formatNumber(result.grid.averageCandidates)} / ${formatNumber(result.brute.totalPairs)}，接触 ${result.grid.contactCount} 对，输出${result.outputEqual ? "一致" : "不一致"}`
        );
      }
    });
    state.benchmarkReport = report;
    renderBenchmarkReport(report);
    dom.benchmarkState.textContent = report.allOutputsEqual ? "3/3 输出一致" : "存在输出差异";
    dom.benchmarkState.classList.toggle(
      "is-error",
      !report.allOutputsEqual || report.totalErrors > 0
    );
    log(
      report.allOutputsEqual && report.totalErrors === 0 ? "info" : "error",
      `基准完成：${report.results.length} 组场景，输出${
        report.allOutputsEqual ? "全部一致" : "不一致"
      }，异常 ${report.totalErrors} 条`
    );
    if (!options.silent) setToast("三组固定场景基准已完成");
    return report;
  } catch (error) {
    reportError("基准运行失败", error);
    dom.benchmarkState.textContent = "运行异常";
    dom.benchmarkState.classList.add("is-error");
    return null;
  } finally {
    state.benchmarkRunning = false;
    dom.benchmarkButton.disabled = false;
    dom.auditButton.disabled = false;
  }
}

function publicObject(object) {
  return {
    id: object.id,
    shape: object.shape,
    x: object.x,
    y: object.y,
    radius: object.radius,
    width: object.width,
    height: object.height,
    angle: object.angle,
    hue: object.hue,
    vx: object.vx,
    vy: object.vy,
    spin: object.spin,
    boundaryCase: object.boundaryCase,
    bounds: object.bounds ? { ...object.bounds } : null
  };
}

function getMetrics() {
  const detection = state.detection;
  return {
    frameMsEma: state.frameEma,
    fps: state.frameEma > 0 ? 1000 / state.frameEma : 0,
    detectionMs: detection?.detectionMs ?? 0,
    indexUpdateMs: state.lastIndexMs,
    candidatePairs: detection?.candidatePairs ?? 0,
    totalPairs: totalPairCount(),
    narrowPairs: detection?.narrowPairs ?? 0,
    contacts: detection?.contacts.length ?? 0,
    contactDigest: detection?.digest ?? null,
    occupiedCells: state.scene?.grid.cells.size ?? 0,
    nodeCount: state.scene?.grid.nodeCount ?? 0,
    indexReuseRatio: state.scene?.grid.reuseRatio() ?? 1,
    objectCount: state.objects.length
  };
}

function getSnapshot() {
  const detection = state.detection;
  return {
    schemaVersion: 1,
    scene: {
      id: state.scenarioId,
      name: state.scenario?.name ?? null,
      width: SCENE_WIDTH,
      height: SCENE_HEIGHT,
      objects: state.objects.map(publicObject)
    },
    engine: state.strategy,
    selectedId: state.selectedId,
    collision: {
      candidatePairs: detection?.candidatePairs ?? 0,
      narrowPairs: detection?.narrowPairs ?? 0,
      contacts: (detection?.contacts ?? []).map((contact) => ({ ...contact })),
      digest: detection?.digest ?? null
    },
    metrics: getMetrics(),
    parity: state.parity,
    logs: state.logs.map((entry) => ({ ...entry }))
  };
}

function reportError(context, error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  log("error", `${context} · ${message}`);
  console.error(context, error);
}

function downloadReport() {
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    activeSnapshot: getSnapshot(),
    benchmarks: state.benchmarkReport,
    logs: state.logs.map((entry) => ({ ...entry }))
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `broadphase-report-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  log(
    "info",
    state.benchmarkReport ? "已导出活动快照、三组基准与日志" : "已导出活动快照与日志，基准尚未运行"
  );
}

function animationLoop(now) {
  try {
    if (state.playing) {
      const rawDelta = state.lastTickAt ? now - state.lastTickAt : 1000 / 60;
      state.lastTickAt = now;
      if (rawDelta > 0 && rawDelta < 250) {
        state.frameEma = state.frameEma * 0.82 + rawDelta * 0.18;
        state.frameSamples.push(rawDelta);
        if (state.frameSamples.length > 48) state.frameSamples.shift();
      }
      simulateFrame(Math.min(Math.max(rawDelta, 1), 33) / 1000);
    } else if (state.dirty) {
      detectNow();
    }
    updateUi(false);
  } catch (error) {
    setPlaying(false);
    state.dirty = false;
    reportError("帧更新异常", error);
  } finally {
    requestAnimationFrame(animationLoop);
  }
}

function initialize() {
  for (const scenario of SCENARIOS) {
    const option = document.createElement("option");
    option.value = scenario.id;
    option.textContent = scenario.name;
    dom.sceneSelect.append(option);
  }

  dom.sceneSelect.addEventListener("change", () => {
    clearTimeout(state.startupBenchmarkTimer);
    loadScenario(dom.sceneSelect.value);
  });
  for (const button of dom.engineButtons) {
    button.addEventListener("click", () => setStrategy(button.dataset.engine));
  }
  dom.playButton.addEventListener("click", () => setPlaying(!state.playing));
  dom.stepButton.addEventListener("click", singleStep);
  dom.resetButton.addEventListener("click", () => {
    loadScenario(state.scenarioId);
    setToast("场景已重置");
  });
  dom.scaleDown.addEventListener("click", () => scaleSelected(1 / 1.15));
  dom.scaleUp.addEventListener("click", () => scaleSelected(1.15));
  dom.deleteButton.addEventListener("click", deleteSelected);
  dom.auditButton.addEventListener("click", () => {
    const parity = runAudit({ silent: false });
    setToast(parity?.equal ? "暴力与网格输出一致" : "审计发现差异");
  });
  dom.benchmarkButton.addEventListener("click", () => runBenchmarks());
  dom.exportButton.addEventListener("click", downloadReport);
  dom.cellSize.addEventListener("input", () => {
    const value = Number(dom.cellSize.value);
    state.cellSize = value;
    dom.cellSizeOutput.textContent = `${value} px`;
    state.frameSamples = [];
    const start = performance.now();
    state.scene.setCellSize(value);
    state.lastIndexMs = performance.now() - start;
    state.lastIndexUpdate = null;
    detectNow();
    log("info", `网格尺寸调整为 ${value} px，索引已重建并重新检测`);
    scheduleAudit();
  });

  dom.canvas.addEventListener("pointerdown", handlePointerDown);
  dom.canvas.addEventListener("pointermove", handlePointerMove);
  dom.canvas.addEventListener("pointerup", handlePointerUp);
  dom.canvas.addEventListener("pointercancel", handlePointerUp);
  dom.canvas.addEventListener(
    "wheel",
    (event) => {
      if (state.selectedId === null) return;
      event.preventDefault();
      scaleSelected(event.deltaY < 0 ? 1.1 : 1 / 1.1);
    },
    { passive: false }
  );

  window.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;
    if (event.code === "Space") {
      event.preventDefault();
      setPlaying(!state.playing);
    } else if (event.code === "Delete" || event.code === "Backspace") {
      event.preventDefault();
      deleteSelected();
    } else if (event.code === "Escape") {
      state.selectedId = null;
      state.dirty = true;
      updateSelectionUi();
    } else if (event.key === "+" || event.key === "=") {
      scaleSelected(1.1);
    } else if (event.key === "-" || event.key === "_") {
      scaleSelected(1 / 1.1);
    }
  });

  const resizeObserver = new ResizeObserver(() => {
    renderer.resize();
    if (state.detection) {
      renderer.draw(
        state.objects,
        state.detection.contacts,
        state.selectedId,
        state.cellSize
      );
    }
  });
  resizeObserver.observe(dom.canvas);

  window.addEventListener("error", (event) => {
    log("error", `未捕获异常：${event.message}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason =
      event.reason instanceof Error ? event.reason.message : String(event.reason ?? "未知原因");
    log("error", `未处理 Promise：${reason}`);
  });

  renderer.resize();
  loadScenario("after");
  requestAnimationFrame(animationLoop);

  window.collisionLab = {
    getSnapshot,
    getMetrics,
    validateParity: () => runAudit({ silent: true }),
    runBenchmarks: (options = {}) => runBenchmarks({ silent: true, ...options }),
    setScenario: (scenarioId) => {
      loadScenario(scenarioId);
      return getSnapshot();
    },
    setStrategy: (strategy) => {
      setStrategy(strategy);
      return getMetrics();
    },
    getBenchmarkReport: () => state.benchmarkReport,
    getLogs: () => state.logs.map((entry) => ({ ...entry })),
    start: () => setPlaying(true),
    pause: () => setPlaying(false),
    step: () => singleStep(),
    reset: () => loadScenario(state.scenarioId)
  };

  state.startupBenchmarkTimer = setTimeout(() => {
    if (!state.benchmarkRunning) runBenchmarks({ silent: true });
  }, 1200);
}

initialize();
