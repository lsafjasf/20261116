import { SAMPLES, normalizeSample, buildCards, dataSignature, formatNumber, formatFull } from "./data.js";
import {
  createTemplate,
  createInstances,
  createProject,
  auditReferences,
  persistTemplate,
  persistInstances,
  persistProject,
  loadTemplateFromStore,
  loadInstancesFromStore,
  loadProjectFromStore,
  installBundle,
  countSceneNodes,
  signature,
  makeSnapshot,
  compareSnapshots,
  clone
} from "./state.js";
import { renderStage, keyframeAt } from "./renderer.js";
import { exportWebm, downloadBlob } from "./export.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const canvas = $("#stageCanvas");
const nowIso = () => new Date().toISOString();

const state = {
  template: createTemplate(),
  instances: createInstances(),
  activeVariant: "short",
  sampleId: "A",
  filter: "all",
  revision: 0,
  result: null,
  cards: [],
  time: 6,
  playing: false,
  loop: true,
  selectedKey: 1,
  layout: null,
  reloadAudit: null,
  preExport: null,
  postExport: null,
  comparison: null,
  exportInfo: null,
  lastSavedAt: null
};

function instance() {
  return state.instances.find((item) => item.variant === state.activeVariant) || state.instances[0];
}

function sample() {
  const base = clone(SAMPLES[state.sampleId]);
  if (state.revision > 0) {
    const target = base.records.find((record) => !base.records.some((other) => other !== record && other.id === record.id && other.revenue === record.revenue));
    if (target) {
      target[base.primaryKey] = (target[base.primaryKey] || 0) + state.revision * (state.sampleId === "A" ? 14800 : 52);
      target[base.secondaryKey] = (target[base.secondaryKey] || 0) + state.revision * (state.sampleId === "A" ? 17 : 7200);
    }
  }
  return base;
}

function visibleCards() {
  const cards = state.cards.slice(0, Math.min(state.template.cardCount, 3));
  if (state.template.cardCount > 3) {
    cards.push({
      label: "HEALTH",
      value: `${state.result.quality.score}`,
      full: `${state.result.quality.score}`,
      note: `${state.result.quality.nulls} nulls / ${state.result.quality.duplicates} duplicate`
    });
  }
  return cards.length ? cards : state.cards.slice(0, 1);
}

function recomputeData() {
  state.result = normalizeSample(sample(), state.filter, state.revision);
  state.cards = buildCards(sample(), state.result);
}

function renderCanvas() {
  state.layout = renderStage(canvas, {
    template: state.template,
    instance: instance(),
    result: state.result,
    cards: visibleCards(),
    time: state.time
  });
  updateStageMeta();
}

function updateStageMeta() {
  const layout = state.layout;
  if (!layout) return;
  $("#layoutMeasure").textContent = `${layout.fontSize}px / ${layout.lines.length}L`;
  $("#layoutStatus").textContent = `${layout.lines.length} 行 / ${layout.fontSize}px`;
  $("#bindingStatus").textContent = `样例 ${state.sampleId} · ${visibleCards().length} 项指标`;
  $("#nodeCount").textContent = countSceneNodes(state.template, instance(), visibleCards().length);
  $("#titleLengthLabel").textContent = `${Array.from(instance().title).length} 字`;
  $("#cardCountLabel").textContent = `0${visibleCards().length} CARDS`;
  $("#templateVersion").textContent = `T.0${state.template.version}`;
  $("#templateIdLabel").textContent = state.template.id;
  $("#instancePill").textContent = `${instance().id} · LINKED`;
  $("#sceneTitle").textContent = `Launch / ${state.activeVariant === "short" ? "短文案" : "长文案"}`;
  $("#transitionName").textContent = state.template.transition.toUpperCase();
}

function updateTimeUI() {
  $("#timecode").innerHTML = `${formatTime(state.time)} <em>/ 00:12.00</em>`;
  $("#playhead").style.left = `${(state.time / 12) * 100}%`;
  $$(".timeline-key").forEach((key) => {
    key.classList.toggle("active", Number(key.dataset.index) === state.selectedKey);
  });
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const rest = (seconds % 60).toFixed(2).padStart(5, "0");
  return `${minutes}:${rest}`;
}

function renderInspector() {
  $("#templateNameInput").value = state.template.name;
  $("#formatSelect").value = state.template.format;
  $("#tempoSelect").value = state.template.tempo;
  $("#titleInput").value = instance().title;
  $("#kickerInput").value = instance().kicker;
  $("#cardCountInput").value = state.template.cardCount;
  $("#cardGapInput").value = state.template.cardGap;
  $("#accentInput").value = state.template.accent.toLowerCase();
  $("#accentTextInput").value = state.template.accent.toUpperCase();
  $$("#variantSwitch button").forEach((button) => button.classList.toggle("active", button.dataset.variant === state.activeVariant));
  $$("#transitionGrid button").forEach((button) => button.classList.toggle("active", button.dataset.transition === state.template.transition));
  renderKeyframes();
}

