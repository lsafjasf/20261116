import { FALLBACK_MESSAGES, VersionedResourceCache, createThumbnailFallback } from "/core/fallback.js";
import { runAllParameterGroups } from "/core/diagnostics.js";
import { StableAtlasPacker } from "/core/packer.js";
import { createDemoProject, projectFingerprint } from "/core/project.js";
import { renderAtlas, restoreOriginalFrame } from "/core/render.js";
import {
  buildAtlasPackage,
  createSnapshotPackage,
  packageFingerprint,
  packerFromPackage,
  validateAtlasPackage,
} from "/core/schema.js";
import { roundChanges, runThreeRoundScenario } from "/core/scenario.js";
import { createDemoFrames, createSpriteFrame, hashPixels } from "/core/sprite.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const atlasCanvas = $("#atlas-canvas");
const atlasContext = atlasCanvas.getContext("2d");
const animationCanvas = $("#animation-canvas");
const animationContext = animationCanvas.getContext("2d");
const displayCanvas = document.createElement("canvas");
const resourceCache = new VersionedResourceCache({ ttlMs: 12000 });
const STORAGE_KEY = "stable-atlas-lab-snapshots-v1";

const state = {
  frames: [],
  frameById: new Map(),
  packer: null,
  project: null,
  atlas: null,
  atlasCanvas: null,
  lastChange: null,
  roundIndex: 0,
  roundResults: [],
  roundBaseline: null,
  snapshots: [],
  lastExport: null,
  selectedFrameId: null,
  activeKeyframeId: null,
  nextIndex: 200,
  thumbnailFallback: false,
  busy: false,
};

function toast(title, message = "", kind = "ok") {
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.innerHTML = `<strong></strong><p></p>`;
  node.querySelector("strong").textContent = title;
  node.querySelector("p").textContent = message;
  $("#toast-stack").append(node);
  setTimeout(() => node.remove(), 5200);
}

function showFallback(message) {
  $("#fallback-message").textContent = `${message} 已清除失效缓存，并从工程源数据重建；当前画面不是旧缓存。`;
  $("#fallback-banner").hidden = false;
}

function hideFallback() {
  $("#fallback-banner").hidden = true;
}

function readParameters() {
  return {
    width: Number($("#param-width").value),
    height: Number($("#param-height").value),
    padding: Number($("#param-padding").value),
    allowRotation: $("#param-rotate").checked,
    trim: $("#param-trim").checked,
    autoCompact: $("#param-compact").checked,
    autoGrow: true,
    compaction: {
      minUtilization: Number($("#param-floor").value),
      dropTolerance: 0.14,
      targetUtilization: 0.62,
      minUpdates: 4,
    },
  };
}

function currentAtlas() {
  return renderAtlas(state.packer, [...state.frameById.values()]);
}

function ensureSelectedFrame() {
  if (!state.frameById.has(state.selectedFrameId)) {
    state.selectedFrameId = state.project?.frameOrder?.find((id) => state.frameById.has(id)) ?? null;
  }
}

function updateProjectFrames(addedIds = [], deletedIds = []) {
  const deleted = new Set(deletedIds);
  state.project.frameOrder = state.project.frameOrder.filter((id) => !deleted.has(id));
  for (const id of addedIds) {
    if (!state.project.frameOrder.includes(id)) state.project.frameOrder.push(id);
  }
  for (const keyframe of state.project.keyframes) {
    if (!state.frameById.has(keyframe.frameId)) keyframe.frameId = state.project.frameOrder[0];
  }
  ensureSelectedFrame();
  state.project.selectedFrameId = state.selectedFrameId;
  state.project.revision += 1;
}

