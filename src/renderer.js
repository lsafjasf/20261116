import {
  OFFSET_SAFE,
  PRESSURE_MAX,
  PRESSURE_MIN,
  objectPositions
} from './engine.js';

const TAU = Math.PI * 2;
const VIEW_W = 1180;
const VIEW_H = 620;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, r);
}

function metalGradient(ctx, x0, y0, x1, y1) {
  const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
  gradient.addColorStop(0, '#2a3840');
  gradient.addColorStop(0.22, '#718089');
  gradient.addColorStop(0.38, '#394951');
  gradient.addColorStop(0.7, '#17262d');
  gradient.addColorStop(1, '#0b151a');
  return gradient;
}

function glow(ctx, x, y, radius, color) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();
}

export class StageRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bounds = { width: VIEW_W, height: VIEW_H, scale: 1, offsetX: 0, offsetY: 0 };
    this.dpr = 1;
    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    this.sizingObserver = new ResizeObserver(this.resize);
    this.sizingObserver.observe(canvas);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    const scale = Math.min(rect.width / VIEW_W, rect.height / VIEW_H);
    this.bounds = {
      width: rect.width,
      height: rect.height,
      scale,
      offsetX: (rect.width - VIEW_W * scale) / 2,
      offsetY: (rect.height - VIEW_H * scale) / 2
    };
  }

  draw(state, wallTime = 0, options = {}) {
    const ctx = this.ctx;
    const { width, height, scale, offsetX, offsetY } = this.bounds;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#071117';
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    this.drawBackdrop(ctx, state, wallTime);
    this.drawStation(ctx, state, wallTime, options);
    ctx.restore();
  }

  drawBackdrop(ctx, state, time) {
    const horizon = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    horizon.addColorStop(0, 'rgba(11, 29, 37, 0.7)');
    horizon.addColorStop(0.56, 'rgba(6, 16, 22, 0.25)');
    horizon.addColorStop(1, 'rgba(2, 6, 9, 0.92)');
    ctx.fillStyle = horizon;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    ctx.save();
    ctx.globalAlpha = 0.26;
    ctx.strokeStyle = '#31505c';
    ctx.lineWidth = 1;
    for (let y = 425; y < VIEW_H; y += 24) {
      const spread = (y - 425) * 0.4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(VIEW_W, y);
      ctx.stroke();
      ctx.globalAlpha *= 0.2;
      ctx.beginPath();
      ctx.moveTo(590 - spread, y);
      ctx.lineTo(590 + spread, y);
      ctx.stroke();
      ctx.globalAlpha = 0.26;
    }
    for (let x = -700; x <= 700; x += 82) {
      ctx.beginPath();
      ctx.moveTo(590 + x * 0.2, 425);
      ctx.lineTo(590 + x, VIEW_H);
      ctx.stroke();
    }
    ctx.restore();

    const sweep = ((time * 0.025) % 1) * VIEW_W;
    const scan = ctx.createLinearGradient(sweep - 90, 0, sweep + 90, 0);
    scan.addColorStop(0, 'rgba(88,224,220,0)');
    scan.addColorStop(0.5, 'rgba(88,224,220,0.025)');
    scan.addColorStop(1, 'rgba(88,224,220,0)');
    ctx.fillStyle = scan;
    ctx.fillRect(sweep - 90, 0, 180, VIEW_H);

    ctx.strokeStyle = 'rgba(137, 180, 190, 0.12)';
    ctx.setLineDash([3, 12]);
    ctx.beginPath();
    ctx.moveTo(590, 48);
    ctx.lineTo(590, 566);
    ctx.stroke();
    ctx.setLineDash([]);

    const pressureDanger = state.pressure > PRESSURE_MAX;
    glow(
      ctx,
      590,
      345,
      230,
      pressureDanger ? 'rgba(255, 107, 97, 0.08)' : 'rgba(88, 224, 220, 0.055)'
    );
  }

  drawStation(ctx, state, time, options) {
    this.drawGantry(ctx, state, time);
    this.drawBaseFixture(ctx, state, time);

    const positions = objectPositions(state);
    this.drawBase(ctx, state, positions, time);
    this.drawAlignmentGuide(ctx, state, positions, time);
    this.drawGasket(ctx, state, positions, time);
    this.drawModule(ctx, state, positions, time);
    this.drawPressHead(ctx, state, positions, time);
    this.drawClamp(ctx, state, positions, time);
    this.drawSensorCallouts(ctx, state, positions, time, options);
    this.drawStationHud(ctx, state, time, options);
  }

  drawGantry(ctx, state, time) {
    ctx.save();
    ctx.fillStyle = 'rgba(2, 7, 10, 0.55)';
    ctx.beginPath();
    ctx.ellipse(590, 540, 300, 46, 0, 0, TAU);
    ctx.fill();

    const frameGradient = metalGradient(ctx, 250, 95, 930, 150);
    ctx.fillStyle = frameGradient;
    ctx.fillRect(252, 88, 676, 18);
    ctx.fillStyle = '#0b171d';
    ctx.fillRect(276, 106, 22, 325);
    ctx.fillRect(882, 106, 22, 325);
    ctx.strokeStyle = 'rgba(151, 210, 217, 0.34)';
    ctx.lineWidth = 1;
    ctx.strokeRect(276.5, 106.5, 21, 324);
    ctx.strokeRect(882.5, 106.5, 21, 324);

    for (let x = 306; x < 875; x += 44) {
      ctx.fillStyle = x % 88 === 0 ? '#15262e' : '#101f26';
      ctx.fillRect(x, 95, 22, 5);
    }

    const lampPulse = 0.55 + Math.sin(time * 0.004) * 0.2;
    ctx.fillStyle = `rgba(88, 224, 220, ${lampPulse})`;
    ctx.fillRect(568, 108, 44, 3);
    ctx.fillStyle = 'rgba(88, 224, 220, 0.1)';
    ctx.fillRect(546, 111, 88, 1);

    ctx.fillStyle = '#102028';
    ctx.fillRect(533, 106, 114, 28);
    ctx.strokeStyle = 'rgba(151, 210, 217, 0.23)';
    ctx.strokeRect(533.5, 106.5, 113, 27);
    ctx.fillStyle = '#5d727a';
    ctx.font = '600 8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('HEAD / P-02', 590, 122);

    ctx.strokeStyle = 'rgba(120, 231, 163, 0.35)';
    ctx.beginPath();
    ctx.moveTo(287, 145);
    ctx.lineTo(287, 230);
    ctx.moveTo(893, 145);
    ctx.lineTo(893, 230);
    ctx.stroke();

    ctx.fillStyle = '#0c191f';
    ctx.fillRect(433, 132, 314, 17);
    ctx.fillStyle = '#31434b';
    for (let x = 445; x < 735; x += 18) ctx.fillRect(x, 137, 8, 2);
    ctx.restore();
  }

  drawBaseFixture(ctx, state, time) {
    ctx.save();
    ctx.fillStyle = '#09141a';
    ctx.beginPath();
    ctx.moveTo(412, 458);
    ctx.lineTo(768, 458);
    ctx.lineTo(836, 532);
    ctx.lineTo(344, 532);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(151, 210, 217, 0.24)';
    ctx.stroke();

    const top = ctx.createLinearGradient(380, 430, 800, 470);
    top.addColorStop(0, '#15262e');
    top.addColorStop(0.5, '#30454e');
    top.addColorStop(1, '#0e1c23');
    ctx.fillStyle = top;
    ctx.beginPath();
    ctx.moveTo(392, 422);
    ctx.lineTo(788, 422);
    ctx.lineTo(824, 468);
    ctx.lineTo(356, 468);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(151, 210, 217, 0.4)';
    ctx.stroke();

    ctx.strokeStyle = 'rgba(88, 224, 220, 0.22)';
    ctx.lineWidth = 1;
    for (let y = 474; y < 526; y += 13) {
      ctx.beginPath();
      ctx.moveTo(373 + (y - 468) * 0.7, y);
      ctx.lineTo(807 - (y - 468) * 0.7, y);
      ctx.stroke();
    }

    ctx.fillStyle = '#050b0f';
    ctx.fillRect(414, 476, 42, 20);
    ctx.fillRect(724, 476, 42, 20);
    ctx.fillStyle = '#486068';
    for (let x = 420; x < 452; x += 7) ctx.fillRect(x, 481, 3, 7);
    for (let x = 730; x < 762; x += 7) ctx.fillRect(x, 481, 3, 7);

    ctx.fillStyle = 'rgba(88, 224, 220, 0.72)';
    const blink = Math.sin(time * 0.006) > 0.2;
    if (blink) ctx.fillRect(585, 493, 10, 2);
    ctx.fillStyle = '#192a31';
    ctx.fillRect(554, 489, 72, 10);
    ctx.strokeStyle = 'rgba(151, 210, 217, 0.2)';
    ctx.strokeRect(554.5, 489.5, 71, 9);
    ctx.fillStyle = '#617880';
    ctx.font = '6px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('TANDEM BASE / 07', 590, 496);
    ctx.restore();
  }

  drawBase(ctx, state, positions, time) {
    const position = positions.base;
    ctx.save();
    ctx.translate(position.x, position.y);
    const tilt = clamp((state.offset - OFFSET_SAFE) * 0.0016, -0.035, 0.08);
    ctx.rotate(tilt);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.ellipse(0, 23, 67, 15, 0, 0, TAU);
    ctx.fill();

    ctx.fillStyle = metalGradient(ctx, -74, -30, 74, 34);
    roundedRect(ctx, -72, -18, 144, 44, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(166, 197, 202, 0.45)';
    ctx.stroke();

    ctx.fillStyle = '#091218';
    roundedRect(ctx, -55, -34, 110, 21, 4);
    ctx.fill();
    ctx.strokeStyle = state.offset <= OFFSET_SAFE
      ? 'rgba(88, 224, 220, 0.38)'
      : 'rgba(243, 179, 93, 0.3)';
    ctx.stroke();

    for (let x = -46; x <= 46; x += 23) {
      ctx.fillStyle = '#2e4149';
      ctx.fillRect(x - 4, -7, 8, 4);
    }

    ctx.fillStyle = 'rgba(88, 224, 220, 0.72)';
    ctx.fillRect(-29, 10, 17, 2);
    ctx.fillStyle = 'rgba(151, 210, 217, 0.45)';
    ctx.fillRect(15, 10, 18, 2);

    if (state.leftHeld) {
      ctx.strokeStyle = 'rgba(88, 224, 220, 0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(-75, -21, 150, 50);
    }
    ctx.restore();
  }

  drawAlignmentGuide(ctx, state, positions, time) {
    const module = positions.module;
    const safe = state.offset <= OFFSET_SAFE;
    ctx.save();
    ctx.strokeStyle = safe ? 'rgba(120, 231, 163, 0.17)' : 'rgba(243, 179, 93, 0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 7]);
    ctx.beginPath();
    ctx.arc(590, 371, 82, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = safe ? 'rgba(120, 231, 163, 0.55)' : 'rgba(243, 179, 93, 0.6)';
    ctx.beginPath();
    ctx.moveTo(590 - 15, 371);
    ctx.lineTo(590 - 5, 371);
    ctx.moveTo(590 + 5, 371);
    ctx.lineTo(590 + 15, 371);
    ctx.moveTo(590, 361);
    ctx.lineTo(590, 366);
    ctx.stroke();

    const drift = module.x - 590;
    if (Math.abs(drift) > 1) {
      ctx.strokeStyle = 'rgba(255, 107, 97, 0.42)';
      ctx.beginPath();
      ctx.moveTo(590, 264);
      ctx.lineTo(module.x, 264);
      ctx.stroke();
      for (let side = -1; side <= 1; side += 2) {
        ctx.beginPath();
        ctx.moveTo(module.x + side * 6, 260);
        ctx.lineTo(module.x, 264);
        ctx.lineTo(module.x + side * 6, 268);
        ctx.stroke();
      }
    }

    ctx.fillStyle = safe ? 'rgba(120, 231, 163, 0.85)' : 'rgba(243, 179, 93, 0.9)';
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(safe ? 'ALIGN LOCK' : `DRIFT ${state.offset.toFixed(1)}mm`, 590, 458);
    ctx.restore();
  }

  drawGasket(ctx, state, positions, time) {
    const gasket = positions.gasket;
    const danger = state.pressure > PRESSURE_MAX;
    const crush = state.pressure > 85;
    const pulse = 0.5 + Math.sin(time * 0.009) * 0.18;
    ctx.save();
    ctx.translate(gasket.x, gasket.y);
    ctx.fillStyle = crush ? `rgba(255, 107, 97, ${0.15 + pulse * 0.1})` : 'rgba(243, 179, 93, 0.08)';
    ctx.beginPath();
    ctx.arc(0, 0, danger ? 47 : 40, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = danger
      ? `rgba(255, 107, 97, ${0.55 + pulse * 0.3})`
      : 'rgba(243, 179, 93, 0.52)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 230, 180, 0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 23, 0, TAU);
    ctx.stroke();

    ctx.fillStyle = crush ? 'rgba(255, 107, 97, 0.22)' : 'rgba(243, 179, 93, 0.1)';
    ctx.beginPath();
    ctx.arc(-9, -4, 5, 0, TAU);
    ctx.arc(8, 5, 3, 0, TAU);
    ctx.fill();

    if (state.pressure >= PRESSURE_MIN && state.pressure <= PRESSURE_MAX) {
      ctx.strokeStyle = `rgba(120, 231, 163, ${0.48 + pulse * 0.2})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 8]);
      ctx.beginPath();
      ctx.arc(0, 0, 36, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  drawModule(ctx, state, positions, time) {
    const module = positions.module;
    ctx.save();
    ctx.translate(module.x, module.y);
    const pressureOffset = clamp(state.pressure * 0.07, 0, 7);
    ctx.translate(0, pressureOffset);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.46)';
    ctx.beginPath();
    ctx.ellipse(0, 72, 80, 13, 0, 0, TAU);
    ctx.fill();

    const body = ctx.createLinearGradient(-74, -45, 75, 72);
    body.addColorStop(0, '#34464e');
    body.addColorStop(0.18, '#7d8c91');
    body.addColorStop(0.34, '#2b3a41');
    body.addColorStop(0.72, '#14252c');
    body.addColorStop(1, '#09161c');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(-72, -34);
    ctx.lineTo(72, -34);
    ctx.lineTo(61, 55);
    ctx.lineTo(-61, 55);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(169, 205, 212, 0.47)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#071319';
    ctx.beginPath();
    ctx.moveTo(-54, -24);
    ctx.lineTo(54, -24);
    ctx.lineTo(48, 12);
    ctx.lineTo(-48, 12);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(88, 224, 220, 0.23)';
    ctx.beginPath();
    ctx.moveTo(-46, 31);
    ctx.lineTo(46, 31);
    ctx.stroke();
    ctx.fillStyle = 'rgba(88, 224, 220, 0.72)';
    ctx.fillRect(-30, 36, 13, 2);
    ctx.fillStyle = 'rgba(243, 179, 93, 0.78)';
    ctx.fillRect(17, 36, 13, 2);

    for (let x = -61; x <= 61; x += 15) {
      ctx.fillStyle = x % 30 === 0 ? '#162830' : '#1c3038';
      ctx.fillRect(x - 5, 44, 10, 4);
    }

    ctx.fillStyle = '#14252c';
    roundedRect(ctx, -38, -61, 76, 31, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(151, 210, 217, 0.3)';
    ctx.stroke();
    ctx.fillStyle = '#435b63';
    for (let x = -29; x <= 29; x += 10) {
      ctx.fillRect(x, -54, 4, 17);
    }
    ctx.fillStyle = '#061116';
    ctx.beginPath();
    ctx.arc(0, -42, 11, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(88, 224, 220, 0.44)';
    ctx.beginPath();
    ctx.arc(0, -42, 6, 0, TAU);
    ctx.stroke();

    if (state.rightHeld) {
      ctx.strokeStyle = 'rgba(243, 179, 93, 0.25)';
      ctx.strokeRect(-77, -65, 154, 126);
    }
    ctx.restore();
  }

  drawPressHead(ctx, state, positions, time) {
    const module = positions.module;
    const pressDistance = state.rightHeld ? clamp(state.pressure * 0.34, 5, 34) : 4;
    const headY = 160 + pressDistance;
    ctx.save();
    ctx.fillStyle = '#0a171d';
    ctx.fillRect(570, 106, 40, 45);
    ctx.strokeStyle = 'rgba(151, 210, 217, 0.31)';
    ctx.strokeRect(570.5, 106.5, 39, 44);

    ctx.fillStyle = metalGradient(ctx, 542, headY - 16, 638, headY + 18);
    roundedRect(ctx, 540, headY, 100, 23, 3);
    ctx.fill();
    ctx.strokeStyle = state.rightHeld
      ? 'rgba(243, 179, 93, 0.72)'
      : 'rgba(151, 210, 217, 0.32)';
    ctx.stroke();
    ctx.fillStyle = '#09171d';
    ctx.fillRect(565, headY + 18, 70, 10);

    ctx.fillStyle = state.rightHeld ? '#f3b35d' : '#455d65';
    ctx.fillRect(579, headY + 8, 42, 3);
    ctx.fillStyle = 'rgba(243, 179, 93, 0.3)';
    ctx.fillRect(555, headY + 23, 90, 1);

    if (state.rightHeld) {
      ctx.strokeStyle = 'rgba(243, 179, 93, 0.17)';
      for (let x = 550; x <= 630; x += 10) {
        ctx.beginPath();
        ctx.moveTo(x, headY + 23);
        ctx.lineTo(x + 4, module.y - 65);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawClamp(ctx, state, positions, time) {
    const base = positions.base;
    const engage = state.leftHeld ? 1 : 0;
    const armX = 344 + engage * 13;
    const armY = base.y - 4;
    const grapX = base.x - 62 + engage * 11;
    ctx.save();
    ctx.fillStyle = '#0b171d';
    ctx.fillRect(294, armY - 20, 42, 40);
    ctx.strokeStyle = 'rgba(151, 210, 217, 0.28)';
    ctx.strokeRect(294.5, armY - 19.5, 41, 39);

    ctx.fillStyle = metalGradient(ctx, armX, armY - 10, grapX, armY + 10);
    roundedRect(ctx, armX, armY - 9, Math.max(24, grapX - armX), 18, 3);
    ctx.fill();
    ctx.strokeStyle = state.leftHeld
      ? 'rgba(88, 224, 220, 0.72)'
      : 'rgba(151, 210, 217, 0.26)';
    ctx.stroke();

    ctx.fillStyle = '#071218';
    ctx.fillRect(grapX - 10, armY - 22, 20, 45);
    ctx.strokeStyle = state.leftHeld
      ? 'rgba(88, 224, 220, 0.7)'
      : 'rgba(151, 210, 217, 0.27)';
    ctx.strokeRect(grapX - 9.5, armY - 21.5, 19, 44);

    ctx.fillStyle = state.leftHeld ? 'rgba(88, 224, 220, 0.72)' : '#455b63';
    ctx.fillRect(grapX - 4, armY - 13, 8, 2);
    ctx.fillRect(grapX - 4, armY + 10, 8, 2);

    ctx.strokeStyle = state.leftHeld
      ? `rgba(88, 224, 220, ${0.3 + Math.sin(time * 0.01) * 0.1})`
      : 'rgba(243, 179, 93, 0.18)';
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(294, armY - 29);
    ctx.lineTo(base.x + 30, armY - 29);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = state.leftHeld ? 'rgba(88, 224, 220, 0.8)' : 'rgba(243, 179, 93, 0.7)';
    ctx.font = '7px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(state.leftHeld ? 'CLAMP LOCK' : 'CLAMP FREE', 298, armY - 35);
    ctx.restore();
  }

  drawSensorCallouts(ctx, state, positions, time, options) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = '7px monospace';

    const offsetSafe = state.offset <= OFFSET_SAFE;
    ctx.strokeStyle = offsetSafe ? 'rgba(120, 231, 163, 0.35)' : 'rgba(243, 179, 93, 0.38)';
    ctx.beginPath();
    ctx.moveTo(positions.base.x + 54, positions.base.y - 50);
    ctx.lineTo(770, 472);
    ctx.lineTo(796, 472);
    ctx.stroke();
    ctx.fillStyle = offsetSafe ? 'rgba(120, 231, 163, 0.88)' : 'rgba(243, 179, 93, 0.88)';
    ctx.textAlign = 'left';
    ctx.fillText(`BASE Δ ${state.offset.toFixed(1)} mm`, 770, 465);

    const pressureSafe = state.pressure >= PRESSURE_MIN && state.pressure <= PRESSURE_MAX;
    ctx.strokeStyle = pressureSafe ? 'rgba(120, 231, 163, 0.35)' : 'rgba(243, 179, 93, 0.4)';
    ctx.beginPath();
    ctx.moveTo(654, 190);
    ctx.lineTo(790, 190);
    ctx.lineTo(812, 208);
    ctx.stroke();
    ctx.fillStyle = pressureSafe ? 'rgba(120, 231, 163, 0.9)' : 'rgba(243, 179, 93, 0.92)';
    ctx.fillText(`RAM ${state.pressure.toFixed(1)}%`, 790, 183);

    const columnX = 846;
    const columnY = 250;
    const columnH = 122;
    ctx.strokeStyle = 'rgba(151, 210, 217, 0.25)';
    ctx.strokeRect(columnX + 0.5, columnY + 0.5, 17, columnH);
    for (let index = 0; index < 10; index += 1) {
      const segmentY = columnY + columnH - (index + 1) * (columnH / 10) + 2;
      const active = state.pressure >= index * 10 + 5;
      ctx.fillStyle = active
        ? (state.pressure > PRESSURE_MAX ? 'rgba(255, 107, 97, 0.65)' : 'rgba(243, 179, 93, 0.62)')
        : 'rgba(126, 150, 158, 0.08)';
      ctx.fillRect(columnX + 3, segmentY, 11, columnH / 10 - 3);
    }
    ctx.fillStyle = 'rgba(243, 179, 93, 0.85)';
    ctx.fillText('PRESSURE', columnX - 3, columnY + columnH + 12);

    if (state.timeline.collisions.length > 0 && state.phase === 'failed') {
      const collision = state.timeline.collisions[state.timeline.collisions.length - 1];
      this.drawCollisionBurst(ctx, collision, time);
    }
    ctx.restore();
  }

  drawCollisionBurst(ctx, collision, time) {
    const x = collision.position.x;
    const y = collision.position.y;
    const phase = (time * 0.0015) % 1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let index = 0; index < 9; index += 1) {
      const angle = index * 0.72 + phase * 0.4;
      const distance = 16 + phase * 36 + (index % 3) * 7;
      ctx.fillStyle = `rgba(255, 107, 97, ${0.62 - phase * 0.5})`;
      ctx.fillRect(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance, 2, 2);
    }
    ctx.strokeStyle = `rgba(255, 107, 97, ${0.5 - phase * 0.4})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 22 + phase * 30, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  drawStationHud(ctx, state, time, options) {
    ctx.save();
    const syncRatio = clamp(state.syncMs / 1200, 0, 1);
    ctx.fillStyle = 'rgba(5, 12, 16, 0.58)';
    roundedRect(ctx, 422, 527, 336, 31, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(151, 210, 217, 0.16)';
    ctx.stroke();

    ctx.fillStyle = '#50676f';
    ctx.font = '7px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('SYNC', 436, 546);
    ctx.fillStyle = '#101f26';
    ctx.fillRect(472, 538, 207, 6);
    const syncGradient = ctx.createLinearGradient(472, 0, 679, 0);
    syncGradient.addColorStop(0, '#2f7d83');
    syncGradient.addColorStop(1, syncRatio >= 1 ? '#78e7a3' : '#58e0dc');
    ctx.fillStyle = syncGradient;
    ctx.fillRect(472, 538, 207 * syncRatio, 6);
    ctx.fillStyle = syncRatio >= 1 ? '#78e7a3' : '#b7d9db';
    ctx.font = '600 8px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(syncRatio * 100)}%`, 741, 546);

    if (options.replay) {
      ctx.fillStyle = 'rgba(243, 179, 93, 0.82)';
      ctx.font = '600 7px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('REPLAY / DETERMINISTIC', 590, 571);
    } else if (state.phase === 'active') {
      ctx.fillStyle = 'rgba(88, 224, 220, 0.7)';
      ctx.font = '600 7px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('LIVE / SHARED TIMELINE', 590, 571);
    }
    ctx.restore();
  }
}