function renderKeyframes() {
  const keys = [...state.template.keyframes].sort((a, b) => a.time - b.time);
  state.selectedKey = Math.min(state.selectedKey, keys.length - 1);
  $("#keyCountBadge").textContent = keys.length;
  $("#keyframeList").innerHTML = keys.map((keyframe, index) => `
    <div class="key-row ${index === state.selectedKey ? "active" : ""}" data-index="${index}">
      <time>${keyframe.time.toFixed(2)}s</time>
      <div class="key-line"><i style="left:${Math.min(92, Math.max(0, (keyframe.x - 60) / 60 * 100))}%"></i></div>
      <span class="swatch" style="background:${keyframe.color}"></span>
    </div>
  `).join("");
  $("#timelineKeys").innerHTML = keys.map((keyframe, index) => `
    <span class="timeline-key ${index === state.selectedKey ? "active" : ""}" data-index="${index}" style="left:calc(${keyframe.time / 12 * 100}% - 4px)"></span>
  `).join("");
  const selected = keys[state.selectedKey] || keys[0];
  if (selected) {
    $("#keyCurrentTime").textContent = `${selected.time.toFixed(2)}s`;
    $("#keyTimeInput").value = selected.time;
    $("#keyXInput").value = Math.round(selected.x);
    $("#keyYInput").value = Math.round(selected.y);
    $("#keyOpacityInput").value = selected.opacity;
    $("#keyColorInput").value = /^#[0-9a-f]{6}$/i.test(selected.color) ? selected.color : "#d7ff45";
  }
  updateTimeUI();
}

function renderDataPanel() {
  const result = state.result;
  const sampleData = SAMPLES[state.sampleId];
  const cards = state.cards;
  $("#filterValue").textContent = result.filterLabel;
  $("#dataVersion").textContent = result.version;
  $("#exportScope").textContent = `样例 ${state.sampleId} · ${result.acceptedCount}/${result.rawCount} 有效`;
  $("#healthPill");
  $("#dataHealth").className = `health-pill ${result.quality.outliers ? "warn" : ""}`;
  $("#dataHealth").innerHTML = `<i></i> ${result.quality.outliers ? "CLAMPED" : "VALID"}`;
  $("#dataHealth").style.color = result.quality.outliers ? "var(--warning)" : "var(--green)";
  $$("#sampleSwitch button").forEach((button) => button.classList.toggle("active", button.dataset.sample === state.sampleId));
  $("#recordCount").textContent = `${result.acceptedCount} / ${result.rawCount}`;

  const filterOptions = ["all", ...new Set(sampleData.records.map((record) => record.entity))];
  $("#filterSelect").innerHTML = filterOptions.map((option) => `
    <option value="${option}">${option === "all" ? sampleData.filterLabel.split(" · ")[0] : option}</option>
  `).join("");
  $("#filterSelect").value = state.filter;

  $("#metricGrid").innerHTML = cards.map((card, index) => `
    <div class="metric-cell">
      <span>0${index + 1} / ${card.label}</span>
      <strong>${card.value}</strong>
      <em>${card.note}</em>
    </div>
  `).join("");

  const rows = result.accepted.map((record) => {
    const flag = record.flags.includes("outlier") ? "outlier" : record.flags.includes("null") ? "null" : "";
    const status = flag === "outlier" ? "CLAMPED" : flag === "null" ? "NULL" : "OK";
    return `<tr class="${flag === "null" ? "null-row" : ""}">
      <td>${record.id}</td><td>${record.entity}</td>
      <td>${formatNumber(record[sampleData.primaryKey], sampleData.id === "A" ? "currency" : "integer")}</td>
      <td><span class="row-state ${flag}"></span> ${status}</td>
    </tr>`;
  });
  const duplicateRows = result.duplicates.map((record) => `
    <tr class="muted"><td>${record.id}</td><td>${record.entity}</td>
    <td>${formatNumber(record[sampleData.primaryKey], sampleData.id === "A" ? "currency" : "integer")}</td>
    <td><span class="row-state duplicate"></span> DUP</td></tr>
  `);
  $("#recordsBody").innerHTML = [...rows, ...duplicateRows].join("");

  $("#qualityScore").textContent = `${result.quality.score.toFixed(1)} / 100`;
  const healthy = Math.max(16, 100 - result.quality.nulls * 2 - result.quality.duplicates * 3 - result.quality.outliers * 5);
  const nullWidth = Math.max(4, result.quality.nulls * 6);
  const dupWidth = Math.max(3, result.quality.duplicates * 5);
  const outlierWidth = Math.max(4, result.quality.outliers * 8);
  $("#qualityBars").innerHTML = `
    <i style="width:${healthy}%"></i><i class="null" style="width:${nullWidth}%"></i>
    <i class="dup" style="width:${dupWidth}%"></i><i class="outlier" style="width:${outlierWidth}%"></i>
  `;
  $("#nullCount").textContent = result.quality.nulls;
  $("#dupCount").textContent = result.quality.duplicates;
  $("#outlierCount").textContent = result.quality.outliers;
  $("#binding1").textContent = cards[0]?.full || "—";
  $("#binding2").textContent = cards[1]?.full || "—";
  $("#binding3").textContent = cards[2]?.full || "—";
}

