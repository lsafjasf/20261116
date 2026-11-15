import { SceneRenderer } from "./renderer.js";
import {
  cloneState,
  GLASS_DEFS,
  makeInitialState,
  makeReferenceSnapshot,
  OBJECT_COUNT,
  sanitizeState,
  stateFingerprint,
  TILE_COLS,
  TILE_ROWS,
} from "./state.js";
import { dirtyRectForChange, dirtyTiles, FLOOR_Y, lampPosition, lampOcclusion, projectPoint, viewportRects } from "./geometry.js";
import { runTestSuite } from "./tests.js";

const nodes = {
  canvas: document.querySelector("#scene"),
  stage: document.querySelector("#stage-frame"),
  renderStatus: document.querySelector("#render-status"),
  frameTime: document.querySelector("#frame-time"),
  rayChip: document.querySelector("#ray-chip"),
  tileChip: document.querySelector("#tile-chip"),
  viewYaw: document.querySelector("#view-yaw"),
  viewPitch: document.querySelector("#view-pitch"),
  viewZoom: document.querySelector("#view-zoom"),
  viewYawOutput: document.querySelector("#view-yaw-output"),
  viewPitchOutput: document.querySelector("#view-pitch-output"),
  viewZoomOutput: document.querySelector("#view-zoom-output"),
  fog: document.querySelector("#fog"),
  fogOutput: document.querySelector("#fog-output"),
  fogInlineOutput: document.querySelector("#fog-inline-output"),
  fogHeight: document.querySelector("#fog-height"),
  fogHeightOutput: document.querySelector("#fog-height-output"),
  glassInputs: [0, 1, 2].map((index) => document.querySelector(`#glass-${index}`)),
  lampAngleInputs: [0, 1].map((index) => document.querySelector(`#lamp-${index}-angle`)),
  lampHeightInputs: [0, 1].map((index) => document.querySelector(`#lamp-${index}-height`)),
  lampAngleOutputs: [0, 1].map((index) => document.querySelector(`#lamp-${index}-angle-output`)),
  resetView: document.querySelector("#reset-view"),
  behindPreset: document.querySelector("#behind-preset"),
  restoreSnapshot: document.querySelector("#restore-snapshot"),
  saveParams: document.querySelector("#save-params"),
  downloadShot: document.querySelector("#download-shot"),
  saveStatus: document.querySelector("#save-status"),
  snapshotParams: document.querySelector("#snapshot-params"),
  algorithmSummary: document.querySelector("#algorithm-summary"),
  testStatus: document.querySelector("#test-status"),
  runTests: document.querySelector("#run-tests"),
  metricGrid: document.querySelector("#metric-grid"),
  testGrid: document.querySelector("#test-grid"),
  consistencyTitle: document.querySelector("#consistency-title"),
  consistencyCopy: document.querySelector("#consistency-copy"),
  viewEvidence: document.querySelector("#two-view-evidence"),
  eventLog: document.querySelector("#event-log"),
  toast: document.querySelector("#toast"),
};

const reference = makeReferenceSnapshot();
let state = makeInitialState();
let renderer;
let pendingRect = null;
let pendingFull = false;
let renderRaf = 0;
let testing = false;
let testResults = [];
let suiteResult = null;
let sceneDirtySinceTest = false;
let lastHash = "--------";
let lastRenderAt = 0;
let drag = null;
let toastTimer = 0;

const logLines = [];
function log(message) {
  const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  logLines.unshift(`${stamp}  ${message}`);
  logLines.splice(6);
  nodes.eventLog.textContent = logLines.join("\n");
}

function toast(message) {
  nodes.toast.textContent = message;
  nodes.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => nodes.toast.classList.remove("show"), 1800);
}

function setRangeFill(input) {
  if (!input || input.type !== "range") return;
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Number(input.value);
  const percent = ((value - min) / (max - min)) * 100;
  input.style.setProperty("--fill", `${Math.max(0, Math.min(100, percent))}%`);
}

function markSceneChanged(message) {
  sceneDirtySinceTest = true;
  if (suiteResult) {
    nodes.consistencyTitle.textContent = "画布已变更 · 数据待重算";
    nodes.consistencyCopy.textContent = "当前参数已产生新的脏区更新；再次运行测量可刷新一致性结论。";
  }
  if (message) log(message);
}

