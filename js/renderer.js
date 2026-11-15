/*
 * Canvas renderer: sea, reefs, harbour, lighthouse chamber, light cone,
 * ships and battery/heat gauges. Pure drawing from a simulation snapshot.
 */
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.LighthouseRenderer = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SHIP_COLORS = ['#7dd3fc', '#fcd34d', '#f9a8d4'];

  class Renderer {
    constructor(canvas, world) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.world = world;
      this.frame = 0;
    }

    draw(snapshot, hud) {
      const ctx = this.ctx;
      const w = this.canvas.width;
      const h = this.canvas.height;
      this.frame++;

      this._drawSea(ctx, w, h);
      this._drawHarbour(ctx, snapshot);
      this._drawReefs(ctx, snapshot);
      this._drawBeam(ctx, snapshot);
      this._drawLighthouse(ctx, snapshot);
      this._drawShips(ctx, snapshot);
      this._drawGauges(ctx, snapshot, hud);
      this._drawModeBanner(ctx, snapshot, w, h);
    }

    _drawSea(ctx, w, h) {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#0b1e3a');
      grad.addColorStop(1, '#061226');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(125, 211, 252, 0.07)';
      ctx.lineWidth = 1;
      const offset = (this.frame * 0.6) % 36;
      for (let y = -36 + offset; y < h; y += 36) {
        ctx.beginPath();
        for (let x = 0; x <= w; x += 24) {
          const yy = y + Math.sin((x + this.frame) / 40) * 3;
          if (x === 0) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
    }

    _drawHarbour(ctx, snap) {
      const hb = this.world.harbor;
      ctx.save();
      ctx.beginPath();
      ctx.arc(hb.x, hb.y, hb.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(52, 211, 153, 0.18)';
      ctx.fill();
      ctx.setLineDash([7, 6]);
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#a7f3d0';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('港池 HARBOUR', hb.x, hb.y + hb.r + 18);
      ctx.restore();
    }

    _drawReefs(ctx, snap) {
      for (const reef of snap.reefs) {
        ctx.beginPath();
        ctx.arc(reef.x, reef.y, reef.r, 0, Math.PI * 2);
        ctx.fillStyle = reef.lit ? '#b45309' : '#3f3f46';
        ctx.fill();
        ctx.strokeStyle = reef.lit ? '#fb923c' : '#71717a';
        ctx.lineWidth = 2;
        ctx.stroke();
        if (reef.lit) {
          ctx.strokeStyle = 'rgba(251, 146, 60, 0.5)';
          ctx.beginPath();
          ctx.arc(reef.x, reef.y, reef.r + 6, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    _drawBeam(ctx, snap) {
      if (!snap.lampOn) return;
      const c = this.world.center;
      const a0 = snap.angle - snap.beam.half;
      const a1 = snap.angle + snap.beam.half;
      const grad = ctx.createRadialGradient(
        c.x, c.y, 10, c.x, c.y, snap.beam.range);
      const hot = snap.mode === 'overheat';
      grad.addColorStop(0, hot ? 'rgba(248,113,113,0.55)' : 'rgba(254,240,138,0.5)');
      grad.addColorStop(1, 'rgba(254,240,138,0)');
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.arc(c.x, c.y, snap.beam.range, a0, a1);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    _drawLighthouse(ctx, snap) {
      const c = this.world.center;
      ctx.save();
      ctx.beginPath();
      ctx.arc(c.x, c.y, 26, 0, Math.PI * 2);
      ctx.fillStyle = snap.mode === 'overheat' ? '#7f1d1d' : '#1e293b';
      ctx.fill();
      ctx.strokeStyle = snap.mode === 'overheat' ? '#f87171' : '#94a3b8';
      ctx.lineWidth = 3;
      ctx.stroke();

      // Rotating lamp chamber.
      ctx.translate(c.x, c.y);
      ctx.rotate(snap.angle);
      ctx.fillStyle = snap.lampOn ? '#fde68a' : '#475569';
      ctx.fillRect(0, -5, 22, 10);
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, Math.PI * 2);
      ctx.fillStyle = snap.lampOn ? '#fff7cc' : '#334155';
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = '#cbd5e1';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('灯腔', c.x, c.y + 44);
    }

    _drawShips(ctx, snap) {
      snap.ships.forEach((ship, i) => {
        ctx.save();
        ctx.translate(ship.x, ship.y);
        ctx.rotate(ship.heading);
        if (ship.state === 'docked') {
          ctx.fillStyle = '#34d399';
        } else if (ship.state === 'wrecked') {
          ctx.fillStyle = '#ef4444';
        } else if (ship.state === 'lost') {
          ctx.fillStyle = '#6b7280';
        } else {
          ctx.fillStyle = SHIP_COLORS[i % SHIP_COLORS.length];
        }
        ctx.beginPath();
        ctx.moveTo(13, 0);
        ctx.lineTo(-9, -7);
        ctx.lineTo(-5, 0);
        ctx.lineTo(-9, 7);
        ctx.closePath();
        ctx.fill();
        if (ship.lit) {
          ctx.strokeStyle = 'rgba(254, 240, 138, 0.9)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(0, 0, 16, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();

        ctx.fillStyle = '#e2e8f0';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('船' + (i + 1), ship.x, ship.y - 16);
      });
    }

    _drawGauges(ctx, snap, hud) {
      const x = 14;
      let y = this.canvas.height - 78;
      const barW = 180;
      const bar = (label, value, color, warn) => {
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(label, x, y - 6);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x, y, barW, 10);
        ctx.fillStyle = warn ? '#f87171' : color;
        ctx.fillRect(x, y, barW * Math.max(0, Math.min(1, value)), 10);
        y += 24;
      };
      bar('热量 HEAT', snap.heat / 100, '#fb923c', snap.heat > 85);
      bar('危险 HAZARD', snap.hazard / 100, '#a78bfa', snap.hazard > 70);
      bar('电源 POWER', snap.power, '#38bdf8', snap.power < 0.15);

      ctx.fillStyle = '#e2e8f0';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(
        '进港 ' + snap.ships.filter((s) => s.state === 'docked').length +
        '/3   时间 ' + snap.time.toFixed(1) + 's   种子 ' + snap.seed,
        x, y + 4);
    }

    _drawModeBanner(ctx, snap, w, h) {
      if (snap.mode === 'running') return;
      const labels = {
        ready: '准备就绪 — 按开始',
        paused: '已暂停',
        overheat: '灯腔过热！强制冷却中',
        success: '三船全部进港 — 成功',
        failed: '任务失败 — 可恢复或重开'
      };
      ctx.save();
      ctx.fillStyle = 'rgba(2, 6, 23, 0.62)';
      ctx.fillRect(0, h / 2 - 34, w, 68);
      ctx.fillStyle = snap.mode === 'success' ? '#34d399'
        : snap.mode === 'failed' ? '#f87171'
        : snap.mode === 'overheat' ? '#fb923c' : '#fcd34d';
      ctx.font = 'bold 26px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(labels[snap.mode] || snap.mode, w / 2, h / 2 + 9);
      ctx.restore();
    }
  }

  return { Renderer };
});