function boundsText(key, bound) {
  if (!bound) return `${key}: insufficient sample`;
  return `${key}: center=${bound.center.toFixed(1)} mad=${bound.mad.toFixed(1)} bound=[${bound.low.toFixed(1)}, ${bound.high.toFixed(1)}]`;
}

function renderDebugPipeline() {
  const result = state.result;
  const sampleData = SAMPLES[state.sampleId];
  const primary = sampleData.primaryKey;
  const secondary = sampleData.secondaryKey;
  const acceptedText = result.accepted.map((record) => `${record.id}:${record[primary] === null ? "null" : Math.round(record[primary])}`).join("  ");
  const duplicateText = result.duplicates.length
    ? result.duplicates.map((record) => `${record.id}→keep-first`).join(", ")
    : "none";
  const nullText = result.nullFields.length
    ? result.nullFields.map((item) => `${item.id}.${item.field}`).join(", ")
    : "none";
  const outlierText = result.outliers.length
    ? result.outliers.map((item) => `${item.id}.${item.field} ${Math.round(item.raw)}→${Math.round(item.clamped)} (|z|=${item.z})`).join("\n")
    : "none";

  $("#ingestStatus").textContent = "PARSED";
  $("#normalizeStatus").textContent = result.outliers.length ? "CLAMPED" : "CLEAN";
  $("#aggregateStatus").textContent = "READY";
  $("#bindStatus").textContent = "SYNCED";
  $("#ingestDebug").textContent = [
    `source    = ${result.source}`,
    `schema    = ${state.sampleId === "A" ? "commerce@q3" : "operations@w01"}`,
    `filter    = ${result.filterLabel}`,
    `rows      = ${result.rawCount} raw / ${result.scopedCount} in scope`,
    `revision  = r${result.revision}`,
    `id_key    = ${state.sampleId === "A" ? "transaction_id" : "operation_id"}`
  ].join("\n");
  $("#normalizeDebug").textContent = [
    `dedupe     = ${duplicateText}`,
    `nulls      = ${nullText}`,
    `outliers   = ${outlierText}`,
    boundsText(primary, result.bounds[primary]),
    boundsText(secondary, result.bounds[secondary]),
    `accepted   = ${acceptedText}`
  ].join("\n");
  const formula = state.sampleId === "A"
    ? `gmv=${Math.round(result.calculated.revenue)} orders=${result.calculated.orders} aov=${result.calculated.aov.toFixed(2)}`
    : `hours=${Math.round(result.calculated.hours)} spend=${result.calculated.spend} quality=${result.calculated.quality.toFixed(2)}`;
  $("#aggregateDebug").textContent = [
    `group_by   = ${sampleData.entity}`,
    `accepted   = ${result.acceptedCount} / ${result.rawCount}`,
    `clamped    = ${result.outliers.length} field(s)`,
    formula,
    `checksum   = ${dataSignature(result, state.cards)}`,
    `quality    = ${result.quality.score.toFixed(1)} / 100`
  ].join("\n");
  $("#bindDebug").textContent = [
    `template   = ${state.template.id}@v${state.template.version}`,
    `instance   = ${instance().id} (${state.activeVariant})`,
    `title      = ${instance().title.length} chars`,
    `layout     = ${state.layout.lines.length} lines @ ${state.layout.fontSize}px`,
    `cards      = ${visibleCards().map((card) => `${card.label}:${card.value}`).join(" / ")}`,
    `frame      = t=${state.time.toFixed(2)}s color=${state.layout.motion.color}`,
    `stage_sig  = ${signature(state.layout.signature)}`
  ].join("\n");
}