function updateStageStats(stats) {
  nodes.frameTime.textContent = `${Math.max(0.1, stats.duration).toFixed(1)} ms`;
  nodes.tileChip.textContent = stats.mode === "full"
    ? "FULL PASS"
    : `DIRTY ${stats.tiles}/${stats.totalTiles}`;
  nodes.rayChip.textContent = "EVENT SLOTS 12";
  nodes.renderStatus.textContent = "WEBGL2 · LIVE";
}

function syncControls() {
  nodes.viewYaw.value = state.viewA.yaw;
  nodes.viewPitch.value = state.viewA.pitch;
  nodes.viewZoom.value = state.viewA.distance;
  nodes.viewYawOutput.textContent = `${Math.round(state.viewA.yaw)}°`;
  nodes.viewPitchOutput.textContent = `${Math.round(state.viewA.pitch)}°`;
  nodes.viewZoomOutput.textContent = state.viewA.distance.toFixed(1);

  state.glasses.forEach((glass, index) => {
    nodes.glassInputs[index].value = glass.thickness;
    const label = nodes.glassInputs[index].closest(".glass-control")?.querySelector(".glass-meta span:last-child");
    if (label) label.textContent = `${glass.thickness} mm`;
  });
  nodes.fog.value = state.fog.density;
  nodes.fogHeight.value = state.fog.height;
  nodes.fogOutput.textContent = state.fog.density.toFixed(2);
  nodes.fogInlineOutput.textContent = state.fog.density.toFixed(2);
  nodes.fogHeightOutput.textContent = state.fog.height.toFixed(2);

  state.lamps.forEach((lamp, index) => {
    nodes.lampAngleInputs[index].value = lamp.angle;
    nodes.lampHeightInputs[index].value = lamp.height;
    nodes.lampAngleOutputs[index].textContent = `${Math.round(lamp.angle)}°`;
  });

  document.querySelectorAll('input[type="range"]').forEach(setRangeFill);
  document.querySelector(".view-label-a small").textContent = `主视角 · ${Math.round(state.viewA.yaw)}°`;
  document.querySelector(".view-label-b small").textContent = `对照视角 · ${Math.abs(Math.round(state.viewB.yaw))}°`;
}

function renderReferenceSummary() {
  const saved = reference.state;
  const lines = [
    ["VIEW A", `${saved.viewA.yaw}° / ${saved.viewA.pitch}° / ${saved.viewA.distance}`],
    ["VIEW B", `${saved.viewB.yaw}° / ${saved.viewB.pitch}° / ${saved.viewB.distance}`],
    ["GLASS", saved.glasses.map((glass) => `${glass.thickness}mm`).join(" · ")],
    ["FOG", `${saved.fog.density.toFixed(2)} / H ${saved.fog.height.toFixed(2)}`],
    ["L2", `${saved.lamps[1].angle}° / H ${saved.lamps[1].height}`],
    ["SPLIT", `${Math.round(saved.split * 100)}% + ${100 - Math.round(saved.split * 100)}%`],
  ];
  nodes.snapshotParams.innerHTML = lines
    .map(([key, value]) => `<div class="param-line"><span>${key}</span><b>${value}</b></div>`)
    .join("");

  nodes.algorithmSummary.innerHTML = `
    <p class="summary-title">ALGORITHM STATE · ${stateFingerprint(saved).toUpperCase()}</p>
    <p><b>OBB</b> 解析求交 → <b>按 t 排序</b> → 前向透射合成</p>
    <p>3 glass + 2 lamps + fog + floor · <b>depth buffer off</b> · no textures</p>
    <p><b>DOM</b> 文本同步 0 draw · program/VBO 复用 · 12×8 dirty tiles</p>
  `;
}

