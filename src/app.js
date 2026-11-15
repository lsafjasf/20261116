import { DEFAULT_CONFIG, DEFAULT_VIEW, clamp, clone, formatBytes, formatHash, hashString } from "./config.js";
import { createCanvas, layoutFor, renderAtlas, renderSlots } from "./atlas.js";
import { analyzeCanvas, compareCanvases } from "./measure.js";
import { entrySignature, generateEntries } from "./shapes.js";
import {
  buildIndex,
  canvasBlob,
  configFromIndex,
  createBundle,
  decodeAtlasBlob,
  downloadBlob,
  restoreEntries,
  validateReloadedAtlas,
} from "./serialize.js";
import { runScenario } from "./scenarios.js";

const byId = (id) => document.getElementById(id);
const els = {
  atlasCanvas: byId("atlasCanvas"),
  overlayCanvas: byId("overlayCanvas"),
  atlasStage: byId("atlasStage"),
  magnifierCanvas: byId("magnifierCanvas"),
  atlasWidth: byId("atlasWidth"),
  atlasHeight: byId("atlasHeight"),
  cellSize: byId("cellSize"),
  paddingRange: byId("paddingRange"),
  paddingOutput: byId("paddingOutput"),
  applyLayoutButton: byId("applyLayoutButton"),
  generateButton: byId("generateButton"),
  importButton: byId("importButton"),
  shapeFileInput: byId("shapeFileInput"),
  restoreButton: byId("restoreButton"),
  exportReloadButton: byId("exportReloadButton"),
  reloadCheckButton: byId("reloadCheckButton"),
  runScenariosButton: byId("runScenariosButton"),
  samplerSelect: byId("samplerSelect"),
  zoomSelect: byId("zoomSelect"),
  gridToggle: byId("gridToggle"),
  slotSelect: byId("slotSelect"),
  scaleRange: byId("scaleRange"),
  rotationRange: byId("rotationRange"),
  blurRange: byId("blurRange"),
  offsetRange: byId("offsetRange"),
  scaleOutput: byId("scaleOutput"),
  rotationOutput: byId("rotationOutput"),
  nudgeLeft: byId("nudgeLeft"),
  nudgeRight: byId("nudgeRight"),
  randomizeButton: byId("randomizeButton"),
  bundleIndexFile: byId("bundleIndexFile"),
  bundleAtlasFile: byId("bundleAtlasFile"),
};

const state = {
  config: { ...DEFAULT_CONFIG },
  view: { ...DEFAULT_VIEW },
  scene: generateEntries(14, 20261116),
  selectedId: null,
  measurements: null,
  lastUpdate: {
    mode: "FULL",
    dirtyTiles: 14,
    dirtyPixels: DEFAULT_CONFIG.width * DEFAULT_CONFIG.height,
    elapsedMs: 0,
    text: "初始图集已光栅化。",
  },
  textureRebuilds: 0,
  sceneRebuilds: 0,
  operations: 0,
  generateSeed: 7,
  corner: "tl",
  magnifierSource: "live",
  reloaded: null,
  scenarios: {},
  liveCheck: null,
  checkTimer: 0,
  baseline: null,
  drag: null,
  pointer: { slot: null },
};

state.selectedId = state.scene[0]?.id || null;

function selectedEntry() {
  return state.scene.find((entry) => entry.id === state.selectedId) || null;
}

function sceneSignature() {
  return hashString([...state.scene].sort((a, b) => a.slot - b.slot).map(entrySignature).join(";"));
}

function setAtlasSize() {
  for (const canvas of [els.atlasCanvas, els.overlayCanvas]) {
    canvas.width = state.config.width;
    canvas.height = state.config.height;
  }
  const atlasContext = els.atlasCanvas.getContext("2d", { willReadFrequently: true });
  atlasContext.imageSmoothingEnabled = false;
  els.overlayCanvas.getContext("2d").imageSmoothingEnabled = false;
}

function ensureValidSlots() {
  const layout = layoutFor(state.config);
  if (layout.capacity < state.scene.length) {
    throw new Error(`容量不足：${state.scene.length} 个对象，仅 ${layout.capacity} 个槽位`);
  }
  const occupied = new Set();
  const invalid = [];
  for (const entry of state.scene) {
    if (entry.slot >= layout.capacity || occupied.has(entry.slot)) invalid.push(entry);
    else occupied.add(entry.slot);
  }
  const free = [];
  for (let index = 0; index < layout.capacity; index += 1) {
    if (!occupied.has(index)) free.push(index);
  }
  for (const entry of invalid) entry.slot = free.shift();
}

function renderFull(mode = "FULL", text = "全量纹理已重建。") {
  if (mode !== "RELOAD") invalidateReload();
  state.magnifierSource = "live";
  const started = performance.now();
  setAtlasSize();
  ensureValidSlots();
  const context = els.atlasCanvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, state.config.width, state.config.height);
  renderSlots(els.atlasCanvas, state.scene, state.config, state.scene.map((entry) => entry.slot));
  const elapsedMs = performance.now() - started;
  state.textureRebuilds += 1;
  state.operations += 1;
  state.lastUpdate = {
    mode,
    dirtyTiles: state.scene.length,
    dirtyPixels: state.config.width * state.config.height,
    elapsedMs,
    text,
  };
  state.measurements = analyzeCanvas(els.atlasCanvas, state.scene, state.config);
  refreshUI();
  scheduleLiveCheck();
}