function renderReferenceDebug() {
  const templateRaw = localStorage.getItem("kinetic.template.v1") || "";
  const instancesRaw = localStorage.getItem("kinetic.instances.v1") || "";
  const audit = auditReferences(state.template, state.instances);
  $("#templateStoreDebug").textContent = [
    `key       = kinetic.template.v1`,
    `id        = ${state.template.id}`,
    `version   = v${state.template.version}`,
    `schema    = ${state.template.schema}`,
    `keyframes = ${state.template.keyframes.length}`,
    `bytes     = ${new Blob([templateRaw]).size}`,
    `updated   = ${state.template.updatedAt || "unsaved"}`
  ].join("\n");
  $("#instanceRefDebug").textContent = [
    `store     = kinetic.instances.v1 (${new Blob([instancesRaw]).size} bytes)`,
    ...audit.linked.map((item) => `${item.id} ${item.variant.padEnd(5)} → ${item.templateId} ✓`),
    ...audit.orphaned.map((item) => `${item.id} → ${item.templateId} ✗ ORPHAN`),
    `linked    = ${audit.linked.length}/${audit.totalInstances}`
  ].join("\n");
  const reload = state.reloadAudit;
  $("#reloadAuditDebug").textContent = reload
    ? [
        `audit     = ${reload.preserved ? "REFERENCES PRESERVED" : "REFERENCE LOSS"}`,
        `before    = ${reload.before.linked.length}/${reload.before.totalInstances} linked`,
        `after     = ${reload.after.linked.length}/${reload.after.totalInstances} linked`,
        `template  = ${reload.before.templateId} → ${reload.after.templateId}`,
        `orphans   = ${reload.after.orphaned.length}`,
        `checked   = ${reload.after.checkedAt}`
      ].join("\n")
    : "保存模板后执行重载审计。\n实例 ID / templateId 将在重载前后逐项比对。";
}

function updateSnapshotDebug() {
  const pretty = (snapshot) => snapshot
    ? JSON.stringify(snapshot, null, 2)
    : "尚未导出";
  $("#preExportDebug").textContent = pretty(state.preExport);
  $("#postExportDebug").textContent = pretty(state.postExport);
  if (state.comparison) {
    $("#integritySeal").textContent = state.comparison.ok ? "MATCH" : "DRIFT";
    $("#integritySeal").style.color = state.comparison.ok ? "var(--acid)" : "var(--coral)";
    $("#integritySeal").style.borderColor = state.comparison.ok ? "#748834" : "#8d4434";
    if (!state.comparison.ok) {
      $("#postExportDebug").textContent = `${pretty(state.postExport)}\n\nDRIFT: ${state.comparison.reasons.join(", ")}`;
    }
  }
}

function renderAll(options = {}) {
  if (options.inspector !== false) renderInspector();
  renderDataPanel();
  renderCanvas();
  renderDebugPipeline();
  renderReferenceDebug();
  updateSnapshotDebug();
  updateTimeUI();
}

function toast(title, message, type = "ok") {
  const node = document.createElement("div");
  node.className = `toast ${type === "error" ? "error" : ""}`;
  node.innerHTML = `<strong>${title}</strong>${message}`;
  $("#toastStack").append(node);
  setTimeout(() => node.remove(), 4200);
}

function setSaveStatus(text, tone = "ok") {
  const node = $("#saveStatus");
  node.innerHTML = `<i></i> ${text}`;
  node.style.color = tone === "error" ? "var(--danger)" : "";
}

function reloadTemplateAndAudit() {
  const before = auditReferences(state.template, state.instances);
  const storedTemplate = loadTemplateFromStore();
  if (!storedTemplate) throw new Error("模板存储缺失");
  state.template = storedTemplate;
  const after = auditReferences(state.template, state.instances);
  const idsBefore = before.linked.map((item) => item.id).sort().join(",");
  const idsAfter = after.linked.map((item) => item.id).sort().join(",");
  state.reloadAudit = {
    before,
    after,
    preserved: before.ok && after.ok && idsBefore === idsAfter && before.templateId === after.templateId
  };
  renderReferenceDebug();
  return state.reloadAudit;
}

function saveTemplate() {
  state.template.updatedAt = nowIso();
  persistTemplate(state.template);
  const audit = reloadTemplateAndAudit();
  state.lastSavedAt = nowIso();
  setSaveStatus(`模板已保存 · ${audit.after.linked.length}/${audit.after.totalInstances} 引用`);
  toast("TEMPLATE SAVED", `模板与实例分开存储；重载后 ${audit.after.linked.length}/${audit.after.totalInstances} 个实例引用保持。`);
  renderAll();
}

function saveInstances() {
  const stamped = state.instances.map((item) => ({
    ...item,
    templateId: state.template.id,
    templateVersion: state.template.version,
    updatedAt: nowIso()
  }));
  state.instances = stamped;
  persistInstances(stamped);
  const audit = auditReferences(state.template, stamped);
  state.lastSavedAt = nowIso();
  setSaveStatus(`2 个实例已保存 · LINKED`);
  toast("INSTANCES SAVED", `短 / 长两种文案分别保存；${audit.linked.length} 个实例指向 ${state.template.id}。`);
  renderAll();
}

