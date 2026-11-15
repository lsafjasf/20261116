import * as C from './constants.js';

// Canvas side-view renderer: ocean depth, sub cross-section, samples, HUD bars.
export function render(ctx, s, width = 960, height = 600) {
  const depthView = Math.max(160, s.depth + 30);
  const surfaceY = 70;
  const bottomY = height - 40;
  const yOf = (depth) => surfaceY + (depth / depthView) * (bottomY - surfaceY);
  const xOf = (x) => width / 2 + x * 4.2;

  drawWater(ctx, width, height, surfaceY, s);
  drawDepthScale(ctx, surfaceY, bottomY, depthView);
  drawSamples(ctx, s, xOf, yOf);
  drawSubmarine(ctx, s, xOf(s.x), yOf(s.depth));
  drawHudBars(ctx, s, width);
  drawObjective(ctx, s, width);
  drawEventBanner(ctx, s, width);
}

function drawWater(ctx, w, h, surfaceY, s) {
  const grad = ctx.createLinearGradient(0, surfaceY, 0, h);
  grad.addColorStop(0, '#1d6fa5');
  grad.addColorStop(0.5, '#0d3b66');
  grad.addColorStop(1, '#041426');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  // surface waves
  ctx.strokeStyle = 'rgba(180,230,255,0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= w; x += 8) {
    const y = surfaceY + Math.sin((x + s.tick * 6) / 26) * 3;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  // particulate / current streaks (deterministic from tick)
  ctx.strokeStyle = 'rgba(150,200,255,0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 26; i++) {
    const px = (i * 137 + s.tick * (s.currentEvent?.kind === 'current' ? 14 : 3)) % w;
    const py = surfaceY + ((i * 53 + s.tick) % (h - surfaceY));
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + 14, py);
    ctx.stroke();
  }
  // seabed
  ctx.fillStyle = '#1a1310';
  ctx.fillRect(0, h - 26, w, 26);
}

function drawDepthScale(ctx, surfaceY, bottomY, depthView) {
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.fillStyle = 'rgba(220,240,255,0.75)';
  ctx.font = '11px monospace';
  ctx.lineWidth = 1;
  for (let d = 0; d <= depthView; d += 10) {
    const y = surfaceY + (d / depthView) * (bottomY - surfaceY);
    ctx.beginPath();
    ctx.moveTo(8, y);
    ctx.lineTo(d % 50 === 0 ? 30 : 20, y);
    ctx.stroke();
    if (d % 20 === 0) ctx.fillText(`${d}m`, 34, y + 4);
  }
}

function drawSamples(ctx, s, xOf, yOf) {
  for (const q of s.samples) {
    const x = xOf(q.x);
    const y = yOf(q.depth);
    const active = q.id === s.nextSampleId && !q.taken;
    ctx.save();
    if (q.taken) {
      ctx.fillStyle = '#4ade80';
      ctx.strokeStyle = '#166534';
    } else if (active) {
      ctx.fillStyle = '#facc15';
      ctx.strokeStyle = '#a16207';
    } else {
      ctx.fillStyle = 'rgba(200,200,200,0.55)';
      ctx.strokeStyle = 'rgba(120,120,120,0.7)';
    }
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, active ? 8 + Math.sin(s.tick / 4) * 2 : 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e8f4ff';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(`S${q.id + 1}${q.taken ? '✓' : ''}`, x + 10, y + 4);
    ctx.restore();
  }
}