function renderIncremental(slots, text = "仅重绘受影响槽位。") {
  invalidateReload();
  state.magnifierSource = "live";
  const started = performance.now();
  const uniqueSlots = renderSlots(els.atlasCanvas, state.scene, state.config, slots);
  const elapsedMs = performance.now() - started;
  state.operations += 1;
  state.lastUpdate = {
    mode: "INCREMENTAL",
    dirtyTiles: uniqueSlots.length,
    dirtyPixels: uniqueSlots.length * state.config.cell * state.config.cell,
    elapsedMs,
    text,
  };
  state.measurements = analyzeCanvas(els.atlasCanvas, state.scene, state.config);
  refreshUI();
  scheduleLiveCheck();
  return uniqueSlots;
}

function scheduleLiveCheck() {
  clearTimeout(state.checkTimer);
  state.checkTimer = setTimeout(() => {
    const full = renderAtlas(state.scene, state.config);
    const comparison = compareCanvases(els.atlasCanvas, full);
    state.liveCheck = {
      equal: comparison.equal,
      liveHash: comparison.hashA,
      fullHash: comparison.hashB,
      diffPixels: comparison.diffPixels,
      objectCount: state.scene.length,
    };
    refreshConsistency();
  }, 80);
}

function refreshUI() {
  updateMetricsUI();
  updateSelectedPanel();
  updatePreset();
  updateAlgorithmSummary();
  drawOverlay();
  renderMagnifier();
  refreshConsistency();
}

function updateMetricsUI() {
  const metrics = state.measurements;
  if (!metrics) return;
  const percent = (value) => `${(value * 100).toFixed(2)}%`;
  byId("atlasDimension").textContent = `${state.config.width} × ${state.config.height}`;
  byId("gridChip").textContent = `${metrics.capacity ? layoutFor(state.config).cols : 0} × ${metrics.capacity ? layoutFor(state.config).rows : 0} GRID`;
  byId("fillRatio").textContent = percent(metrics.fillRatio);
  byId("fillPixels").textContent = `${metrics.fillPixels.toLocaleString()} texels`;
  byId("slotRatio").textContent = `${metrics.occupiedSlots} / ${metrics.capacity}`;
  byId("slotPercent").textContent = percent(metrics.slotRatio);
  byId("guardViolations").textContent = String(metrics.guardViolations);
  byId("metricObjects").textContent = String(state.scene.length);
  byId("sceneHash").textContent = `scene ${formatHash(sceneSignature())}`;
  byId("atlasHash").textContent = formatHash(metrics.hash);
  byId("metricPadding").textContent = `${state.config.padding} px`;
  byId("metricCapacity").textContent = String(metrics.capacity);
  byId("metricBytes").textContent = formatBytes(metrics.atlasBytes);
  byId("sceneRebuilds").textContent = String(state.sceneRebuilds);
  byId("objectCount").textContent = String(state.scene.length);
  byId("occupiedSlots").textContent = String(metrics.occupiedSlots);
  byId("shapeKinds").textContent = String(new Set(state.scene.map((entry) => entry.kind)).size);

  const update = state.lastUpdate;
  byId("updateMode").textContent = update.mode;
  byId("dirtyTiles").textContent = String(update.dirtyTiles);
  byId("dirtyPixels").textContent = update.dirtyPixels.toLocaleString();
  byId("updateMs").textContent = `${update.elapsedMs.toFixed(1)} ms`;
  byId("updateText").textContent = update.text;
  byId("scopeFill").style.width = `${clamp((update.dirtyPixels / (state.config.width * state.config.height)) * 100, 0, 100)}%`;
  byId("dirtyChip").textContent = update.mode === "INCREMENTAL"
    ? `Δ ${update.dirtyTiles} SLOT${update.dirtyTiles === 1 ? "" : "S"}`
    : update.mode;
}

function updateSelectedPanel() {
  const entry = selectedEntry();
  const controls = [
    els.slotSelect,
    els.scaleRange,
    els.rotationRange,
    els.blurRange,
    els.offsetRange,
    byId("nudgeLeft"),
    byId("nudgeRight"),
    byId("randomizeButton"),
  ];
  for (const control of controls) control.disabled = !entry;
  if (!entry) {
    byId("selectedName").textContent = "—";
    byId("selectedKind").textContent = "—";
    byId("selectedMeta").textContent = "点击图集选择一个槽位";
    return;
  }
  const slot = layoutFor(state.config).slots[entry.slot];
  byId("selectedName").textContent = entry.name;
  byId("selectedKind").textContent = entry.kind;
  byId("selectedMeta").textContent = `槽位 ${entry.slot} · R${slot.row}/C${slot.col}`;
  byId("selectedSwatch").style.background = `hsl(${entry.hue} 86% 64%)`;
  byId("selectedSwatch").style.color = `hsl(${entry.hue} 86% 64%)`;
  els.slotSelect.value = String(entry.slot);
  els.scaleRange.value = entry.scale.toFixed(2);
  els.rotationRange.value = String(Math.round(entry.rotation));
  els.blurRange.value = String(Math.round(entry.shadowBlur));
  els.offsetRange.value = String(Math.round((entry.shadowDx + entry.shadowDy) / 2));
  byId("scaleOutput").textContent = `${entry.scale.toFixed(2)}×`;
  byId("rotationOutput").textContent = `${Math.round(entry.rotation)}°`;
}

function rebuildSlotSelect() {
  const layout = layoutFor(state.config);
  const entry = selectedEntry();
  const occupiedBy = new Map(state.scene.map((item) => [item.slot, item]));
  els.slotSelect.replaceChildren();
  for (const slot of layout.slots) {
    const option = document.createElement("option");
    option.value = String(slot.index);
    const occupant = occupiedBy.get(slot.index);
    option.textContent = `#${slot.index} · C${slot.col} R${slot.row}${occupant ? ` · ${occupant.name}` : " · 空"}`;
    els.slotSelect.append(option);
  }
  els.slotSelect.value = String(entry?.slot ?? 0);
}