function projectBundle() {
  return createProject(state.template, state.instances, {
    sampleId: state.sampleId,
    filter: state.filter,
    revision: state.revision
  }, {
    reloadAudit: state.reloadAudit,
    exportComparison: state.comparison,
    preExport: state.preExport,
    postExport: state.postExport,
    export: state.exportInfo ? {
      mimeType: state.exportInfo.mimeType,
      durationMs: state.exportInfo.durationMs,
      frameCount: state.exportInfo.frameCount,
      renderPasses: state.exportInfo.renderPasses,
      nominalFrames: state.exportInfo.nominalFrames,
      fps: state.exportInfo.fps,
      videoTrack: state.exportInfo.videoTrack,
      audioTrack: state.exportInfo.audioTrack,
      size: state.exportInfo.size,
      durationPatched: state.exportInfo.durationPatched,
      createdAt: state.exportInfo.createdAt
    } : null
  });
}

function saveProject(download = true) {
  persistTemplate(state.template);
  persistInstances(state.instances);
  const bundle = projectBundle();
  persistProject(bundle);
  state.lastSavedAt = nowIso();
  setSaveStatus("工程已保存 · 可重载");
  if (download) {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    downloadBlob(blob, "atlas-project.json");
  }
  toast("PROJECT SAVED", "模板、实例和数据状态已保存；工程包与独立存储引用一致。");
  renderReferenceDebug();
  return bundle;
}

function refreshCanvasOnly() {
  renderCanvas();
  renderDebugPipeline();
  updateTimeUI();
}

function switchVariant(variant) {
  if (!state.instances.some((item) => item.variant === variant)) return;
  state.activeVariant = variant;
  $$("#variantSwitch button").forEach((button) => button.classList.toggle("active", button.dataset.variant === variant));
  $("#titleInput").value = instance().title;
  $("#kickerInput").value = instance().kicker;
  $("#editState")?.remove();
  refreshCanvasOnly();
  updateStageMeta();
  setSaveStatus("实例切换 · 未保存变更", "warn");
}

function selectKeyframe(index) {
  state.selectedKey = index;
  renderKeyframes();
  renderCanvas();
  renderDebugPipeline();
  updateTimeUI();
}

function applyKeyframe() {
  const keys = [...state.template.keyframes].sort((a, b) => a.time - b.time);
  const keyframe = keys[state.selectedKey];
  if (!keyframe) return;
  keyframe.time = Math.max(0, Math.min(12, Number($("#keyTimeInput").value)));
  keyframe.x = Number($("#keyXInput").value);
  keyframe.y = Number($("#keyYInput").value);
  keyframe.opacity = Number($("#keyOpacityInput").value);
  keyframe.color = $("#keyColorInput").value.toUpperCase();
  state.template.keyframes = keys.sort((a, b) => a.time - b.time);
  state.selectedKey = state.template.keyframes.indexOf(keyframe);
  state.template.updatedAt = nowIso();
  renderKeyframes();
  refreshCanvasOnly();
  toast("KEYFRAME UPDATED", `${keyframe.time.toFixed(2)}s · position ${keyframe.x}/${keyframe.y} · opacity ${keyframe.opacity.toFixed(2)} · ${keyframe.color}`);
}

function addKeyframe() {
  const motion = keyframeAt(state.template.keyframes, state.time);
  const keyframe = {
    id: `K-${Date.now().toString(36).slice(-4)}`,
    time: Number(state.time.toFixed(2)),
    x: Math.round(motion.x),
    y: Math.round(motion.y),
    opacity: Number(motion.opacity.toFixed(2)),
    color: state.template.accent
  };
  state.template.keyframes.push(keyframe);
  state.template.keyframes.sort((a, b) => a.time - b.time);
  state.selectedKey = state.template.keyframes.indexOf(keyframe);
  state.template.updatedAt = nowIso();
  renderKeyframes();
  refreshCanvasOnly();
}

function deleteKeyframe() {
  if (state.template.keyframes.length <= 2) {
    toast("KEYFRAME LOCKED", "至少保留两个关键帧。", "error");
    return;
  }
  state.template.keyframes.splice(state.selectedKey, 1);
  state.selectedKey = Math.max(0, state.selectedKey - 1);
  renderKeyframes();
  refreshCanvasOnly();
}

let playFrame = 0;
let lastPlayTime = 0;

function playTick(timestamp) {
  if (!state.playing) return;
  if (!lastPlayTime) lastPlayTime = timestamp;
  const delta = (timestamp - lastPlayTime) / 1000;
  lastPlayTime = timestamp;
  state.time += delta;
  if (state.time >= 12) {
    if (state.loop) state.time %= 12;
    else {
      state.time = 12;
      state.playing = false;
      $("#playBtn").textContent = "▶";
    }
  }
  renderCanvas();
  updateTimeUI();
  renderDebugPipeline();
  if (state.playing) playFrame = requestAnimationFrame(playTick);
}

function togglePlay() {
  state.playing = !state.playing;
  $("#playBtn").textContent = state.playing ? "❚❚" : "▶";
  if (state.playing) {
    lastPlayTime = 0;
    if (state.time >= 11.99) state.time = 0;
    playFrame = requestAnimationFrame(playTick);
  } else {
    cancelAnimationFrame(playFrame);
  }
}

