import {
  DEFAULT_STATE,
  LAYERS,
  LAYER_LABELS,
  auditSnapshotsEqual,
  bearingLabel,
  bearingLabelZh,
  buildAuditSnapshot,
  compareThresholds,
  createProject,
  getDrainagePath,
  normalizeUiState,
  parseProject,
  processSample,
  round,
} from "./core.js";
import { SAMPLE_DEFINITIONS, GRID } from "./samples.js";
import {
  CANVAS_SIZE,
  canvasToBlob,
  createExportCanvas,
  drawMap,
  exportFilename,
  hitTestCanvas,
  renderLegend,
} from "./render.js";

const DATA_VERSION = "2026.11.16-r3";
const topologyCache = new Map();
const initialSelection = "4:18";

const state = {
  ui: normalizeUiState({
    ...DEFAULT_STATE,
    selectedId: initialSelection,
  }),
  topology: null,
  checks: [],
  checksRunAt: null,
  audit: {
    status: "idle",
    before: null,
    after: null,
    equal: null,
    dryRun: false,
    checkedAt: null,
  },
};

const dom = {};
let toastTimer = null;
let dryRunTimer = null;

function getTopology(sampleId) {
  if (!topologyCache.has(sampleId)) topologyCache.set(sampleId, processSample(sampleId));
  return topologyCache.get(sampleId);
}

function cacheDom() {
  const ids = [
    "algorithmVersion",
    "headerVersion",
    "currentFilter",
    "currentVersion",
    "exportMethod",
    "terrainCanvas",
    "hoverReadout",
    "cursorStatus",
    "mapLegend",
    "thresholdA",
    "thresholdB",
    "thresholdAValue",
    "thresholdBValue",
    "countA",
    "countB",
    "barA",
    "barB",
    "compareNote",
    "riskPill",
    "selectedCellTag",
    "emptySelection",
    "selectionContent",
    "selectedElevation",
    "selectedElevationRaw",
    "selectedSlope",
    "selectedAspect",
    "selectedAspectLabel",
    "selectedFlow",
    "selectedFlowLabel",
    "selectedAccum",
    "selectedRisk",
    "selectedRiskState",
    "pathSummary",
    "pathChain",
    "cellSource",
    "toggleArrows",
    "toggleGrid",
    "exportButton",
    "auditBadge",
    "auditCopy",
    "saveProjectButton",
    "openProjectButton",
    "projectFileInput",
    "debugStatus",
    "debugGridCount",
    "debugRawCount",
    "debugDuplicates",
    "debugNulls",
    "debugOutliers",
    "debugFlow",
    "fixtureLabel",
    "pipelineFlow",
    "debugLog",
    "checksSummary",
    "selfChecks",
    "auditObjects",
    "auditHash",
    "runChecksButton",
    "footerContext",
    "toast",
  ];
  ids.forEach((id) => {
    dom[id] = document.getElementById(id);
  });
}