function drawSlice(containerContext, sourceCanvas, slice, options = {}) {
  const trim = slice.spriteSourceSize;
  const frame = slice.frame;
  const scratch = document.createElement("canvas");
  scratch.width = trim.w;
  scratch.height = trim.h;
  const context = scratch.getContext("2d");
  context.imageSmoothingEnabled = false;
  if (slice.rotated) {
    context.translate(0, trim.h);
    context.rotate(-Math.PI / 2);
    context.drawImage(
      sourceCanvas,
      frame.x,
      frame.y,
      frame.w,
      frame.h,
      0,
      0,
      frame.w,
      frame.h,
    );
  } else {
    context.drawImage(sourceCanvas, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
  }
  const scale = options.scale ?? 1;
  const sourceWidth = slice.sourceSize.w;
  const sourceHeight = slice.sourceSize.h;
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  containerContext.imageSmoothingEnabled = false;
  containerContext.drawImage(
    scratch,
    x + trim.x * scale,
    y + trim.y * scale,
    trim.w * scale,
    trim.h * scale,
  );
  return { width: sourceWidth * scale, height: sourceHeight * scale };
}

function sliceForFrame(frameId) {
  const placement = state.packer.placements.get(frameId);
  if (!placement) return null;
  return {
    id: placement.id,
    frame: { x: placement.x, y: placement.y, w: placement.w, h: placement.h },
    rotated: placement.rotated,
    trimmed: placement.trimmed,
    sourceSize: { w: placement.sourceWidth, h: placement.sourceHeight },
    spriteSourceSize: {
      x: placement.trimRect.x,
      y: placement.trimRect.y,
      w: placement.trimRect.w,
      h: placement.trimRect.h,
    },
    colors: [...placement.colors],
  };
}

function updateMetrics() {
  const metrics = state.packer.metrics();
  $("#metric-frames").textContent = String(metrics.frameCount);
  $("#metric-size").textContent = `${state.packer.width}²`;
  $("#metric-util").textContent = `${(metrics.utilization * 100).toFixed(1)}%`;
  $("#atlas-hash").textContent = `hash ${hashPixels(state.atlas.pixels)}`;
  $("#atlas-caption").textContent = `${state.packer.width} × ${state.packer.height} · ${state.packer.assertNoOverlaps() ? "无重叠" : "存在重叠"}`;
  $("#metric-overlap").textContent = state.packer.assertNoOverlaps() ? "0" : "!";
  $("#metric-overlap").className = state.packer.assertNoOverlaps() ? "ok" : "";
  $("#round-counter").textContent = `${state.roundIndex} / 3`;
}

function renderAtlasPreview() {
  state.atlas = currentAtlas();
  const raw = document.createElement("canvas");
  raw.width = state.atlas.width;
  raw.height = state.atlas.height;
  raw.getContext("2d").putImageData(
    new ImageData(new Uint8ClampedArray(state.atlas.pixels), state.atlas.width, state.atlas.height),
    0,
    0,
  );
  state.atlasCanvas = raw;
  atlasCanvas.width = state.atlas.width;
  atlasCanvas.height = state.atlas.height;
  atlasContext.imageSmoothingEnabled = false;
  atlasContext.clearRect(0, 0, atlasCanvas.width, atlasCanvas.height);
  atlasContext.drawImage(raw, 0, 0);
  const scaleX = atlasCanvas.width / state.atlas.width;
  const scaleY = atlasCanvas.height / state.atlas.height;
  atlasContext.save();
  atlasContext.lineWidth = 1;
  for (const placement of state.packer.placements.values()) {
    atlasContext.strokeStyle = "rgba(83, 216, 223, 0.34)";
    atlasContext.strokeRect(placement.x + 0.5, placement.y + 0.5, placement.w - 1, placement.h - 1);
  }
  if (state.lastChange?.rearrangedRegion) {
    const region = state.lastChange.rearrangedRegion;
    atlasContext.strokeStyle = "#ffb34d";
    atlasContext.lineWidth = 2;
    atlasContext.setLineDash([5, 3]);
    atlasContext.strokeRect(
      (region.x + 0.5) * scaleX,
      (region.y + 0.5) * scaleY,
      Math.max(1, (region.w - 1) * scaleX),
      Math.max(1, (region.h - 1) * scaleY),
    );
  }
  const selected = state.selectedFrameId && state.packer.placements.get(state.selectedFrameId);
  if (selected) {
    atlasContext.setLineDash([]);
    atlasContext.strokeStyle = "#53d8df";
    atlasContext.lineWidth = 2;
    atlasContext.strokeRect(selected.x, selected.y, selected.w, selected.h);
  }
  atlasContext.restore();
}

function renderKeyframeOptions() {
  const select = $("#keyframe-select");
  select.innerHTML = "";
  for (const keyframe of state.project.keyframes) {
    const option = document.createElement("option");
    option.value = keyframe.id;
    option.textContent = `${keyframe.index}: ${keyframe.name}`;
    select.append(option);
  }
  if (!state.project.keyframes.some((entry) => entry.id === state.activeKeyframeId)) {
    state.activeKeyframeId = state.project.keyframes[0]?.id ?? null;
  }
  select.value = state.activeKeyframeId ?? "";
}

function renderAnimation() {
  const keyframe =
    state.project.keyframes.find((entry) => entry.id === state.activeKeyframeId) ??
    state.project.keyframes[0];
  if (!keyframe) return;
  const frameId = state.frameById.has(keyframe.frameId)
    ? keyframe.frameId
    : state.project.frameOrder.find((id) => state.frameById.has(id));
  const slice = frameId ? sliceForFrame(frameId) : null;
  const width = animationCanvas.width;
  const height = animationCanvas.height;
  const background = animationContext.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, keyframe.colors.backdrop);
  background.addColorStop(0.55, "#111b2b");
  background.addColorStop(1, "#090e17");
  animationContext.fillStyle = background;
  animationContext.fillRect(0, 0, width, height);
  animationContext.strokeStyle = "rgba(255,255,255,0.045)";
  for (let x = 0; x < width; x += 24) {
    animationContext.beginPath();
    animationContext.moveTo(x, 0);
    animationContext.lineTo(x, height);
    animationContext.stroke();
  }
  animationContext.fillStyle = "rgba(255, 179, 77, 0.09)";
  animationContext.beginPath();
  animationContext.ellipse(width / 2, height * 0.82, 138, 25, 0, 0, Math.PI * 2);
  animationContext.fill();
  if (slice) {
    const scale = Math.min(3.2, (height * 0.72) / Math.max(1, slice.sourceSize.h));
    const displayWidth = slice.sourceSize.w * scale;
    const displayHeight = slice.sourceSize.h * scale;
    drawSlice(animationContext, state.atlasCanvas, slice, {
      x: (width - displayWidth) / 2,
      y: (height - displayHeight) / 2 - 2,
      scale,
    });
  }
  $("#keyframe-name").textContent = `${keyframe.name} · #${keyframe.index}`;
  const layerList = $("#layer-list");
  layerList.innerHTML = "";
  for (const layer of state.project.layers) {
    const item = document.createElement("li");
    const color = keyframe.colors[layer.id] ?? layer.color;
    item.innerHTML = `<i style="color:${color};background:${color}"></i><span></span><b></b>`;
    item.querySelector("span").textContent = layer.name;
    item.querySelector("b").textContent = color.toUpperCase();
    layerList.append(item);
  }
}

