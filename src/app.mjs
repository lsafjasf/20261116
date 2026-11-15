import {
  STORAGE_KEY, createInitialDoc, createInitialUi, clone, uid,
  History, Storage,
} from './state.mjs';
import {
  isEditable, installFocusTrap, freezeBackground, createFocusReturn,
} from './focus.mjs';
import { renderCanvas, renderSidebar, renderStatus, announce, showToast } from './render.mjs';

// ---------- 启动与恢复 ----------

const storage = new Storage(globalThis.localStorage);
let doc;
let ui;
let history;
let renderTick = 0;
let recoveryBanner = null;
let storageReady = false;
let storageBlocked = false;
let restoredFromStorage = false;

function boot() {
  const loaded = storage.load();
  if (loaded.ok && loaded.payload) {
    doc = loaded.payload.doc;
    ui = { ...createInitialUi(), ...loaded.payload.ui };
    reconcileSelection();
    history = new History(doc, (next) => { doc = next; });
    restoredFromStorage = true;
    showToast('已从本地存储恢复上次会话', 'ok');
  } else if (loaded.ok) {
    doc = createInitialDoc();
    ui = createInitialUi();
    history = new History(doc, (next) => { doc = next; });
  } else {
    // 主快照损坏：保留可读快照 + 尝试 last-good
    const lastGood = storage.loadLastGood();
    doc = lastGood ? lastGood.doc : createInitialDoc();
    ui = lastGood?.ui ? { ...createInitialUi(), ...lastGood.ui } : createInitialUi();
    reconcileSelection();
    history = new History(doc, (next) => { doc = next; });
    showRecoveryBanner(loaded.error, loaded.raw, !!lastGood);
  }
}

function reconcileSelection() {
  if (!doc.shapes.some((s) => s.id === ui.selectedShapeId)) {
    ui.selectedShapeId = doc.shapes[0]?.id ?? null;
  }
  if (!doc.timeline.some((k) => k.id === ui.selectedKeyId)) {
    ui.selectedKeyId = doc.timeline[0]?.id ?? null;
  }
}

function showRecoveryBanner(error, raw, hasLastGood) {
  storage.lastError = `恢复失败：${error}`;
  storageBlocked = true; // 损坏未处理前禁止任何自动写入
  const banner = document.createElement('section');
  banner.className = 'recovery-banner';
  banner.setAttribute('role', 'alert');
  banner.innerHTML = `
    <strong class="danger">⚠ 存储快照损坏，已保留可读快照</strong>
    <p class="hint">主快照无法解析（${error}）。下方保留损坏原文；${
      hasLastGood ? '已自动回退到最近一次完好快照（last-good）。' : '无 last-good，已载入内置初始文档。'
    }</p>
    <pre id="corrupt-raw"></pre>
    <div class="row">
      <button type="button" id="btn-download-corrupt">下载损坏快照</button>
      <button type="button" id="btn-download-snapshot" class="primary">下载当前可读快照</button>
      <button type="button" id="btn-repair-storage">用可读快照修复存储</button>
      <button type="button" id="btn-dismiss-banner">知道了</button>
    </div>`;
  banner.querySelector('#corrupt-raw').textContent = raw ?? '(空)';
  document.querySelector('main').before(banner);
  banner.querySelector('#btn-download-corrupt').addEventListener('click', () =>
    downloadJson('corrupt-snapshot.txt', raw ?? ''));
  banner.querySelector('#btn-download-snapshot').addEventListener('click', () =>
    downloadJson('readable-snapshot.json', JSON.stringify({ doc, ui }, null, 2)));
  banner.querySelector('#btn-repair-storage').addEventListener('click', () => {
    storageBlocked = false;
    storage.readOnly = false;
    storage.forceWriteFail = false;
    storage.save({ doc, ui });
    render();
    showToast('存储已用当前可读快照修复，自动保存恢复', 'ok');
    banner.remove();
  });
  banner.querySelector('#btn-dismiss-banner').addEventListener('click', () => banner.remove());
  recoveryBanner = banner;
  showToast('存储恢复失败：已保留可读快照与损坏原文', 'danger');
}

