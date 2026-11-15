// 纯渲染层：state -> SVG/DOM，不含任何事件处理逻辑。

import { docToScreen, normalizeShape } from './geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function shapeNode(el, { selected, draft }) {
  const shape = normalizeShape(el);
  let node;
  if (el.type === 'line') {
    node = document.createElementNS(SVG_NS, 'line');
    node.setAttribute('x1', el.x1);
    node.setAttribute('y1', el.y1);
    node.setAttribute('x2', el.x2);
    node.setAttribute('y2', el.y2);
    node.setAttribute('stroke', '#9bd1ff');
    node.setAttribute('stroke-width', 3);
    node.setAttribute('stroke-linecap', 'round');
  } else {
    node = document.createElementNS(SVG_NS, el.type);
    if (el.type === 'ellipse') {
      node.setAttribute('cx', shape.x + shape.width / 2);
      node.setAttribute('cy', shape.y + shape.height / 2);
      node.setAttribute('rx', Math.max(shape.width / 2, 0.5));
      node.setAttribute('ry', Math.max(shape.height / 2, 0.5));
    } else {
      node.setAttribute('x', shape.x);
      node.setAttribute('y', shape.y);
      node.setAttribute('width', Math.max(shape.width, 1));
      node.setAttribute('height', Math.max(shape.height, 1));
      node.setAttribute('rx', 6);
    }
    node.setAttribute('fill', 'rgba(90,162,255,0.32)');
    node.setAttribute('stroke', '#5aa2ff');
    node.setAttribute('stroke-width', 2);
  }
  node.setAttribute('data-id', el.id);
  if (draft) node.setAttribute('stroke-dasharray', '6 5');
  if (selected) {
    node.setAttribute('data-selected', 'true');
    node.setAttribute('filter', 'drop-shadow(0 0 4px #ffd24a)');
  }
  return node;
}

export function render(state, dom) {
  const { stage, cursor } = dom;
  const { width, height } = state.canvasSize;
  const { zoom, panX, panY } = state.view;
  stage.setAttribute('viewBox', `0 0 ${width} ${height}`);
  stage.innerHTML = '';

  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('transform',
    `translate(${width / 2 + panX} ${height / 2 + panY}) scale(${zoom}) translate(${-width / 2} ${-height / 2})`);
  stage.appendChild(group);

  for (const el of state.elements) {
    group.appendChild(shapeNode(el, { selected: el.id === state.selectedId, draft: false }));
  }
  if (state.draft && state.draft.kind === 'shape') {
    group.appendChild(shapeNode(state.draft, { selected: true, draft: true }));
  }

  const screen = docToScreen(state.cursor, state.view, state.canvasSize);
  cursor.style.left = `${screen.x}px`;
  cursor.style.top = `${screen.y}px`;
  cursor.dataset.tool = state.tool;
}

function serializeElement(el) {
  const shape = normalizeShape(el);
  if (el.type === 'line') {
    return `  <line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="#9bd1ff" stroke-width="3" stroke-linecap="round" data-id="${el.id}"/>`;
  }
  const dims = el.type === 'rect'
    ? `x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" rx="6"`
    : `cx="${shape.x + shape.width / 2}" cy="${shape.y + shape.height / 2}" rx="${shape.width / 2}" ry="${shape.height / 2}"`;
  const tag = el.type === 'rect' ? 'rect' : 'ellipse';
  return `  <${tag} ${dims} fill="rgba(90,162,255,0.32)" stroke="#5aa2ff" stroke-width="2" data-id="${el.id}"/>`;
}

export function exportSVG(state) {
  const { width, height } = state.canvasSize;
  const body = state.elements.map(serializeElement).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${body}\n</svg>\n`;
}

export function exportJSON(state) {
  return JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    canvasSize: state.canvasSize,
    elements: state.elements,
  }, null, 2);
}