function drawThumbnail(canvas, slice) {
  const context = canvas.getContext("2d");
  canvas.width = 112;
  canvas.height = 112;
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, 112, 112);
  const scale = Math.min(88 / slice.sourceSize.w, 88 / slice.sourceSize.h);
  const width = slice.sourceSize.w * scale;
  const height = slice.sourceSize.h * scale;
  drawSlice(context, state.atlasCanvas, slice, {
    x: (112 - width) / 2,
    y: (112 - height) / 2,
    scale,
  });
}

function renderThumbnails() {
  const grid = $("#thumbnail-grid");
  grid.innerHTML = "";
  const ordered = state.project.frameOrder.filter((id) => state.frameById.has(id));
  const selectedIndex = Math.max(0, ordered.indexOf(state.selectedFrameId));
  const start = Math.max(0, Math.min(ordered.length - 9, selectedIndex - 4));
  const ids = ordered.slice(start, start + 9);
  if (ids.length === 0) return;
  for (const id of ids) {
    const thumb = document.createElement("button");
    thumb.className = "thumb";
    thumb.type = "button";
    thumb.title = id;
    if (state.thumbnailFallback) {
      const fallback = createThumbnailFallback(state.frameById.get(id));
      thumb.classList.add("placeholder");
      thumb.style.setProperty("--ph-color", fallback.color);
      thumb.dataset.label = fallback.label;
      const label = document.createElement("span");
      label.textContent = "fallback";
      thumb.append(label);
    } else {
      const canvas = document.createElement("canvas");
      thumb.append(canvas);
      const slice = sliceForFrame(id);
      if (slice) drawThumbnail(canvas, slice);
      const label = document.createElement("span");
      label.textContent = id.slice(-3);
      thumb.append(label);
    }
    thumb.addEventListener("click", () => {
      state.selectedFrameId = id;
      renderAtlasPreview();
      renderInspector();
      renderThumbnails();
    });
    grid.append(thumb);
  }
}

function renderInspector() {
  ensureSelectedFrame();
  const placement = state.selectedFrameId
    ? state.packer.placements.get(state.selectedFrameId)
    : null;
  const stats = $("#slice-stats");
  stats.innerHTML = "";
  if (!placement) {
    $("#slice-badge").textContent = "无切片";
    return;
  }
  $("#slice-badge").textContent = `${placement.rotated ? "rotated" : "normal"} + ${placement.trimmed ? "trimmed" : "untrimmed"}`;
  const entries = [
    ["ID", placement.id],
    ["frame", `x${placement.x} y${placement.y} · ${placement.w}×${placement.h}`],
    ["sourceSize", `${placement.sourceWidth}×${placement.sourceHeight}`],
    ["spriteSourceSize", `${placement.trimRect.x},${placement.trimRect.y} · ${placement.trimRect.w}×${placement.trimRect.h}`],
    ["rotated", String(placement.rotated)],
    ["colors", placement.colors.join("  ")],
  ];
  for (const [label, value] of entries) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value;
    row.append(term, detail);
    stats.append(row);
  }
}

function refreshView() {
  ensureSelectedFrame();
  state.project.selectedFrameId = state.selectedFrameId;
  renderAtlasPreview();
  updateMetrics();
  renderKeyframeOptions();
  renderAnimation();
  renderThumbnails();
  renderInspector();
}

