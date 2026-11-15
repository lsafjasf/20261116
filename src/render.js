import * as C from './config.js';

// Split-screen canvas renderer. Left: upstream pool + sluice gate.
// Right: controlled channel, pumping station and the protected street.
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  draw(sim, recording, currentTick) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0d1420';
    ctx.fillRect(0, 0, w, h);

    this.drawLeft(ctx, 0, 0, w / 2, h, sim);
    this.drawRight(ctx, w / 2, 0, w / 2, h, sim);
    this.drawOverlays(ctx, w, h, sim, recording, currentTick);
  }

  waterY(level, maxLevel, top, bottom) {
    const f = Math.max(0, Math.min(1, level / maxLevel));
    return bottom - f * (bottom - top);
  }

  drawLeft(ctx, x, y, w, h, sim) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = '#101c2c';
    ctx.fillRect(x, y, w, h);

    const groundY = y + h - 60;
    const maxLevel = 6;
    const upY = this.waterY(sim.upstreamLevel, maxLevel, y + 30, groundY);
    const chY = this.waterY(sim.channelLevel, maxLevel, y + 30, groundY);

    // upstream pool
    ctx.fillStyle = '#1f6feb';
    ctx.fillRect(x + 20, upY, w * 0.42, groundY - upY);
    // channel water
    ctx.fillStyle = '#2f81f7';
    ctx.fillRect(x + w * 0.5, chY, w * 0.5 - 20, groundY - chY);

    // bank line
    ctx.strokeStyle = '#5b7186';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + 20, groundY);
    ctx.lineTo(x + w - 20, groundY);
    ctx.stroke();

    // gate structure
    const gateX = x + w * 0.46;
    const gateH = sim.gate.position * 120;
    ctx.fillStyle = '#c9d4e3';
    ctx.fillRect(gateX, groundY - gateH - 40, 18, gateH + 40);
    ctx.fillStyle = '#f5a524';
    ctx.fillRect(gateX - 3, groundY - gateH - 46, 24, 8);

    this.label(ctx, x + 12, y + 22, 'P1 上游闸门 / Upstream Gate', '#e6edf3');
    this.gauge(ctx, x + 24, y + 44, 150, '上游水位', sim.upstreamLevel.toFixed(2) + ' m');
    this.gauge(ctx, x + 24, y + 70, 150, '闸门开度', Math.round(sim.gate.position * 100) + '%');
    this.gauge(ctx, x + 24, y + 96, 150, '来流', sim.inflow.toFixed(1) + ' m³/s');
    ctx.restore();
  }

  drawRight(ctx, x, y, w, h, sim) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = '#0f1a29';
    ctx.fillRect(x, y, w, h);

    const groundY = y + h - 60;
    const maxLevel = 6;
    const chY = this.waterY(sim.channelLevel, maxLevel, y + 30, groundY);
    ctx.fillStyle = '#2f81f7';
    ctx.fillRect(x + 20, chY, w * 0.55, groundY - chY);

    // bank + street
    ctx.strokeStyle = '#5b7186';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + 20, groundY);
    ctx.lineTo(x + w - 20, groundY);
    ctx.stroke();
    const streetH = Math.min(46, sim.streetDepth * 120);
    ctx.fillStyle = sim.streetDepth > 0 ? '#7d2f3a' : '#3a4a5e';
    ctx.fillRect(x + w * 0.62, groundY - streetH, w * 0.3, streetH);

    // pump station
    const px = x + w * 0.62;
    ctx.fillStyle = sim.pump.tripped ? '#e5484d' : '#36b37e';
    ctx.fillRect(px, groundY - 90, 46, 90);
    ctx.fillStyle = '#0d1420';
    ctx.fillRect(px + 8, groundY - 70, 30, 10 + (1 - sim.pump.speed) * 40);

    this.label(ctx, x + 12, y + 22, 'P2 下游泵站 / Pump Station', '#e6edf3');
    this.gauge(ctx, x + 24, y + 44, 170, '渠道水位', sim.channelLevel.toFixed(2) + ' m');
    this.gauge(ctx, x + 24, y + 70, 170, '泵速', Math.round(sim.pump.speed * 100) + '%');
    this.gauge(ctx, x + 24, y + 96, 170, '机温', sim.pump.heat.toFixed(0) + ' ℃');
    this.gauge(ctx, x + 24, y + 122, 170, '街区积水', sim.streetDepth.toFixed(3) + ' m');
    this.gauge(ctx, x + 24, y + 148, 170, '耐久', sim.pump.durability + '%');
    ctx.restore();
  }

  label(ctx, x, y, text, color) {
    ctx.fillStyle = color;
    ctx.font = 'bold 14px monospace';
    ctx.fillText(text, x, y);
  }

  gauge(ctx, x, y, w, name, value) {
    ctx.font = '12px monospace';
    ctx.fillStyle = '#8aa0b8';
    ctx.fillText(name, x, y);
    ctx.fillStyle = '#e6edf3';
    ctx.fillText(value, x + w, y);
  }

  drawOverlays(ctx, w, h, sim, recording, currentTick) {
    // Pressure bar across the top center.
    const barW = 320;
    const bx = w / 2 - barW / 2;
    const by = 8;
    ctx.fillStyle = '#1b2735';
    ctx.fillRect(bx, by, barW, 14);
    const norm = Math.min(1, sim.pressure / (C.PRESSURE_CRITICAL * 1.4));
    const color =
      sim.pressure >= C.PRESSURE_CRITICAL
        ? '#e5484d'
        : sim.pressure >= C.PRESSURE_WARN
          ? '#f5a524'
          : '#36b37e';
    ctx.fillStyle = color;
    ctx.fillRect(bx, by, barW * norm, 14);
    ctx.strokeStyle = '#46566b';
    ctx.strokeRect(bx, by, barW, 14);
    ctx.font = '11px monospace';
    ctx.fillStyle = '#e6edf3';
    ctx.fillText(`压力差 ${sim.pressure.toFixed(2)} kPa`, bx, by + 26);

    // Mission progress.
    const progress = (sim.tick / C.TOTAL_TICKS) * 100;
    ctx.fillStyle = '#8aa0b8';
    ctx.fillText(`任务进度 ${progress.toFixed(1)}%  t=${sim.simSeconds.toFixed(0)}s`, bx + 150, by + 26);

    // Conflict markers from the shared timeline at their exact ticks.
    if (recording) {
      for (const conflict of recording.timeline.conflicts) {
        if (Math.abs(conflict.tick - currentTick) <= 2) {
          this.flag(ctx, w / 2 - 8, h / 2, '冲突 ' + conflict.object + ' @' + conflict.position);
        }
      }
      const collisions = recording.timeline.events.filter(
        (e) => e.type === 'structural_collision'
      );
      for (const event of collisions) {
        if (Math.abs(event.tick - currentTick) <= 2) {
          this.flag(ctx, 24, h / 2 + 30, '结构碰撞 ' + event.pressure + 'kPa @' + event.position, '#e5484d');
        }
      }
    }

    if (sim.ended) {
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      ctx.fillRect(0, h / 2 - 40, w, 80);
      ctx.font = 'bold 26px monospace';
      ctx.fillStyle = sim.ended.result === 'success' ? '#36b37e' : '#e5484d';
      ctx.textAlign = 'center';
      ctx.fillText(
        sim.ended.result === 'success' ? '调度成功：30 分钟安全水位' : '调度失败：' + sim.ended.reason,
        w / 2,
        h / 2 + 8
      );
      ctx.textAlign = 'left';
    }
  }

  flag(ctx, x, y, text, color = '#f5a524') {
    ctx.font = 'bold 12px monospace';
    const width = ctx.measureText(text).width + 14;
    ctx.fillStyle = 'rgba(13,20,32,0.9)';
    ctx.fillRect(x, y - 16, width, 22);
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y - 16, width, 22);
    ctx.fillStyle = color;
    ctx.fillText(text, x + 7, y);
  }
}