function downloadJson(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- 持久化调度 ----------

let saveTimer = null;

function scheduleSave() {
  if (!storageReady) return; // 恢复流程结束前不得自动落盘（避免覆盖损坏现场）
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}

function flushSave() {
  if (storageBlocked) return;
  try {
    storage.save({ doc, ui });
  } catch (err) {
    showToast(err.message, 'danger');
    announce('存储写入失败，内存状态仍然保留');
  }
  render();
}

// ---------- 渲染编排 ----------

const canvas = document.getElementById('canvas');
const canvasScroll = document.getElementById('canvas-scroll');
const sidebarScroll = document.getElementById('sidebar-scroll');

const handlers = {
  selectShape,
  selectKey,
  openTextModal: (textId) => openModal(textId),
  onShapeKey: handleShapeKey,
  onShapePointerDown: startShapeDrag,
};

function render() {
  renderTick += 1;
  reconcileSelection();
  // 拖拽中不重建 SVG 节点（坐标由节点属性自然反映），避免打断指针捕获
  if (!drag) renderCanvas(canvas, doc, ui, handlers);
  renderSidebar(doc, ui, handlers);
  renderStatus(buildStatusSnapshot());
  document.getElementById('btn-undo').disabled = !history.canUndo();
  document.getElementById('btn-redo').disabled = !history.canRedo();
  document.getElementById('btn-del-key').disabled = !ui.selectedKeyId;
  scheduleSave();
}

function buildStatusSnapshot() {
  const labels = history.topLabels();
  const modalOpen = !document.getElementById('modal-backdrop').hidden;
  return {
    doc,
    ui,
    modalOpen,
    backgroundInert: document.querySelector('.topbar')?.inert === true,
    activeEditable: isEditable(document.activeElement),
    tabOrder: describeTabOrder(modalOpen),
    storage: {
      status: storage.lastError
        ? '异常'
        : storage.saveCount ? '正常' : restoredFromStorage ? '正常（已恢复）' : '待首次保存',
      statusClass: storage.lastError ? 'danger' : 'ok',
      saveCount: storage.saveCount,
      lastSavedAt: storage.lastSavedAt
        ? storage.lastSavedAt.toLocaleTimeString()
        : (restoredFromStorage ? '已恢复（本会话未再保存）' : null),
      lastBytes: storage.lastBytes,
      lastError: storage.lastError,
    },
    history: {
      canUndo: history.canUndo(),
      canRedo: history.canRedo(),
      pastDepth: history.past.length,
      futureDepth: history.future.length,
    },
    historyLabels: labels,
    renderTick,
  };
}

function describeTabOrder(modalOpen) {
  if (modalOpen) return '弹窗内循环（背景 inert）';
  const order = [];
  for (const el of document.querySelectorAll(
    'button, input, textarea, [tabindex="0"]',
  )) {
    if (el.offsetParent === null && el !== document.activeElement) continue;
    if (el.closest('.modal')) continue;
    order.push(el.id || el.tagName.toLowerCase());
    if (order.length >= 8) break;
  }
  return order.join(' → ');
}

// ---------- 编辑命令（全部经过历史） ----------

function commit(label, mutate, coalesceKey = null) {
  history.commit(label, mutate, coalesceKey);
  render();
}

function addShape(kind) {
  const id = uid('shape');
  commit(`添加${kind === 'rect' ? '矩形' : '椭圆'}`, (d) => {
    d.shapes.push({
      id, kind,
      x: 120 + Math.round(Math.random() * 200),
      y: 100 + Math.round(Math.random() * 160),
      w: 150, h: 110,
      fill: kind === 'rect' ? '#3d6fb4' : '#b45a8f',
    });
  });
  ui.selectedShapeId = id;
  render();
  canvas.querySelector(`.shape[data-id="${id}"]`)?.focus();
  announce(`已添加${kind === 'rect' ? '矩形' : '椭圆'}`);
}

function moveSelectedShape(dx, dy) {
  const id = ui.selectedShapeId;
  if (!id) return;
  commit('方向键移动图形', (d) => {
    const shape = d.shapes.find((s) => s.id === id);
    if (shape) { shape.x += dx; shape.y += dy; }
  }, `move:${id}`);
}

// 鼠标/指针拖拽图形：拖拽中直接更新 doc，松手时补一条历史（可一次撤销）
let drag = null;

function toSvgPoint(event) {
  const ctm = canvas.getScreenCTM();
  return {
    x: (event.clientX - ctm.e) / ctm.a,
    y: (event.clientY - ctm.f) / ctm.d,
  };
}

function startShapeDrag(event, id) {
  if (event.button !== 0) return;
  selectShape(id);
  const shape = doc.shapes.find((s) => s.id === id);
  if (!shape) return;
  event.preventDefault();
  drag = {
    id,
    start: toSvgPoint(event),
    origin: { x: shape.x, y: shape.y },
    snapshot: clone(doc),
    moved: false,
  };
  try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* 节点可能被重渲染替换 */ }
  window.addEventListener('pointermove', onShapeDrag);
  window.addEventListener('pointerup', endShapeDrag, { once: true });
}

