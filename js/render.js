import { FRAME_W, FRAME_H } from './constants.js';
import { allTargetPositions, lightAt, LIGHT_ZONES } from './scene.js';
import { project, hFov, vFov, aperture, shutter } from './sim.js';

const REASON_LABEL = {
  'no-target': '取景框内无目标',
  'off-center': '构图偏出安全框',
  'bad-framing': '目标尺寸不合格',
  'out-of-focus': '失焦',
  'bad-exposure': '曝光不合格',
  'motion-blur': '运动模糊',
};

function evToGray(ev) {
  const t = Math.max(0, Math.min(1, (ev - 5) / 8));
  return Math.round(30 + t * 150);
}

export function drawViewfinder(ctx, state, tick, flash = null) {
  ctx.clearRect(0, 0, FRAME_W, FRAME_H);

  // Background light zones, projected as vertical world slabs.
  for (const zone of LIGHT_ZONES) {
    const gray = evToGray(lightAt((zone.x0 + zone.x1) / 2, tick));
    const left = worldXtoFrame(state, zone.x0);
    const right = worldXtoFrame(state, zone.x1);
    ctx.fillStyle = `rgb(${gray},${gray},${Math.min(255, gray + 18)})`;
    ctx.fillRect(Math.max(0, left), 0, Math.min(FRAME_W, right) - Math.max(0, left), FRAME_H);
  }

  // Ground line for depth reference.
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, FRAME_H * 0.72);
  ctx.lineTo(FRAME_W, FRAME_H * 0.72);
  ctx.stroke();

  // Targets: circle + tracking label, bracketed when inside the frame.
  for (const pos of allTargetPositions(tick)) {
    const pr = project(state, pos);
    if (!pr) continue;
    const radiusPx = Math.max(6, (pos.size / pr.depth / Math.tan(vFov(state) / 2)) * FRAME_H * 0.5);
    ctx.beginPath();
    ctx.arc(pr.x, pr.y, radiusPx, 0, Math.PI * 2);
    ctx.fillStyle = pos.color + 'cc';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '13px monospace';
    ctx.fillText(pos.name, pr.x + radiusPx + 6, pr.y - radiusPx);
  }

  drawFrameGuides(ctx);
  drawFocusBox(ctx, state, tick);
  if (flash) drawFlash(ctx, flash);
}

function worldXtoFrame(state, x) {
  const fake = { x, y: 0, z: 18 };
  const pr = project(state, fake);
  return pr ? pr.x : (x < 0 ? -100 : FRAME_W + 100);
}

function drawFrameGuides(ctx) {
  ctx.strokeStyle = 'rgba(255,255,255,0.65)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(FRAME_W * 0.11, FRAME_H * 0.11, FRAME_W * 0.78, FRAME_H * 0.78);
  ctx.beginPath();
  ctx.moveTo(FRAME_W / 2, 0);
  ctx.lineTo(FRAME_W / 2, FRAME_H);
  ctx.moveTo(0, FRAME_H / 2);
  ctx.lineTo(FRAME_W, FRAME_H / 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.stroke();
}

function drawFocusBox(ctx, state, tick) {
  let nearest = null;
  for (const pos of allTargetPositions(tick)) {
    const pr = project(state, pos);
    if (!pr) continue;
    const radius = Math.hypot(pr.u, pr.v);
    if (!nearest || radius < nearest.radius) nearest = { pos, pr, radius };
  }
  if (!nearest) return;
  const inFocus = Math.abs(nearest.pr.depth - state.focus) / state.focus <= 0.18;
  const size = 26;
  ctx.strokeStyle = inFocus ? '#5dff8f' : '#ff5d5d';
  ctx.lineWidth = 2.5;
  const { x, y } = nearest.pr;
  ctx.beginPath();
  for (const [cx, cy, dx, dy] of [
    [x - size, y - size, 10, 0], [x - size, y - size, 0, 10],
    [x + size, y - size, -10, 0], [x + size, y - size, 0, 10],
    [x - size, y + size, 10, 0], [x - size, y + size, 0, -10],
    [x + size, y + size, -10, 0], [x + size, y + size, 0, -10],
  ]) {
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + dx, cy + dy);
  }
  ctx.stroke();
}