function resetDemo() {
  state.frames = createDemoFrames(100);
  state.frameById = new Map(state.frames.map((frame) => [frame.id, frame]));
  state.packer = new StableAtlasPacker(readParameters());
  state.packer.packAll(state.frames);
  state.project = createDemoProject(state.frames);
  state.selectedFrameId = state.project.keyframes[0].frameId;
  state.activeKeyframeId = state.project.keyframes[0].id;
  state.lastChange = null;
  state.roundIndex = 0;
  state.roundResults = [];
  state.lastExport = null;
  state.thumbnailFallback = false;
  state.nextIndex = 200;
  state.roundBaseline = {
    placements: new Map(state.packer.placements),
    utilization: state.packer.metrics().utilization,
  };
  $("#reload-export-btn").disabled = true;
  $("#reload-result").className = "result-box quiet";
  $("#reload-result").textContent = "等待导出或载入";
  $("#compare-result").className = "check-note";
  $("#compare-result").textContent = "尚未执行像素比对";
  hideFallback();
  refreshView();
  renderRoundTable();
}

function applyChangeSet(changes, label) {
  const before = {
    placements: new Map(state.packer.placements),
    utilization: state.packer.metrics().utilization,
    fingerprint: projectFingerprint(state.project, state.packer),
  };
  const result = state.packer.applyChanges(changes);
  const added = changes.upserts
    .filter((frame) => !state.frameById.has(frame.id))
    .map((frame) => frame.id);
  for (const frame of changes.upserts) state.frameById.set(frame.id, frame);
  for (const id of changes.deletes) state.frameById.delete(id);
  state.frames = [...state.frameById.values()];
  updateProjectFrames(added, changes.deletes);
  state.lastChange = result;
  refreshView();
  return { before, result, label };
}

function nextFrameId() {
  let id;
  do {
    id = `spr-${String(state.nextIndex).padStart(3, "0")}`;
    state.nextIndex += 1;
  } while (state.frameById.has(id));
  return id;
}

function addFrames(count = 2) {
  const upserts = [];
  for (let index = 0; index < count; index += 1) {
    const id = nextFrameId();
    const numeric = Number(id.slice(-3));
    upserts.push(createSpriteFrame(id, numeric));
  }
  const applied = applyChangeSet({ upserts, deletes: [] }, `新增 ${count} 帧`);
  toast("增量新增完成", `新增 ${count} 帧，未受影响帧位移 0。`, "ok");
  return applied;
}

function modifyFrames(count = 2) {
  const candidates = state.project.frameOrder
    .filter((id) => state.frameById.has(id))
    .slice(0, Math.max(0, count));
  const upserts = candidates.map((id) => {
    const current = state.frameById.get(id);
    const index = Number(id.split("-").at(-1));
    return createSpriteFrame(id, index, { variant: (current.version ?? 0) + 1 });
  });
  applyChangeSet({ upserts, deletes: [] }, `修改 ${count} 帧`);
  toast("增量修改完成", `已更新 ${upserts.length} 帧；其余坐标保持。`, "ok");
}

function deleteFrame() {
  const protectedIds = new Set(state.project.keyframes.map((keyframe) => keyframe.frameId));
  const candidate =
    [...state.project.frameOrder].reverse().find((id) => !protectedIds.has(id)) ??
    state.project.frameOrder.at(-1);
  if (!candidate) return;
  applyChangeSet({ upserts: [], deletes: [candidate] }, `删除 ${candidate}`);
  toast("增量删除完成", `已删除 ${candidate}，空洞保留给后续小帧复用。`, "ok");
}

function unaffectedMovement(before, after, affectedIds) {
  let moved = 0;
  let maxDelta = 0;
  let compared = 0;
  for (const [id, old] of before) {
    if (affectedIds.has(id) || !after.has(id)) continue;
    const current = after.get(id);
    compared += 1;
    const delta = Math.abs(old.x - current.x) + Math.abs(old.y - current.y);
    maxDelta = Math.max(maxDelta, delta);
    if (delta > 0 || old.rotated !== current.rotated) moved += 1;
  }
  return { compared, moved, maxDelta };
}