function onShapeDrag(event) {
  if (!drag) return;
  const point = toSvgPoint(event);
  const dx = Math.round(point.x - drag.start.x);
  const dy = Math.round(point.y - drag.start.y);
  if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
  const shape = doc.shapes.find((s) => s.id === drag.id);
  if (shape) {
    shape.x = drag.origin.x + dx;
    shape.y = drag.origin.y + dy;
    // 直接更新节点几何属性，不重建 DOM；看板同步坐标
    const node = canvas.querySelector(`.shape[data-id="${drag.id}"]`);
    if (node) {
      if (shape.kind === 'rect') {
        node.setAttribute('x', shape.x);
        node.setAttribute('y', shape.y);
      } else {
        node.setAttribute('cx', shape.x + shape.w / 2);
        node.setAttribute('cy', shape.y + shape.h / 2);
      }
    }
    renderStatus(buildStatusSnapshot());
  }
}

function endShapeDrag() {
  window.removeEventListener('pointermove', onShapeDrag);
  if (!drag) return;
  if (drag.moved) {
    history.commitExternal('拖拽移动图形', drag.snapshot);
    announce('图形已拖拽移动，可一次撤销');
  }
  drag = null;
  render();
}

function deleteSelectedShape() {
  const id = ui.selectedShapeId;
  if (!id) return;
  commit('删除图形', (d) => {
    d.shapes = d.shapes.filter((s) => s.id !== id);
  });
  ui.selectedShapeId = doc.shapes[0]?.id ?? null;
  render();
  announce('图形已删除');
}

function selectShape(id) {
  ui.selectedShapeId = id;
  render();
}

function handleShapeKey(event, id) {
  if (id !== ui.selectedShapeId) selectShape(id);
  const step = event.shiftKey ? 20 : 8;
  const map = {
    ArrowUp: [0, -step], ArrowDown: [0, step],
    ArrowLeft: [-step, 0], ArrowRight: [step, 0],
  };
  if (map[event.key]) {
    event.preventDefault();
    moveSelectedShape(map[event.key][0], map[event.key][1]);
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    deleteSelectedShape();
  }
}

function upsertText(textId, title, body) {
  commit(textId ? '编辑文本块' : '新建文本块', (d) => {
    const existing = d.texts.find((t) => t.id === textId);
    if (existing) {
      existing.title = title;
      existing.body = body;
    } else {
      d.texts.push({ id: uid('text'), title, body });
    }
  });
}