function setCanvasResolution() {
  const canvas = dom.terrainCanvas;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(CANVAS_SIZE.width * ratio);
  const pixelHeight = Math.round(CANVAS_SIZE.height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

function renderCanvas() {
  const ctx = setCanvasResolution();
  drawMap(ctx, state.topology, state.ui);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function cellTitle(cell) {
  return `R${pad2(cell.row)} / C${pad2(cell.col)}`;
}

function selectedCell() {
  return state.ui.selectedId ? state.topology.byId.get(state.ui.selectedId) : null;
}

function thresholdPair() {
  return {
    lower: Math.min(state.ui.thresholdA, state.ui.thresholdB),
    upper: Math.max(state.ui.thresholdA, state.ui.thresholdB),
  };
}

function setText(node, value) {
  if (node) node.textContent = value;
}

function syncLayerButtons() {
  document.querySelectorAll(".layer-btn").forEach((button) => {
    const active = button.dataset.layer === state.ui.layer;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function syncSampleButtons() {
  document.querySelectorAll(".sample-btn").forEach((button) => {
    const active = button.dataset.sample === state.ui.sampleId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderThresholds() {
  const compare = compareThresholds(
    state.topology,
    state.ui.thresholdA,
    state.ui.thresholdB,
    state.ui.selectedId,
  );
  setText(dom.thresholdAValue, `${state.ui.thresholdA}%`);
  setText(dom.thresholdBValue, `${state.ui.thresholdB}%`);
  dom.thresholdA.value = state.ui.thresholdA;
  dom.thresholdB.value = state.ui.thresholdB;
  dom.thresholdA.style.setProperty("--range-progress", `${state.ui.thresholdA}%`);
  dom.thresholdB.style.setProperty("--range-progress", `${state.ui.thresholdB}%`);
  setText(dom.countA, compare.countA);
  setText(dom.countB, compare.countB);
  const maxCount = Math.max(compare.countA, compare.countB, 1);
  dom.barA.style.width = `${(compare.countA / maxCount) * 100}%`;
  dom.barB.style.width = `${(compare.countB / maxCount) * 100}%`;
  const lower = compare.lower;
  const upper = compare.upper;
  if (lower === upper) {
    setText(
      dom.compareNote,
      `两个阈值重合；${compare.countA} 个网格同时命中，调整任一滑块即可查看分级差异。`,
    );
  } else if (state.ui.thresholdA >= state.ui.thresholdB) {
    setText(
      dom.compareNote,
      `阈值 A 更高：${compare.onlyB} 格落在 ${lower}–${upper}% 关注带，${compare.delta} 格随阈值下降进入命中区。`,
    );
  } else {
    setText(
      dom.compareNote,
      `阈值 B 高于 A，色带已按上下界自动重排；当前高风险边界为 ${upper}%，两阈值相差 ${compare.delta} 格。`,
    );
  }
  setText(dom.riskPill, `A ≥ ${state.ui.thresholdA}% · B ≥ ${state.ui.thresholdB}%`);
  setText(
    dom.currentFilter,
    `A ≥ ${state.ui.thresholdA}% / B ≥ ${state.ui.thresholdB}% · ${LAYER_LABELS[state.ui.layer]}`,
  );
}

function renderContext() {
  const sample = state.topology.sample;
  setText(dom.headerVersion, sample.revision);
  setText(dom.currentVersion, sample.revision);
  setText(dom.algorithmVersion, DATA_VERSION.split("-").at(-1));
  setText(
    dom.exportMethod,
    "风险 = log₁₊(汇流格−1) / log₁₊(最大汇流−1) × 100%；导出含阈值图例、版本与关键值校验",
  );
  setText(
    dom.footerContext,
    `${sample.fixture} · ${state.topology.cols}×${state.topology.rows} · 100 m · ${LAYER_LABELS[state.ui.layer]}`,
  );
}

function renderSelection() {
  const cell = selectedCell();
  const hasCell = Boolean(cell);
  dom.emptySelection.hidden = hasCell;
  dom.selectionContent.hidden = !hasCell;
  if (!cell) {
    setText(dom.selectedCellTag, "未选中");
    return;
  }
  const path = getDrainagePath(state.topology, cell.id);
  const compare = compareThresholds(
    state.topology,
    state.ui.thresholdA,
    state.ui.thresholdB,
    cell.id,
  );
  setText(dom.selectedCellTag, cellTitle(cell));
  setText(dom.selectedElevation, round(cell.elevation, 1).toFixed(1));
  setText(
    dom.selectedElevationRaw,
    `基线 ${round(cell.baseElevation, 1).toFixed(1)} · Δ ${(cell.elevation - cell.baseElevation >= 0 ? "+" : "")}${round(cell.elevation - cell.baseElevation, 1).toFixed(1)}`,
  );
  setText(dom.selectedSlope, cell.slopeDeg.toFixed(2));
  setText(dom.selectedAspect, cell.aspectDeg.toFixed(1));
  setText(
    dom.selectedAspectLabel,
    `${bearingLabel(cell.aspectDeg)} / ${bearingLabelZh(cell.aspectDeg)}`,
  );
  setText(
    dom.selectedFlow,
    cell.flowDirDeg === null ? "SINK" : `${cell.flowDirDeg.toFixed(0)}°`,
  );
  setText(
    dom.selectedFlowLabel,
    cell.flowDirDeg === null ? "洼地" : `${cell.flowDirCode} · ${bearingLabelZh(cell.flowDirDeg)}`,
  );
  setText(dom.selectedAccum, cell.flowAccum);
  setText(dom.selectedRisk, `${cell.riskIndex.toFixed(1)}%`);
  setText(dom.selectedRiskState, compare.selectedState);
  setText(
    dom.pathSummary,
    `${path.ids.length} 格 · ${path.lengthM.toFixed(1)} m · ${path.endReason}`,
  );
  setText(
    dom.pathChain,
    path.ids
      .slice(0, 12)
      .map((id) => {
        const entry = state.topology.byId.get(id);
        return `R${pad2(entry.row)}C${pad2(entry.col)}`;
      })
      .join(" → ") + (path.ids.length > 12 ? ` → +${path.ids.length - 12}` : ""),
  );
  const sourceLabels = {
    measured: "固定样例实测记录",
    imputed: "空值 → 邻域基线填补",
    clamped: "异常值 → 边界截断",
    generated: "未采样网格 → 程序生成基线",
  };
  setText(
    dom.cellSource,
    `${sourceLabels[cell.dataStatus] || "程序生成"} · 100 m 网格 · 汇流 ${cell.flowAccum} 格`,
  );
}

function renderHover() {
  const cell = state.ui.hoverId ? state.topology.byId.get(state.ui.hoverId) : null;
  if (!cell) {
    setText(dom.hoverReadout, "移动到网格查看读数");
    dom.hoverReadout.classList.remove("has-cell");
    setText(dom.cursorStatus, "R— / C—");
    return;
  }
  const direction =
    cell.flowDirDeg === null ? "SINK" : `${cell.flowDirCode} ${cell.flowDirDeg}°`;
  setText(
    dom.hoverReadout,
    `${cellTitle(cell)} · H ${round(cell.elevation, 1).toFixed(1)} m · S ${cell.slopeDeg.toFixed(1)}° · ${direction}`,
  );
  dom.hoverReadout.classList.add("has-cell");
  setText(
    dom.cursorStatus,
    `${cellTitle(cell)} · ${round(cell.elevation, 1).toFixed(1)} m · 风险 ${cell.riskIndex.toFixed(1)}%`,
  );
}

function flowIntegrity(topology) {
  const flowCells = topology.cells.filter((cell) => !cell.isSink);
  const valid = flowCells.filter((cell) => {
    const downstream = topology.byId.get(cell.downstreamId);
    return downstream && downstream.elevation < cell.elevation;
  }).length;
  return { valid, total: flowCells.length };
}

function renderDebug() {
  const { stats, sample } = state.topology;
  const flow = flowIntegrity(state.topology);
  const compare = compareThresholds(
    state.topology,
    state.ui.thresholdA,
    state.ui.thresholdB,
    state.ui.selectedId,
  );
  setText(dom.debugGridCount, state.topology.cells.length);
  setText(dom.debugRawCount, stats.rawRecords);
  setText(dom.debugDuplicates, stats.duplicateRecords);
  setText(dom.debugNulls, stats.nullRecords);
  setText(dom.debugOutliers, stats.outlierRecords);
  setText(dom.debugFlow, `${flow.valid}/${flow.total}`);
  setText(dom.fixtureLabel, `${sample.fixture} · ${sample.revision}`);

  const pipeline = [
    ["原始记录", stats.rawRecords],
    ["去重后", stats.rawRecords - stats.duplicateRecords],
    ["空值修复", stats.nullRecords],
    ["异常截断", stats.outlierRecords],
    ["网格对象", state.topology.cells.length],
  ];
  dom.pipelineFlow.innerHTML = pipeline
    .map(
      ([label, value], index) =>
        `<span class="pipe-step">${label} <b>${value}</b></span>${
          index < pipeline.length - 1 ? '<i class="pipe-arrow">›</i>' : ""
        }`,
    )
    .join("");

  const selected = selectedCell();
  const lines = [
    `<span class="log-key">[dataset]</span> ${sample.fixture} · ${sample.revision} · ${state.topology.cols}×${state.topology.rows}`,
    `<span class="log-key">[repair]</span> raw=${stats.rawRecords} dedupe=${stats.duplicateRecords} null=${stats.nullRecords} outlier=${stats.outlierRecords}`,
    `<span class="log-key">[dem]</span> elevations=${state.topology.cells.length} min=${Math.min(...state.topology.cells.map((cell) => cell.elevation)).toFixed(1)}m max=${Math.max(...state.topology.cells.map((cell) => cell.elevation)).toFixed(1)}m`,
    `<span class="log-key">[d8]</span> valid=${flow.valid}/${flow.total} maxAccum=${state.topology.maxAccum} sinks=${state.topology.cells.filter((cell) => cell.isSink).length}`,
    `<span class="log-key">[threshold]</span> A=${state.ui.thresholdA}%→${compare.countA} B=${state.ui.thresholdB}%→${compare.countB} delta=${compare.delta}`,
    selected
      ? `<span class="log-key">[cell]</span> ${cellTitle(selected)} h=${selected.elevation.toFixed(1)}m slope=${selected.slopeDeg.toFixed(2)}° aspect=${selected.aspectDeg.toFixed(1)}° fdir=${selected.flowDirCode} accum=${selected.flowAccum} risk=${selected.riskIndex.toFixed(1)}%`
      : `<span class="log-key">[cell]</span> 等待选择网格`,
  ];
  dom.debugLog.innerHTML = lines.join("\n");
  renderChecks();
  renderAudit();
}

function renderChecks() {
  if (!state.checks.length) {
    dom.selfChecks.innerHTML = `<li class="is-idle">尚未运行校验；点击“运行内置校验”生成可复核证据。</li>`;
    setText(dom.checksSummary, "未运行");
    return;
  }
  dom.selfChecks.innerHTML = state.checks
    .map(
      (check) =>
        `<li class="${check.pass ? "" : "is-fail"}" title="${check.detail}">${check.label}: ${check.pass ? "PASS" : "FAIL"}</li>`,
    )
    .join("");
  const passed = state.checks.filter((check) => check.pass).length;
  setText(dom.checksSummary, `${passed}/${state.checks.length} PASS`);
}

function hashPair(snapshot) {
  return `${snapshot.keyValues.elevation}·${snapshot.keyValues.flowDirection}`;
}

function renderAudit() {
  const audit = state.audit;
  if (audit.status === "pass") {
    dom.auditBadge.textContent = audit.dryRun ? "干跑通过" : "导出通过";
    dom.auditBadge.className = "audit-badge is-pass";
    setText(
      dom.auditCopy,
      `对象 ${audit.before.objectCount} → ${audit.after.objectCount}，关键数值校验一致。${audit.dryRun ? "当前状态已就绪，可正式导出。" : "PNG 已生成。"}`,
    );
    setText(
      dom.auditObjects,
      `对象 ${audit.before.objectCount}→${audit.after.objectCount} · ${audit.before.gridObjects} cells`,
    );
    setText(dom.auditHash, `${hashPair(audit.before)} → ${hashPair(audit.after)}`);
  } else if (audit.status === "fail") {
    dom.auditBadge.textContent = "审计失败";
    dom.auditBadge.className = "audit-badge is-warn";
    setText(dom.auditCopy, "导出前后对象或关键数值不一致，请查看调试台。");
    setText(dom.auditObjects, "不一致");
    setText(dom.auditHash, `${hashPair(audit.before)} → ${hashPair(audit.after)}`);
  } else {
    dom.auditBadge.textContent = "待审计";
    dom.auditBadge.className = "audit-badge";
    setText(
      dom.auditCopy,
      "导出会固定当前筛选与版本，并比对导出前后的对象数量和关键数值。",
    );
    setText(dom.auditObjects, "等待导出审计");
    setText(dom.auditHash, "—");
  }
}

function renderAll() {
  syncSampleButtons();
  syncLayerButtons();
  renderCanvas();
  renderLegend(dom.mapLegend, state.topology, state.ui);
  renderContext();
  renderThresholds();
  renderSelection();
  renderHover();
  renderDebug();
}

function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove("is-visible"), 2600);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resetEvidence(reason) {
  state.audit = {
    status: "idle",
    before: null,
    after: null,
    equal: null,
    dryRun: false,
    checkedAt: null,
  };
  state.checks = [];
  state.checksRunAt = null;
  setText(dom.debugStatus, `${reason} · 等待重算`);
  renderAudit();
  renderChecks();
  clearTimeout(dryRunTimer);
  dryRunTimer = setTimeout(() => {
    runExportAudit({ dryRun: true, silent: true });
    runInternalChecks({ silent: true });
  }, 160);
}

function setLayer(layer) {
  if (!LAYERS.includes(layer) || layer === state.ui.layer) return;
  const hoverBefore = state.ui.hoverId;
  const selectedBefore = state.ui.selectedId;
  state.ui.layer = layer;
  renderAll();
  if (hoverBefore !== state.ui.hoverId || selectedBefore !== state.ui.selectedId) {
    throw new Error("图层切换改变了鼠标或选中网格");
  }
  setText(dom.debugStatus, `图层已同步 · ${LAYER_LABELS[layer]}`);
  resetEvidence("显示图层变化");
}

function setThreshold(key, value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return;
  if (key !== "thresholdA" && key !== "thresholdB") return;
  state.ui[key] = Math.round(Math.min(100, Math.max(0, numeric)));
  renderThresholds();
  renderCanvas();
  renderLegend(dom.mapLegend, state.topology, state.ui);
  renderSelection();
  renderContext();
  renderDebug();
  resetEvidence(`阈值 ${key === "thresholdA" ? "A" : "B"} = ${state.ui[key]}%`);
}

function changeSample(sampleId) {
  if (!SAMPLE_DEFINITIONS.some((sample) => sample.id === sampleId)) return;
  if (sampleId === state.ui.sampleId) return;
  const oldHover = state.ui.hoverId;
  const oldSelected = state.ui.selectedId;
  state.ui.sampleId = sampleId;
  state.topology = getTopology(sampleId);
  state.ui.selectedId = oldSelected;
  state.ui.hoverId = oldHover;
  renderAll();
  setText(dom.debugStatus, `数据已切换 · ${state.topology.sample.name}`);
  resetEvidence("数据版本变化");
  showToast(`已切换到样例 ${state.topology.sample.code}，所有视图已同步`);
}

function cellFromPointer(event) {
  const rect = dom.terrainCanvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * CANVAS_SIZE.width;
  const y = ((event.clientY - rect.top) / rect.height) * CANVAS_SIZE.height;
  return hitTestCanvas(state.topology, x, y);
}

function updateHover(event) {
  const cell = cellFromPointer(event);
  const nextId = cell ? cell.id : null;
  if (nextId === state.ui.hoverId) return;
  state.ui.hoverId = nextId;
  renderCanvas();
  renderHover();
}

function selectCell(cellId) {
  if (!cellId || !state.topology.byId.has(cellId)) return;
  state.ui.selectedId = cellId;
  renderCanvas();
  renderSelection();
  renderThresholds();
  renderDebug();
  state.checks = [];
  renderChecks();
  setText(dom.debugStatus, `已锁定 ${cellTitle(state.topology.byId.get(cellId))}`);
}

async function runExportAudit({ dryRun = false, silent = false } = {}) {
  const before = buildAuditSnapshot(
    state.topology,
    state.ui.thresholdA,
    state.ui.thresholdB,
  );
  const exportCanvas = createExportCanvas(state.topology, state.ui, before, new Date());
  const after = buildAuditSnapshot(
    state.topology,
    state.ui.thresholdA,
    state.ui.thresholdB,
  );
  const equal = auditSnapshotsEqual(before, after);
  state.audit = {
    status: equal ? "pass" : "fail",
    before,
    after,
    equal,
    dryRun,
    checkedAt: new Date().toISOString(),
  };
  renderAudit();
  setText(
    dom.debugStatus,
    equal
      ? `${dryRun ? "干跑" : "导出"}审计通过 · ${before.objectCount} 对象`
      : "导出审计失败",
  );
  if (!dryRun) {
    if (!equal) {
      showToast("导出审计失败：对象或关键数值发生变化");
    } else {
      const blob = await canvasToBlob(exportCanvas);
      downloadBlob(blob, exportFilename(state.topology, state.ui));
      showToast(`PNG 已导出，含阈值图例与口径 · ${before.objectCount} 对象校验一致`);
    }
  } else if (!silent && equal) {
    showToast(`导出干跑通过：${before.objectCount} 个对象，关键值一致`);
  }
  return equal;
}

function readoutIsConsistent() {
  const cell = selectedCell();
  if (!cell) return { pass: false, detail: "当前没有选中网格" };
  const expected = {
    elevation: round(cell.elevation, 1).toFixed(1),
    slope: cell.slopeDeg.toFixed(2),
    aspect: cell.aspectDeg.toFixed(1),
    accum: String(cell.flowAccum),
    risk: `${cell.riskIndex.toFixed(1)}%`,
    direction:
      cell.flowDirDeg === null ? "SINK" : `${cell.flowDirDeg.toFixed(0)}°`,
  };
  const actual = {
    elevation: dom.selectedElevation.textContent,
    slope: dom.selectedSlope.textContent,
    aspect: dom.selectedAspect.textContent,
    accum: dom.selectedAccum.textContent,
    risk: dom.selectedRisk.textContent,
    direction: dom.selectedFlow.textContent,
  };
  const pass =
    JSON.stringify(expected) === JSON.stringify(actual) &&
    dom.selectedFlowLabel.textContent.includes(
      cell.flowDirDeg === null ? "洼地" : cell.flowDirCode,
    ) &&
    dom.selectedAspectLabel.textContent.includes(bearingLabel(cell.aspectDeg));
  return {
    pass,
    detail: pass
      ? `${cellTitle(cell)} 的高程(m)、坡度(°)、坡向(°)、流向(°)与汇流(格)读数一致`
      : `读数不一致 ${JSON.stringify({ expected, actual })}`,
  };
}

function fixtureCheck(sampleId) {
  const topology = getTopology(sampleId);
  const { stats } = topology;
  const finite = topology.cells.every(
    (cell) =>
      Number.isFinite(cell.elevation) &&
      Number.isFinite(cell.slopeDeg) &&
      Number.isFinite(cell.aspectDeg),
  );
  return {
    pass:
      stats.nullRecords > 0 &&
      stats.duplicateRecords > 0 &&
      stats.outlierRecords > 0 &&
      finite,
    detail: `${topology.sample.code}: null=${stats.nullRecords}, duplicate=${stats.duplicateRecords}, outlier=${stats.outlierRecords}, finite=${finite}`,
  };
}

function runInternalChecks({ silent = false } = {}) {
  const sampleA = fixtureCheck("north-ridge");
  const sampleB = fixtureCheck("south-terrace");
  const compare = compareThresholds(
    state.topology,
    state.ui.thresholdA,
    state.ui.thresholdB,
    state.ui.selectedId,
  );
  const flow = flowIntegrity(state.topology);
  const expectedA = state.topology.cells.filter(
    (cell) => cell.riskIndex >= state.ui.thresholdA,
  ).length;
  const expectedB = state.topology.cells.filter(
    (cell) => cell.riskIndex >= state.ui.thresholdB,
  ).length;
  const thresholdPass =
    compare.countA === expectedA &&
    compare.countB === expectedB &&
    compare.delta === Math.abs(expectedA - expectedB);

  const layerBefore = state.ui.layer;
  const hoverBefore = state.ui.hoverId;
  const selectedBefore = state.ui.selectedId;
  let layerPass = true;
  LAYERS.forEach((layer) => {
    state.ui.layer = layer;
    renderCanvas();
    if (
      state.ui.hoverId !== hoverBefore ||
      state.ui.selectedId !== selectedBefore
    ) {
      layerPass = false;
    }
  });
  state.ui.layer = layerBefore;
  renderCanvas();
  syncLayerButtons();
  renderLegend(dom.mapLegend, state.topology, state.ui);
  renderContext();

  const project = createProject(state.ui);
  const reloaded = parseProject(JSON.parse(JSON.stringify(project)));
  const projectPass =
    JSON.stringify(reloaded.state) === JSON.stringify(normalizeUiState(state.ui));

  const readout = readoutIsConsistent();
  const beforeAudit = buildAuditSnapshot(
    state.topology,
    state.ui.thresholdA,
    state.ui.thresholdB,
  );
  createExportCanvas(state.topology, state.ui, beforeAudit, new Date());
  const afterAudit = buildAuditSnapshot(
    state.topology,
    state.ui.thresholdA,
    state.ui.thresholdB,
  );
  const exportPass = auditSnapshotsEqual(beforeAudit, afterAudit);

  state.checks = [
    {
      label: "样例 A 空/重/异",
      pass: sampleA.pass,
      detail: sampleA.detail,
    },
    {
      label: "样例 B 空/重/异",
      pass: sampleB.pass,
      detail: sampleB.detail,
    },
    {
      label: "坡度/坡向边界",
      pass: state.topology.cells.every(
        (cell) =>
          cell.slopeDeg >= 0 &&
          cell.slopeDeg <= 90 &&
          cell.aspectDeg >= 0 &&
          cell.aspectDeg < 360,
      ),
      detail: "slope ∈ [0,90]°, aspect ∈ [0,360)°",
    },
    {
      label: "D8 单调下降",
      pass: flow.valid === flow.total,
      detail: `${flow.valid}/${flow.total} 个非汇网格的下游高程更低`,
    },
    {
      label: "双阈值比较",
      pass: thresholdPass,
      detail: `A=${compare.countA}, B=${compare.countB}, Δ=${compare.delta}`,
    },
    {
      label: "单位/方向读数一致",
      pass: readout.pass,
      detail: readout.detail,
    },
    {
      label: "图层切换保持网格",
      pass: layerPass,
      detail: `hover=${state.ui.hoverId}, selected=${state.ui.selectedId}`,
    },
    {
      label: "工程往返一致",
      pass: projectPass,
      detail: "工程 JSON 保存/载入后状态逐字段相等",
    },
    {
      label: "导出对象/关键值",
      pass: exportPass,
      detail: `${beforeAudit.objectCount}→${afterAudit.objectCount}; ${hashPair(beforeAudit)}→${hashPair(afterAudit)}`,
    },
  ];
  state.checksRunAt = new Date().toISOString();
  renderChecks();
  renderDebug();
  const passed = state.checks.filter((check) => check.pass).length;
  setText(
    dom.debugStatus,
    `${passed}/${state.checks.length} PASS · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
  );
  if (!silent) {
    showToast(
      passed === state.checks.length
        ? `内置校验通过：${passed}/${state.checks.length}`
        : `内置校验存在异常：${passed}/${state.checks.length}`,
    );
  }
  return passed === state.checks.length;
}

function saveProject() {
  const snapshot = buildAuditSnapshot(
    state.topology,
    state.ui.thresholdA,
    state.ui.thresholdB,
  );
  const project = createProject(state.ui, { snapshot });
  const blob = new Blob([JSON.stringify(project, null, 2)], {
    type: "application/json",
  });
  const name = `terrain-flow_${state.topology.sample.code}_${state.ui.thresholdA}-${state.ui.thresholdB}.terrain.json`;
  downloadBlob(blob, name);
  showToast(`工程已保存 · ${name}`);
}

async function loadProjectFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const loaded = parseProject(JSON.parse(text));
    state.ui = normalizeUiState(loaded.state);
    state.topology = getTopology(state.ui.sampleId);
    if (!state.ui.selectedId) {
      state.ui.selectedId = state.topology.byId.has(initialSelection)
        ? initialSelection
        : null;
    }
    renderAll();
    resetEvidence(`工程已载入 · ${loaded.savedAt ? loaded.savedAt.slice(0, 16).replace("T", " ") : "无时间"}`);
    showToast(
      `工程已重新载入 · ${state.topology.sample.name} · A ${state.ui.thresholdA}% / B ${state.ui.thresholdB}%`,
    );
  } catch (error) {
    console.error(error);
    showToast(`载入失败：${error.message}`);
  } finally {
    dom.projectFileInput.value = "";
  }
}

function bindEvents() {
  document.querySelectorAll(".sample-btn").forEach((button) => {
    button.addEventListener("click", () => changeSample(button.dataset.sample));
  });
  document.querySelectorAll(".layer-btn").forEach((button) => {
    button.addEventListener("click", () => setLayer(button.dataset.layer));
  });
  dom.thresholdA.addEventListener("input", (event) =>
    setThreshold("thresholdA", event.target.value),
  );
  dom.thresholdB.addEventListener("input", (event) =>
    setThreshold("thresholdB", event.target.value),
  );
  dom.terrainCanvas.addEventListener("pointermove", updateHover);
  dom.terrainCanvas.addEventListener("click", (event) => {
    const cell = cellFromPointer(event);
    if (cell) selectCell(cell.id);
  });
  dom.toggleArrows.addEventListener("change", (event) => {
    state.ui.showArrows = event.target.checked;
    renderCanvas();
    resetEvidence("箭头显示变化");
  });
  dom.toggleGrid.addEventListener("change", (event) => {
    state.ui.showGrid = event.target.checked;
    renderCanvas();
    resetEvidence("网格显示变化");
  });
  dom.exportButton.addEventListener("click", async () => {
    dom.exportButton.disabled = true;
    try {
      await runExportAudit({ dryRun: false });
    } catch (error) {
      console.error(error);
      showToast(`导出失败：${error.message}`);
    } finally {
      dom.exportButton.disabled = false;
    }
  });
  dom.saveProjectButton.addEventListener("click", saveProject);
  dom.openProjectButton.addEventListener("click", () => dom.projectFileInput.click());
  dom.projectFileInput.addEventListener("change", (event) => {
    void loadProjectFile(event.target.files?.[0]);
  });
  dom.runChecksButton.addEventListener("click", () => {
    runExportAudit({ dryRun: true, silent: true });
    runInternalChecks();
  });
}

function exposeDebugApi() {
  window.__terrainApp = {
    getState: () => ({ ...state.ui }),
    getSample: () => state.topology.sample,
    getTopology: () => state.topology,
    getCell: (id) => state.topology.byId.get(id),
    getAudit: () => structuredClone(state.audit),
    getChecks: () => state.checks.map((check) => ({ ...check })),
    getSnapshot: () =>
      buildAuditSnapshot(state.topology, state.ui.thresholdA, state.ui.thresholdB),
    selectCell,
    setLayer,
    setThreshold,
    runInternalChecks,
    runExportAudit,
    createProject: () => createProject(state.ui),
  };
}

async function init() {
  cacheDom();
  try {
    await document.fonts.load("400 16px 'Noto Sans SC'");
    await document.fonts.ready;
  } catch (error) {
    console.warn("中文字体预载失败，将使用系统回退", error);
  }
  state.topology = getTopology(state.ui.sampleId);
  if (!state.topology.byId.has(state.ui.selectedId)) {
    state.ui.selectedId = initialSelection;
  }
  bindEvents();
  renderAll();
  exposeDebugApi();
  setText(
    dom.debugStatus,
    `已载入 ${state.topology.sample.fixture} · ${GRID.cols * GRID.rows} 网格`,
  );
  setTimeout(() => {
    runExportAudit({ dryRun: true, silent: true });
    runInternalChecks({ silent: true });
  }, 80);
}

init();