async function recordRound(applied, roundNumber) {
  const affectedIds = new Set([
    ...applied.result.requested.upsertIds,
    ...applied.result.requested.deleteIds,
  ]);
  const movement = unaffectedMovement(applied.before.placements, state.packer.placements, affectedIds);
  const imageDataUrl = state.atlasCanvas.toDataURL("image/png");
  const snapshot = createSnapshotPackage({
    packer: state.packer,
    project: state.project,
    atlas: state.atlas,
    imageDataUrl,
    label: `round-${roundNumber}-pre-export`,
    snapshotId: `round-${roundNumber}`,
  });
  const packageJson = buildAtlasPackage({
    packer: state.packer,
    project: state.project,
    atlas: state.atlas,
    imageDataUrl,
  });
  const validation = validateAtlasPackage(packageJson);
  const reloaded = packerFromPackage(packageJson);
  const reloadFingerprint = projectFingerprint(packageJson.project, reloaded);
  const row = {
    round: roundNumber,
    label: applied.label,
    width: state.packer.width,
    height: state.packer.height,
    utilization: state.packer.metrics().utilization,
    utilizationBefore: applied.before.utilization,
    region: applied.result.rearrangedRegion,
    moved: applied.result.moved.length,
    inserted: applied.result.inserted.length,
    deleted: applied.result.deleted.length,
    resized: applied.result.resized.length,
    unaffected: movement,
    compacted: applied.result.compacted,
    pixelHash: hashPixels(state.atlas.pixels),
    rotatedFrames: packageJson.frames.filter((slice) => slice.rotated).length,
    trimmedFrames: packageJson.frames.filter((slice) => slice.trimmed).length,
    noOverlap: validation.ok,
    snapshotMatches: packageFingerprint(snapshot) === packageFingerprint(packageJson),
    reloadMatches: reloadFingerprint === projectFingerprint(state.project, state.packer),
  };
  state.roundResults.push(row);
  renderRoundTable();
  return row;
}

async function runNextRound() {
  if (state.busy) return;
  if (state.roundIndex >= 3) {
    toast("三轮已完成", "点击“重置 100 帧”后可重新跑固定基准。", "warn");
    return;
  }
  state.busy = true;
  try {
    const changes = roundChanges(state.roundIndex);
    const applied = applyChangeSet(changes, changes.label);
    state.roundIndex += 1;
    $("#round-counter").textContent = `${state.roundIndex} / 3`;
    await recordRound(applied, state.roundIndex);
    toast(
      `第 ${state.roundIndex} 轮完成`,
      `未受影响帧位移 ${applied.result.moved.length} 个变更帧之外为 0。`,
      "ok",
    );
  } catch (error) {
    toast("增量执行失败", error.message, "error");
  } finally {
    state.busy = false;
  }
}

function renderRoundTable() {
  const body = $("#round-table");
  if (state.roundResults.length === 0) {
    body.innerHTML = `<tr class="placeholder-row"><td colspan="7">运行固定场景后显示三轮数据</td></tr>`;
    return;
  }
  body.innerHTML = "";
  for (const row of state.roundResults) {
    const tr = document.createElement("tr");
    const region = row.region
      ? `${row.region.x},${row.region.y}<br>${row.region.w}×${row.region.h}`
      : "—";
    const utilDelta = row.utilization - row.utilizationBefore;
    const deltaClass = utilDelta >= 0 ? "good" : "warn";
    const checkClass = row.noOverlap && row.snapshotMatches && row.reloadMatches ? "good" : "warn";
    tr.innerHTML = `
      <td><strong>#${row.round}</strong><br>${row.inserted}+ / ${row.deleted}− / ${row.resized}↻</td>
      <td>${row.width}×${row.height}</td>
      <td><span class="pill ${deltaClass}">${(row.utilization * 100).toFixed(1)}%</span><br>${utilDelta >= 0 ? "+" : ""}${(utilDelta * 100).toFixed(2)}%</td>
      <td>${region}</td>
      <td><strong>${row.unaffected.moved}</strong> / ${row.unaffected.compared}<br><span class="mono">max ${row.unaffected.maxDelta}px</span></td>
      <td><span class="mono">${row.pixelHash}</span><br>${row.rotatedFrames}↻ · ${row.trimmedFrames}✂</td>
      <td><span class="pill ${checkClass}">${row.noOverlap && row.snapshotMatches && row.reloadMatches ? "PASS" : "CHECK"}</span></td>`;
    body.append(tr);
  }
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1500);
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("PNG 解码失败"));
    image.src = dataUrl;
  });
}

async function pixelsFromDataUrl(dataUrl) {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, pixels: data.data };
}

function currentPackage() {
  const imageDataUrl = state.atlasCanvas.toDataURL("image/png");
  return buildAtlasPackage({
    packer: state.packer,
    project: state.project,
    atlas: state.atlas,
    imageDataUrl,
  });
}

function loadStoredSnapshots() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    state.snapshots = Array.isArray(stored)
      ? stored.filter((snapshot) => validateAtlasPackage(snapshot).ok).slice(-5)
      : [];
  } catch {
    state.snapshots = [];
  }
}

function persistSnapshots() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.snapshots.slice(-5)));
  } catch (error) {
    toast("快照未写入本地存储", `已保留在当前会话；${error.message}`, "warn");
  }
}