function addKeyframe() {
  const id = uid('key');
  const t = doc.timeline.length ? Math.max(...doc.timeline.map((k) => k.t)) + 30 : 0;
  commit('新增时间轴关键帧', (d) => {
    d.timeline.push({ id, t, label: `帧 ${d.timeline.length + 1}` });
  });
  ui.selectedKeyId = id;
  render();
  announce('已新增关键帧');
}

function deleteSelectedKeyframe() {
  const id = ui.selectedKeyId;
  if (!id) return;
  commit('删除关键帧', (d) => {
    d.timeline = d.timeline.filter((k) => k.id !== id);
  });
  ui.selectedKeyId = doc.timeline[0]?.id ?? null;
  render();
  announce('关键帧已删除');
}

function selectKey(id) {
  ui.selectedKeyId = id;
  render();
}

function undo() {
  const label = history.undo();
  if (label === null) {
    showToast('没有可撤销的操作', 'warn');
  } else {
    reconcileSelection();
    render();
    announce(`已撤销：${label}`);
  }
}

function redo() {
  const label = history.redo();
  if (label === null) {
    showToast('没有可重做的操作', 'warn');
  } else {
    reconcileSelection();
    render();
    announce(`已重做：${label}`);
  }
}

// ---------- 弹窗：焦点陷阱 / 草稿 / 焦点归还 ----------

const backdrop = document.getElementById('modal-backdrop');
const modal = document.getElementById('text-modal');
const titleInput = document.getElementById('modal-title-input');
const bodyInput = document.getElementById('modal-body-input');
const modalError = document.getElementById('modal-error');
let unfreeze = null;
let restoreFocus = null;
let trapDispose = null;

function openModal(textId = null) {
  restoreFocus = createFocusReturn();
  // inert 会使滚动容器不可滚动，先固化当前滚动位置
  ui.scroll.canvas = { left: canvasScroll.scrollLeft, top: canvasScroll.scrollTop };
  ui.scroll.sidebar = { left: sidebarScroll.scrollLeft, top: sidebarScroll.scrollTop };
  const existing = textId ? doc.texts.find((t) => t.id === textId) : null;
  // 未提交草稿优先：上次 Esc 关闭的内容不能丢
  const draft = ui.modalDraft && (!textId || ui.modalDraft.textId === textId)
    ? ui.modalDraft
    : { textId, title: existing?.title ?? '', body: existing?.body ?? '', dirty: false };
  ui.modalDraft = draft;
  titleInput.value = draft.title;
  bodyInput.value = draft.body;
  modalError.hidden = true;
  backdrop.hidden = false;
  document.body.classList.add('modal-open');
  unfreeze = freezeBackground([
    document.querySelector('.topbar'),
    document.querySelector('.workspace'),
    document.querySelector('.status-panel'),
  ]);
  trapDispose = installFocusTrap(modal);
  (draft.dirty ? bodyInput : titleInput).focus();
  render();
  announce(existing ? '文本编辑弹窗已打开' : '新建文本弹窗已打开');
}

function closeModal({ commitChanges = false } = {}) {
  if (backdrop.hidden) return;
  if (commitChanges) {
    const title = titleInput.value.trim();
    const body = bodyInput.value.trim();
    if (!title && !body) {
      modalError.textContent = '失败提示：标题和正文不能同时为空，请输入内容或选择“丢弃草稿”。';
      modalError.hidden = false;
      titleInput.focus();
      announce('保存失败：内容为空');
      return;
    }
    upsertText(ui.modalDraft.textId, title, body);
    ui.modalDraft = null;
  }
  // Esc/取消：保留未提交草稿到 ui（并随持久化保存）
  backdrop.hidden = true;
  document.body.classList.remove('modal-open');
  trapDispose?.();
  unfreeze?.();
  restoreScroll();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    restoreScroll();
    ui.scroll.canvas = { left: canvasScroll.scrollLeft, top: canvasScroll.scrollTop };
    ui.scroll.sidebar = { left: sidebarScroll.scrollLeft, top: sidebarScroll.scrollTop };
    scheduleSave();
  }));
  const ok = restoreFocus?.();
  render();
  announce(commitChanges ? '弹窗已保存关闭，焦点回到触发按钮'
    : `弹窗已关闭，草稿已保留，焦点${ok ? '回到触发按钮' : '未能回到触发元素'}`);
}