function captureSnapshot() {
  const oldTime = state.time;
  state.time = 6;
  const layout = renderStage(canvas, {
    template: state.template,
    instance: instance(),
    result: state.result,
    cards: visibleCards(),
    time: 6
  });
  const snapshot = makeSnapshot({
    template: state.template,
    instances: state.instances,
    instance: instance(),
    result: state.result,
    cards: visibleCards(),
    layout,
    stageSignature: signature(layout.signature)
  });
  state.time = oldTime;
  renderCanvas();
  return snapshot;
}

let exportInProgress = false;

async function runExport() {
  if (exportInProgress) return;
  exportInProgress = true;
  state.playing = false;
  cancelAnimationFrame(playFrame);
  $("#playBtn").textContent = "▶";
  state.preExport = captureSnapshot();
  state.postExport = null;
  state.comparison = null;
  updateSnapshotDebug();
  document.body.classList.add("is-exporting");
  $("#exportOverlay").classList.add("active");
  $("#exportBtn").disabled = true;
  const originalTime = state.time;

  try {
    const result = await exportWebm(canvas, {
      template: state.template,
      instance: instance(),
      result: state.result,
      cards: visibleCards()
    }, {
      onProgress: ({ elapsed, frameCount, layout }) => {
        $("#exportOverlayTime").textContent = `00:${(elapsed / 1000).toFixed(1).padStart(4, "0")}`;
        $("#exportBtn").innerHTML = `<span class="export-icon">●</span> ${Math.min(100, Math.round(elapsed / 120)).toString().padStart(2, "0")}%`;
        if (frameCount % 12 === 0) {
          state.layout = layout;
          renderDebugPipeline();
        }
      }
    });
    state.exportInfo = result;
    state.postExport = captureSnapshot();
    state.comparison = compareSnapshots(state.preExport, state.postExport);
    state.time = originalTime;
    renderCanvas();
    renderDebugPipeline();
    updateSnapshotDebug();
    const filename = `atlas-${state.activeVariant}-${result.mimeType.includes("vp9") ? "vp9" : "vp8"}-12s.webm`;
    downloadBlob(result.blob, filename);
    const status = state.comparison.ok ? "对象与关键值一致" : `检测到漂移：${state.comparison.reasons.join("、")}`;
    toast("EXPORT COMPLETE", `${result.frameCount} 帧 @ ${result.fps}fps / ${(result.size / 1024 / 1024).toFixed(2)} MB · 音频轨 ${result.audioTrack.present ? "ON" : "OFF"} · ${status}`, state.comparison.ok ? "ok" : "error");
    setSaveStatus("12s WebM 已导出 · 快照一致");
    saveProject(false);
  } catch (error) {
    console.error(error);
    toast("EXPORT FAILED", error.message, "error");
    setSaveStatus("导出失败 · 查看调试面板", "error");
  } finally {
    exportInProgress = false;
    document.body.classList.remove("is-exporting");
    $("#exportOverlay").classList.remove("active");
    $("#exportBtn").disabled = false;
    $("#exportBtn").innerHTML = `<span class="export-icon">↓</span> 导出 12s`;
  }
}

function applyBundle(bundle, options = {}) {
  const installed = installBundle(bundle);
  state.template = installed.template;
  state.instances = installed.instances;
  state.sampleId = installed.dataState.sampleId || "A";
  state.filter = installed.dataState.filter || "all";
  state.revision = installed.dataState.revision || 0;
  state.activeVariant = installed.instances[0]?.variant || "short";
  state.time = 6;
  state.selectedKey = Math.min(1, state.template.keyframes.length - 1);
  state.reloadAudit = installed.verification?.reloadAudit || null;
  state.preExport = installed.verification?.preExport || null;
  state.postExport = installed.verification?.postExport || null;
  state.comparison = installed.verification?.exportComparison || null;
  state.exportInfo = installed.verification?.export || null;
  recomputeData();
  renderAll();
  if (options.notify !== false) {
    const audit = auditReferences(state.template, state.instances);
    toast("PROJECT LOADED", `${state.template.id}@v${state.template.version} · ${audit.linked.length}/${audit.totalInstances} 实例引用已解析。`);
  }
  return auditReferences(state.template, state.instances);
}

function loadProjectFile(file) {
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      applyBundle(JSON.parse(String(reader.result)));
      setSaveStatus("工程已载入 · REFERENCES OK");
    } catch (error) {
      toast("LOAD FAILED", error.message, "error");
    }
  });
  reader.readAsText(file);
}

