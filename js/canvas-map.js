/* Canvas 区域地图：热区、边流向动画、满载/超载高亮、节点库存 */
(function (global) {
  const APP = global.App || (global.App = {});
  const TYPE_COLOR = { factory: '#2f9e44', warehouse: '#1c7ed6', store: '#e8590c' };

  function MapView(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hoverEdge = null;
    this.selectedEdge = null;
    this.onSelect = null;
    this.phase = 0;
    this._bindClick();
  }

  MapView.prototype._bindClick = function () {
    this.canvas.addEventListener('click', (ev) => {
      const hit = this._hitEdge(ev.offsetX, ev.offsetY);
      this.selectedEdge = hit;
      if (this.onSelect) this.onSelect(hit);
    });
    this.canvas.addEventListener('mousemove', (ev) => {
      this.hoverEdge = this._hitEdge(ev.offsetX, ev.offsetY);
      this.canvas.style.cursor = this.hoverEdge ? 'pointer' : 'default';
    });
  };

  MapView.prototype._hitEdge = function (x, y) {
    if (!this.model) return null;
    const found = this.model.edges.find((e) => {
      const a = this.model.nodeById[e.from];
      const b = this.model.nodeById[e.to];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * dx, py = a.y + t * dy;
      return Math.hypot(x - px, y - py) < 9;
    });
    return found ? found.id : null;
  };

  MapView.prototype.setModel = function (model) {
    this.model = model;
  };

  MapView.prototype.draw = function (tickState, filters) {
    if (!this.model || !tickState) return;
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    this._partials = tickState.partials || [];
    this._drawHeat(tickState);
    tickState.edges.forEach((e) => this._drawEdge(e, filters));
    tickState.nodes.forEach((n) => this._drawNode(n, filters));
    this._drawLegend();
  };

  MapView.prototype._drawHeat = function (tickState) {
    const ctx = this.ctx;
    tickState.nodes.filter((n) => n.type === 'store').forEach((n) => {
      const node = this.model.nodeById[n.id];
      const ratio = n.demand > 0 ? n.shortage / n.demand : 0;
      if (ratio <= 0) return;
      const grad = ctx.createRadialGradient(node.x, node.y, 4, node.x, node.y, 70);
      grad.addColorStop(0, 'rgba(229,57,53,' + (0.35 * ratio).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(229,57,53,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(node.x, node.y, 70, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  MapView.prototype._drawEdge = function (edgeState, filters) {
    const ctx = this.ctx;
    const a = this.model.nodeById[edgeState.from];
    const b = this.model.nodeById[edgeState.to];
    const dim = filters.edge !== 'all' && filters.edge !== edgeState.id;
    const partial = (this._partials || []).some((p) =>
      p.target === edgeState.from || p.target === edgeState.to);
    ctx.save();
    if (dim) ctx.globalAlpha = 0.18;
    const isSelected = this.selectedEdge === edgeState.id || this.hoverEdge === edgeState.id;
    ctx.lineWidth = 2 + Math.min(6, edgeState.util * 6) + (isSelected ? 2 : 0);
    if (edgeState.overcap) ctx.strokeStyle = '#e03131';
    else if (partial) ctx.strokeStyle = '#f08c00';
    else if (edgeState.util >= 0.8) ctx.strokeStyle = '#f08c00';
    else ctx.strokeStyle = '#495057';
    ctx.setLineDash(edgeState.overcap || partial ? [8, 4] : []);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    this._drawFlowDots(a, b, edgeState);
    const label = edgeState.id + ' ' + edgeState.flow + '/' + edgeState.cap;
    this._label((a.x + b.x) / 2, (a.y + b.y) / 2 - 8, label,
      edgeState.overcap ? '#e03131' : '#343a40');
    ctx.restore();
  };

  MapView.prototype._drawFlowDots = function (a, b, edgeState) {
    if (edgeState.flow <= 0) return;
    const ctx = this.ctx;
    const count = Math.max(1, Math.round(edgeState.util * 3));
    for (let i = 0; i < count; i++) {
      const t = ((this.phase + i / count) % 1);
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      ctx.fillStyle = '#1c7ed6';
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  MapView.prototype._drawNode = function (nodeState, filters) {
    const ctx = this.ctx;
    const node = this.model.nodeById[nodeState.id];
    const dim = filters.nodeType !== 'all' && filters.nodeType !== nodeState.type;
    ctx.save();
    if (dim) ctx.globalAlpha = 0.2;
    const r = nodeState.type === 'warehouse' ? 14 : 11;
    ctx.fillStyle = nodeState.outage ? '#868e96'
      : nodeState.partial ? '#f08c00' : TYPE_COLOR[nodeState.type];
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = nodeState.shortage > 0 ? '#e03131' : '#fff';
    ctx.lineWidth = nodeState.shortage > 0 ? 3 : 2;
    ctx.stroke();
    this._label(node.x, node.y - r - 8, nodeState.id, '#212529');
    const sub = nodeState.type === 'store'
      ? '缺' + nodeState.shortage : '库' + nodeState.inv;
    this._label(node.x, node.y + r + 12, sub,
      nodeState.shortage > 0 ? '#e03131' : '#495057');
    ctx.restore();
  };

  MapView.prototype._label = function (x, y, text, color) {
    const ctx = this.ctx;
    ctx.font = '12px sans-serif';
    const width = ctx.measureText(text).width + 6;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(x - width / 2, y - 10, width, 14);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y - 3);
  };

  MapView.prototype._drawLegend = function () {
    const ctx = this.ctx;
    const items = [
      ['#2f9e44', '工厂'], ['#1c7ed6', '仓库'], ['#e8590c', '商店'],
      ['#f08c00', '高负载/受限'], ['#e03131', '满载/缺货']
    ];
    items.forEach((it, i) => {
      const x = 16 + i * 128, y = this.canvas.height - 18;
      ctx.fillStyle = it[0];
      ctx.fillRect(x, y - 7, 12, 12);
      ctx.fillStyle = '#212529';
      ctx.textAlign = 'left';
      ctx.font = '12px sans-serif';
      ctx.fillText(it[1], x + 16, y);
    });
  };

  MapView.prototype.advance = function (speed) {
    this.phase = (this.phase + speed) % 1;
  };

  APP.MapView = MapView;
})(typeof window !== 'undefined' ? window : globalThis);
