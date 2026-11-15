import {
  SnapshotStore,
  STORAGE_KEYS,
  clone,
  createInitialState,
  sanitizeState
} from "./state.js";
import { CanvasRenderer } from "./renderer.js";

const byId = (id) => document.getElementById(id);
const elements = {
  viewport: byId("canvasViewport"),
  world: byId("world"),
  objectsLayer: byId("objectsLayer"),
  inkCanvas: byId("inkCanvas"),
  zoomReadout: byId("zoomReadout"),
  viewportReadout: byId("viewportReadout"),
  objectCount: byId("objectCount"),
  strokeCount: byId("strokeCount"),
  deleteButton: byId("deleteButton"),
  deleteCount: byId("deleteCount"),
  undoButton: byId("undoButton"),
  redoButton: byId("redoButton"),
  multiSelectButton: byId("multiSelectButton"),
  zoomInButton: byId("zoomInButton"),
  zoomOutButton: byId("zoomOutButton"),
  fitButton: byId("fitButton"),
  addNoteButton: byId("addNoteButton"),
  saveIndicator: byId("saveIndicator"),
  saveText: byId("saveText"),
  inputStatus: byId("inputStatus"),
  inputDetail: byId("inputDetail"),
  storageStatus: byId("storageStatus"),
  storageDetail: byId("storageDetail"),
  renderStatus: byId("renderStatus"),
  renderDetail: byId("renderDetail"),
  selectionList: byId("selectionList"),
  clearSelectionButton: byId("clearSelectionButton"),
  draftIndicator: byId("draftIndicator"),
  draftIndicatorTitle: byId("draftIndicatorTitle"),
  draftIndicatorBody: byId("draftIndicatorBody"),
  snapshotText: byId("snapshotText"),
  snapshotMeta: byId("snapshotMeta"),
  revisionBadge: byId("revisionBadge"),
  recoveryBanner: byId("recoveryBanner"),
  recoveryMessage: byId("recoveryMessage"),
  copySnapshotButton: byId("copySnapshotButton"),
  reloadSnapshotButton: byId("reloadSnapshotButton"),
  interactionStatus: byId("interactionStatus"),
  gestureBadge: byId("gestureBadge"),
  gestureIcon: byId("gestureIcon"),
  gestureText: byId("gestureText"),
  longPressRing: byId("longPressRing"),
  toastRegion: byId("toastRegion"),
  noteDialog: byId("noteDialog"),
  noteForm: byId("noteForm"),
  noteTitle: byId("noteTitle"),
  noteBody: byId("noteBody"),
  draftStatus: byId("draftStatus"),
  draftDot: byId("draftDot"),
  closeNoteButton: byId("closeNoteButton"),
  cancelNoteButton: byId("cancelNoteButton"),
  discardDraftButton: byId("discardDraftButton"),
  helpButton: byId("helpButton"),
  helpPopover: byId("helpPopover"),
  clockLabel: byId("clockLabel")
};

const store = new SnapshotStore();
const loaded = store.load();
const state = loaded.state;
const renderer = new CanvasRenderer(elements);

let activeTool = "select";
let undoStack = [];
let redoStack = [];
let recoveryInfo = loaded.recovery;
let saveTimer = null;
let scrollTimer = null;
let saveInFlight = false;
let lastSave = { at: null, bytes: 0 };
let lastStorageError = "";
let restoringScroll = true;
let draftStroke = null;
let dialogReturnFocus = null;
let lastInputModality = "系统";
let currentGesture = "待机";
let currentInputDetail = "等待交互";
let lastPointerType = "mouse";
let currentOrientation = "";

const interaction = {
  pointers: new Map(),
  mode: "idle",
  panStart: null,
  pinch: null,
  longPressTimer: null,
  longPressTarget: null,
  moved: false,
  drawingPointerId: null,
  gestureChangedViewport: false,
  touchGesture: null
};

const accepts = {
  pan: false,
  zoom: false,
  multiSelect: false,
  delete: false,
  rotate: false
};

function inputLabel(pointerType) {
  if (pointerType === "touch") return "触屏";
  if (pointerType === "pen") return "触控笔";
  return "鼠标";
}