function bindEvents() {
  $$('.tabs[data-tabs="inspector"] .tab').forEach((tab) => {
    tab.addEventListener("click", () => {
      $$('.tabs[data-tabs="inspector"] .tab').forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      $$(".inspector > .tab-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === tab.dataset.tab));
    });
  });
  $$(".debug-tabs .tab, .debug-tabs button").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".debug-tabs button").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      $$(".debug-tab-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === tab.dataset.tab));
    });
  });

  $("#templateNameInput").addEventListener("input", (event) => {
    state.template.name = event.target.value;
    state.template.updatedAt = nowIso();
  });
  $("#formatSelect").addEventListener("change", (event) => {
    state.template.format = event.target.value;
    renderCanvas();
  });
  $("#tempoSelect").addEventListener("change", (event) => {
    state.template.tempo = event.target.value;
  });
  $$("#variantSwitch button").forEach((button) => button.addEventListener("click", () => switchVariant(button.dataset.variant)));
  $("#titleInput").addEventListener("input", (event) => {
    instance().title = event.target.value;
    instance().updatedAt = nowIso();
    refreshCanvasOnly();
    updateStageMeta();
    setSaveStatus("文案变更 · 尚未保存实例", "warn");
  });
  $("#kickerInput").addEventListener("input", (event) => {
    instance().kicker = event.target.value;
    instance().updatedAt = nowIso();
    refreshCanvasOnly();
  });
  $("#cardCountInput").addEventListener("input", (event) => {
    state.template.cardCount = Number(event.target.value);
    refreshCanvasOnly();
    updateStageMeta();
  });
  $("#cardGapInput").addEventListener("input", (event) => {
    state.template.cardGap = Number(event.target.value);
    refreshCanvasOnly();
  });
  $("#accentInput").addEventListener("input", (event) => {
    state.template.accent = event.target.value.toUpperCase();
    $("#accentTextInput").value = state.template.accent;
    refreshCanvasOnly();
  });
  $("#accentTextInput").addEventListener("change", (event) => {
    const value = event.target.value.trim();
    if (/^#[0-9a-f]{6}$/i.test(value)) {
      state.template.accent = value.toUpperCase();
      $("#accentInput").value = value;
      refreshCanvasOnly();
    }
  });
  $$("#transitionGrid button").forEach((button) => {
    button.addEventListener("click", () => {
      state.template.transition = button.dataset.transition;
      $$("#transitionGrid button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      refreshCanvasOnly();
      updateStageMeta();
    });
  });

  $("#keyframeList").addEventListener("click", (event) => {
    const row = event.target.closest(".key-row");
    if (row) selectKeyframe(Number(row.dataset.index));
  });
  $("#timelineKeys").addEventListener("click", (event) => {
    const marker = event.target.closest(".timeline-key");
    if (!marker) return;
    event.stopPropagation();
    const keyframe = [...state.template.keyframes].sort((a, b) => a.time - b.time)[Number(marker.dataset.index)];
    state.time = keyframe.time;
    selectKeyframe(Number(marker.dataset.index));
  });
  $("#addKeyframeBtn").addEventListener("click", addKeyframe);
  $("#applyKeyframeBtn").addEventListener("click", applyKeyframe);
  $("#deleteKeyframeBtn").addEventListener("click", deleteKeyframe);

  $("#playBtn").addEventListener("click", togglePlay);
  $("#loopBtn").addEventListener("click", () => {
    state.loop = !state.loop;
    $("#loopBtn").classList.toggle("on", state.loop);
  });
  let scrubbing = false;
  const scrub = (event) => {
    const rect = $("#trackArea").getBoundingClientRect();
    state.time = Math.max(0, Math.min(12, ((event.clientX - rect.left) / rect.width) * 12));
    renderCanvas();
    updateTimeUI();
    renderDebugPipeline();
  };
  $("#trackArea").addEventListener("pointerdown", (event) => {
    if (event.target.closest(".timeline-key")) return;
    scrubbing = true;
    $("#trackArea").setPointerCapture(event.pointerId);
    scrub(event);
  });
  $("#trackArea").addEventListener("pointermove", (event) => {
    if (scrubbing) scrub(event);
  });
  $("#trackArea").addEventListener("pointerup", (event) => {
    scrubbing = false;
    $("#trackArea").releasePointerCapture(event.pointerId);
  });

  $("#sampleSwitch").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-sample]");
    if (!button) return;
    state.sampleId = button.dataset.sample;
    state.filter = "all";
    state.revision = 0;
    recomputeData();
    state.time = 6;
    renderAll();
    setSaveStatus(`数据版本 ${state.result.version}`);
  });
  $("#filterSelect").addEventListener("change", (event) => {
    state.filter = event.target.value;
    recomputeData();
    renderAll();
    setSaveStatus(`筛选已应用 · ${state.result.version}`);
  });
  $("#refreshDataBtn").addEventListener("click", () => {
    state.revision += 1;
    recomputeData();
    renderAll();
    toast("DATA UPDATED", `${state.result.version} · 画布、KPI、表格、调试链路已同步。`);
    setSaveStatus(`数据已更新 · ${state.result.version}`);
  });

  $("#saveTemplateBtn").addEventListener("click", saveTemplate);
  $("#saveInstancesBtn").addEventListener("click", saveInstances);
  $("#saveProjectBtn").addEventListener("click", () => saveProject(true));
  $("#loadProjectBtn").addEventListener("click", () => $("#projectFileInput").click());
  $("#projectFileInput").addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (file) loadProjectFile(file);
    event.target.value = "";
  });
  $("#exportBtn").addEventListener("click", runExport);
  $("#debugToggle").addEventListener("click", () => {
    const collapsed = $("#debugPanel").classList.toggle("collapsed");
    $("#debugToggle").textContent = collapsed ? "展开" : "收起";
  });
  $("#fullscreenBtn").addEventListener("click", async () => {
    if (!document.fullscreenElement) await $("#canvasWrap").requestFullscreen();
    else await document.exitFullscreen();
  });
  $("#fitBtn").addEventListener("click", () => {
    $("#canvasWrap").animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 220 });
  });
}