function drawFlash(ctx, flash) {
  ctx.fillStyle = flash.ok ? 'rgba(120,255,160,0.28)' : 'rgba(255,90,90,0.32)';
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px monospace';
  ctx.textAlign = 'center';
  const text = flash.ok
    ? '已保存'
    : `拒绝：${flash.reasons.map((reason) => REASON_LABEL[reason] || reason).join('、')}`;
  ctx.fillText(text, FRAME_W / 2, 42);
  ctx.textAlign = 'left';
}

export function reasonLabel(reason) {
  return REASON_LABEL[reason] || reason;
}

// Left dashboard: gimbal direction + motion load.
export function drawLeftPanel(ctx, state, input) {
  panelFrame(ctx, '左侧玩家 · 云台');
  gauge(ctx, 130, 150, 52, input.left.pan, '水平', -1, 1);
  gauge(ctx, 270, 150, 52, input.left.tilt, '俯仰', -1, 1);
  ctx.fillStyle = '#cfe3ff';
  ctx.font = '14px monospace';
  ctx.fillText(`yaw ${state.yaw.toFixed(3)} rad`, 40, 245);
  ctx.fillText(`pitch ${state.pitch.toFixed(3)} rad`, 40, 268);
  const turnLoad = Math.hypot(input.left.pan, input.left.tilt);
  ctx.fillStyle = turnLoad > 0.8 ? '#ff9d5d' : '#9fd1ff';
  ctx.fillText(turnLoad > 0.8 ? '快速转向：模糊风险' : '云台稳定', 40, 296);
}

// Right dashboard: focus / aperture / shutter / zoom + film and durability.
export function drawRightPanel(ctx, state) {
  panelFrame(ctx, '右侧玩家 · 镜头与曝光');
  ctx.fillStyle = '#cfe3ff';
  ctx.font = '14px monospace';
  const rows = [
    `焦距 ${state.focal.toFixed(0)} mm (视角 ${(hFov(state) * 180 / Math.PI).toFixed(1)}°)`,
    `对焦距离 ${state.focus.toFixed(1)} m`,
    `光圈 f/${aperture(state)}`,
    `快门 1/${Math.round(1 / shutter(state))} s`,
  ];
  rows.forEach((row, index) => ctx.fillText(row, 40, 120 + index * 26));

  bar(ctx, 40, 220, 300, 14, state.film, 6, '备用胶片');
  bar(ctx, 40, 258, 300, 14, state.durability, 100, '器材耐久');
  ctx.fillStyle = '#ffe9a8';
  ctx.fillText(`已保存目标 ${state.photos.length}/3`, 40, 305);
}

function panelFrame(ctx, title) {
  ctx.fillStyle = '#101826';
  ctx.fillRect(0, 0, 380, 360);
  ctx.strokeStyle = '#2b4a6f';
  ctx.strokeRect(0.5, 0.5, 379, 359);
  ctx.fillStyle = '#8fd3ff';
  ctx.font = 'bold 15px monospace';
  ctx.fillText(title, 24, 36);
}

function gauge(ctx, cx, cy, radius, value, label, low, high) {
  const norm = (value - low) / (high - low);
  ctx.strokeStyle = '#2b4a6f';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, Math.PI * 0.75, Math.PI * 2.25);
  ctx.stroke();
  ctx.strokeStyle = '#5db8ff';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, Math.PI * 0.75, Math.PI * (0.75 + 1.5 * norm));
  ctx.stroke();
  ctx.fillStyle = '#cfe3ff';
  ctx.font = '13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(label, cx, cy + 24);
  ctx.textAlign = 'left';
}

function bar(ctx, x, y, width, height, value, max, label) {
  ctx.fillStyle = '#1d2d44';
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = value / max > 0.35 ? '#5dff8f' : '#ff7d5d';
  ctx.fillRect(x, y, width * Math.max(0, Math.min(1, value / max)), height);
  ctx.strokeStyle = '#3d5d80';
  ctx.strokeRect(x + 0.5, y + 0.5, width, height);
  ctx.fillStyle = '#cfe3ff';
  ctx.font = '13px monospace';
  ctx.fillText(`${label} ${Math.round(value * 10) / 10}/${max}`, x, y - 5);
}