function discardDraft() {
  ui.modalDraft = null;
  titleInput.value = '';
  bodyInput.value = '';
  backdrop.hidden = true;
  document.body.classList.remove('modal-open');
  trapDispose?.();
  unfreeze?.();
  restoreScroll();
  requestAnimationFrame(() => requestAnimationFrame(restoreScroll));
  const ok = restoreFocus?.();
  render();
  announce(`草稿已丢弃，焦点${ok ? '回到触发按钮' : '未能归还'}`);
}

function markDraftDirty() {
  if (ui.modalDraft) {
    ui.modalDraft.dirty = true;
    ui.modalDraft.title = titleInput.value;
    ui.modalDraft.body = bodyInput.value;
    scheduleSave();
    render();
  }
}

// ---------- 事件绑定与快捷键守卫 ----------

document.getElementById('btn-add-rect').addEventListener('click', () => addShape('rect'));
document.getElementById('btn-add-ellipse').addEventListener('click', () => addShape('ellipse'));
document.getElementById('btn-open-text').addEventListener('click', () => openModal(null));
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);
document.getElementById('btn-add-key').addEventListener('click', addKeyframe);
document.getElementById('btn-del-key').addEventListener('click', deleteSelectedKeyframe);
document.getElementById('btn-sim-fail').addEventListener('click', () => {
  storage.corrupt();
  storage.lastError = '检测到主快照已被损坏（下次刷新触发恢复横幅）';
  showToast('已损坏主快照，刷新页面可验证恢复流程', 'warn');
  render();
});
document.getElementById('btn-write-fail').addEventListener('click', (e) => {
  storage.forceWriteFail = !storage.forceWriteFail;
  e.currentTarget.textContent = storage.forceWriteFail
    ? '⚠ 恢复写入（当前强制失败）' : '⚠ 模拟写入失败';
  showToast(storage.forceWriteFail
    ? '已开启写入失败注入：之后保存将报错，内存状态不受影响'
    : '已关闭写入失败注入', storage.forceWriteFail ? 'warn' : 'ok');
});

document.getElementById('btn-modal-save').addEventListener('click', () => closeModal({ commitChanges: true }));
document.getElementById('btn-modal-cancel').addEventListener('click', () => closeModal());
document.getElementById('btn-modal-discard').addEventListener('click', discardDraft);
titleInput.addEventListener('input', markDraftDirty);
bodyInput.addEventListener('input', markDraftDirty);

backdrop.addEventListener('mousedown', (event) => {
  if (event.target === backdrop) {
    event.preventDefault(); // 阻止焦点从触发按钮转移到 body
    closeModal();
  }
});

// 弹窗内键盘：Esc / Ctrl+Enter 在全局快捷键之前处理
modal.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeModal();
  } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    closeModal({ commitChanges: true });
  }
});