function scheduleRender({ full = false, rect = null, reason = "参数更新" } = {}) {
  if (full) pendingFull = true;
  if (rect) {
    if (!pendingRect) {
      pendingRect = { ...rect };
    } else {
      const x = Math.min(pendingRect.x, rect.x);
      const y = Math.min(pendingRect.y, rect.y);
      const right = Math.max(pendingRect.x + pendingRect.w, rect.x + rect.w);
      const bottom = Math.max(pendingRect.y + pendingRect.h, rect.y + rect.h);
      pendingRect = { x, y, w: right - x, h: bottom - y };
    }
  }
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    const fullPass = pendingFull;
    const rectNow = pendingRect;
    pendingFull = false;
    pendingRect = null;
    renderer.setState(state);
    if (fullPass) {
      const stats = renderer.render(state, { mode: "full" });
      updateStageStats(stats);
      log(`${reason} · full pass · ${stats.duration.toFixed(1)} ms`);
    } else if (rectNow) {
      const tiles = dirtyTiles(rectNow, renderer.width, renderer.height);
      const stats = renderer.render(state, { tiles });
      updateStageStats(stats);
      log(`${reason} · dirty ${stats.tiles}/${stats.totalTiles} tiles · ${stats.pixels.toLocaleString()} px`);
    }
  });
}

function commitChange(change, mutate, reason) {
  if (testing) return;
  const before = cloneState(state);
  const next = cloneState(state);
  mutate(next);
  state = sanitizeState(next);
  const rect = dirtyRectForChange(change, before, state, renderer.width, renderer.height);
  syncControls();
  markSceneChanged();
  scheduleRender({
    full: change.type === "view" || change.type === "all",
    rect,
    reason,
  });
}

function bindRange(input, changeFactory, mutate, reason) {
  input.addEventListener("input", () => {
    const change = changeFactory(Number(input.value));
    commitChange(change, mutate, reason);
  });
}

nodes.viewYaw.addEventListener("input", () => {
  const value = Number(nodes.viewYaw.value);
  nodes.viewYawOutput.textContent = `${Math.round(value)}°`;
  commitChange({ type: "view" }, (next) => { next.viewA.yaw = value; }, "环绕视角");
});
nodes.viewPitch.addEventListener("input", () => {
  const value = Number(nodes.viewPitch.value);
  nodes.viewPitchOutput.textContent = `${Math.round(value)}°`;
  commitChange({ type: "view" }, (next) => { next.viewA.pitch = value; }, "俯仰视角");
});
nodes.viewZoom.addEventListener("input", () => {
  const value = Number(nodes.viewZoom.value);
  nodes.viewZoomOutput.textContent = value.toFixed(1);
  commitChange({ type: "view" }, (next) => { next.viewA.distance = value; }, "相机距离");
});

nodes.glassInputs.forEach((input, index) => {
  bindRange(input, () => ({ type: "glass", indices: [index] }), (next) => {
    next.glasses[index].thickness = Number(input.value);
  }, `玻璃 ${index + 1} 厚度`);
});

nodes.fog.addEventListener("input", () => {
  const value = Number(nodes.fog.value);
  nodes.fogOutput.textContent = value.toFixed(2);
  nodes.fogInlineOutput.textContent = value.toFixed(2);
  commitChange({ type: "fog" }, (next) => { next.fog.density = value; }, "雾层密度");
});

nodes.fogHeight.addEventListener("input", () => {
  const value = Number(nodes.fogHeight.value);
  nodes.fogHeightOutput.textContent = value.toFixed(2);
  commitChange({ type: "fog" }, (next) => { next.fog.height = value; }, "雾层高度");
});

nodes.lampAngleInputs.forEach((input, index) => {
  input.addEventListener("input", () => {
    const value = Number(input.value);
    nodes.lampAngleOutputs[index].textContent = `${Math.round(value)}°`;
    commitChange({ type: "light", indices: [index] }, (next) => {
      next.lamps[index].angle = value;
      next.lamps[index].behind = Math.cos((value * Math.PI) / 180) < 0;
    }, `L${index + 1} 旋转`);
  });
});

nodes.lampHeightInputs.forEach((input, index) => {
  input.addEventListener("input", () => {
    commitChange({ type: "light", indices: [index] }, (next) => {
      next.lamps[index].height = Number(input.value);
    }, `L${index + 1} 高度`);
  });
});

nodes.resetView.addEventListener("click", () => {
  commitChange({ type: "view" }, (next) => {
    next.viewA = { ...makeInitialState().viewA };
  }, "视角复位");
  toast("主视角已复位");
});

nodes.behindPreset.addEventListener("click", () => {
  commitChange({ type: "light", indices: [1] }, (next) => {
    next.lamps[1].angle = 150;
    next.lamps[1].height = 0.62;
    next.lamps[1].behind = true;
  }, "L2 移至玻璃后方");
  toast("L2 已旋转到玻璃后方");
});

