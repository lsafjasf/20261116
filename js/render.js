/* Canvas 弧线图渲染器：节点、贝塞尔弧线、流量标签、命中检测与拖动热区。 */
(function (root) {
  'use strict';

  var NODE_LAYOUT = {
    grid: { x: 90, y: 120 },
    transformer: { x: 280, y: 120 },
    mcc: { x: 470, y: 120 },
    chiller: { x: 680, y: 70 },
    pump: { x: 680, y: 200 },
    hvac: { x: 680, y: 330 },
    boiler: { x: 280, y: 380 },
    sink: { x: 900, y: 200 },
    env: { x: 1080, y: 440 }
  };
  var NODE_R = 30;
  var HIT_PADDING = 14;
  var DESIGN_WIDTH = 1180;
  var DESIGN_HEIGHT = 560;

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.nodePos = NODE_LAYOUT;
    this.edgeGeom = [];
    this.hoverEdge = null;
  }

  Renderer.prototype.resize = function () {
    var dpr = window.devicePixelRatio || 1;
    var rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.width = rect.width;
    this.height = rect.height;
    // 等比缩放设计坐标系，窄屏下整张图完整可见，命中坐标同步换算。
    this.scale = Math.min(rect.width / DESIGN_WIDTH, rect.height / DESIGN_HEIGHT);
    this.offsetX = (rect.width - DESIGN_WIDTH * this.scale) / 2;
    this.offsetY = (rect.height - DESIGN_HEIGHT * this.scale) / 2;
    this.ctx.setTransform(
      dpr * this.scale, 0, 0, dpr * this.scale,
      dpr * this.offsetX, dpr * this.offsetY
    );
  };

  function edgePath(ctx, p0, p1, bend) {
    var mx = (p0.x + p1.x) / 2;
    var my = (p0.y + p1.y) / 2;
    var dx = p1.x - p0.x;
    var dy = p1.y - p0.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var cx = mx - (dy / len) * bend;
    var cy = my + (dx / len) * bend;
    ctx.moveTo(p0.x, p0.y);
    ctx.quadraticCurveTo(cx, cy, p1.x, p1.y);
    return { cx: cx, cy: cy };
  }

  Renderer.prototype.draw = function (graph) {
    var ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    this.edgeGeom = [];

    var maxFlow = 1;
    graph.edges.forEach(function (e) {
      if (e.kind === 'flow' && e.value > maxFlow) maxFlow = e.value;
    });

    var self = this;
    graph.edges.forEach(function (edge, idx) {
      var p0 = self.nodePos[edge.from];
      var p1 = self.nodePos[edge.to];
      if (!p0 || !p1) return;
      var isLoss = edge.kind !== 'flow';
      var bend = isLoss ? 60 + (idx % 3) * 16 : ((idx % 2 === 0) ? 26 : -26);
      self._drawEdge(edge, p0, p1, bend, maxFlow);
    });

    this._drawNodes(graph);
  };

  Renderer.prototype._drawEdge = function (edge, p0, p1, bend, maxFlow) {
    var ctx = this.ctx;
    var start = { x: p0.x, y: p0.y };
    var end = { x: p1.x, y: p1.y };

    ctx.save();
    ctx.beginPath();
    var ctrl = edgePath(ctx, start, end, bend);

    var width;
    if (edge.kind === 'flow') {
      width = 1.5 + (edge.value / maxFlow) * 7;
    } else {
      width = 1.5 + Math.min(6, edge.value / 40);
    }
    var hovered = this.hoverEdge === edge.id;
    ctx.lineWidth = width + (hovered ? 2.5 : 0);
    ctx.strokeStyle = edge.color;
    ctx.globalAlpha = edge.value < 0.05 ? 0.25 : (hovered ? 1 : 0.85);
    if (edge.kind === 'loss-abnormal') {
      ctx.setLineDash([7, 5]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    this._drawArrow(start, end, ctrl, edge.color);
    this._drawLabel(edge, start, end, ctrl, hovered);
    ctx.restore();

    this.edgeGeom.push({
      id: edge.id, start: start, end: end, ctrl: ctrl,
      bend: bend, kind: edge.kind
    });
  };

  Renderer.prototype._drawArrow = function (start, end, ctrl, color) {
    var ctx = this.ctx;
    var t = 0.88;
    var x = (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * ctrl.cx + t * t * end.x;
    var y = (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * ctrl.cy + t * t * end.y;
    var dx = 2 * (1 - t) * (ctrl.cx - start.x) + 2 * t * (end.x - ctrl.cx);
    var dy = 2 * (1 - t) * (ctrl.cy - start.y) + 2 * t * (end.y - ctrl.cy);
    var ang = Math.atan2(dy, dx);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-8, -4.5);
    ctx.lineTo(-8, 4.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  Renderer.prototype._drawLabel = function (edge, start, end, ctrl, hovered) {
    var ctx = this.ctx;
    var lx = 0.25 * start.x + 0.5 * ctrl.cx + 0.25 * end.x;
    var ly = 0.25 * start.y + 0.5 * ctrl.cy + 0.25 * end.y;
    var text = Math.round(edge.value * 10) / 10 + ' kWh';
    ctx.font = (hovered ? 'bold 11px ' : '11px ') +
      '-apple-system, "PingFang SC", sans-serif';
    var w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(15,20,28,0.82)';
    ctx.fillRect(lx - w / 2 - 4, ly - 9, w + 8, 16);
    ctx.strokeStyle = edge.color;
    ctx.lineWidth = 1;
    ctx.strokeRect(lx - w / 2 - 4, ly - 9, w + 8, 16);
    ctx.fillStyle = hovered ? '#ffffff' : '#cdd8e6';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx, ly);
  };

  Renderer.prototype._drawNodes = function (graph) {
    var ctx = this.ctx;
    var self = this;
    graph.nodes.forEach(function (n) {
      var p = self.nodePos[n.id];
      if (!p) return;
      ctx.beginPath();
      ctx.arc(p.x, p.y, NODE_R, 0, Math.PI * 2);
      var grad = ctx.createRadialGradient(p.x - 8, p.y - 8, 4, p.x, p.y, NODE_R);
      grad.addColorStop(0, '#2c3a4f');
      grad.addColorStop(1, '#1a2331');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = n.lossRatio >= 0.12 ? '#d64545'
        : n.lossRatio >= 0.05 ? '#e0a32e' : '#41506a';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#eef3fa';
      ctx.font = '600 11px -apple-system, "PingFang SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.name, p.x, p.y - 4);
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.fillStyle = '#9fb2cc';
      ctx.fillText(Math.round(n.inflow) + '/' + Math.round(n.outflow), p.x, p.y + 10);
    });
  };

  // 点到二次贝塞尔曲线距离（采样近似，足够命中检测）。
  Renderer.prototype.hitTest = function (x, y) {
    x = (x - this.offsetX) / this.scale;
    y = (y - this.offsetY) / this.scale;
    var best = null;
    var bestDist = HIT_PADDING;
    this.edgeGeom.forEach(function (g) {
      for (var i = 0; i <= 20; i++) {
        var t = i / 20;
        var px = (1 - t) * (1 - t) * g.start.x + 2 * (1 - t) * t * g.ctrl.cx + t * t * g.end.x;
        var py = (1 - t) * (1 - t) * g.start.y + 2 * (1 - t) * t * g.ctrl.cy + t * t * g.end.y;
        var d = Math.hypot(px - x, py - y);
        if (d < bestDist) {
          bestDist = d;
          best = g;
        }
      }
    });
    return best ? best.id : null;
  };

  Renderer.prototype.dragEdgeValue = function (edge, startY, currentY) {
    // 向上拖增加、向下拖减少；每像素 2 kWh。
    var delta = (startY - currentY) * 2;
    return edge.value + delta;
  };

  root.FlowRenderer = Renderer;
})(window);