function updatePreset() {
  const preset = {
    sampler: state.view.sampler,
    zoom: state.view.zoom,
    edgePadding: state.config.padding,
    guardPx: 1,
    checker: "#101d23",
    corner: state.corner,
    baselineScene: state.baseline?.scene.length ?? state.scene.length,
    scenarioGrid: "640×640 / cell 128",
  };
  byId("presetCode").textContent = JSON.stringify(preset, null, 2);
  byId("magnifierFilter").textContent = state.view.sampler.toUpperCase();
  els.atlasCanvas.style.imageRendering = state.view.sampler === "nearest" ? "pixelated" : "auto";
  els.magnifierCanvas.style.imageRendering = state.view.sampler === "nearest" ? "pixelated" : "auto";
}

function updateAlgorithmSummary() {
  const metrics = state.measurements;
  const layout = layoutFor(state.config);
  const lines = [
    `packer      fixed-grid ${layout.cols}x${layout.rows} @${state.config.cell}`,
    `isolation   content-clip + 1px guard`,
    `padding     ${state.config.padding}px / sample contentRect`,
    `sampler     ${state.view.sampler} / clamp-to-edge`,
    `objects     ${state.scene.length} live / ${metrics?.occupiedSlots ?? 0} slots`,
    `dirty       slot-union / last ${state.lastUpdate.dirtyTiles} tile(s)`,
    `texture     ${state.textureRebuilds} rebuild / scene ${state.sceneRebuilds}`,
    `live/full   ${state.liveCheck ? `${formatHash(state.liveCheck.liveHash)} ↔ ${formatHash(state.liveCheck.fullHash)}` : "checking…"}`,
    `isolate     ${metrics?.guardViolations ?? 0} guard violations`,
  ];
  byId("algorithmSummary").textContent = lines.join("\n");
}

function drawOverlay() {
  const context = els.overlayCanvas.getContext("2d");
  context.clearRect(0, 0, state.config.width, state.config.height);
  if (!state.view.showGrid) return;
  const layout = layoutFor(state.config);
  context.lineWidth = 1;
  context.font = "8px ui-monospace, monospace";
  context.textBaseline = "top";
  const selected = selectedEntry();

  for (const slot of layout.slots) {
    context.strokeStyle = "rgba(143, 200, 208, 0.12)";
    context.setLineDash([]);
    context.strokeRect(slot.x + 0.5, slot.y + 0.5, slot.w - 1, slot.h - 1);
    if (slot.index % layout.cols === 0 || slot.index < layout.cols) {
      context.fillStyle = "rgba(126, 165, 172, 0.35)";
      context.fillText(`${slot.col}/${slot.row}`, slot.x + 5, slot.y + 5);
    }
  }

  if (selected) {
    const slot = layout.slots[selected.slot];
    context.strokeStyle = "rgba(121, 242, 208, 0.92)";
    context.lineWidth = 2;
    context.setLineDash([]);
    context.strokeRect(slot.x + 2, slot.y + 2, slot.w - 4, slot.h - 4);
    context.strokeStyle = "rgba(255, 127, 159, 0.52)";
    context.lineWidth = 1;
    context.setLineDash([3, 3]);
    context.strokeRect(slot.x + 0.5, slot.y + 0.5, slot.w - 1, slot.h - 1);
    context.strokeStyle = "rgba(127, 231, 255, 0.55)";
    context.setLineDash([2, 4]);
    context.strokeRect(
      slot.contentRect.x + 0.5,
      slot.contentRect.y + 0.5,
      slot.contentRect.w - 1,
      slot.contentRect.h - 1,
    );
  }

  if (state.pointer.slot != null) {
    const slot = layout.slots[state.pointer.slot];
    context.strokeStyle = "rgba(255, 211, 111, 0.7)";
    context.lineWidth = 1;
    context.setLineDash([]);
    context.strokeRect(slot.x + 3.5, slot.y + 3.5, slot.w - 7, slot.h - 7);
  }
}

let checkerPattern = null;
function getCheckerPattern(context) {
  if (checkerPattern) return checkerPattern;
  const tile = createCanvas(24, 24);
  const tileContext = tile.getContext("2d");
  tileContext.fillStyle = "#0a171d";
  tileContext.fillRect(0, 0, 24, 24);
  tileContext.fillStyle = "#13262e";
  tileContext.fillRect(0, 0, 12, 12);
  tileContext.fillRect(12, 12, 12, 12);
  checkerPattern = context.createPattern(tile, "repeat");
  return checkerPattern;
}