function drawSubmarine(ctx, s, cx, cy) {
  const w = 150, h = 52;
  ctx.save();
  ctx.translate(cx, cy);
  // hull outline
  ctx.fillStyle = s.phase === C.PHASE.RUNAWAY ? '#7f1d1d' : '#274060';
  ctx.strokeStyle = '#9fc5e8';
  ctx.lineWidth = 2;
  roundRect(ctx, -w / 2, -h / 2, w, h, 22);
  ctx.fill();
  ctx.stroke();
  // sail / conning tower
  ctx.fillStyle = '#1d3049';
  roundRect(ctx, -14, -h / 2 - 16, 28, 18, 5);
  ctx.fill();
  ctx.strokeRect(-14, -h / 2 - 16, 28, 18);
  // periscope
  ctx.beginPath();
  ctx.moveTo(0, -h / 2 - 16);
  ctx.lineTo(0, -h / 2 - 26);
  ctx.lineTo(8, -h / 2 - 26);
  ctx.stroke();
  // ballast tanks (cross-section liquid level follows ballast value)
  const tankW = 30;
  for (const tx of [-w / 2 + 8, w / 2 - 8 - tankW]) {
    ctx.fillStyle = 'rgba(8,20,35,0.65)';
    ctx.fillRect(tx, -h / 2 + 6, tankW, h - 12);
    const liquidH = (h - 12) * s.ballast;
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(tx, h / 2 - 6 - liquidH, tankW, liquidH);
    ctx.strokeStyle = 'rgba(180,220,255,0.6)';
    ctx.strokeRect(tx, -h / 2 + 6, tankW, h - 12);
  }
  // cabin window + light cone
  ctx.fillStyle = '#bfe6ff';
  ctx.fillRect(w / 2 - 14, -8, 10, 10);
  if (s.lightMode > 0) {
    const coneLen = s.lightMode === 2 ? 90 : 48;
    ctx.fillStyle = s.lightMode === 2 ? 'rgba(255,240,150,0.28)' : 'rgba(255,240,150,0.16)';
    ctx.beginPath();
    ctx.moveTo(w / 2 - 4, -3);
    ctx.lineTo(w / 2 + coneLen, -18 - (s.lightMode === 2 ? 12 : 0));
    ctx.lineTo(w / 2 + coneLen, 12 + (s.lightMode === 2 ? 12 : 0));
    ctx.closePath();
    ctx.fill();
  }
  // two crew stations: A (propulsion/light) left, B (ballast/valves) right
  drawCrew(ctx, -28, 8, '#f59e0b', 'A');
  drawCrew(ctx, 28, 8, '#22d3ee', 'B');
  // propeller + thrust
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-w / 2, 0);
  ctx.lineTo(-w / 2 - 12, 0);
  ctx.stroke();
  const spin = s.tick * (s.engineOn ? 1.4 : 0.3);
  ctx.save();
  ctx.translate(-w / 2 - 18, 0);
  ctx.rotate(spin);
  ctx.strokeStyle = s.thrustScale > 0.6 ? '#fde68a' : '#64748b';
  for (let i = 0; i < 3; i++) {
    ctx.rotate((Math.PI * 2) / 3);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(9, 3);
    ctx.stroke();
  }
  ctx.restore();
  // vertical velocity arrow
  if (Math.abs(s.vs) > 0.05) {
    ctx.fillStyle = s.vs < -C.RUNAWAY_SPEED ? '#f87171' : '#7dd3fc';
    ctx.beginPath();
    const ay = -h / 2 - 34;
    if (s.vs < 0) { ctx.moveTo(0, ay - 8); ctx.lineTo(-6, ay + 2); ctx.lineTo(6, ay + 2); }
    else { ctx.moveTo(0, ay + 8); ctx.lineTo(-6, ay - 2); ctx.lineTo(6, ay - 2); }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawCrew(ctx, x, y, color, label) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0b1622';
  ctx.font = 'bold 9px monospace';
  ctx.fillText(label, x - 3, y + 3);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function bar(ctx, x, y, w, h, value, max, color, label, suffix = '') {
  ctx.fillStyle = 'rgba(5,15,28,0.7)';
  ctx.fillRect(x, y, w, h);
  const pct = Math.max(0, Math.min(1, value / max));
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * pct, h);
  ctx.strokeStyle = 'rgba(200,230,255,0.5)';
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#e8f4ff';
  ctx.font = '11px monospace';
  ctx.fillText(`${label} ${value.toFixed(0)}${suffix}`, x + 4, y - 3);
}

function drawHudBars(ctx, s, width) {
  const y = 12, h = 14, w = 128, gap = 14;
  let x = 12;
  bar(ctx, x, y, w, h, s.battery, 100, batteryColor(s), '电量'); x += w + gap;
  bar(ctx, x, y, w, h, s.o2, 100, '#38bdf8', '氧气'); x += w + gap;
  bar(ctx, x, y, w, h, s.hull, 100, hullColor(s), '耐久'); x += w + gap;
  bar(ctx, x, y, w, h, s.temp, 40, tempColor(s), '舱温', '°C');
  ctx.fillStyle = '#cfe8ff';
  ctx.font = '12px monospace';
  ctx.fillText(`深度 ${s.depth.toFixed(1)}m  升降 ${s.vs.toFixed(2)}m/s  压载 ${(s.ballast * 100).toFixed(0)}%`, 12, 52);
  ctx.fillText(`样本 ${s.collected}/3  引擎 ${s.engineOn ? 'ON' : 'OFF'}  灯光 ${['关','标准','泛光'][s.lightMode]}  功率 ${(s.powerDraw ?? 0).toFixed(1)}kW`, 12, 66);
}

const batteryColor = (s) => s.battery < 15 ? '#f87171' : '#a3e635';
const hullColor = (s) => s.hull < 30 ? '#f87171' : s.hull < 60 ? '#fbbf24' : '#4ade80';
const tempColor = (s) => (s.temp < 8 || s.temp > 32) ? '#f87171' : '#fb923c';

function drawObjective(ctx, s, width) {
  ctx.fillStyle = 'rgba(5,15,28,0.78)';
  ctx.fillRect(width - 330, 8, 318, 58);
  ctx.strokeStyle = 'rgba(125,211,252,0.6)';
  ctx.strokeRect(width - 330, 8, 318, 58);
  ctx.fillStyle = '#7dd3fc';
  ctx.font = 'bold 12px monospace';
  ctx.fillText(`目标: ${s.objective ?? ''}`, width - 322, 26);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '11px monospace';
  const change = s.lastChange;
  ctx.fillText(`状态: ${s.phase}${s.failReason ? ' / ' + s.failReason : ''}`, width - 322, 44);
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`最近变化 [t${change?.tick ?? 0}]: ${(change?.text ?? '').slice(0, 30)}`, width - 322, 60);
}

function drawEventBanner(ctx, s, width) {
  if (!s.currentEvent) return;
  const label = { current: '强洋流', leak: '管路渗漏', cold: '冷水团' }[s.currentEvent.kind];
  ctx.fillStyle = 'rgba(120,53,15,0.85)';
  ctx.fillRect(width / 2 - 110, 80, 220, 26);
  ctx.fillStyle = '#fde68a';
  ctx.font = 'bold 13px monospace';
  ctx.fillText(`⚠ 随机事件：${label} (${s.currentEvent.ticksLeft})`, width / 2 - 96, 98);
}