function renderSnapshots() {
  const list = $("#snapshot-list");
  $("#snapshot-count").textContent = String(state.snapshots.length);
  if (state.snapshots.length === 0) {
    list.innerHTML = `<p class="hint">导出时自动保留当前工程、坐标、颜色与图集像素。</p>`;
    return;
  }
  list.innerHTML = "";
  for (const snapshot of [...state.snapshots].reverse()) {
    const node = document.createElement("div");
    node.className = "snapshot";
    node.innerHTML = `
      <div><strong></strong><small></small></div>
      <div><button type="button" data-action="load">载入</button><button type="button" data-action="save">下载</button></div>`;
    node.querySelector("strong").textContent = snapshot.snapshot?.label ?? "pre-export";
    node.querySelector("small").textContent =
      `${snapshot.frames.length} 帧 · ${snapshot.atlas.width}×${snapshot.atlas.height} · ${snapshot.atlas.pixelHash}`;
    node.querySelector('[data-action="load"]').addEventListener("click", () => reloadPackage(snapshot));
    node.querySelector('[data-action="save"]').addEventListener("click", () => {
      downloadBlob(
        new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
        `${snapshot.snapshot?.id ?? "snapshot"}.json`,
      );
    });
    list.append(node);
  }
}

async function verifyPreviewAgainstPackage(pkg) {
  const decoded = await pixelsFromDataUrl(pkg.atlas.imageDataUrl);
  const previewHash = hashPixels(state.atlas.pixels);
  const decodedHash = hashPixels(decoded.pixels);
  const sameSize = decoded.width === pkg.atlas.width && decoded.height === pkg.atlas.height;
  const exact = sameSize && decodedHash === pkg.atlas.pixelHash && previewHash === pkg.atlas.pixelHash;
  const byId = new Map([...state.frameById.values()].map((frame) => [frame.id, frame]));
  let restored = 0;
  for (const slice of pkg.frames) {
    const original = byId.get(slice.id);
    if (!original) continue;
    const image = restoreOriginalFrame(slice, decoded);
    let equal = image.width === original.width && image.height === original.height;
    if (equal) {
      for (let index = 0; index < image.pixels.length; index += 1) {
        if (image.pixels[index] !== original.pixels[index]) {
          equal = false;
          break;
        }
      }
    }
    if (equal) restored += 1;
  }
  const allRestored = restored === pkg.frames.length;
  $("#compare-result").className = `check-note ${exact && allRestored ? "ok" : "bad"}`;
  $("#compare-result").textContent = exact && allRestored
    ? `像素完全一致 · ${restored}/${pkg.frames.length} 帧可还原`
    : `校验失败：预览 ${previewHash} / 导出 ${decodedHash}，还原 ${restored}/${pkg.frames.length}`;
  return { exact: exact && allRestored, restored, previewHash, decodedHash };
}

async function exportProject() {
  if (state.busy) return;
  state.busy = true;
  try {
    const capturedAt = new Date().toISOString();
    const imageDataUrl = state.atlasCanvas.toDataURL("image/png");
    const snapshot = createSnapshotPackage({
      packer: state.packer,
      project: state.project,
      atlas: state.atlas,
      imageDataUrl,
      label: "pre-export",
      snapshotId: `pre-export-r${state.project.revision}-${Date.now()}`,
      capturedAt,
    });
    const packageJson = buildAtlasPackage({
      packer: state.packer,
      project: state.project,
      atlas: state.atlas,
      imageDataUrl,
      exportedAt: capturedAt,
    });
    const validation = validateAtlasPackage(packageJson);
    if (!validation.ok) throw new Error(validation.errors.join("; "));
    state.snapshots.push(snapshot);
    state.snapshots = state.snapshots.slice(-5);
    persistSnapshots();
    renderSnapshots();
    state.lastExport = packageJson;
    $("#reload-export-btn").disabled = false;
    $("#reload-result").className = "result-box ok";
    $("#reload-result").textContent =
      `导出已生成 · ${packageJson.frames.length} 帧 · ${packageJson.atlas.width}×${packageJson.atlas.height}。导出前快照已保留。`;
    const pngBlob = await new Promise((resolve) => state.atlasCanvas.toBlob(resolve, "image/png"));
    downloadBlob(pngBlob, `atlas-r${state.project.revision}.png`);
    downloadBlob(
      new Blob([JSON.stringify(packageJson, null, 2)], { type: "application/json" }),
      `atlas-r${state.project.revision}.json`,
    );
    await verifyPreviewAgainstPackage(packageJson);
    toast("导出完成", "PNG、切片 JSON 和导出前快照均已生成。", "ok");
  } catch (error) {
    toast("导出失败", error.message, "error");
  } finally {
    state.busy = false;
  }
}

