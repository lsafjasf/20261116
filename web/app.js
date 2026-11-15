import { buildDemoScene } from '../src/core/demo.js';
import { EditorController } from '../src/core/commands.js';
import {
  findNode,
  flattenDrawOrder,
  parentChain,
  effectiveVisibility,
} from '../src/core/scene.js';
import { renderScene } from '../src/render/renderer.js';
import { createBrowserCanvas } from './browser-canvas.js';
import { sampleAt } from '../src/core/keyframes.js';
import { ResourceService } from '../src/core/resource-service.js';

const W = 480;
const H = 360;
const BG = '#f4f6fa';

const host = document.getElementById('canvas-host');

let controller = new EditorController(buildDemoScene());
let sampleTime = 0;
const notices = [];

const resourceService = new ResourceService({
  backend: async (key) => ({ version: 1, payload: { key } }),
  thumbnailer: async (payload) => ({ kind: 'thumb', for: payload.key }),
});

function currentScene() {
  return sampleTime > 0 ? sampleAt(controller.root, sampleTime) : controller.root;
}

function redraw() {
  host.innerHTML = '';
  const canvas = createBrowserCanvas(W, H, BG);
  host.appendChild(canvas.canvas);
  const highlight = controller.selectedId ? controller.highlightSet() : new Set();
  renderScene(canvas, currentScene(), {
    width: W,
    height: H,
    background: BG,
    highlightIds: highlight,
  });
}

function renderTree() {
  const panel = document.getElementById('tree');
  panel.innerHTML = '';
  const drawIndex = new Map(flattenDrawOrder(controller.root).map((n, i) => [n.id, i]));
  const walk = (node, depth) => {
    const row = document.createElement('div');
    row.className = 'tree-row';
    if (node.id === controller.selectedId) row.classList.add('selected');
    if (controller.selectedId &&
        parentChain(controller.root, controller.selectedId).some((n) => n.id === node.id)) {
      row.classList.add('chain');
    }
    row.style.paddingLeft = `${8 + depth * 16}px`;
    row.innerHTML = `
      <span class="eye">${node.visible === false ? '🚫' : '👁'}</span>
      <span class="name">${node.name}</span>
      <span class="meta">#${drawIndex.get(node.id)} · ${node.type}${node.clipped ? ' · ✂裁剪' : ''}</span>`;
    row.addEventListener('click', () => {
      try {
        controller.select(node.id);
        renderAll();
      } catch (err) {
        pushNotice('error', err.message);
      }
    });
    panel.appendChild(row);
    node.children.forEach((c) => walk(c, depth + 1));
  };
  walk(controller.root, 0);
}

function renderInspector() {
  const panel = document.getElementById('inspector');
  if (!controller.selectedId) {
    panel.innerHTML = '<p class="hint">未选择节点</p>';
    return;
  }
  const node = findNode(controller.root, controller.selectedId);
  const chain = parentChain(controller.root, node.id).map((n) => n.name).join(' → ');
  panel.innerHTML = `
    <h3>${node.name}</h3>
    <p class="hint">父链：${chain}</p>
    <label>X <input id="in-x" type="number" value="${node.transform.x}"></label>
    <label>Y <input id="in-y" type="number" value="${node.transform.y}"></label>
    <label>旋转 <input id="in-r" type="number" value="${node.transform.rotation}"></label>
    <label>缩放X <input id="in-sx" type="number" value="${node.transform.scaleX}"></label>
    <label>缩放Y <input id="in-sy" type="number" value="${node.transform.scaleY}"></label>
    <label>填充 <input id="in-fill" type="color" value="${node.style.fill}"></label>
    <label>透明度 <input id="in-opacity" type="range" min="0" max="1" step="0.01"
      value="${node.style.opacity}"></label>
    <p class="hint">实际可见：${effectiveVisibility(controller.root, node.id) ? '是' : '否'}
      ${node.clipped ? '｜裁剪区 ' + JSON.stringify(node.clipRect) : ''}</p>`;
  bindInspector(node);
}

function bindInspector(node) {
  const bind = (id, apply) => {
    document.getElementById(id).addEventListener('change', (e) => {
      controller.history.push(controller.root, `edit:${node.id}`);
      try {
        apply(e.target.value);
        renderAll();
      } catch (err) {
        controller.undo();
        pushNotice('error', err.message);
        renderAll();
      }
    });
  };
  bind('in-x', (v) => { node.transform.x = Number(v); });
  bind('in-y', (v) => { node.transform.y = Number(v); });
  bind('in-r', (v) => { node.transform.rotation = Number(v); });
  bind('in-sx', (v) => { node.transform.scaleX = Number(v); });
  bind('in-sy', (v) => { node.transform.scaleY = Number(v); });
  bind('in-fill', (v) => { node.style.fill = v; });
  bind('in-opacity', (v) => { node.style.opacity = Number(v); });
}

function renderNotices() {
  const box = document.getElementById('notices');
  box.innerHTML = notices
    .slice(-5)
    .map((n) => `<div class="notice ${n.level}">[${n.level}] ${n.text}</div>`)
    .join('');
}

function pushNotice(level, text) {
  notices.push({ level, text });
  renderNotices();
}

function renderAll() {
  renderTree();
  renderInspector();
  redraw();
  document.getElementById('undo-btn').disabled = !controller.history.canUndo;
}

document.getElementById('undo-btn').addEventListener('click', () => {
  const r = controller.undo();
  pushNotice(r.restored ? 'info' : 'warning',
    r.restored ? `已撤销：${r.label}` : '没有可撤销的操作');
  renderAll();
});

document.getElementById('delete-btn').addEventListener('click', () => {
  if (!controller.selectedId) return pushNotice('warning', '请先选择要删除的节点');
  try {
    controller.deleteNode(controller.selectedId);
    renderAll();
  } catch (err) {
    pushNotice('error', err.message);
  }
});

document.getElementById('hide-btn').addEventListener('click', () => {
  if (!controller.selectedId) return pushNotice('warning', '请先选择节点');
  const node = findNode(controller.root, controller.selectedId);
  node.visible ? controller.hide(node.id) : controller.show(node.id);
  renderAll();
});

document.getElementById('move-btn').addEventListener('click', () => {
  if (!controller.selectedId) return pushNotice('warning', '请先选择节点');
  controller.moveBy(controller.selectedId, 12, 8);
  renderAll();
});

document.getElementById('time').addEventListener('input', (e) => {
  sampleTime = Number(e.target.value);
  document.getElementById('time-label').textContent = `t=${sampleTime}`;
  redraw();
});

document.getElementById('sim-fault').addEventListener('click', async () => {
  resourceService.setFault('tex/demo', 'network');
  const r = await resourceService.getThumbnail('tex/demo');
  r.notices.forEach((n) => pushNotice(n.level === 'error' ? 'error' : 'warning', n.message));
  document.getElementById('resource-state').textContent =
    `资源来源: ${r.source}（${r.thumbnail.kind}）`;
});

document.getElementById('clear-fault').addEventListener('click', async () => {
  resourceService.clearFault('tex/demo');
  resourceService.invalidate('tex/demo');
  const r = await resourceService.getThumbnail('tex/demo');
  pushNotice('info', `缓存失效后已重新请求，来源: ${r.source}`);
  document.getElementById('resource-state').textContent =
    `资源来源: ${r.source}（${r.thumbnail.kind}）`;
});

renderAll();