function renderMagnifier() {
  const canvas = els.magnifierCanvas;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = getCheckerPattern(context);
  context.fillRect(0, 0, canvas.width, canvas.height);
  const entry = selectedEntry();
  if (!entry) {
    context.fillStyle = "rgba(205, 226, 226, 0.6)";
    context.font = "12px ui-monospace, monospace";
    context.fillText("SELECT A SLOT", 22, 32);
    return;
  }
  const source = state.magnifierSource === "reloaded" && state.reloaded
    ? state.reloaded.canvas
    : els.atlasCanvas;
  const slot = layoutFor(state.config).slots[entry.slot];
  const cropW = 78;
  const cropH = 45;
  const margin = 11;
  let x = slot.x - margin;
  let y = slot.y - margin;
  if (state.corner.includes("r")) x = slot.x + slot.w - cropW + margin;
  if (state.corner.includes("b")) y = slot.y + slot.h - cropH + margin;
  x = clamp(x, 0, Math.max(0, state.config.width - cropW));
  y = clamp(y, 0, Math.max(0, state.config.height - cropH));

  context.imageSmoothingEnabled = state.view.sampler !== "nearest";
  context.drawImage(source, x, y, cropW, cropH, 0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;

  const scaleX = canvas.width / cropW;
  const scaleY = canvas.height / cropH;
  const guide = (rect, color, dash) => {
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 1;
    context.setLineDash(dash);
    context.strokeRect(
      (rect.x - x) * scaleX + 0.5,
      (rect.y - y) * scaleY + 0.5,
      rect.w * scaleX - 1,
      rect.h * scaleY - 1,
    );
    context.restore();
  };

  guide({ x: slot.x, y: slot.y, w: slot.w, h: slot.h }, "rgba(121, 242, 208, 0.88)", []);
  guide(slot.contentRect, "rgba(127, 231, 255, 0.72)", [4, 4]);
  context.save();
  context.strokeStyle = "rgba(255, 127, 159, 0.68)";
  context.setLineDash([2, 5]);
  context.strokeRect(
    (slot.x - x) * scaleX + 1.5,
    (slot.y - y) * scaleY + 1.5,
    slot.w * scaleX - 3,
    slot.h * scaleY - 3,
  );
  context.restore();

  context.fillStyle = "rgba(5, 14, 18, 0.72)";
  context.fillRect(8, 8, 114, 18);
  context.fillStyle = "rgba(205, 233, 230, 0.82)";
  context.font = "9px ui-monospace, monospace";
  context.fillText(`${state.view.sampler.toUpperCase()} · SLOT ${entry.slot}`, 14, 21);
  context.fillStyle = "rgba(121, 242, 208, 0.8)";
  context.fillText(`${cropW}×${cropH}px → ${canvas.width}×${canvas.height}px`, 8, canvas.height - 10);

  byId("magnifierSlot").textContent = `#${entry.slot} · C${slot.col} R${slot.row}`;
  byId("magnifierGuard").textContent = String(state.measurements?.guardAlphaMax ?? 0);
  byId("magnifierRect").textContent = `${slot.contentRect.x},${slot.contentRect.y} ${slot.contentRect.w}×${slot.contentRect.h}`;
  byId("magnifierSource").textContent = state.magnifierSource === "reloaded" && state.reloaded
    ? "RELOADED PNG"
    : "LIVE ATLAS";
}

function refreshConsistency() {
  const card = byId("consistencyCard");
  card.classList.remove("ok", "bad");
  const scenarioValues = Object.values(state.scenarios);
  const scenarioPass = scenarioValues.length === 3 && scenarioValues.every((result) => result.status === "pass");
  const scenarioText = scenarioValues.length
    ? `三场景 ${scenarioValues.filter((result) => result.status === "pass").length}/3 符合预期。`
    : "三场景等待运行。";
  const reloadText = state.reloaded
    ? `回载 ${state.reloaded.validation.restoredCount}/${state.reloaded.validation.objectCount} 项。`
    : "回载检查未执行。";
  if (!state.liveCheck) {
    byId("consistencyTitle").textContent = "正在核对画面与数据";
    byId("consistencyText").textContent = `纹理 ${formatHash(state.measurements?.hash)}；${scenarioText}${reloadText}`;
    return;
  }
  if (state.liveCheck.equal) {
    card.classList.add("ok");
    byId("consistencyTitle").textContent = "最终画面与数据一致";
    byId("consistencyText").textContent =
      `实时纹理 ${formatHash(state.liveCheck.liveHash)} 与独立全量重算 ${formatHash(state.liveCheck.fullHash)} 相同；` +
      `${state.scene.length} 个对象与 ${state.measurements.occupiedSlots} 个索引槽位对应。${scenarioText}${reloadText}`;
  } else {
    card.classList.add("bad");
    byId("consistencyTitle").textContent = "画面与数据不一致";
    byId("consistencyText").textContent =
      `差异 ${state.liveCheck.diffPixels.toLocaleString()} px；实时 ${formatHash(state.liveCheck.liveHash)}，` +
      `全量 ${formatHash(state.liveCheck.fullHash)}。${scenarioText}${reloadText}`;
  }
}

function selectEntry(id) {
  if (!state.scene.some((entry) => entry.id === id)) return;
  state.selectedId = id;
  els.slotSelect.value = String(selectedEntry()?.slot ?? 0);
  refreshUI();
}

function moveSelectedToSlot(targetSlot) {
  const entry = selectedEntry();
  const layout = layoutFor(state.config);
  if (!entry || targetSlot === entry.slot || !layout.slots[targetSlot]) return;
  const oldSlot = entry.slot;
  const occupant = state.scene.find((item) => item.slot === targetSlot);
  entry.slot = targetSlot;
  if (occupant) occupant.slot = oldSlot;
  rebuildSlotSelect();
  renderIncremental(
    [oldSlot, targetSlot],
    occupant
      ? `交换槽位 #${oldSlot} ↔ #${targetSlot}，只重绘 2 个槽位。`
      : `移动到空槽 #${targetSlot}，只重绘旧槽与新槽。`,
  );
}

function updateSelected(patch, label) {
  const entry = selectedEntry();
  if (!entry) return;
  Object.assign(entry, patch);
  renderIncremental([entry.slot], `${label}仅影响槽位 #${entry.slot}。`);
}

function syncConfigInputs() {
  els.atlasWidth.value = String(state.config.width);
  els.atlasHeight.value = String(state.config.height);
  els.cellSize.value = String(state.config.cell);
  els.paddingRange.value = String(state.config.padding);
  els.paddingOutput.textContent = `${state.config.padding} px`;
}

function syncViewInputs() {
  els.samplerSelect.value = state.view.sampler;
  els.zoomSelect.value = String(state.view.zoom);
  els.gridToggle.checked = state.view.showGrid;
}

function applyLayout() {
  const next = {
    width: Number(els.atlasWidth.value),
    height: Number(els.atlasHeight.value),
    cell: Number(els.cellSize.value),
    padding: Number(els.paddingRange.value),
  };
  const capacity = layoutFor(next).capacity;
  if (capacity < state.scene.length) {
    state.lastUpdate = {
      ...state.lastUpdate,
      text: `布局未应用：${state.scene.length} 个对象超过 ${capacity} 个槽位。`,
    };
    updateMetricsUI();
    return;
  }
  state.config = next;
  state.paddingRange.value = String(next.padding);
  els.paddingOutput.textContent = `${next.padding} px`;
  rebuildSlotSelect();
  renderFull("LAYOUT", "全局布局已应用；对象数组未重建，纹理按新网格重排。");
}

function generateMoreShapes() {
  const layout = layoutFor(state.config);
  const occupied = new Set(state.scene.map((entry) => entry.slot));
  const free = layout.slots.map((slot) => slot.index).filter((slot) => !occupied.has(slot));
  if (!free.length) {
    state.lastUpdate = { ...state.lastUpdate, text: "没有空闲槽位，形状未生成。" };
    updateMetricsUI();
    return;
  }
  const count = Math.min(6, free.length);
  state.generateSeed += 17;
  const additions = generateEntries(count, state.generateSeed, state.scene.length + 1, free.slice(0, count));
  state.scene.push(...additions);
  state.selectedId = additions[additions.length - 1].id;
  rebuildSlotSelect();
  renderIncremental(additions.map((entry) => entry.slot), `导入 ${count} 个程序形状，只绘制新增槽位。`);
}

function normalizeImportedShape(spec, index, freeSlots) {
  const kinds = ["drop", "star", "blade", "blob", "ring", "ghost", "shard", "crown"];
  const requestedSlot = Number.isInteger(spec.slot) ? spec.slot : null;
  let slot = null;
  if (requestedSlot != null && freeSlots.includes(requestedSlot)) {
    slot = requestedSlot;
    freeSlots.splice(freeSlots.indexOf(slot), 1);
  } else {
    slot = freeSlots.shift();
  }
  if (slot == null) return null;
  return {
    id: spec.id || `imp-${Date.now().toString(36)}-${index}`,
    name: spec.name || `导入形状 ${index + 1}`,
    kind: kinds.includes(spec.kind) ? spec.kind : "blob",
    seed: Number.isFinite(spec.seed) ? spec.seed : 500 + index * 97,
    hue: Number.isFinite(spec.hue) ? spec.hue : (index * 53 + 28) % 360,
    slot,
    scale: clamp(Number(spec.scale ?? spec.transform?.scale ?? 0.9), 0.35, 1.25),
    rotation: Number(spec.rotation ?? spec.transform?.rotation ?? 0),
    shadowBlur: clamp(Number(spec.shadow?.blur ?? spec.shadowBlur ?? 8), 0, 20),
    shadowDx: clamp(Number(spec.shadow?.dx ?? spec.shadowDx ?? 5), 0, 14),
    shadowDy: clamp(Number(spec.shadow?.dy ?? spec.shadowDy ?? 6), 0, 14),
  };
}

async function importShapeFile(file) {
  const parsed = JSON.parse(await file.text());
  if (parsed.format === "shadow-atlas/v1") {
    state.config = configFromIndex(parsed);
    state.scene = restoreEntries(parsed);
    state.selectedId = state.scene[0]?.id ?? null;
    syncConfigInputs();
    rebuildSlotSelect();
    renderFull("IMPORT", "索引中的对象已全部恢复，纹理由形状参数重新生成。");
    return;
  }
  const specs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.shapes) ? parsed.shapes : null;
  if (!specs) throw new Error("JSON 应为形状数组或含 shapes 数组的对象");
  const occupied = new Set(state.scene.map((entry) => entry.slot));
  const freeSlots = layoutFor(state.config).slots
    .map((slot) => slot.index)
    .filter((slot) => !occupied.has(slot));
  const additions = specs
    .map((spec, index) => normalizeImportedShape(spec, index, freeSlots))
    .filter(Boolean);
  if (!additions.length) throw new Error("没有可用的空槽位");
  state.scene.push(...additions);
  state.selectedId = additions[additions.length - 1].id;
  rebuildSlotSelect();
  renderIncremental(additions.map((entry) => entry.slot), `导入 ${additions.length} 个外部形状，仅绘制新槽位。`);
}