function timeText(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function formatScale(scale) {
  return `${Math.round(scale * 100)}%`;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampViewport(viewport) {
  return {
    x: clampNumber(viewport.x, -2800, 3600),
    y: clampNumber(viewport.y, -2400, 3000),
    scale: clampNumber(viewport.scale, 0.2, 4)
  };
}

function announce(message) {
  elements.interactionStatus.textContent = "";
  window.setTimeout(() => {
    elements.interactionStatus.textContent = message;
  }, 20);
}

function toast(message, options = {}) {
  const node = document.createElement("div");
  node.className = `toast${options.error ? " is-error" : ""}`;
  node.textContent = message;
  elements.toastRegion.append(node);
  window.setTimeout(() => node.remove(), options.duration || 3800);
}

function setInputStatus(modality, gesture, detail) {
  lastInputModality = modality;
  currentGesture = gesture;
  currentInputDetail = detail;
  elements.inputStatus.textContent = `${modality} · ${gesture}`;
  elements.inputDetail.textContent = detail;
}

function setSaveVisual(mode, text) {
  elements.saveIndicator.classList.toggle("is-saving", mode === "saving");
  elements.saveIndicator.classList.toggle("has-error", mode === "error");
  elements.saveText.textContent = text;
}

function getSelectionObjects() {
  const selected = new Set(state.selectedIds);
  return state.objects.filter((object) => selected.has(object.id));
}

function renderSelection() {
  renderer.updateSelection(state.objects, state.selectedIds);
  elements.selectionList.replaceChildren();
  const objects = getSelectionObjects();
  if (!objects.length) {
    const empty = document.createElement("p");
    empty.className = "selection-empty";
    empty.textContent = "尚未选择对象";
    elements.selectionList.append(empty);
  } else {
    for (const object of objects) {
      const chip = document.createElement("span");
      chip.className = "selection-chip";
      const dot = document.createElement("i");
      dot.setAttribute("aria-hidden", "true");
      chip.append(dot, document.createTextNode(object.title));
      elements.selectionList.append(chip);
    }
  }
  const count = state.selectedIds.length;
  elements.deleteButton.disabled = count === 0;
  elements.clearSelectionButton.disabled = count === 0;
  elements.deleteCount.hidden = count === 0;
  elements.deleteCount.textContent = String(count);
  elements.deleteButton.setAttribute(
    "aria-label",
    count ? `删除 ${count} 个选中对象` : "删除选中对象，当前无选择"
  );
  elements.multiSelectButton.classList.toggle("is-active", state.multiSelect);
  elements.multiSelectButton.setAttribute("aria-pressed", String(state.multiSelect));
}

function updateHistoryButtons() {
  elements.undoButton.disabled = undoStack.length === 0;
  elements.redoButton.disabled = redoStack.length === 0;
  const undoLabel = undoStack.length
    ? `撤销${undoStack[undoStack.length - 1].label} (Ctrl+Z)`
    : "没有可撤销的操作";
  elements.undoButton.setAttribute("aria-label", undoLabel);
  elements.redoButton.setAttribute(
    "aria-label",
    redoStack.length ? `重做${redoStack[redoStack.length - 1].label} (Ctrl+Shift+Z)` : "没有可重做的操作"
  );
}

function updateSnapshot() {
  const selectionNames = getSelectionObjects().map((object) => object.title);
  const base = store.readableSnapshot(state, {
    input: {
      modality: lastInputModality,
      gesture: currentGesture,
      detail: currentInputDetail
    },
    storage: {
      source: loaded.source,
      revision: state.revision,
      lastSavedAt: lastSave.at,
      bytes: lastSave.bytes,
      error: lastStorageError || null
    }
  });
  const raw = recoveryInfo?.raw
    ? `\n\n--- 未能自动恢复的原始快照 ---\n${recoveryInfo.raw.slice(0, 12000)}`
    : "";
  elements.snapshotText.textContent = `${base}${raw}`;
  elements.snapshotMeta.textContent = lastSave.at
    ? `已写入 ${timeText(new Date(lastSave.at))} · ${lastSave.bytes} B`
    : "尚未写入 · 当前内存快照可读";
  elements.revisionBadge.textContent = `rev ${state.revision}`;
  elements.snapshotText.dataset.selection = JSON.stringify(selectionNames);
}

function updateInspector() {
  const selectedCount = state.selectedIds.length;
  const hasDraft = Boolean(state.draft.title || state.draft.body);
  elements.objectCount.textContent = String(state.objects.length);
  elements.strokeCount.textContent = String(state.strokes.length);
  elements.draftIndicator.hidden = !hasDraft;
  elements.draftIndicatorTitle.textContent = hasDraft
    ? state.draft.title || "未提交便签草稿已保留"
    : "";
  elements.draftIndicatorBody.textContent = hasDraft
    ? (state.draft.body ? state.draft.body.slice(0, 46) : "关闭弹窗或刷新后仍可继续")
    : "";
  elements.addNoteButton.setAttribute(
    "aria-label",
    hasDraft ? "继续未提交的便签草稿" : "新建便签"
  );
  elements.renderStatus.textContent = `${state.objects.length} 对象 · ${selectedCount} 选中`;
  elements.renderDetail.textContent =
    `${state.strokes.length} 笔迹 · 视口 ${formatScale(state.viewport.scale)} · 页面 y ${Math.round(state.scrollY)}`;
  renderSelection();
  updateSnapshot();
}

function renderScene(animateNewId = null) {
  renderer.rebuild(state.objects, state.selectedIds, animateNewId);
  renderer.drawInk(state.strokes, draftStroke);
  renderer.setViewport(state.viewport);
  updateInspector();
}

function renderTransformOnly() {
  renderer.setViewport(state.viewport);
  elements.renderDetail.textContent =
    `${state.strokes.length} 笔迹 · 视口 ${formatScale(state.viewport.scale)} · 页面 y ${Math.round(state.scrollY)}`;
}

function showRecovery(message, raw = recoveryInfo?.raw || "") {
  recoveryInfo = { message, raw };
  elements.recoveryBanner.hidden = false;
  elements.recoveryMessage.textContent = message;
  updateSnapshot();
}

function hideRecovery() {
  recoveryInfo = null;
  elements.recoveryBanner.hidden = true;
}

if (loaded.recovery) {
  showRecovery(loaded.recovery.message, loaded.recovery.raw);
}

function finishSave(result) {
  saveInFlight = false;
  if (result.ok) {
    lastSave = { at: result.at, bytes: result.bytes };
    lastStorageError = "";
    setSaveVisual("saved", `已保存 · ${timeText(new Date(result.at))}`);
    elements.storageStatus.textContent = recoveryInfo ? "已保存 · 备份恢复中" : "已保存到本地";
    elements.storageDetail.textContent =
      `rev ${state.revision} · ${result.bytes} B · 主快照 + 备份`;
  } else {
    const previousError = lastStorageError;
    lastStorageError = result.error;
    setSaveVisual("error", "本地保存失败");
    elements.storageStatus.textContent = "本地保存失败 · 内存快照保留";
    elements.storageDetail.textContent = result.error;
    if (!recoveryInfo?.message.includes("保存失败")) {
      showRecovery(
        "本地快照写入失败。当前画布没有被清空，下方仍保留可读快照，可先复制再继续。"
      );
    }
    if (previousError !== result.error) {
      toast("本地保存失败，当前状态与可读快照仍保留在页面中。", { error: true, duration: 5200 });
    }
  }
  updateSnapshot();
}

function saveNow() {
  window.clearTimeout(saveTimer);
  if (saveInFlight) return;
  saveInFlight = true;
  state.updatedAt = new Date().toISOString();
  const result = store.save(state);
  finishSave(result);
}

function scheduleSave(delay = 220) {
  if (restoringScroll) return;
  setSaveVisual("saving", "正在写入…");
  elements.storageStatus.textContent = "正在写入本地快照";
  elements.storageDetail.textContent = `rev ${state.revision} · 等待提交`;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, delay);
}

function markChanged({ save = true, delay = 220 } = {}) {
  state.revision += 1;
  state.updatedAt = new Date().toISOString();
  updateInspector();
  if (save) scheduleSave(delay);
}

function setViewport(nextViewport, { save = true, revise = true, delay = 240 } = {}) {
  state.viewport = clampViewport(nextViewport);
  renderer.setViewport(state.viewport);
  elements.renderDetail.textContent =
    `${state.strokes.length} 笔迹 · 视口 ${formatScale(state.viewport.scale)} · 页面 y ${Math.round(state.scrollY)}`;
  if (revise) {
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
  }
  updateSnapshot();
  if (save) scheduleSave(delay);
}

function zoomAt(factor, localPoint, options = {}) {
  const current = state.viewport;
  const nextScale = clampNumber(current.scale * factor, 0.2, 4);
  if (nextScale === current.scale) return;
  const world = {
    x: (localPoint.x - current.x) / current.scale,
    y: (localPoint.y - current.y) / current.scale
  };
  setViewport({
    x: localPoint.x - world.x * nextScale,
    y: localPoint.y - world.y * nextScale,
    scale: nextScale
  }, options);
}

function zoomFromCenter(factor) {
  const rect = elements.viewport.getBoundingClientRect();
  zoomAt(factor, { x: rect.width / 2, y: rect.height / 2 });
  accepts.zoom = true;
  announce(`画布缩放调整为 ${formatScale(state.viewport.scale)}`);
}

function fitToContent() {
  setViewport(renderer.fitViewport(state.objects));
  setInputStatus(lastInputModality, "回到内容", `视口适配 ${formatScale(state.viewport.scale)}`);
  announce(`已回到全部内容，缩放 ${formatScale(state.viewport.scale)}`);
}

function captureContent() {
  return {
    objects: clone(state.objects),
    strokes: clone(state.strokes),
    selectedIds: [...state.selectedIds],
    multiSelect: state.multiSelect,
    label: "操作"
  };
}

function pushHistory(label) {
  undoStack.push({ ...captureContent(), label });
  if (undoStack.length > 40) undoStack.shift();
  redoStack = [];
  updateHistoryButtons();
}

function restoreContent(entry) {
  const focusedObjectId = document.activeElement?.dataset?.objectId || null;
  const viewportHadFocus = document.activeElement === elements.viewport;
  state.objects = clone(entry.objects);
  state.strokes = clone(entry.strokes);
  state.selectedIds = entry.selectedIds.filter((id) =>
    state.objects.some((object) => object.id === id)
  );
  state.multiSelect = Boolean(entry.multiSelect);
  renderScene();
  if (focusedObjectId && state.objects.some((object) => object.id === focusedObjectId)) {
    renderer.focusObject(focusedObjectId);
  } else if (viewportHadFocus) {
    renderer.focusViewport();
  }
  markChanged();
}

function undo() {
  if (!undoStack.length) {
    toast("没有可撤销的操作。");
    return;
  }
  if (draftStroke) {
    draftStroke = null;
    renderer.drawInk(state.strokes);
  }
  const entry = undoStack.pop();
  redoStack.push({ ...captureContent(), label: entry.label });
  restoreContent(entry);
  updateHistoryButtons();
  setInputStatus(lastInputModality, "撤销", `已撤销${entry.label}，选择与滚动位置保留`);
  announce(`已撤销${entry.label}。选择对象和页面滚动位置保持不变。`);
  toast(`已撤销${entry.label}，选择与滚动位置已保留。`);
}

function redo() {
  if (!redoStack.length) {
    toast("没有可重做的操作。");
    return;
  }
  const entry = redoStack.pop();
  undoStack.push({ ...captureContent(), label: entry.label });
  restoreContent(entry);
  updateHistoryButtons();
  setInputStatus(lastInputModality, "重做", `已重做${entry.label}`);
  announce(`已重做${entry.label}`);
  toast(`已重做${entry.label}。`);
}

function selectObject(objectId, { toggle = false, focus = false, announceSelection = true } = {}) {
  const object = state.objects.find((item) => item.id === objectId);
  if (!object) return;
  if (toggle) state.multiSelect = true;
  let nextSelection;
  if (toggle || state.multiSelect) {
    const selected = new Set(state.selectedIds);
    if (selected.has(objectId)) selected.delete(objectId);
    else selected.add(objectId);
    nextSelection = [...selected];
  } else {
    nextSelection = [objectId];
  }
  state.selectedIds = nextSelection;
  if (toggle || state.multiSelect || state.selectedIds.length > 1) {
    accepts.multiSelect = true;
  }
  renderer.updateSelection(state.objects, state.selectedIds);
  markChanged({ delay: 160 });
  if (focus) renderer.focusObject(objectId);
  const count = state.selectedIds.length;
  const message = count
    ? `已选择 ${count} 个对象：${getSelectionObjects().map((item) => item.title).join("、")}`
    : "已取消全部对象选择";
  if (announceSelection) {
    announce(message);
    setInputStatus(lastInputModality, toggle || state.multiSelect ? "多选" : "选择", message);
  }
}

function setMultiSelect(enabled, message = "") {
  state.multiSelect = Boolean(enabled);
  elements.multiSelectButton.classList.toggle("is-active", state.multiSelect);
  elements.multiSelectButton.setAttribute("aria-pressed", String(state.multiSelect));
  markChanged({ delay: 160 });
  const text = message || (state.multiSelect ? "多选模式已开启，点按对象可增减选择" : "多选模式已关闭");
  setInputStatus(lastInputModality, state.multiSelect ? "多选" : "选择", text);
  announce(text);
}

function clearSelection(message = "选择已清除，对象位置保持不变") {
  state.selectedIds = [];
  state.multiSelect = false;
  renderer.updateSelection(state.objects, state.selectedIds);
  markChanged({ delay: 160 });
  setInputStatus(lastInputModality, "选择", message);
  announce(message);
}

function deleteSelected() {
  if (!state.selectedIds.length) {
    toast("请先选择要删除的对象。");
    return;
  }
  const selected = new Set(state.selectedIds);
  const objects = state.objects.filter((object) => selected.has(object.id));
  pushHistory(objects.length === 1 ? "删除对象" : "删除多个对象");
  state.objects = state.objects.filter((object) => !selected.has(object.id));
  state.selectedIds = [];
  state.multiSelect = false;
  renderScene();
  markChanged();
  accepts.delete = true;
  renderer.focusViewport();
  const message = `已删除 ${objects.length} 个对象，可撤销恢复`;
  setInputStatus(lastInputModality, "删除", message);
  announce(message);
  toast(message);
}

function restoreScrollPosition(value) {
  const target = Math.max(0, Number(value) || 0);
  requestAnimationFrame(async () => {
    window.scrollTo({ top: target, left: 0, behavior: "instant" });
    try {
      await document.fonts.ready;
    } catch {
      // Font loading should not block a scroll restore.
    }
    window.scrollTo({ top: target, left: 0, behavior: "instant" });
    window.setTimeout(() => {
      restoringScroll = false;
      state.scrollY = window.scrollY;
      updateSnapshot();
      saveNow();
    }, 50);
  });
}

window.addEventListener("scroll", () => {
  if (restoringScroll) return;
  state.scrollY = window.scrollY;
  setSaveVisual("saving", "记录滚动位置…");
  elements.storageStatus.textContent = "正在记录页面位置";
  elements.storageDetail.textContent = `页面 y ${Math.round(state.scrollY)} · rev ${state.revision}`;
  window.clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(() => {
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    updateSnapshot();
    scheduleSave(80);
  }, 120);
}, { passive: true });

window.addEventListener("pagehide", () => {
  state.scrollY = window.scrollY;
  preserveDraftStroke();
  store.save(state);
});

function showGesture(icon, text) {
  elements.gestureIcon.textContent = icon;
  elements.gestureText.textContent = text;
  elements.gestureBadge.classList.add("is-visible");
}

function hideGesture(delay = 460) {
  window.setTimeout(() => elements.gestureBadge.classList.remove("is-visible"), delay);
}

function targetObjectAt(clientX, clientY) {
  const target = document.elementFromPoint(clientX, clientY);
  const element = target?.closest?.(".canvas-object");
  return element?.dataset.objectId || null;
}

function clearLongPress() {
  window.clearTimeout(interaction.longPressTimer);
  interaction.longPressTimer = null;
  interaction.longPressTarget = null;
  elements.longPressRing.classList.remove("is-visible");
}

function placeLongPressRing(local) {
  elements.longPressRing.style.left = `${local.x}px`;
  elements.longPressRing.style.top = `${local.y}px`;
  elements.longPressRing.classList.remove("is-visible");
  void elements.longPressRing.offsetWidth;
  elements.longPressRing.classList.add("is-visible");
}

function startLongPress(pointer) {
  clearLongPress();
  if (!pointer.objectId) return;
  interaction.longPressTarget = pointer.objectId;
  placeLongPressRing(pointer.local);
  interaction.longPressTimer = window.setTimeout(() => {
    if (interaction.mode !== "touch-pending" || interaction.moved) return;
    const livePointer = interaction.pointers.get(pointer.id);
    if (!livePointer) return;
    interaction.mode = "longpress";
    state.multiSelect = true;
    state.selectedIds = [pointer.objectId];
    renderer.updateSelection(state.objects, state.selectedIds);
    markChanged({ delay: 120 });
    accepts.multiSelect = true;
    elements.longPressRing.classList.remove("is-visible");
    setInputStatus("触屏", "长按多选", "已进入多选；轻点其他对象可增减选择");
    announce("长按已进入多选模式。轻点其他对象可继续选择。");
    if (navigator.vibrate) navigator.vibrate(35);
  }, 520);
}

function abortDraftStroke() {
  if (!draftStroke) return;
  draftStroke = null;
  interaction.drawingPointerId = null;
  renderer.drawInk(state.strokes);
}

function preserveDraftStroke() {
  if (!draftStroke) return;
  if (draftStroke.points.length > 1) {
    state.strokes.push(draftStroke);
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
  }
  draftStroke = null;
  interaction.drawingPointerId = null;
}

function beginPinch() {
  clearLongPress();
  abortDraftStroke();
  const points = [...interaction.pointers.values()].slice(0, 2);
  if (points.length < 2) return;
  const rect = elements.viewport.getBoundingClientRect();
  const midpoint = {
    x: (points[0].clientX + points[1].clientX) / 2 - rect.left,
    y: (points[0].clientY + points[1].clientY) / 2 - rect.top
  };
  const distance = Math.hypot(
    points[0].clientX - points[1].clientX,
    points[0].clientY - points[1].clientY
  );
  interaction.mode = "pinch";
  interaction.touchGesture = "pinch";
  interaction.moved = true;
  interaction.gestureChangedViewport = true;
  interaction.pinch = {
    startDistance: Math.max(1, distance),
    startScale: state.viewport.scale,
    startViewport: { ...state.viewport },
    anchor: {
      x: (midpoint.x - state.viewport.x) / state.viewport.scale,
      y: (midpoint.y - state.viewport.y) / state.viewport.scale
    }
  };
  renderer.setPinching(true);
  renderer.setDragging(false);
  showGesture("↔", "双指缩放");
  setInputStatus("触屏", "双指缩放", `${formatScale(state.viewport.scale)} · 不创建笔迹`);
  announce("双指缩放开始，绘制已禁用，不会产生笔迹。");
}

function updatePinch() {
  const points = [...interaction.pointers.values()].slice(0, 2);
  if (points.length < 2 || !interaction.pinch) return;
  const rect = elements.viewport.getBoundingClientRect();
  const midpoint = {
    x: (points[0].clientX + points[1].clientX) / 2 - rect.left,
    y: (points[0].clientY + points[1].clientY) / 2 - rect.top
  };
  const distance = Math.hypot(
    points[0].clientX - points[1].clientX,
    points[0].clientY - points[1].clientY
  );
  const scale = clampNumber(
    interaction.pinch.startScale * (distance / interaction.pinch.startDistance),
    0.2,
    4
  );
  const next = {
    x: midpoint.x - interaction.pinch.anchor.x * scale,
    y: midpoint.y - interaction.pinch.anchor.y * scale,
    scale
  };
  setViewport(next, { save: false, revise: false });
  elements.zoomReadout.value = formatScale(scale);
  elements.zoomReadout.textContent = formatScale(scale);
  setInputStatus("触屏", "双指缩放", `${formatScale(scale)} · 对象世界坐标未改变`);
}

function finishViewportGesture(gesture, modality = "触屏") {
  if (!interaction.gestureChangedViewport) return;
  interaction.gestureChangedViewport = false;
  accepts.pan = accepts.pan || gesture === "平移";
  accepts.zoom = accepts.zoom || gesture === "缩放";
  markChanged({ delay: 100 });
  setInputStatus(modality, `${gesture}结束`, `视口 ${Math.round(state.viewport.x)}，${Math.round(state.viewport.y)} · ${formatScale(state.viewport.scale)}`);
  announce(`${gesture}结束。选中对象位置未变化。`);
}

function beginDrawing(event) {
  const world = renderer.clientToWorld(event.clientX, event.clientY);
  draftStroke = {
    id: `stroke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    color: "#20231f",
    width: 3.6,
    points: [{ x: world.x, y: world.y }]
  };
  interaction.mode = "drawing";
  interaction.drawingPointerId = event.pointerId;
  interaction.moved = true;
  renderer.drawInk(state.strokes, draftStroke);
  setInputStatus(inputLabel(event.pointerType), "绘制", "鼠标或触控笔正在书写；第二触点会取消笔迹");
  showGesture("✎", "绘制");
}

function updateDrawing(event) {
  if (!draftStroke || interaction.drawingPointerId !== event.pointerId) return;
  const world = renderer.clientToWorld(event.clientX, event.clientY);
  const last = draftStroke.points[draftStroke.points.length - 1];
  if (Math.hypot(world.x - last.x, world.y - last.y) < 1.1) return;
  draftStroke.points.push(world);
  renderer.drawInk(state.strokes, draftStroke);
}

function finishDrawing() {
  if (!draftStroke) return;
  if (draftStroke.points.length < 2) {
    abortDraftStroke();
    interaction.mode = "idle";
    return;
  }
  pushHistory("添加笔迹");
  state.strokes.push(draftStroke);
  draftStroke = null;
  interaction.drawingPointerId = null;
  renderer.drawInk(state.strokes);
  markChanged({ delay: 120 });
  setInputStatus(inputLabel(lastPointerType), "笔迹完成", `笔迹总数 ${state.strokes.length}`);
  announce(`笔迹已提交，当前共 ${state.strokes.length} 条笔迹。`);
}

function onPointerDown(event) {
  if (event.button !== undefined && event.button !== 0 && event.pointerType !== "touch") return;
  lastPointerType = event.pointerType || "mouse";
  const local = renderer.clientToLocal(event.clientX, event.clientY);
  if (local.x < 0 || local.y < 0 ||
      local.x > elements.viewport.clientWidth || local.y > elements.viewport.clientHeight) {
    return;
  }

  const objectId = targetObjectAt(event.clientX, event.clientY);
  const pointer = {
    id: event.pointerId,
    pointerType: lastPointerType,
    clientX: event.clientX,
    clientY: event.clientY,
    local,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startLocal: local,
    startTime: performance.now(),
    objectId
  };
  interaction.pointers.set(event.pointerId, pointer);
  try {
    elements.viewport.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture can fail for synthetic events; move handlers still work.
  }

  if (lastPointerType === "touch") {
    event.preventDefault();
    setInputStatus("触屏", interaction.pointers.size > 1 ? "双指缩放" : "单指待机",
      interaction.pointers.size > 1
        ? "手势优先于绘制与页面滚动"
        : objectId ? "长按进入多选，轻点选择" : "移动以平移画布");
    if (interaction.pointers.size === 1) {
      interaction.mode = "touch-pending";
      interaction.touchGesture = null;
      interaction.moved = false;
      interaction.gestureChangedViewport = false;
      interaction.panStart = null;
      startLongPress(pointer);
    } else {
      beginPinch();
    }
    return;
  }

  if (activeTool === "pen" && (lastPointerType === "mouse" || lastPointerType === "pen")) {
    event.preventDefault();
    beginDrawing(event);
    return;
  }

  if (objectId) {
    interaction.mode = "object";
    interaction.moved = false;
    selectObject(objectId, { toggle: event.shiftKey }, { focus: false });
    showGesture("◎", "对象选择");
    hideGesture(260);
    return;
  }

  interaction.mode = "pan";
  interaction.moved = false;
  interaction.gestureChangedViewport = false;
  interaction.panStart = {
    clientX: event.clientX,
    clientY: event.clientY,
    local,
    viewport: { ...state.viewport }
  };
  renderer.setDragging(false);
  setInputStatus(inputLabel(lastPointerType), "准备平移", "拖动空白处移动画布");
  window.clearTimeout(interaction.longPressTimer);
}

function onPointerMove(event) {
  const pointer = interaction.pointers.get(event.pointerId);
  if (!pointer) return;
  pointer.clientX = event.clientX;
  pointer.clientY = event.clientY;
  pointer.local = renderer.clientToLocal(event.clientX, event.clientY);

  if (interaction.mode === "pinch") {
    event.preventDefault();
    updatePinch();
    return;
  }

  if (pointer.pointerType === "touch") {
    const travel = Math.hypot(
      pointer.clientX - pointer.startClientX,
      pointer.clientY - pointer.startClientY
    );
    if (travel > 8 && (interaction.mode === "touch-pending" || interaction.mode === "pan")) {
      if (interaction.mode === "touch-pending") {
        clearLongPress();
        interaction.mode = "pan";
        interaction.touchGesture = "pan";
        interaction.panStart = {
          local: { ...pointer.local },
          viewport: { ...state.viewport }
        };
        renderer.setDragging(true);
        showGesture("↔", "单指平移");
      }
      interaction.moved = true;
      interaction.gestureChangedViewport = true;
      const dx = pointer.local.x - interaction.panStart.local.x;
      const dy = pointer.local.y - interaction.panStart.local.y;
      setViewport({
        x: interaction.panStart.viewport.x + dx,
        y: interaction.panStart.viewport.y + dy,
        scale: interaction.panStart.viewport.scale
      }, { save: false, revise: false });
      setInputStatus("触屏", "单指平移", `x ${Math.round(state.viewport.x)} · y ${Math.round(state.viewport.y)}`);
    }
    return;
  }

  if (interaction.mode === "drawing") {
    event.preventDefault();
    updateDrawing(event);
    return;
  }

  if (interaction.mode === "pan" && interaction.panStart) {
    const travel = Math.hypot(
      pointer.clientX - interaction.panStart.clientX,
      pointer.clientY - interaction.panStart.clientY
    );
    if (travel > 3) {
      interaction.moved = true;
      interaction.gestureChangedViewport = true;
      renderer.setDragging(true);
      showGesture("↔", "平移");
      const dx = pointer.local.x - interaction.panStart.local.x;
      const dy = pointer.local.y - interaction.panStart.local.y;
      setViewport({
        x: interaction.panStart.viewport.x + dx,
        y: interaction.panStart.viewport.y + dy,
        scale: interaction.panStart.viewport.scale
      }, { save: false, revise: false });
      setInputStatus(inputLabel(pointer.pointerType), "平移", `x ${Math.round(state.viewport.x)} · y ${Math.round(state.viewport.y)}`);
    }
  }
}

function finishTouchPointer(event) {
  const hadPinch = interaction.mode === "pinch";
  const tappedObject = interaction.longPressTarget;
  interaction.pointers.delete(event.pointerId);
  if (hadPinch) {
    if (interaction.pointers.size >= 1) {
      const remaining = [...interaction.pointers.values()][0];
      interaction.pinch = null;
      interaction.mode = "pan";
      interaction.panStart = {
        local: { ...remaining.local },
        viewport: { ...state.viewport }
      };
      renderer.setPinching(false);
      renderer.setDragging(true);
      setInputStatus("触屏", "单指继续平移", "缩放已锁定，剩余手指继续拖动");
      return;
    }
    interaction.pinch = null;
    renderer.setPinching(false);
    renderer.setDragging(false);
    interaction.mode = "idle";
    finishViewportGesture(interaction.touchGesture === "pinch" ? "缩放" : "平移");
    interaction.touchGesture = null;
    hideGesture();
    return;
  }

  clearLongPress();
  if (interaction.mode === "longpress") {
    interaction.mode = "idle";
    hideGesture();
    return;
  }

  if (!interaction.moved) {
    if (tappedObject) {
      selectObject(tappedObject, { toggle: state.multiSelect });
    } else if (!state.multiSelect) {
      clearSelection("点按空白处已清除选择");
    }
  }

  const wasPan = interaction.mode === "pan";
  interaction.mode = "idle";
  if (wasPan) finishViewportGesture(interaction.touchGesture === "pinch" ? "缩放" : "平移");
  interaction.touchGesture = null;
  renderer.setDragging(false);
  hideGesture();
}

function onPointerUp(event) {
  const pointer = interaction.pointers.get(event.pointerId);
  if (!pointer) return;
  if (pointer.pointerType === "touch") {
    event.preventDefault();
    finishTouchPointer(event);
    return;
  }

  if (interaction.mode === "drawing") {
    event.preventDefault();
    interaction.pointers.delete(event.pointerId);
    finishDrawing();
    interaction.mode = "idle";
    hideGesture(220);
    return;
  }

  interaction.pointers.delete(event.pointerId);
  if (interaction.mode === "pan") {
    interaction.mode = "idle";
    renderer.setDragging(false);
    finishViewportGesture("平移", inputLabel(pointer.pointerType));
    hideGesture();
    if (!interaction.moved && !event.shiftKey && !state.multiSelect) {
      clearSelection("点按空白处已清除选择");
    }
    return;
  }
  interaction.mode = "idle";
  hideGesture(220);
}

function onPointerCancel(event) {
  const pointer = interaction.pointers.get(event.pointerId);
  if (!pointer) return;
  clearLongPress();
  interaction.pointers.delete(event.pointerId);
  if (interaction.mode === "drawing") abortDraftStroke();
  if (interaction.mode === "pinch") {
    interaction.pinch = null;
    renderer.setPinching(false);
    finishViewportGesture("缩放");
  } else if (interaction.mode === "pan") {
    finishViewportGesture("平移");
  }
  interaction.mode = "idle";
  renderer.setDragging(false);
  hideGesture();
  announce("手势已取消，画布状态保持可恢复。");
}

let wheelCommitTimer = null;
function onCanvasWheel(event) {
  event.preventDefault();
  const local = renderer.clientToLocal(event.clientX, event.clientY);
  const zoomGesture = event.ctrlKey || event.metaKey;
  if (zoomGesture) {
    const factor = Math.exp(-event.deltaY * 0.0022);
    zoomAt(factor, local, { save: false, revise: false });
    showGesture("↔", "触控板缩放");
    setInputStatus("触控板 / 鼠标", "缩放", `${formatScale(state.viewport.scale)} · 页面滚动已锁定`);
    accepts.zoom = true;
  } else {
    let deltaX = event.deltaX;
    let deltaY = event.deltaY;
    if (event.shiftKey && Math.abs(deltaX) < 0.01) {
      deltaX = deltaY;
      deltaY = 0;
    }
    setViewport({
      x: state.viewport.x - deltaX,
      y: state.viewport.y - deltaY,
      scale: state.viewport.scale
    }, { save: false, revise: false });
    showGesture("↔", "触控板平移");
    setInputStatus("触控板 / 鼠标", "平移", "页面滚动已锁定；指针移出画布后可滚动页面");
    accepts.pan = true;
  }
  window.clearTimeout(wheelCommitTimer);
  wheelCommitTimer = window.setTimeout(() => {
    markChanged({ delay: 100 });
    hideGesture();
  }, 90);
}

elements.viewport.addEventListener("pointerdown", onPointerDown);
elements.viewport.addEventListener("pointermove", onPointerMove);
elements.viewport.addEventListener("pointerup", onPointerUp);
elements.viewport.addEventListener("pointercancel", onPointerCancel);
elements.viewport.addEventListener("wheel", onCanvasWheel, { passive: false });
elements.viewport.addEventListener("contextmenu", (event) => event.preventDefault());
elements.viewport.addEventListener("touchmove", (event) => event.preventDefault(), { passive: false });
elements.viewport.addEventListener("dragstart", (event) => event.preventDefault());

function setTool(tool) {
  activeTool = tool === "pen" ? "pen" : "select";
  renderer.setTool(activeTool);
  for (const button of document.querySelectorAll("[data-tool]")) {
    const active = button.dataset.tool === activeTool;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  const message = activeTool === "pen"
    ? "画笔工具已启用；鼠标或触控笔可绘制，触屏仍保留平移与缩放手势"
    : "选择工具已启用；拖动空白处平移，点按对象选择";
  setInputStatus(lastInputModality, activeTool === "pen" ? "画笔" : "选择", message);
  announce(message);
}

for (const button of document.querySelectorAll("[data-tool]")) {
  button.addEventListener("click", () => setTool(button.dataset.tool));
}

elements.multiSelectButton.addEventListener("click", () => {
  setMultiSelect(!state.multiSelect);
});

elements.undoButton.addEventListener("click", () => {
  setInputStatus("键盘 / 鼠标", "撤销", "正在恢复上一内容快照");
  undo();
});

elements.redoButton.addEventListener("click", () => {
  setInputStatus("键盘 / 鼠标", "重做", "正在恢复下一内容快照");
  redo();
});

elements.zoomInButton.addEventListener("click", () => zoomFromCenter(1.22));
elements.zoomOutButton.addEventListener("click", () => zoomFromCenter(1 / 1.22));
elements.fitButton.addEventListener("click", fitToContent);
elements.deleteButton.addEventListener("click", deleteSelected);
elements.clearSelectionButton.addEventListener("click", () => clearSelection());

elements.objectsLayer.addEventListener("keydown", (event) => {
  const option = event.target.closest(".canvas-object");
  if (!option) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectObject(option.dataset.objectId, { toggle: event.shiftKey }, { focus: true });
    return;
  }
  if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const options = [...elements.objectsLayer.querySelectorAll(".canvas-object")];
    const current = options.indexOf(option);
    let nextIndex = current;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = Math.min(options.length - 1, current + 1);
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = Math.max(0, current - 1);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = options.length - 1;
    options[nextIndex]?.focus({ preventScroll: true });
    setInputStatus("键盘", "浏览对象", `焦点：${options[nextIndex]?.getAttribute("aria-label") || ""}`);
  }
});

function isFormField(target) {
  return target instanceof HTMLElement && (
    target.matches("input, textarea, select") ||
    target.isContentEditable
  );
}

document.addEventListener("keydown", (event) => {
  if (elements.noteDialog.open && event.key !== "Escape") return;
  const modifier = event.ctrlKey || event.metaKey;
  const key = event.key;

  if (modifier && key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (modifier && key.toLowerCase() === "s") {
    event.preventDefault();
    saveNow();
    toast("当前快照已手动写入本地。");
    return;
  }
  if (isFormField(event.target)) return;

  if ((key === "Delete" || key === "Backspace") && state.selectedIds.length) {
    event.preventDefault();
    deleteSelected();
    return;
  }
  if (key === "Escape") {
    if (!elements.helpPopover.hidden) {
      elements.helpPopover.hidden = true;
      elements.helpButton.setAttribute("aria-expanded", "false");
      elements.helpButton.focus({ preventScroll: true });
    } else if (state.selectedIds.length) {
      clearSelection("按 Escape 已清除选择");
    }
    return;
  }
  if (modifier || event.altKey) return;

  if (key.toLowerCase() === "v") {
    setTool("select");
  } else if (key.toLowerCase() === "p") {
    setTool("pen");
  } else if (key.toLowerCase() === "m") {
    setMultiSelect(!state.multiSelect);
  } else if (key.toLowerCase() === "f") {
    fitToContent();
  } else if (event.target === elements.viewport && key.startsWith("Arrow")) {
    event.preventDefault();
    const step = event.shiftKey ? 72 : 26;
    const delta = {
      ArrowLeft: { x: step, y: 0 },
      ArrowRight: { x: -step, y: 0 },
      ArrowUp: { x: 0, y: step },
      ArrowDown: { x: 0, y: -step }
    }[key];
    setViewport({
      x: state.viewport.x + delta.x,
      y: state.viewport.y + delta.y,
      scale: state.viewport.scale
    });
    accepts.pan = true;
    setInputStatus("键盘", "方向键平移", `x ${Math.round(state.viewport.x)} · y ${Math.round(state.viewport.y)}`);
    announce(`画布已平移。视口 x ${Math.round(state.viewport.x)}，y ${Math.round(state.viewport.y)}。`);
  } else if (event.target === elements.viewport && (key === "+" || key === "=")) {
    event.preventDefault();
    zoomFromCenter(1.22);
  } else if (event.target === elements.viewport && (key === "-" || key === "_")) {
    event.preventDefault();
    zoomFromCenter(1 / 1.22);
  } else if (event.target === elements.viewport && key === "0") {
    event.preventDefault();
    setViewport({ x: 38, y: 42, scale: 1 });
    accepts.zoom = true;
    setInputStatus("键盘", "重置缩放", "视口回到 100%");
  }
});

function openNoteDialog() {
  dialogReturnFocus = document.activeElement;
  elements.noteTitle.value = state.draft.title;
  elements.noteBody.value = state.draft.body;
  elements.noteTitle.removeAttribute("aria-invalid");
  elements.draftStatus.textContent = state.draft.title || state.draft.body
    ? "草稿已从上次会话恢复"
    : "草稿会随会话保留";
  elements.noteDialog.showModal();
  setInputStatus("键盘 / 鼠标", "编辑便签", "关闭弹窗不会丢弃草稿");
  requestAnimationFrame(() => elements.noteTitle.focus());
}

function closeNoteDialog(reason = "draft") {
  if (!elements.noteDialog.open) return;
  elements.noteDialog.close();
  if (reason === "discarded") {
    toast("便签草稿已丢弃。");
  } else {
    toast("弹窗已关闭，未提交内容、选择与滚动位置均已保留。");
  }
}

function syncDraftFromForm() {
  state.draft = {
    title: elements.noteTitle.value.slice(0, 80),
    body: elements.noteBody.value.slice(0, 500)
  };
  elements.noteTitle.removeAttribute("aria-invalid");
  elements.draftStatus.textContent = "草稿已自动保留，关闭后仍可继续";
  elements.draftDot.style.background = "#65a53a";
  markChanged({ delay: 100 });
}

elements.addNoteButton.addEventListener("click", openNoteDialog);
elements.closeNoteButton.addEventListener("click", () => closeNoteDialog());
elements.cancelNoteButton.addEventListener("click", () => closeNoteDialog());
elements.noteTitle.addEventListener("input", syncDraftFromForm);
elements.noteBody.addEventListener("input", syncDraftFromForm);

elements.discardDraftButton.addEventListener("click", () => {
  state.draft = { title: "", body: "" };
  elements.noteTitle.value = "";
  elements.noteBody.value = "";
  markChanged({ delay: 80 });
  closeNoteDialog("discarded");
});

elements.noteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = elements.noteTitle.value.trim();
  const body = elements.noteBody.value.trim();
  if (!title) {
    elements.noteTitle.setAttribute("aria-invalid", "true");
    elements.draftStatus.textContent = "失败：请先填写标题，再放到画布上";
    elements.draftDot.style.background = "#a73525";
    elements.noteTitle.focus();
    toast("无法提交便签：标题为空。草稿已保留。", { error: true });
    announce("便签提交失败，请填写标题。草稿没有丢失。");
    return;
  }
  const center = renderer.viewportCenterWorld();
  const jitter = (state.objects.length % 4) * 8;
  const object = {
    id: `note-${Date.now().toString(36)}`,
    type: "note-warm",
    x: Math.round(center.x - 105 + jitter),
    y: Math.round(center.y - 76 + jitter),
    width: 210,
    height: 152,
    kicker: "NEW NOTE",
    title,
    body: body || "一张新的便签。",
    footer: `刚刚 · ${timeText()}`
  };
  pushHistory("创建便签");
  state.objects.push(object);
  state.selectedIds = [object.id];
  state.multiSelect = false;
  state.draft = { title: "", body: "" };
  renderScene(object.id);
  markChanged({ delay: 80 });
  accepts.multiSelect = false;
  elements.noteDialog.close();
  window.setTimeout(() => renderer.focusObject(object.id), 40);
  setInputStatus("键盘 / 鼠标", "便签已提交", `已创建「${title}」并选中`);
  announce(`便签「${title}」已放到画布上并选中。`);
  toast("便签已提交并选中；按 Delete 可删除，撤销可恢复。");
});

elements.noteDialog.addEventListener("close", () => {
  state.scrollY = window.scrollY;
  elements.noteTitle.removeAttribute("aria-invalid");
  markChanged({ delay: 80 });
  if (dialogReturnFocus && document.contains(dialogReturnFocus)) {
    window.setTimeout(() => {
      if (!elements.noteDialog.open) dialogReturnFocus.focus({ preventScroll: true });
    }, 20);
  }
});

elements.helpButton.addEventListener("click", () => {
  const willOpen = elements.helpPopover.hidden;
  elements.helpPopover.hidden = !willOpen;
  elements.helpButton.setAttribute("aria-expanded", String(willOpen));
  if (willOpen) setInputStatus("系统", "帮助", "手势与键盘说明已展开");
});

async function copySnapshot() {
  const text = elements.snapshotText.textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast("可读快照已复制到剪贴板。");
  } catch {
    const range = document.createRange();
    range.selectNodeContents(elements.snapshotText);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toast("无法访问剪贴板；快照文本已选中，可按 Ctrl+C 复制。", { error: true });
  }
}

elements.copySnapshotButton.addEventListener("click", copySnapshot);

elements.reloadSnapshotButton.addEventListener("click", () => {
  const result = store.load();
  if (result.source === "fallback") {
    showRecovery(
      `手动恢复失败：${result.recovery?.message || "磁盘快照不可读"}`,
      result.recovery?.raw || ""
    );
    toast("磁盘快照未能完整恢复，当前状态与可读快照均已保留。", { error: true, duration: 5200 });
    return;
  }
  Object.assign(state, sanitizeState(result.state));
  renderScene();
  updateHistoryButtons();
  if (result.recovery) {
    showRecovery(result.recovery.message, result.recovery.raw);
  } else {
    hideRecovery();
  }
  markChanged({ delay: 60 });
  restoreScrollPosition(state.scrollY);
  toast(result.recovery ? "主快照损坏，已从备份快照恢复画布。" : "已从本地快照恢复画布。");
});

let viewportRect = elements.viewport.getBoundingClientRect();
let orientation = window.innerWidth > window.innerHeight ? "landscape" : "portrait";
let rotateTimer = null;

function handleViewportResize() {
  const nextRect = elements.viewport.getBoundingClientRect();
  if (Math.abs(nextRect.width - viewportRect.width) < 1 &&
      Math.abs(nextRect.height - viewportRect.height) < 1) {
    viewportRect = nextRect;
    return;
  }
  const previousViewport = { ...state.viewport };
  const centerWorld = {
    x: (viewportRect.width / 2 - previousViewport.x) / previousViewport.scale,
    y: (viewportRect.height / 2 - previousViewport.y) / previousViewport.scale
  };
  viewportRect = nextRect;
  state.viewport = clampViewport({
    x: nextRect.width / 2 - centerWorld.x * previousViewport.scale,
    y: nextRect.height / 2 - centerWorld.y * previousViewport.scale,
    scale: previousViewport.scale
  });
  renderer.setViewport(state.viewport);
  const nextOrientation = window.innerWidth > window.innerHeight ? "landscape" : "portrait";
  if (nextOrientation !== orientation) {
    orientation = nextOrientation;
    accepts.rotate = true;
    document.body.classList.add("is-rotating");
    window.clearTimeout(rotateTimer);
    rotateTimer = window.setTimeout(() => document.body.classList.remove("is-rotating"), 350);
    const label = orientation === "portrait" ? "竖屏" : "横屏";
    setInputStatus("系统", `旋转 · ${label}`, "保留视口中心的世界坐标，对象未发生跳位");
    announce(`设备已旋转为${label}，世界坐标中心保持不变。`);
  }
  markChanged({ delay: 140 });
  updateInspector();
}

const resizeObserver = new ResizeObserver(handleViewportResize);
resizeObserver.observe(elements.viewport);

window.addEventListener("orientationchange", () => {
  window.setTimeout(handleViewportResize, 120);
});

function updateClock() {
  elements.clockLabel.textContent = timeText();
}

function initialize() {
  renderer.setTool(activeTool);
  if (loaded.source === "new") {
    state.viewport = renderer.fitViewport(state.objects);
  } else {
    lastSave = {
      at: state.updatedAt,
      bytes: JSON.stringify(state).length
    };
  }
  renderScene();
  updateHistoryButtons();
  viewportRect = elements.viewport.getBoundingClientRect();
  orientation = window.innerWidth > window.innerHeight ? "landscape" : "portrait";
  lastInputModality = "系统";
  currentGesture = loaded.source === "new" ? "新会话" : "已恢复会话";
  currentInputDetail = "等待输入 · 鼠标、触控板、触屏与键盘共用同一状态";
  elements.inputStatus.textContent = `${lastInputModality} · ${currentGesture}`;
  elements.inputDetail.textContent = currentInputDetail;
  setSaveVisual("saved", loaded.recovery ? "已从备份恢复" : "本地快照就绪");
  elements.storageStatus.textContent = loaded.recovery ? "已从备份快照恢复" : "已保存到本地";
  elements.storageDetail.textContent =
    `rev ${state.revision} · ${lastSave.bytes || 0} B · 主快照 + 备份`;
  elements.multiSelectButton.setAttribute("aria-pressed", String(state.multiSelect));
  elements.multiSelectButton.classList.toggle("is-active", state.multiSelect);
  updateClock();
  window.setInterval(updateClock, 30000);
  restoreScrollPosition(state.scrollY);
  window.setTimeout(() => {
    if (!elements.noteDialog.open && !state.draft.title && !state.draft.body) {
      announce("画布已就绪。可选择对象、平移或缩放，所有变化会同步到可读状态快照。");
    }
  }, 600);
}

window.addEventListener("resize", () => {
  window.clearTimeout(rotateTimer);
  rotateTimer = window.setTimeout(handleViewportResize, 160);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    state.scrollY = window.scrollY;
    preserveDraftStroke();
    store.save(state);
  }
});

initialize();

window.canvasApp = {
  ready: true,
  snapshot: () => clone(state),
  metrics: () => ({
    viewport: { ...state.viewport },
    selectedIds: [...state.selectedIds],
    objectCount: state.objects.length,
    strokeCount: state.strokes.length,
    scrollY: window.scrollY,
    orientation,
    acceptance: { ...accepts },
    storageKeys: { ...STORAGE_KEYS },
    lastSave,
    input: { modality: lastInputModality, gesture: currentGesture, detail: currentInputDetail },
    canvasRect: elements.viewport.getBoundingClientRect().toJSON()
  }),
  screenToWorld: (clientX, clientY) => renderer.clientToWorld(clientX, clientY),
  worldToScreen: (x, y) => renderer.worldToClient(x, y),
  screenToLocal: (clientX, clientY) => renderer.clientToLocal(clientX, clientY),
  objectElement: (id) => renderer.objectMap.get(id) || null,
  readableSnapshot: () => elements.snapshotText.textContent,
  saveNow
};

window.dispatchEvent(new CustomEvent("canvas-ready"));
