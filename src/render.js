/* Canvas 场景渲染：海床 / 两层海流 / 船体 / 脐带 / ROV 工具 / 接头 */
(function (root) {
  'use strict';

  class Renderer {
    constructor(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.W = canvas.width;
      this.H = canvas.height;
      this.margin = { left: 40, right: 30, top: 60, bottom: 60 };
    }

    xMap(x) {
      const span = 40;
      const w = this.W - this.margin.left - this.margin.right;
      return this.margin.left + ((x + span) / (span * 2)) * w;
    }

    zMap(z) {
      const h = this.H - this.margin.top - this.margin.bottom;
      return this.margin.top + (z / 85) * h;
    }

    draw(sim) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.W, this.H);
      this._water();
      this._currents(sim);
      this._seabed(sim);
      this._joints(sim);
      this._umbilical(sim);
      this._ship(sim);
      this._tool(sim);
      this._limits(sim);
    }

    _water() {
      const ctx = this.ctx;
      const g = ctx.createLinearGradient(0, this.margin.top, 0, this.H - this.margin.bottom);
      g.addColorStop(0, 'rgba(20,70,110,0.35)');
      g.addColorStop(1, 'rgba(4,16,28,0.9)');
      ctx.fillStyle = g;
      ctx.fillRect(this.margin.left, this.margin.top,
        this.W - this.margin.left - this.margin.right,
        this.H - this.margin.top - this.margin.bottom);
      ctx.strokeStyle = 'rgba(120,190,230,0.5)';
      ctx.beginPath();
      ctx.moveTo(this.margin.left, this.margin.top);
      ctx.lineTo(this.W - this.margin.right, this.margin.top);
      ctx.stroke();
    }

    _currents(sim) {
      const ctx = this.ctx;
      ctx.lineWidth = 1.4;
      for (const depth of [12, 30, 50, 68]) {
        const c = CableSim.currentAt(sim.time, depth);
        const y = this.zMap(depth);
        ctx.strokeStyle = `rgba(90,170,220,${0.25 + Math.min(0.4, Math.abs(c) * 0.4)})`;
        ctx.beginPath();
        for (let i = 0; i <= 24; i++) {
          const x = this.margin.left + (i / 24) * (this.W - this.margin.left - this.margin.right);
          const yy = y + Math.sin(i * 0.9 + sim.time * 1.4 * Math.sign(c || 1)) * 4;
          i === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
        }
        ctx.stroke();
        ctx.fillStyle = 'rgba(120,190,230,0.7)';
        ctx.font = '10px monospace';
        ctx.fillText(`${depth}m ${c >= 0 ? '→' : '←'}${Math.abs(c).toFixed(2)}m/s`, this.margin.left + 4, y - 5);
      }
    }

    _seabed(sim) {
      const ctx = this.ctx;
      const y = this.zMap(80);
      ctx.fillStyle = '#2a2620';
      ctx.beginPath();
      ctx.moveTo(this.margin.left, this.H);
      for (let i = 0; i <= 24; i++) {
        const x = this.margin.left + (i / 24) * (this.W - this.margin.left - this.margin.right);
        const bump = Math.sin(i * 1.7) * 5 + Math.sin(i * 0.6) * 3;
        ctx.lineTo(x, y + bump);
      }
      ctx.lineTo(this.W - this.margin.right, this.H);
      ctx.closePath();
      ctx.fill();
      void sim;
    }

    _joints(sim) {
      const ctx = this.ctx;
      sim.joints.forEach((j, idx) => {
        const x = this.xMap(j.x);
        const y = this.zMap(j.z);
        ctx.strokeStyle = j.spliced ? '#35d07f' : j.cut ? '#f2b134' : '#8fb4cf';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y - 4, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.font = '11px monospace';
        const state = j.spliced ? '接头完成' : j.cut ? '已切割' : j.located ? '已定位' : '待作业';
        ctx.fillText(`J${idx + 1} ${state}`, x - 28, y + 18);
      });
    }

    _ship(sim) {
      const ctx = this.ctx;
      const x = this.xMap(sim.ship.x);
      const y = this.margin.top - 18;
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = sim.thrusters.port.healthy ? '#cfe2f2' : '#e0a23b';
      ctx.beginPath();
      ctx.moveTo(-34, 14); ctx.lineTo(34, 14); ctx.lineTo(24, 0); ctx.lineTo(-26, 0);
      ctx.closePath(); ctx.fill();
      ctx.fillRect(-6, -12, 12, 12);
      // 推进器箭头
      const thrust = sim.ship.thrust / sim.cfg.SHIP_THRUST_MAX;
      if (Math.abs(thrust) > 0.02) {
        ctx.strokeStyle = '#4aa8ff';
        ctx.beginPath();
        ctx.moveTo(thrust > 0 ? 30 : -30, 10);
        ctx.lineTo(thrust > 0 ? 30 + thrust * 22 : -30 + thrust * 22, 10);
        ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = '#7fa3bd';
      ctx.font = '11px monospace';
      ctx.fillText(`船 x=${sim.ship.x.toFixed(1)}m`, x - 30, y - 18);
    }

    _umbilical(sim) {
      const ctx = this.ctx;
      const u = sim.umbilical;
      const x0 = this.xMap(sim.ship.x);
      const y0 = this.margin.top - 4;
      const x1 = this.xMap(sim.tool.x);
      const y1 = this.zMap(u.z);
      if (u.broken) {
        ctx.strokeStyle = '#ef5d5d';
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo((x0 + x1) / 2, (y0 + y1) / 2 - 14);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ef5d5d';
        ctx.fillText('脐带断裂', (x0 + x1) / 2 - 24, (y0 + y1) / 2 - 20);
        return;
      }
      const ratio = u.tension / sim.cfg.TENSION_BREAK;
      const color = ratio > 0.8 ? '#ef5d5d' : ratio > 0.6 ? '#f2b134' : '#9fd0ef';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      // 悬链线：控制点向海流方向偏移
      const cx = (x0 + x1) / 2 + u.offset * 1.6;
      const cy = (y0 + y1) / 2 + 10;
      ctx.quadraticCurveTo(cx, cy, x1, y1);
      ctx.stroke();
    }

    _tool(sim) {
      const ctx = this.ctx;
      const x = this.xMap(sim.tool.x);
      const y = this.zMap(sim.tool.z);
      ctx.fillStyle = '#ffd479';
      ctx.fillRect(x - 9, y - 6, 18, 12);
      ctx.fillStyle = '#122233';
      ctx.font = '10px monospace';
      ctx.fillText(sim.tool.name, x - 16, y + 22);
      if (sim.tool.phase) {
        ctx.fillStyle = '#35d07f';
        ctx.fillText(sim.tool.progressText, x - 16, y + 34);
      }
    }

    _limits(sim) {
      const ctx = this.ctx;
      const yTop = this.margin.top - 24;
      const yBot = this.H - this.margin.bottom + 6;
      for (const lim of [-sim.cfg.DRIFT_LIMIT, sim.cfg.DRIFT_LIMIT]) {
        const x = this.xMap(lim);
        ctx.strokeStyle = 'rgba(239,93,93,0.55)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, yTop);
        ctx.lineTo(x, yBot);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ef5d5d';
        ctx.font = '10px monospace';
        ctx.fillText(`漂移限值 ${lim}m`, x - 30, yTop);
      }
    }

    // __APPEND__
  }

  root.Renderer = Renderer;
})(window);