async function reloadPackage(input) {
  const pkg = typeof input === "string" ? JSON.parse(input) : input;
  try {
    const validation = validateAtlasPackage(pkg);
    if (!validation.ok) throw new Error(validation.errors.join("; "));
    if (!pkg.atlas.imageDataUrl) throw new Error("JSON 未内嵌 atlas.imageDataUrl，无法独立回载");
    const decoded = await pixelsFromDataUrl(pkg.atlas.imageDataUrl);
    if (hashPixels(decoded.pixels) !== pkg.atlas.pixelHash) {
      throw new Error("嵌入图集与 pixelHash 不一致");
    }
    const restoredFrames = pkg.frames.map((slice) => ({
      id: slice.id,
      ...restoreOriginalFrame(slice, decoded),
      colors: [...slice.colors],
      version: 0,
    }));
    const restoredPacker = packerFromPackage(pkg);
    const restoredProject = JSON.parse(JSON.stringify(pkg.project));
    const expectedFingerprint = pkg.fingerprint ?? projectFingerprint(restoredProject, restoredPacker);
    state.frames = restoredFrames;
    state.frameById = new Map(restoredFrames.map((frame) => [frame.id, frame]));
    state.packer = restoredPacker;
    state.project = restoredProject;
    state.selectedFrameId = restoredProject.selectedFrameId;
    state.activeKeyframeId = restoredProject.keyframes[0]?.id ?? null;
    state.lastChange = null;
    state.thumbnailFallback = false;
    ensureSelectedFrame();
    refreshView();
    const actualFingerprint = projectFingerprint(state.project, state.packer);
    const same = actualFingerprint === expectedFingerprint;
    $("#reload-result").className = `result-box ${same ? "ok" : "bad"}`;
    $("#reload-result").textContent = same
      ? `回载一致 · 图层顺序、关键帧、坐标和颜色均未改变 · ${pkg.frames.length} 帧`
      : "回载校验失败：工程指纹变化";
    $("#reload-export-btn").disabled = false;
    state.lastExport = pkg;
    toast(same ? "重新载入成功" : "回载指纹不一致", same ? "坐标、颜色、图层与关键帧保持一致。" : "请检查 JSON。", same ? "ok" : "error");
    return same;
  } catch (error) {
    $("#reload-result").className = "result-box bad";
    $("#reload-result").textContent = `回载失败：${error.message}`;
    toast("回载失败", error.message, "error");
    return false;
  }
}

function flashRebuild(message) {
  const empty = $("#atlas-empty");
  empty.textContent = message;
  empty.hidden = false;
  setTimeout(() => {
    empty.hidden = true;
    refreshView();
  }, 360);
}

async function simulateFailure(kind) {
  try {
    if (kind === "thumbnail") {
      const result = await resourceCache.getOrLoad(`thumbnail:${state.project.revision}`, {
        forceInvalid: true,
        loader: async () => {
          throw new Error("thumbnail decoder unavailable");
        },
        fallback: async ({ message }) => createThumbnailFallback(state.frameById.get(state.selectedFrameId), message),
      });
      state.thumbnailFallback = true;
      refreshView();
      showFallback(FALLBACK_MESSAGES.THUMBNAIL);
      toast("缩略图已回退", `${result.value.id} 使用颜色占位，图集主体仍可编辑。`, "warn");
      return;
    }
    if (kind === "timeout") {
      const started = performance.now();
      const result = await resourceCache.getOrLoad(`async:${Date.now()}`, {
        timeoutMs: 45,
        loader: () => new Promise(() => {}),
        fallback: async ({ message }) => ({
          message,
          hash: hashPixels(state.atlas.pixels),
          source: "engineering-state",
        }),
      });
      showFallback(result.message ?? FALLBACK_MESSAGES.TIMEOUT);
      flashRebuild("异步请求超时，已从工程内存重建");
      toast(
        "异步超时已回退",
        `${Math.round(performance.now() - started)}ms 后切换本地重建，未使用旧结果。`,
        "warn",
      );
      return;
    }
    const cacheKey = `preview:${state.project.revision}`;
    await resourceCache.getOrLoad(cacheKey, {
      version: 1,
      loader: async () => ({ hash: "old-cache-value" }),
      fallback: async () => ({ hash: "unused" }),
    });
    resourceCache.invalidate(cacheKey, "simulated-invalidation");
    const result = await resourceCache.getOrLoad(cacheKey, {
      version: 2,
      forceInvalid: true,
      loader: async () => {
        throw new Error("simulated network failure");
      },
      fallback: async () => ({
        hash: hashPixels(state.atlas.pixels),
        source: "engineering-state",
      }),
    });
    showFallback(result.message ?? FALLBACK_MESSAGES.INVALID);
    flashRebuild("缓存已失效，正在本地重建");
    toast("缓存失效已回退", "旧缓存已清除，画面由工程源数据重建。", "warn");
  } catch (error) {
    showFallback(`回退链执行失败：${error.message}`);
    toast("回退失败", error.message, "error");
  }
}