// 全局快捷键：可编辑元素聚焦时，单键背景快捷键全部让位
document.addEventListener('keydown', (event) => {
  const modalOpen = !backdrop.hidden;
  const editing = isEditable(event.target);
  const ctrl = event.ctrlKey || event.metaKey;

  // 撤销/重做：弹窗打开时不允许穿透到背景；在输入框内由应用统一接管，
  // 保证“撤销期间输入框不会被背景快捷键劫持”，且仍可撤销到历史操作
  if (ctrl && event.key.toLowerCase() === 'z' && !event.shiftKey) {
    event.preventDefault();
    if (!modalOpen) undo();
    return;
  }
  if (ctrl && ((event.key.toLowerCase() === 'y') ||
    (event.key.toLowerCase() === 'z' && event.shiftKey))) {
    event.preventDefault();
    if (!modalOpen) redo();
    return;
  }

  if (modalOpen || editing) return; // 输入框中输入普通字符不触发背景动作

  const key = event.key.toLowerCase();
  const singleKeyMap = {
    r: () => addShape('rect'),
    o: () => addShape('ellipse'),
    t: () => openModal(null),
    k: addKeyframe,
  };
  if (singleKeyMap[key]) {
    event.preventDefault();
    singleKeyMap[key]();
    return;
  }
  if (key === 'delete' || key === 'backspace') {
    if (ui.selectedShapeId) { event.preventDefault(); deleteSelectedShape(); }
    else if (ui.selectedKeyId) { event.preventDefault(); deleteSelectedKeyframe(); }
    return;
  }

  // 焦点不在图形节点上时，方向键仍可移动当前选中图形
  const arrowMap = {
    arrowup: [0, -(event.shiftKey ? 20 : 8)],
    arrowdown: [0, event.shiftKey ? 20 : 8],
    arrowleft: [-(event.shiftKey ? 20 : 8), 0],
    arrowright: [event.shiftKey ? 20 : 8, 0],
  };
  if (arrowMap[key] && ui.selectedShapeId) {
    event.preventDefault();
    moveSelectedShape(arrowMap[key][0], arrowMap[key][1]);
  }
});

// 全局 Escape 兜底（焦点陷阱外）
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !backdrop.hidden && !modal.contains(event.target)) {
    closeModal();
  }
});

// 滚动位置：进入 UI 状态并持久化，刷新后恢复
function bindScrollRestore(el, key) {
  el.addEventListener('scroll', () => {
    ui.scroll[key] = { left: el.scrollLeft, top: el.scrollTop };
    scheduleSave();
  }, { passive: true });
}
bindScrollRestore(canvasScroll, 'canvas');
bindScrollRestore(sidebarScroll, 'sidebar');

function restoreScroll() {
  applyScroll(canvasScroll, ui.scroll.canvas);
  applyScroll(sidebarScroll, ui.scroll.sidebar);
}

// 浏览器可能截断超出当前可滚动范围的值，分帧重试直到命中或确认上限
function applyScroll(el, target) {
  let tries = 0;
  const tick = () => {
    el.scrollLeft = target.left;
    el.scrollTop = target.top;
    tries += 1;
    const reached =
      (el.scrollLeft === target.left || el.scrollLeft >= el.scrollWidth - el.clientWidth - 1) &&
      (el.scrollTop === target.top || el.scrollTop >= el.scrollHeight - el.clientHeight - 1);
    if (!reached && tries < 8) requestAnimationFrame(tick);
  };
  tick();
}

// 焦点变化只刷新看板，避免重建 DOM 导致焦点丢失
document.addEventListener('focusin', () => {
  renderStatus(buildStatusSnapshot());
});

// 刷新前确保最后状态落盘（写入失败时给出提示）
window.addEventListener('beforeunload', () => {
  if (storageBlocked || storage.readOnly) return;
  clearTimeout(saveTimer);
  try {
    storage.save({ doc, ui });
  } catch (err) {
    announce('页面关闭前保存失败：' + err.message);
  }
});

// ---------- 启动 ----------
boot();
render();
storageReady = true;
// 等布局完成后恢复滚动，避免可滚动范围尚未建立时被浏览器截断
requestAnimationFrame(() => requestAnimationFrame(restoreScroll));
announce('创作台已就绪');

// 供自动化测试访问
globalThis.__app = {
  get doc() { return doc; },
  get ui() { return ui; },
  get history() { return history; },
  get storage() { return storage; },
  STORAGE_KEY,
  openModal, closeModal, undo, redo, addShape, addKeyframe,
  render, flushSave,
};
