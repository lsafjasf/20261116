// 纯渲染层：把 state 投影到 DOM / SVG / 状态看板

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

export function renderCanvas(svg, doc, ui, handlers) {
  svg.innerHTML = '';
  for (const shape of doc.shapes) {
    const selected = shape.id === ui.selectedShapeId;
    let node;
    if (shape.kind === 'rect') {
      node = svgEl('rect', {
        x: shape.x, y: shape.y, width: shape.w, height: shape.h,
        rx: 10, fill: shape.fill, stroke: '#cfe0ff', 'stroke-width': 1.5,
      });
    } else {
      node = svgEl('ellipse', {
        cx: shape.x + shape.w / 2, cy: shape.y + shape.h / 2,
        rx: shape.w / 2, ry: shape.h / 2,
        fill: shape.fill, stroke: '#cfe0ff', 'stroke-width': 1.5,
      });
    }
    node.classList.add('shape');
    if (selected) node.classList.add('selected');
    node.dataset.id = shape.id;
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label',
      `${shape.kind === 'rect' ? '矩形' : '椭圆'} 图形 ${shape.id}，按方向键移动，Delete 删除`);
    node.addEventListener('click', () => handlers.selectShape(shape.id));
    node.addEventListener('keydown', (e) => handlers.onShapeKey(e, shape.id));
    node.addEventListener('pointerdown', (e) => handlers.onShapePointerDown(e, shape.id));
    svg.appendChild(node);
  }
}

function li(title, sub, { selected, id } = {}) {
  const node = document.createElement('li');
  if (selected) node.classList.add('selected');
  if (id) node.dataset.id = id;
  const t = document.createElement('div');
  t.className = 'item-title';
  t.textContent = title;
  const s = document.createElement('div');
  s.className = 'item-sub';
  s.textContent = sub;
  node.append(t, s);
  return node;
}

export function renderSidebar(doc, ui, handlers) {
  const textList = document.getElementById('text-list');
  textList.innerHTML = '';
  if (doc.texts.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'item-sub';
    empty.textContent = '（暂无文本块，按 T 打开弹窗创建）';
    textList.appendChild(empty);
  }
  for (const text of doc.texts) {
    const node = li(text.title || '（无标题）', text.body.slice(0, 60), { id: text.id });
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.addEventListener('click', () => handlers.openTextModal(text.id));
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handlers.openTextModal(text.id);
      }
    });
    textList.appendChild(node);
  }

  const layerList = document.getElementById('layer-list');
  layerList.innerHTML = '';
  for (const shape of doc.shapes) {
    const node = li(
      `${shape.kind === 'rect' ? '矩形' : '椭圆'} ${shape.id}`,
      `x:${shape.x} y:${shape.y} ${shape.w}×${shape.h}`,
      { selected: shape.id === ui.selectedShapeId, id: shape.id },
    );
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.addEventListener('click', () => handlers.selectShape(shape.id));
    node.addEventListener('keydown', (e) => handlers.onShapeKey(e, shape.id));
    layerList.appendChild(node);
  }

  const timeline = document.getElementById('timeline');
  timeline.innerHTML = '';
  for (const key of [...doc.timeline].sort((a, b) => a.t - b.t)) {
    const node = li(`t=${key.t}`, key.label, {
      selected: key.id === ui.selectedKeyId,
      id: key.id,
    });
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.addEventListener('click', () => handlers.selectKey(key.id));
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handlers.selectKey(key.id);
      }
    });
    timeline.appendChild(node);
  }
}

function setDl(id, rows) {
  const dl = document.getElementById(id);
  dl.innerHTML = '';
  for (const [term, value, cls] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (cls) dd.classList.add(cls);
    dl.append(dt, dd);
  }
}

export function renderStatus(snapshot) {
  const active = document.activeElement;
  const focusName =
    active && active !== document.body
      ? `${active.tagName.toLowerCase()}${active.id ? '#' + active.id : ''}${
          active.dataset && active.dataset.shape ? `[shape=${active.dataset.shape}]` : ''
        }`
      : 'body（无焦点）';
  setDl('st-focus', [
    ['activeElement', focusName],
    ['弹窗打开', String(snapshot.modalOpen)],
    ['背景 inert', String(snapshot.backgroundInert)],
    ['当前焦点可编辑', String(snapshot.activeEditable)],
    ['Tab 顺序', snapshot.tabOrder],
  ]);

  setDl('st-edit', [
    ['文本块数', String(snapshot.doc.texts.length)],
    ['图形数', String(snapshot.doc.shapes.length)],
    ['关键帧数', String(snapshot.doc.timeline.length)],
    ['选中图形', snapshot.ui.selectedShapeId ?? '—'],
    ['选中关键帧', snapshot.ui.selectedKeyId ?? '—'],
    ['未提交草稿', snapshot.ui.modalDraft ? '有' : '无', snapshot.ui.modalDraft ? 'warn' : 'ok'],
  ]);

  setDl('st-storage', [
    ['存储状态', snapshot.storage.status, snapshot.storage.statusClass],
    ['保存次数', String(snapshot.storage.saveCount)],
    ['最近保存', snapshot.storage.lastSavedAt ?? '—'],
    ['快照字节', String(snapshot.storage.lastBytes)],
    ['最近错误', snapshot.storage.lastError ?? '无', snapshot.storage.lastError ? 'danger' : 'ok'],
  ]);

  setDl('st-render', [
    ['SVG 子节点', String(snapshot.doc.shapes.length)],
    ['画布滚动', `${snapshot.ui.scroll.canvas.left},${snapshot.ui.scroll.canvas.top}`],
    ['侧栏滚动', `${snapshot.ui.scroll.sidebar.left},${snapshot.ui.scroll.sidebar.top}`],
    ['渲染版本', String(snapshot.renderTick)],
  ]);

  const labels = snapshot.historyLabels;
  setDl('st-history', [
    ['可撤销', String(snapshot.history.canUndo)],
    ['可重做', String(snapshot.history.canRedo)],
    ['past 深度', String(snapshot.history.pastDepth)],
    ['future 深度', String(snapshot.history.futureDepth)],
    ['最近入栈', labels.past.join(' | ') || '—'],
    ['可重做项', labels.future.join(' | ') || '—'],
  ]);

  setDl('st-modal', [
    ['弹窗状态', snapshot.modalOpen ? '打开' : '关闭'],
    ['草稿文本ID', snapshot.ui.modalDraft?.textId ?? '—'],
    ['草稿标题', snapshot.ui.modalDraft?.title ?? '—'],
    ['草稿脏标记', snapshot.ui.modalDraft ? String(snapshot.ui.modalDraft.dirty) : '—',
      snapshot.ui.modalDraft?.dirty ? 'warn' : 'ok'],
  ]);
}

export function announce(message) {
  const region = document.getElementById('live-region');
  region.textContent = '';
  // 触发 aria-live 更新
  requestAnimationFrame(() => { region.textContent = message; });
}

export function showToast(message, kind = '') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${kind}`.trim();
  toast.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { toast.hidden = true; }, 4200);
}
