import { WORLD, ROADS, DANGERS } from '../src/core/world.js';

export class Pane {
  constructor(canvas, side) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.side = side;
    this.scale = 1;
    this.targetScale = 1;
    this.panX = 0;
    this.panY = 0;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
    this.baseScale = Math.min(rect.width / WORLD.width, rect.height / WORLD.height);
  }

  autoZoom(clock) {
    const wave = Math.sin(clock / 9000) * 0.18;
    this.targetScale = this.baseScale * (1 + wave) * (this.side === 'left' ? 1 : 1.05);
    this.scale += (this.targetScale - this.scale) * 0.08;
  }

  toWorld(event) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    return {
      x: (sx - this.width / 2) / this.scale + WORLD.width / 2,
      y: (sy - this.height / 2) / this.scale + WORLD.height / 2
    };
  }

  project(x, y) {
    return [
      (x - WORLD.width / 2) * this.scale + this.width / 2,
      (y - WORLD.height / 2) * this.scale + this.height / 2
    ];
  }

  drawLine(x1, y1, x2, y2, color, width) {
    const [a, b] = this.project(x1, y1);
    const [c, d] = this.project(x2, y2);
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = width;
    this.ctx.beginPath();
    this.ctx.moveTo(a, b);
    this.ctx.lineTo(c, d);
    this.ctx.stroke();
  }

  render(state, highlightMarkerId = null) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#101826';
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.strokeStyle = 'rgba(148,163,184,0.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= WORLD.width; x += 100) this.drawLine(x, 0, x, WORLD.height, 'rgba(148,163,184,0.08)', 1);
    for (let y = 0; y <= WORLD.height; y += 100) this.drawLine(0, y, WORLD.width, y, 'rgba(148,163,184,0.08)', 1);

    for (const road of ROADS) {
      const service = road.id.startsWith('S') || road.id.startsWith('V');
      this.drawLine(road.x1, road.y1, road.x2, road.y2,
        service ? '#334155' : '#475569', service ? 4 : 7);
      this.drawLine(road.x1, road.y1, road.x2, road.y2,
        service ? '#64748b' : '#94a3b8', service ? 1.5 : 2);
    }

    for (const danger of DANGERS) {
      const [x, y] = this.project(danger.x, danger.y);
      const verified = state.verifiedDangers.includes(danger.id);
      ctx.fillStyle = verified ? '#22c55e' : '#ef4444';
      ctx.beginPath();
      ctx.arc(x, y, verified ? 6 : 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#f8fafc';
      ctx.stroke();
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '11px sans-serif';
      ctx.fillText(danger.id, x + 10, y - 8);
    }

    for (const route of state.routes) {
      const color = route.accepted ? '#38bdf8' : '#f97316';
      route.points.forEach(([x, y], i) => {
        if (i === 0) return;
        const [px, py] = route.points[i - 1];
        this.drawLine(px, py, x, y, color, 4);
      });
    }
    if (state.routeDraft.length > 1) {
      state.routeDraft.forEach(([x, y], i) => {
        if (i === 0) return;
        const [px, py] = state.routeDraft[i - 1];
        this.drawLine(px, py, x, y, '#a78bfa', 3);
      });
    }

    for (const marker of state.markers) {
      const [x, y] = this.project(marker.x, marker.y);
      const highlight = marker.id === highlightMarkerId;
      ctx.fillStyle = marker.verified ? '#22c55e' : marker.rejected ? '#ef4444' : '#facc15';
      ctx.beginPath();
      ctx.arc(x, y, highlight ? 11 : 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = highlight ? '#ffffff' : '#0f172a';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (marker.verified) {
        ctx.strokeStyle = '#bbf7d0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - 4, y);
        ctx.lineTo(x - 1, y + 4);
        ctx.lineTo(x + 5, y - 4);
        ctx.stroke();
      }
    }

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '13px sans-serif';
    ctx.fillText(`${this.side === 'left' ? '左：标注员' : '右：验证员'} 缩放 ${(this.scale / this.baseScale).toFixed(2)}x`, 12, 20);
  }
}