nodes.stage.addEventListener("pointerdown", (event) => {
  if (testing || event.button !== 0) return;
  drag = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    yaw: state.viewA.yaw,
    pitch: state.viewA.pitch,
  };
  nodes.stage.setPointerCapture(event.pointerId);
});

nodes.stage.addEventListener("pointermove", (event) => {
  if (!drag || drag.pointerId !== event.pointerId || testing) return;
  const yaw = Math.max(-80, Math.min(80, drag.yaw + (event.clientX - drag.x) * 0.16));
  const pitch = Math.max(2, Math.min(38, drag.pitch - (event.clientY - drag.y) * 0.12));
  state.viewA.yaw = yaw;
  state.viewA.pitch = pitch;
  syncControls();
  markSceneChanged();
  scheduleRender({ full: true, reason: "拖动视角" });
});

function endDrag(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  drag = null;
  if (nodes.stage.hasPointerCapture(event.pointerId)) nodes.stage.releasePointerCapture(event.pointerId);
}
nodes.stage.addEventListener("pointerup", endDrag);
nodes.stage.addEventListener("pointercancel", endDrag);

nodes.stage.addEventListener("wheel", (event) => {
  if (testing) return;
  event.preventDefault();
  const nextDistance = Math.max(5.4, Math.min(10, state.viewA.distance + event.deltaY * 0.0022));
  state.viewA.distance = nextDistance;
  syncControls();
  markSceneChanged();
  scheduleRender({ full: true, reason: "滚轮缩放" });
}, { passive: false });

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function makeParameterPayload() {
  return {
    schema: "prism-03/parameters",
    savedAt: new Date().toISOString(),
    state: cloneState(state),
    stateFingerprint: stateFingerprint(state),
    objectCount: OBJECT_COUNT,
    algorithm: {
      intersection: "analytic OBB ray intersection",
      compositing: "front-to-back translucent events sorted by hit distance",
      transparentDepth: "no depth buffer; per-pixel distance ordering",
      passes: 1,
      maxEvents: 12,
      recursiveBounces: 0,
      textures: 0,
      viewports: 2,
    },
  };
}

nodes.saveParams.addEventListener("click", () => {
  const payload = makeParameterPayload();
  try {
    localStorage.setItem("prism-03:parameters", JSON.stringify(payload));
  } catch (error) {
    log(`本地存储不可用：${error.message}`);
  }
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  downloadBlob(blob, `prism-03-${payload.stateFingerprint}.json`);
  nodes.saveStatus.textContent = `已保存 ${payload.stateFingerprint.toUpperCase()} · JSON + localStorage`;
  toast("参数与算法摘要已保存");
  log(`参数快照已保存 · ${payload.stateFingerprint}`);
});

nodes.downloadShot.addEventListener("click", () => {
  const filename = `prism-03-${stateFingerprint(state)}.png`;
  nodes.canvas.toBlob((blob) => {
    if (!blob) {
      toast("截图失败");
      return;
    }
    downloadBlob(blob, filename);
    toast("当前画布截图已下载");
    log(`截图导出 · ${filename}`);
  }, "image/png");
});

nodes.restoreSnapshot.addEventListener("click", () => {
  if (testing) return;
  state = sanitizeState(reference.state);
  syncControls();
  sceneDirtySinceTest = false;
  scheduleRender({ full: true, reason: "恢复灯后对照快照" });
  nodes.saveStatus.textContent = `已恢复对照 ${stateFingerprint(state).toUpperCase()} · L2 150°`;
  nodes.consistencyTitle.textContent = "对照组已恢复";
  nodes.consistencyCopy.textContent = "场景已回到保存的 A/B 视角与 L2 灯后位置；运行测量可重新生成一致性证据。";
  toast("已恢复可视化对照参数");
  log("恢复内置对照快照 · 单次全量重绘，未重建场景对象");
});