function restoreBaseline() {
  if (!state.baseline) return;
  state.config = clone(state.baseline.config);
  state.scene = clone(state.baseline.scene);
  state.view = clone(state.baseline.view);
  state.selectedId = state.baseline.selectedId;
  state.corner = "tl";
  state.magnifierSource = "live";
  syncConfigInputs();
  syncViewInputs();
  rebuildSlotSelect();
  renderFull("RESTORE", "已一键恢复到可视化对照基准。");
}

function setScenarioRunning(kind) {
  const card = document.querySelector(`[data-scenario="${kind}"]`);
  if (!card) return;
  card.dataset.status = "running";
  card.querySelector("header b").textContent = "RUNNING";
}

function renderScenarioResult(result) {
  const card = document.querySelector(`[data-scenario="${result.kind}"]`);
  if (!card) return;
  card.dataset.status = result.status;
  card.querySelector("header b").textContent = result.kind === "failure"
    ? (result.detected ? "CAUGHT" : "MISSED")
    : (result.status === "pass" ? "MATCH" : "REVIEW");
  const metrics = [
    ["重算前哈希", formatHash(result.hashBeforeRecompute)],
    ["重算后哈希", formatHash(result.hashAfterRecompute)],
    ["对象 前 → 后", `${result.objectCountBefore} → ${result.objectCountAfter}`],
    ["脏槽位", `${result.dirtySlots} / ${result.occupiedSlots}`],
    ["隔离违规", String(result.isolationViolations)],
    ["未污染区", result.stableHashBefore === result.stableHashAfter ? "HASH 相同" : "HASH 变化"],
    ["截图哈希 前/后", `${formatHash(result.screenshotHashBefore)} / ${formatHash(result.screenshotHashAfter)}`],
    ["截图差异", `${result.diffPixels} px`],
  ];
  card.querySelector(".scenario-metrics").innerHTML = metrics
    .map(([label, value], index) => `<div class="${index === 7 ? "metric-wide" : ""}"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
  card.querySelector(".shot-pair").innerHTML = `
    <figure><img src="${result.beforeShot}" alt="${result.kind} 增量重算前截图" /><figcaption>增量 · 重算前</figcaption></figure>
    <figure><img src="${result.fullShot}" alt="${result.kind} 全量重算后截图" /><figcaption>全量 · 重算后</figcaption></figure>
  `;
}

async function runAllScenarios() {
  const stamp = byId("validationStamp");
  stamp.textContent = "RUNNING 0/3";
  for (const kind of ["normal", "boundary", "failure"]) setScenarioRunning(kind);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const results = {};
  let completed = 0;
  for (const kind of ["normal", "boundary", "failure"]) {
    try {
      const result = runScenario(kind);
      results[kind] = result;
      state.scenarios[kind] = result;
      renderScenarioResult(result);
    } catch (error) {
      results[kind] = { kind, status: "fail", error: error.message };
      state.scenarios[kind] = results[kind];
      const card = document.querySelector(`[data-scenario="${kind}"]`);
      card.dataset.status = "fail";
      card.querySelector("header b").textContent = "ERROR";
      card.querySelector(".scenario-metrics").innerHTML =
        `<div class="metric-wide"><span>异常</span><strong>${error.message}</strong></div>`;
    }
    completed += 1;
    stamp.textContent = `RUNNING ${completed}/3`;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const passed = Object.values(state.scenarios).filter((result) => result.status === "pass").length;
  stamp.textContent = `${passed}/3 EXPECTED · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  refreshConsistency();
  return results;
}

function buildStateSummary() {
  return {
    renderer: "canvas2d / deterministic",
    config: { ...state.config },
    sampler: state.view.sampler,
    objects: state.scene.length,
    sceneHash: sceneSignature(),
    atlasHash: state.measurements?.hash ?? null,
    textureRebuilds: state.textureRebuilds,
    sceneRebuilds: state.sceneRebuilds,
    operations: state.operations,
    lastUpdate: { ...state.lastUpdate },
    isolation: {
      mode: "content-clip+transparent-guard",
      guardPx: 1,
      violations: state.measurements?.guardViolations ?? null,
      guardAlphaMax: state.measurements?.guardAlphaMax ?? null,
    },
    liveFullCheck: state.liveCheck,
    reload: state.reloaded
      ? {
          textureHash: state.reloaded.validation.textureHash,
          restored: state.reloaded.validation.restoredCount,
          objects: state.reloaded.validation.objectCount,
          passed: state.reloaded.validation.passed,
        }
      : null,
    scenarios: Object.fromEntries(Object.entries(state.scenarios).map(([kind, result]) => [
      kind,
      {
        status: result.status,
        hashBefore: result.hashBeforeRecompute,
        hashAfter: result.hashAfterRecompute,
        objectsBefore: result.objectCountBefore,
        objectsAfter: result.objectCountAfter,
        diffPixels: result.diffPixels,
      },
    ])),
  };
}

function createReloadThumb(index, item, source) {
  const config = configFromIndex(index);
  const cell = config.cell;
  const col = item.slot % index.atlas.cols;
  const row = Math.floor(item.slot / index.atlas.cols);
  const canvas = createCanvas(96, 96);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = state.view.sampler !== "nearest";
  const x = clamp(col * cell - 2, 0, source.width - cell - 4);
  const y = clamp(row * cell - 2, 0, source.height - cell - 4);
  context.drawImage(source, x, y, cell + 4, cell + 4, 0, 0, 96, 96);
  return canvas.toDataURL("image/png");
}

function renderReloadResults() {
  const loaded = state.reloaded;
  if (!loaded) return;
  const validation = loaded.validation;
  byId("reloadState").textContent = validation.passed ? "PASS" : "FAIL";
  byId("reloadTitle").textContent = validation.passed
    ? `已回载 · ${validation.restoredCount}/${validation.objectCount} 项逐项通过`
    : `回载异常 · ${validation.restoredCount}/${validation.objectCount} 项通过`;
  byId("reloadText").textContent =
    `纹理 ${formatHash(validation.textureHash)} / 索引 ${formatHash(validation.expectedTextureHash)}；` +
    `对象 ${validation.objectCount}；隔离违规 ${validation.guardViolations}；` +
    `采样 rect + guard 已逐项核对。`;
  const container = byId("reloadItems");
  container.replaceChildren();
  for (const item of validation.items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `reload-item ${item.status === "pass" ? "ok" : "bad"}`;
    button.title = item.problems.length ? item.problems.join("；") : `${item.name} 边界检查通过`;
    const image = document.createElement("img");
    image.className = "reload-thumb";
    image.alt = `${item.name} 回载缩略图`;
    image.src = createReloadThumb(loaded.index, item, loaded.canvas);
    const label = document.createElement("span");
    label.textContent = `#${item.slot} ${item.name}`;
    const status = document.createElement("b");
    status.textContent = item.status === "pass" ? "OK" : "ERR";
    label.append(status);
    button.append(image, label);
    button.addEventListener("click", () => {
      state.selectedId = item.id;
      state.corner = "tl";
      state.magnifierSource = "reloaded";
      refreshUI();
    });
    container.append(button);
  }
  refreshConsistency();
}

function acceptReloaded(index, canvas, validation, indexHash = null) {
  state.reloaded = {
    index,
    canvas,
    validation,
    indexHash,
    loadedAt: new Date().toISOString(),
  };
  state.magnifierSource = "reloaded";
  renderReloadResults();
  renderMagnifier();
  updateAlgorithmSummary();
}

function invalidateReload() {
  if (!state.reloaded) return;
  state.reloaded = null;
  state.magnifierSource = "live";
  byId("reloadState").textContent = "STALE";
  byId("reloadTitle").textContent = "场景已变化，回载结果已失效";
  byId("reloadText").textContent = "再次导出或载入文件后重新执行逐项边界检查。";
  byId("reloadItems").replaceChildren();
}

async function exportAndValidate({ download = true } = {}) {
  state.measurements = analyzeCanvas(els.atlasCanvas, state.scene, state.config);
  const summary = buildStateSummary();
  const index = buildIndex(state.scene, state.config, state.measurements, state.view, summary);
  const bundle = createBundle(index);
  const pngBlob = await canvasBlob(els.atlasCanvas);
  if (download) {
    downloadBlob(pngBlob, "shadow-atlas.png");
    setTimeout(() => {
      downloadBlob(new Blob([bundle.indexText], { type: "application/json" }), "shadow-atlas-index.json");
    }, 80);
  }
  const loadedCanvas = await decodeAtlasBlob(pngBlob);
  const validation = validateReloadedAtlas(loadedCanvas, index, state.scene);
  acceptReloaded(index, loadedCanvas, validation, bundle.indexHash);
  return { index, indexText: bundle.indexText, pngBlob, validation };
}

async function loadExternalBundle(indexFile, atlasFile) {
  try {
    const text = await indexFile.text();
    const index = JSON.parse(text);
    if (index.format !== "shadow-atlas/v1") throw new Error("不是 shadow-atlas/v1 索引");
    const loadedCanvas = await decodeAtlasBlob(atlasFile);
    if (loadedCanvas.width !== index.atlas.width || loadedCanvas.height !== index.atlas.height) {
      throw new Error(`PNG 尺寸 ${loadedCanvas.width}×${loadedCanvas.height} 与索引不一致`);
    }
    const config = configFromIndex(index);
    const entries = restoreEntries(index);
    const validation = validateReloadedAtlas(loadedCanvas, index, entries);
    state.config = config;
    state.scene = entries;
    state.selectedId = entries[0]?.id ?? null;
    syncConfigInputs();
    rebuildSlotSelect();
    setAtlasSize();
    const context = els.atlasCanvas.getContext("2d", { willReadFrequently: true });
    context.clearRect(0, 0, state.config.width, state.config.height);
    context.drawImage(loadedCanvas, 0, 0);
    state.measurements = analyzeCanvas(els.atlasCanvas, state.scene, state.config);
    state.lastUpdate = {
      mode: "RELOAD",
      dirtyTiles: state.scene.length,
      dirtyPixels: state.config.width * state.config.height,
      elapsedMs: 0,
      text: "外部 PNG + 索引已载入；逐项恢复与边界检查完成。",
    };
    acceptReloaded(index, loadedCanvas, validation, hashString(text));
    refreshUI();
    scheduleLiveCheck();
  } catch (error) {
    byId("reloadState").textContent = "ERROR";
    byId("reloadTitle").textContent = "文件回载失败";
    byId("reloadText").textContent = error.message;
  }
}

function slotFromPointer(event) {
  const rect = els.atlasStage.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * state.config.width;
  const y = ((event.clientY - rect.top) / rect.height) * state.config.height;
  const layout = layoutFor(state.config);
  const col = Math.floor(x / state.config.cell);
  const row = Math.floor(y / state.config.cell);
  if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) return null;
  return row * layout.cols + col;
}