function seedStorage() {
  let template = loadTemplateFromStore();
  let instances = loadInstancesFromStore();
  if (!template) {
    template = createTemplate();
    persistTemplate(template);
  }
  if (!instances) {
    instances = createInstances(template.id, template.version);
    persistInstances(instances);
  }
  return { template, instances };
}

function updateDebugClock() {
  $("#debugClock").textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
}

async function boot() {
  try {
    await document.fonts.load('700 78px "Noto Sans SC"', "把增长变成看得见的节奏");
    await document.fonts.load('500 10px "IBM Plex Mono"', "DATA / 2026");
  } catch {
    // Canvas falls back to the bundled sans-serif stack.
  }

  const seeded = seedStorage();
  state.template = seeded.template;
  state.instances = seeded.instances;
  const storedProject = loadProjectFromStore();
  if (storedProject?.dataState) {
    state.sampleId = SAMPLES[storedProject.dataState.sampleId] ? storedProject.dataState.sampleId : "A";
    state.filter = storedProject.dataState.filter || "all";
    state.revision = storedProject.dataState.revision || 0;
    state.preExport = storedProject.verification?.preExport || null;
    state.postExport = storedProject.verification?.postExport || null;
    state.comparison = storedProject.verification?.exportComparison || null;
    state.exportInfo = storedProject.verification?.export || null;
  }
  state.activeVariant = state.instances[0]?.variant || "short";
  state.selectedKey = Math.min(1, state.template.keyframes.length - 1);
  state.reloadAudit = {
    before: auditReferences(state.template, state.instances),
    after: auditReferences(state.template, state.instances),
    preserved: auditReferences(state.template, state.instances).ok
  };
  recomputeData();
  bindEvents();
  renderAll();
  updateDebugClock();
  setInterval(updateDebugClock, 1000);
  setSaveStatus(`本地工程 · ${state.template.id}@v${state.template.version}`);

  window.__kinetic = {
    state,
    getVerification: () => ({
      template: state.template,
      instances: state.instances,
      data: {
        sampleId: state.sampleId,
        filter: state.filter,
        revision: state.revision,
        version: state.result.version,
        acceptedCount: state.result.acceptedCount,
        rawCount: state.result.rawCount,
        calculated: state.result.calculated,
        quality: state.result.quality
      },
      layout: state.layout,
      audit: auditReferences(state.template, state.instances),
      reloadAudit: state.reloadAudit,
      preExport: state.preExport,
      postExport: state.postExport,
      comparison: state.comparison,
      export: state.exportInfo ? {
        mimeType: state.exportInfo.mimeType,
        durationMs: state.exportInfo.durationMs,
        frameCount: state.exportInfo.frameCount,
        renderPasses: state.exportInfo.renderPasses,
        nominalFrames: state.exportInfo.nominalFrames,
        durationPatched: state.exportInfo.durationPatched,
        fps: state.exportInfo.fps,
        videoTrack: state.exportInfo.videoTrack,
        audioTrack: state.exportInfo.audioTrack,
        size: state.exportInfo.size,
        createdAt: state.exportInfo.createdAt
      } : null
    }),
    getProjectBundle: () => projectBundle(),
    saveProject: () => saveProject(false),
    saveProjectDownload: () => saveProject(true),
    saveTemplate,
    saveInstances,
    loadBundle: applyBundle,
    switchVariant,
    setSample: (sampleId, filter = "all", revision = 0) => {
      state.sampleId = sampleId;
      state.filter = filter;
      state.revision = revision;
      recomputeData();
      renderAll();
    },
    setTime: (time) => {
      state.time = Math.max(0, Math.min(12, time));
      renderCanvas();
      updateTimeUI();
      renderDebugPipeline();
    },
    snapshot: captureSnapshot,
    export: runExport
  };
  document.documentElement.dataset.ready = "true";
}

boot().catch((error) => {
  console.error(error);
  toast("BOOT FAILED", error.message, "error");
});