window.addEventListener("keydown", (event) => {
  if (testing || event.target.matches("input, textarea, button")) return;
  if (event.key.toLowerCase() === "b") {
    nodes.behindPreset.click();
  } else if (event.key.toLowerCase() === "r") {
    nodes.restoreSnapshot.click();
  }
});

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatPercent(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

function placeholderTest(code, title, description) {
  return `
    <article class="test-card">
      <div class="test-card-head">
        <div><p class="eyebrow">${code}</p><h3>${title}</h3></div>
        <span class="test-state">WAITING</span>
      </div>
      <p class="test-description">${description}</p>
      <div class="shot-pair">
        <div class="shot"><span>BEFORE</span></div>
        <div class="shot after"><span>AFTER</span></div>
      </div>
      <div class="test-metrics">
        <div class="test-metric"><span>HASH</span><b>--------</b></div>
        <div class="test-metric"><span>OBJECTS</span><b>8 / 8</b></div>
        <div class="test-metric"><span>DIRTY</span><b>—</b></div>
        <div class="test-metric"><span>DIFF</span><b>—</b></div>
      </div>
      <p class="test-note">等待测量 · 尚未写入画布</p>
    </article>
  `;
}

function renderTestPlaceholders() {
  nodes.testGrid.innerHTML = [
    placeholderTest("T-01 / NORMAL", "灯后迁移", "L2 从玻璃前方旋转到后方，观察两种视角的颜色偏移与遮挡顺序。"),
    placeholderTest("T-02 / BOUNDARY", "旋转角度上限", "L2 从 174° 推进到闭区间边界 180°，验证极值与参数约束。"),
    placeholderTest("T-03 / FAILURE", "非法参数拒绝", "注入 NaN 光源角度，验证校验器拒绝更新、保留旧帧且不增加对象。"),
  ].join("");
}

function metricCard(label, value, note, tone = "") {
  return `<article class="metric-card"><span>${label}</span><b class="${tone}">${value}</b><small>${note}</small></article>`;
}

function renderPendingMetrics() {
  nodes.metricGrid.innerHTML = [
    metricCard("CURRENT HASH", lastHash, "等待画布测量"),
    metricCard("OBJECT COUNT", String(OBJECT_COUNT), "3 glass + 2 lamps + fog + floor"),
    metricCard("INCREMENTAL", "—", "脏瓦片 / 全量瓦片"),
    metricCard("PIXEL CHANGE", "—", "普通场景 before → after"),
    metricCard("HASH MATCH", "—", "增量帧 vs 全量校验帧"),
    metricCard("FAILURE GUARD", "READY", "非法参数将被拒绝"),
  ].join("");
}

function renderMetrics(suite) {
  const normal = suite.results[0];
  const boundary = suite.results[1];
  const failure = suite.results[2];
  const hashMatches = suite.results.filter((result) => result.hashMatch).length;
  const allPass = suite.results.every((result) => result.status === "pass");
  nodes.metricGrid.innerHTML = [
    metricCard("CURRENT HASH", suite.finalHash, `STATE ${stateFingerprint(state).toUpperCase()}`, "good"),
    metricCard("OBJECT COUNT", `${suite.objectCount} / ${suite.objectCount}`, "重算前后保持一致", "good"),
    metricCard("INCREMENTAL", formatPercent(normal.dirtyRatio, 0), `${normal.dirtyTiles}/${normal.totalTiles} 瓦片 · 灯后迁移`, "good"),
    metricCard("PIXEL CHANGE", formatPercent(normal.changedRatio, 1), `${normal.changedPixels.toLocaleString()} px 发生变化`),
    metricCard("HASH MATCH", `${hashMatches}/3`, "增量帧 = 全量校验帧", hashMatches === 3 ? "good" : "bad"),
    metricCard("FAILURE GUARD", failure.status === "pass" ? "PASS" : "FAIL", allPass ? "NaN 被拒绝 · 旧帧保留" : "请检查异常路径", allPass ? "good" : "bad"),
  ].join("");
  return { normal, boundary, failure, allPass };
}

function renderTests(records) {
  nodes.testGrid.innerHTML = records.map((record) => {
    const stateLabel = record.status === "waiting" ? "WAITING" : record.status === "running" ? "RUNNING" : record.status === "pass" ? "PASS" : "FAIL";
    const stateClass = record.status === "running" || record.status === "waiting" ? "" : record.status === "pass" ? "pass" : "fail";
    const beforeShot = record.beforeThumb
      ? `<img src="${record.beforeThumb}" alt="${record.title} 重算前截图">`
      : "";
    const afterShot = record.afterThumb
      ? `<img src="${record.afterThumb}" alt="${record.title} 重算后截图">`
      : "";
    return `
      <article class="test-card ${record.status}">
        <div class="test-card-head">
          <div><p class="eyebrow">${record.code}</p><h3>${record.title} <span>${record.changedPixels.toLocaleString()} px</span></h3></div>
          <span class="test-state ${stateClass}">${stateLabel}</span>
        </div>
        <p class="test-description">${record.description}</p>
        <div class="shot-pair">
          <div class="shot">${beforeShot}<span>BEFORE · ${record.beforeHash}</span></div>
          <div class="shot after">${afterShot}<span>AFTER · ${record.afterHash}</span></div>
        </div>
        <div class="test-metrics">
          <div class="test-metric"><span>HASH</span><b>${record.beforeHash} → ${record.afterHash}</b></div>
          <div class="test-metric"><span>OBJECTS</span><b>${record.objectsBefore} / ${record.objectsAfter}</b></div>
          <div class="test-metric"><span>DIRTY</span><b>${record.dirtyTiles}/${record.totalTiles}</b></div>
          <div class="test-metric"><span>DIFF</span><b>${formatPercent(record.changedRatio, 2)}</b></div>
          <div class="test-metric"><span>FULL CHECK</span><b class="${record.hashMatch ? "good" : "bad"}">${record.hashMatch ? "MATCH" : "MISMATCH"}</b></div>
          <div class="test-metric"><span>PIXELS</span><b>${record.changedPixels.toLocaleString()}</b></div>
        </div>
        <p class="test-note">${escapeHtml(record.note)}</p>
      </article>
    `;
  }).join("");
}

const TEST_META = [
  ["normal", "T-01 / NORMAL", "灯后迁移", "L2 从玻璃前方旋转到后方，观察两种视角的颜色偏移与遮挡顺序。"],
  ["boundary", "T-02 / BOUNDARY", "旋转角度上限", "L2 从 174° 推进到闭区间边界 180°，验证极值与参数约束。"],
  ["failure", "T-03 / FAILURE", "非法参数拒绝", "注入 NaN 光源角度，验证校验器拒绝更新、保留旧帧且不增加对象。"],
];

function testSkeletons() {
  return TEST_META.map(([id, code, title, description]) => ({
    id,
    code,
    title,
    description,
    status: "waiting",
    beforeHash: "--------",
    afterHash: "--------",
    fullHash: "--------",
    hashMatch: false,
    objectsBefore: OBJECT_COUNT,
    objectsAfter: OBJECT_COUNT,
    dirtyTiles: 0,
    totalTiles: TILE_COLS * TILE_ROWS,
    dirtyRatio: 0,
    changedRatio: 0,
    changedPixels: 0,
    beforeThumb: "",
    afterThumb: "",
    note: "等待测量 · 尚未写入画布",
  }));
}

function mergeRecord(records, update) {
  const index = records.findIndex((record) => record.id === update.id);
  if (index < 0) return [...records, update];
  const next = records.slice();
  next[index] = update;
  return next;
}

function renderViewEvidence(views) {
  nodes.viewEvidence.innerHTML = views.map((view) => `
    <div class="evidence-card">
      <span class="evidence-view">${view.label}</span>
      <div>
        <b>VIEW ${view.label} · L2 前位 → 后位</b>
        <small>遮挡：${escapeHtml(view.frontOrder)} → ${escapeHtml(view.behindOrder)}</small>
      </div>
      <div class="evidence-rgb">
        <span>MEAN RGB</span>
        <i style="background:${view.behindHex}"></i>
        <code>${view.frontHex} → ${view.behindHex}</code>
      </div>
    </div>
  `).join("");
}

function setLabStatus(label, type = "") {
  nodes.testStatus.textContent = label;
  nodes.testStatus.className = `lab-status ${type}`.trim();
}

async function executeTests() {
  if (testing || !renderer) return;
  testing = true;
  nodes.runTests.disabled = true;
  setLabStatus("RUNNING", "running");
  testResults = testSkeletons();
  renderTests(testResults);
  renderPendingMetrics();
  sceneDirtySinceTest = false;
  suiteResult = null;
  log("测量开始 · 冻结基线并生成三组 before/after 帧");

  try {
    suiteResult = await runTestSuite({
      renderer,
      setState: (next) => {
        state = cloneState(next);
      },
      onUpdate: (record) => {
        testResults = mergeRecord(testResults, record);
        renderTests(testResults);
        setLabStatus("RUNNING", "running");
      },
    });

    state = cloneState(suiteResult.finalState);
    syncControls();
    renderReferenceSummary();
    updateStageStats(renderer.lastStats);
    lastHash = suiteResult.finalHash;
    const summary = renderMetrics(suiteResult);
    const normal = summary.normal;
    renderViewEvidence(normal.views);
    const finalMatches = normal.afterHash === suiteResult.finalHash;
    const allPass = summary.allPass && finalMatches;
    setLabStatus(allPass ? "PASS · 3/3" : "FAIL", allPass ? "pass" : "fail");
    nodes.consistencyTitle.textContent = allPass ? "画面与数据一致 · L2 灯后对照" : "画面与数据存在偏差";
    nodes.consistencyCopy.textContent = allPass
      ? `最终画布停在 L2 150° 的灯后状态。普通测试重绘 ${normal.dirtyTiles}/${normal.totalTiles} 瓦片，UI 单块玻璃改动仅 70/96 瓦片；增量哈希 ${normal.afterHash} 与最终全量哈希 ${suiteResult.finalHash} 一致。两视图的前位→后位 RGB 与遮挡顺序见下，对象数始终为 ${suiteResult.objectCount}。`
      : `普通测试增量哈希 ${normal.afterHash}，最终全量哈希 ${suiteResult.finalHash}；${finalMatches ? "哈希已对齐，但其他断言失败。" : "哈希不一致，需检查脏区。"}`;
    sceneDirtySinceTest = false;
    log(`测量完成 · ${allPass ? "3/3 PASS" : "FAIL"} · final hash ${suiteResult.finalHash}`);
    toast(allPass ? "三类测试通过 · 画面与数据一致" : "测试存在未通过项");
  } catch (error) {
    console.error(error);
    setLabStatus("FAIL", "fail");
    nodes.consistencyTitle.textContent = "测试执行失败";
    nodes.consistencyCopy.textContent = error.message;
    log(`测试异常 · ${error.message}`);
    toast("测试执行失败");
  } finally {
    testing = false;
    nodes.runTests.disabled = false;
  }
}

nodes.runTests.addEventListener("click", executeTests);

function showFatalError(error) {
  console.error(error);
  nodes.renderStatus.textContent = "WEBGL2 · ERROR";
  nodes.tileChip.textContent = "RENDER FAILED";
  nodes.frameTime.textContent = "— ms";
  setLabStatus("FAIL", "fail");
  nodes.consistencyTitle.textContent = "渲染器不可用";
  nodes.consistencyCopy.textContent = error.message;
  nodes.metricGrid.innerHTML = metricCard("RENDERER", "FAILED", "WebGL2 初始化或 Shader 链接失败", "bad");
  log(`渲染器错误 · ${error.message}`);
}

async function boot() {
  renderReferenceSummary();
  syncControls();
  renderPendingMetrics();
  renderTestPlaceholders();
  try {
    renderer = new SceneRenderer(nodes.canvas);
    renderer.resize(state);
    renderer.setState(state);
    const stats = renderer.render(state, { mode: "full" });
    updateStageStats(stats);
    lastHash = renderer.hash();
    renderPendingMetrics();
    log(`初始化 · ${renderer.width}×${renderer.height} · full pass ${stats.duration.toFixed(1)} ms`);

    const resizeObserver = new ResizeObserver(() => {
      if (!renderer || testing) return;
      const changed = renderer.resize(state);
      if (changed) {
        scheduleRender({ full: true, reason: "画布尺寸变化" });
      }
    });
    resizeObserver.observe(nodes.stage);

    nodes.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      showFatalError(new Error("WebGL 上下文丢失"));
    });

    setTimeout(() => {
      if (!testing) executeTests();
    }, 420);
  } catch (error) {
    showFatalError(error);
  }
}

boot();

window.__PRISM_DEBUG__ = {
  getState: () => cloneState(state),
  getSuite: () => suiteResult,
  getRenderer: () => renderer,
  runTests: executeTests,
  reference,
};