function entryAtSlot(slot) {
  return state.scene.find((entry) => entry.slot === slot) || null;
}

function attachEvents() {
  els.paddingRange.addEventListener("input", () => {
    els.paddingOutput.textContent = `${els.paddingRange.value} px`;
  });
  els.applyLayoutButton.addEventListener("click", applyLayout);
  els.generateButton.addEventListener("click", generateMoreShapes);
  els.importButton.addEventListener("click", () => els.shapeFileInput.click());
  els.shapeFileInput.addEventListener("change", async () => {
    const file = els.shapeFileInput.files?.[0];
    if (!file) return;
    try {
      await importShapeFile(file);
    } catch (error) {
      state.lastUpdate = { ...state.lastUpdate, text: `形状导入失败：${error.message}` };
      updateMetricsUI();
    }
    els.shapeFileInput.value = "";
  });
  els.restoreButton.addEventListener("click", restoreBaseline);
  els.exportReloadButton.addEventListener("click", () => exportAndValidate({ download: true }));
  els.reloadCheckButton.addEventListener("click", () => exportAndValidate({ download: false }));
  els.runScenariosButton.addEventListener("click", runAllScenarios);

  els.slotSelect.addEventListener("change", () => moveSelectedToSlot(Number(els.slotSelect.value)));
  els.scaleRange.addEventListener("input", () => {
    updateSelected({ scale: Number(els.scaleRange.value) }, "缩放参数");
  });
  els.rotationRange.addEventListener("input", () => {
    updateSelected({ rotation: Number(els.rotationRange.value) }, "旋转参数");
  });
  els.blurRange.addEventListener("input", () => {
    updateSelected({ shadowBlur: Number(els.blurRange.value) }, "阴影模糊");
  });
  els.offsetRange.addEventListener("input", () => {
    const offset = Number(els.offsetRange.value);
    updateSelected({ shadowDx: offset, shadowDy: offset }, "阴影偏移");
  });
  els.nudgeLeft.addEventListener("click", () => {
    const entry = selectedEntry();
    if (entry && entry.slot > 0) moveSelectedToSlot(entry.slot - 1);
  });
  els.nudgeRight.addEventListener("click", () => {
    const entry = selectedEntry();
    if (entry && entry.slot < layoutFor(state.config).capacity - 1) moveSelectedToSlot(entry.slot + 1);
  });
  els.randomizeButton.addEventListener("click", () => {
    const entry = selectedEntry();
    if (!entry) return;
    updateSelected({
      seed: (Math.imul(entry.seed, 1664525) + 1013904223) >>> 0,
      hue: (entry.hue + 47) % 360,
    }, "随机种子");
  });

  els.samplerSelect.addEventListener("change", () => {
    state.view.sampler = els.samplerSelect.value;
    state.lastUpdate = {
      mode: "VIEW",
      dirtyTiles: 0,
      dirtyPixels: 0,
      elapsedMs: 0,
      text: "采样参数变化：仅更新放大镜，纹理 0 像素重绘。",
    };
    refreshUI();
  });
  els.zoomSelect.addEventListener("change", () => {
    state.view.zoom = Number(els.zoomSelect.value);
    state.lastUpdate = {
      mode: "VIEW",
      dirtyTiles: 0,
      dirtyPixels: 0,
      elapsedMs: 0,
      text: "放大倍率变化：仅重绘检查视图。",
    };
    refreshUI();
  });
  els.gridToggle.addEventListener("change", () => {
    state.view.showGrid = els.gridToggle.checked;
    state.lastUpdate = {
      mode: "OVERLAY",
      dirtyTiles: 0,
      dirtyPixels: 0,
      elapsedMs: 0,
      text: "网格开关只刷新覆盖层，未触碰纹理或场景对象。",
    };
    refreshUI();
  });
  document.querySelectorAll(".corner-picker button").forEach((button) => {
    button.addEventListener("click", () => {
      state.corner = button.dataset.corner;
      document.querySelectorAll(".corner-picker button").forEach((item) => item.classList.toggle("active", item === button));
      renderMagnifier();
    });
  });
  byId("magnifierSource").addEventListener("click", () => {
    if (!state.reloaded) return;
    state.magnifierSource = state.magnifierSource === "reloaded" ? "live" : "reloaded";
    renderMagnifier();
  });

  els.atlasStage.addEventListener("pointermove", (event) => {
    const slot = slotFromPointer(event);
    const rect = els.atlasStage.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * state.config.width;
    const y = ((event.clientY - rect.top) / rect.height) * state.config.height;
    byId("pointerReadout").textContent = `x ${Math.floor(x)} / y ${Math.floor(y)}`;
    if (slot !== state.pointer.slot) {
      state.pointer.slot = slot;
      drawOverlay();
    }
  });
  els.atlasStage.addEventListener("pointerleave", () => {
    state.pointer.slot = null;
    byId("pointerReadout").textContent = "x — / y —";
    drawOverlay();
  });
  els.atlasStage.addEventListener("pointerdown", (event) => {
    const slot = slotFromPointer(event);
    if (slot == null) return;
    const entry = entryAtSlot(slot);
    state.drag = { sourceSlot: entry?.slot ?? null, targetSlot: slot };
    if (entry) selectEntry(entry.id);
    els.atlasStage.setPointerCapture?.(event.pointerId);
  });
  els.atlasStage.addEventListener("pointerup", (event) => {
    const target = slotFromPointer(event);
    const drag = state.drag;
    state.drag = null;
    if (target == null) return;
    if (drag?.sourceSlot != null && target !== drag.sourceSlot) {
      const entry = entryAtSlot(drag.sourceSlot);
      if (entry) {
        state.selectedId = entry.id;
        moveSelectedToSlot(target);
      }
    } else if (drag?.sourceSlot == null) {
      const entry = entryAtSlot(target);
      if (entry) selectEntry(entry.id);
    }
  });

  const handleBundleInput = async (input, key) => {
    if (!state.pendingBundle) state.pendingBundle = {};
    state.pendingBundle[key] = input.files?.[0] || null;
    input.closest(".file-pill")?.classList.toggle("loaded", Boolean(input.files?.[0]));
    if (state.pendingBundle.index && state.pendingBundle.atlas) {
      await loadExternalBundle(state.pendingBundle.index, state.pendingBundle.atlas);
    }
  };
  els.bundleIndexFile.addEventListener("change", () => handleBundleInput(els.bundleIndexFile, "index"));
  els.bundleAtlasFile.addEventListener("change", () => handleBundleInput(els.bundleAtlasFile, "atlas"));
}

function initialize() {
  syncConfigInputs();
  syncViewInputs();
  rebuildSlotSelect();
  renderFull("INIT", "初始对象已按固定网格光栅化。");
  state.baseline = clone({
    config: state.config,
    scene: state.scene,
    view: state.view,
    selectedId: state.selectedId,
  });
  updatePreset();
  attachEvents();
  window.__atlasReady = false;
  requestAnimationFrame(async () => {
    await runAllScenarios();
    await exportAndValidate({ download: false });
    window.__atlasReady = true;
  });
}

window.__atlasApp = {
  state,
  runAllScenarios,
  exportAndValidate,
  exportAndValidateNoDownload: () => exportAndValidate({ download: false }),
  restoreBaseline,
  buildStateSummary,
  getIndex: () => buildIndex(state.scene, state.config, state.measurements, state.view, buildStateSummary()),
  loadExternalBundle,
};

initialize();
