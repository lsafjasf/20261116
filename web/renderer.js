import { CONFIG } from '../src/core/config.js';

export function draw(ctx, engine, width, height) {
  const s = engine.state;
  const pattern = engine.pattern;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#10141b';
  ctx.fillRect(0, 0, width, height);

  const loom = { x: 40, y: 60, w: width - 80, h: 300 };
  drawWarp(ctx, engine, loom);
  drawCloth(ctx, engine, loom);
  drawShuttle(ctx, engine, loom);
  drawTensionPanel(ctx, engine, { x: 40, y: 400, w: width - 80, h: 130 });
  drawShedHints(ctx, pattern, loom, s.picks);
}

function drawWarp(ctx, engine, box) {
  const { state, pattern } = engine;
  const n = pattern.warpCount;
  const step = box.w / (n - 1);
  ctx.lineWidth = 2;
  for (let i = 0; i < n; i++) {
    const x = box.x + i * step;
    const up = pattern.shedUp(i, state.picks);
    const colorKey = pattern.warpColor(i, state.picks);
    ctx.strokeStyle = pattern.colors[colorKey];
    ctx.globalAlpha = state.faultThread === i ? 1 : 0.85;
    ctx.beginPath();
    ctx.moveTo(x, box.y);
    ctx.quadraticCurveTo(x + (up ? 10 : -10), box.y + box.h * 0.5, x, box.y + box.h);
    ctx.stroke();
    if (state.faultThread === i) {
      ctx.strokeStyle = '#ff4d4d';
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(x - 8, box.y + 40);
      ctx.lineTo(x + 8, box.y + 70);
      ctx.moveTo(x + 8, box.y + 40);
      ctx.lineTo(x - 8, box.y + 70);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.globalAlpha = 1;
}

function drawShedHints(ctx, pattern, box, picks) {
  const n = pattern.warpCount;
  const step = box.w / (n - 1);
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#8fa0b8';
  for (let i = 0; i < n; i++) {
    const x = box.x + i * step;
    ctx.fillText(pattern.shedUp(i, picks) ? '上' : '下', x - 5, box.y - 14);
  }
}

function drawCloth(ctx, engine, box) {
  const { state, pattern } = engine;
  const rows = state.rows.slice(-14);
  const rowH = 8;
  const startY = box.y + box.h + 18;
  ctx.fillStyle = '#1b2230';
  ctx.fillRect(box.x, startY - 6, box.w, rows.length * rowH + 12);
  rows.forEach((row, idx) => {
    const y = startY + idx * rowH;
    ctx.fillStyle = row.ok ? pattern.colors.weft : '#ff5a5a';
    ctx.globalAlpha = row.ok ? 0.9 : 1;
    ctx.fillRect(box.x, y, box.w, rowH - 2);
    if (!row.ok) {
      ctx.fillStyle = '#2a0d0d';
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText('缺陷', box.x + 6, y + 9);
    }
  });
  ctx.globalAlpha = 1;
  const ratio = Math.min(1, state.clothCm / CONFIG.targetLengthCm);
  ctx.fillStyle = '#39414f';
  ctx.fillRect(box.x, startY + rows.length * rowH + 10, box.w, 8);
  ctx.fillStyle = ratio >= 1 ? '#57d18a' : '#5aa0ff';
  ctx.fillRect(box.x, startY + rows.length * rowH + 10, box.w * ratio, 8);
}

function drawShuttle(ctx, engine, box) {
  const { state } = engine;
  const progress = state.shuttle.active ? state.shuttle.progress : 0;
  const x = state.shuttle.dir === 1
    ? box.x + box.w * progress
    : box.x + box.w * (1 - progress);
  const y = box.y + box.h * 0.5;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = state.phase === 'STOPPED' ? '#ff6b6b' : '#e8b04b';
  ctx.beginPath();
  ctx.ellipse(0, 0, 22, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3a2a10';
  ctx.fillRect(-4, -3, 8, 6);
  ctx.restore();
}

function drawTensionPanel(ctx, engine, box) {
  const { state } = engine;
  ctx.fillStyle = '#161c27';
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.fillStyle = '#9fb2cc';
  ctx.font = '12px sans-serif';
  ctx.fillText('经纱张力 (cN)', box.x + 8, box.y + 18);
  const n = state.tensions.length;
  const gap = 4;
  const barW = (box.w - 16 - gap * (n - 1)) / n;
  const maxT = CONFIG.tensionBreak + 6;
  state.tensions.forEach((t, i) => {
    const x = box.x + 8 + i * (barW + gap);
    const h = (t / maxT) * (box.h - 40);
    const y = box.y + box.h - 12 - h;
    let color = '#5aa0ff';
    if (t >= CONFIG.tensionBreak) color = '#ff3b3b';
    else if (t >= CONFIG.tensionAnomaly) color = '#ff8a3d';
    else if (t >= CONFIG.tensionNormal) color = '#ffd166';
    ctx.fillStyle = color;
    ctx.fillRect(x, y, barW, h);
    if (state.faultThread === i) {
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(x - 1, y - 1, barW + 2, h + 2);
    }
  });
  ctx.strokeStyle = 'rgba(255,70,70,0.8)';
  const breakY = box.y + box.h - 12 - (CONFIG.tensionBreak / maxT) * (box.h - 40);
  ctx.beginPath();
  ctx.moveTo(box.x + 6, breakY);
  ctx.lineTo(box.x + box.w - 6, breakY);
  ctx.stroke();
}