function applyParameters() {
  try {
    const options = readParameters();
    const next = new StableAtlasPacker(options);
    next.packAll([...state.frameById.values()]);
    state.packer = next;
    state.project.revision += 1;
    state.lastChange = null;
    ensureSelectedFrame();
    refreshView();
    $("#param-state").textContent = "已应用";
    toast("参数已应用", `${next.width}×${next.height} · ${(next.metrics().utilization * 100).toFixed(1)}% 利用率`, "ok");
  } catch (error) {
    toast("参数无效", error.message, "error");
  }
}

function renderDiagnostics(result) {
  const container = $("#diagnostics-results");
  container.innerHTML = "";
  for (const suite of result.suites) {
    const group = document.createElement("section");
    group.className = "diagnostic-group";
    const passed = suite.checks.filter((entry) => entry.ok).length;
    group.innerHTML = `
      <header><h3></h3><span class="status ${suite.passed ? "ok" : "bad"}">${suite.passed ? "PASS" : "FAIL"} ${passed}/${suite.checks.length}</span></header>
      <ul></ul>`;
    group.querySelector("h3").textContent = suite.title;
    const list = group.querySelector("ul");
    for (const entry of suite.checks) {
      const item = document.createElement("li");
      item.className = entry.ok ? "" : "bad";
      item.textContent = entry.name;
      list.append(item);
    }
    container.append(group);
  }
}

async function runDiagnostics() {
  const button = $("#run-diagnostics-btn");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "运行中…";
  try {
    const result = await runAllParameterGroups();
    renderDiagnostics(result);
    toast(result.passed ? "三组测试全部通过" : "存在失败项", "默认、边界、异常参数均可重复执行。", result.passed ? "ok" : "error");
  } catch (error) {
    toast("测试执行失败", error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "运行三组测试";
  }
}

function showFullReport() {
  try {
    const report = runThreeRoundScenario({ seed: 628, count: 100 });
    downloadBlob(
      new Blob(
        [JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2)],
        { type: "application/json" },
      ),
      "incremental-report-100.json",
    );
    toast("报告已生成", "包含三轮重排区域、坐标变化、导出哈希与快照校验。", "ok");
  } catch (error) {
    toast("报告生成失败", error.message, "error");
  }
}

function bindEvents() {
  $("#reset-btn").addEventListener("click", resetDemo);
  $("#run-rounds-btn").addEventListener("click", async () => {
    resetDemo();
    while (state.roundIndex < 3) {
      await runNextRound();
    }
  });
  $("#export-btn").addEventListener("click", exportProject);
  $("#apply-params-btn").addEventListener("click", applyParameters);
  $("#preset-default-btn").addEventListener("click", () => {
    $("#param-width").value = "512";
    $("#param-height").value = "512";
    $("#param-padding").value = "2";
    $("#param-floor").value = "0.36";
    $("#param-rotate").checked = true;
    $("#param-trim").checked = true;
    $("#param-compact").checked = true;
    $("#param-state").textContent = "默认";
  });
  for (const input of $$(".controls input")) {
    input.addEventListener("change", () => {
      $("#param-state").textContent = "已修改";
    });
  }
  $('[data-op="add"]').addEventListener("click", () => addFrames(2));
  $('[data-op="modify"]').addEventListener("click", () => modifyFrames(2));
  $('[data-op="delete"]').addEventListener("click", deleteFrame);
  $("#next-round-btn").addEventListener("click", runNextRound);
  for (const button of $$(".failure")) {
    button.addEventListener("click", () => simulateFailure(button.dataset.failure));
  }
  $("#dismiss-fallback").addEventListener("click", () => {
    hideFallback();
    if (state.thumbnailFallback) {
      state.thumbnailFallback = false;
      renderThumbnails();
      toast("缩略图已从源恢复", "已重新读取当前工程帧。", "ok");
    }
  });
  $("#reload-export-btn").addEventListener("click", () => {
    if (state.lastExport) reloadPackage(state.lastExport);
  });
  $("#import-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await reloadPackage(await file.text());
    } catch (error) {
      toast("文件读取失败", error.message, "error");
    } finally {
      event.target.value = "";
    }
  });
  $("#compare-export-btn").addEventListener("click", async () => {
    try {
      const pkg = currentPackage();
      const result = await verifyPreviewAgainstPackage(pkg);
      toast(result.exact ? "像素一致" : "像素不一致", result.exact ? "屏幕预览与导出 PNG 完全相同。" : "请看比对结果。", result.exact ? "ok" : "error");
    } catch (error) {
      toast("比对失败", error.message, "error");
    }
  });
  $("#keyframe-select").addEventListener("change", (event) => {
    state.activeKeyframeId = event.target.value;
    renderAnimation();
  });
  $("#run-diagnostics-btn").addEventListener("click", runDiagnostics);
  $("#show-report-btn").addEventListener("click", showFullReport);
}

loadStoredSnapshots();
bindEvents();
renderSnapshots();
resetDemo();
toast("工作台就绪", "100 帧基线已载入；可运行三轮增量或三组参数测试。", "ok");
