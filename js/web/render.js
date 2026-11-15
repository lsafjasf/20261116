// Canvas renderer: stage, zones, actor, light cone, rig heat and markers.

import {
  STAGE_W,
  STAGE_H,
  ZONE_COUNT,
  ZONE_W,
  RIG_X,
  RIG_Y,
  RIG_LEN,
  HEAT_LIMIT,
  COLORS,
  SCRIPT,
  spotX,
} from '../core/engine.js';

const FILL = {
  warm: 'rgba(255, 214, 140, 0.55)',
  blue: 'rgba(120, 170, 255, 0.55)',
  red: 'rgba(255, 110, 110, 0.55)',
  green: 'rgba(130, 230, 150, 0.55)',
};

const SOLID = {
  warm: '#ffd68c',
  blue: '#78aaff',
  red: '#ff6e6e',
  green: '#82e696',
};

export function currentCueAt(tick) {
  return SCRIPT.find((c) => tick >= c.start && tick < c.end) || null;
}

export function render(ctx, state, options = {}) {
  ctx.clearRect(0, 0, STAGE_W, STAGE_H);

  // Stage backdrop and zone grid.
  ctx.fillStyle = '#141826';
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  for (let z = 0; z < ZONE_COUNT; z++) {
    ctx.fillStyle = z % 2 === 0 ? '#1a2033' : '#171d2e';
    ctx.fillRect(z * ZONE_W, 0, ZONE_W, STAGE_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.strokeRect(z * ZONE_W, 0, ZONE_W, STAGE_H);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '13px monospace';
    ctx.fillText(`ZONE ${z + 1}`, z * ZONE_W + 8, 18);
  }

  const cue = currentCueAt(state.tick);

  // Target marker for the active cue.
  if (cue) {
    const tx = cue.targetX;
    ctx.strokeStyle = SOLID[cue.targetColor];
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(tx, RIG_Y + 30);
    ctx.lineTo(tx, STAGE_H - 30);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = SOLID[cue.targetColor];
    ctx.fillText(`target ${cue.targetColor}`, tx - 34, STAGE_H - 34);
  }

  // Rig fixture arm.
  ctx.strokeStyle = state.overheated ? '#ff5555' : '#9fb2d8';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(RIG_X, RIG_Y);
  ctx.lineTo(RIG_X, RIG_Y + 26);
  ctx.stroke();
  ctx.lineWidth = 1;

  // Light cone.
  if (state.power && state.brightness > 0) {
    const ground = spotX(state.angle);
    const alpha = Math.min(0.85, state.brightness / 100);
    const grad = ctx.createLinearGradient(RIG_X, RIG_Y, ground, STAGE_H);
    const color = FILL[COLORS[state.colorIndex]];
    grad.addColorStop(0, color.replace(/[\d.]+\)$/, `${alpha})`));
    grad.addColorStop(1, color.replace(/[\d.]+\)$/, '0.02)'));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(RIG_X, RIG_Y + 20);
    ctx.lineTo(ground - 34, STAGE_H);
    ctx.lineTo(ground + 34, STAGE_H);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = SOLID[COLORS[state.colorIndex]];
    ctx.beginPath();
    ctx.arc(ground, STAGE_H - 4, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Actor.
  ctx.fillStyle = '#f4f6ff';
  ctx.beginPath();
  ctx.arc(state.actor.x, state.actor.y, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#141826';
  ctx.font = '10px monospace';
  ctx.fillText('ACTOR', state.actor.x - 20, state.actor.y - 18);

  // Heat bar above the rig.
  const heatPct = state.heat / HEAT_LIMIT;
  ctx.fillStyle = '#0c0f1a';
  ctx.fillRect(RIG_X - 70, 6, 140, 10);
  ctx.fillStyle = heatPct > 0.85 ? '#ff5555' : heatPct > 0.6 ? '#ffb347' : '#5fd38a';
  ctx.fillRect(RIG_X - 69, 7, 138 * heatPct, 8);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.strokeRect(RIG_X - 70, 6, 140, 10);
  ctx.fillStyle = '#cdd6ee';
  ctx.fillText(`RIG HEAT ${Math.round(state.heat)}%${state.overheated ? ' LOCKED' : ''}`, RIG_X - 34, 46);

  // Per-tick collision result indicator.
  if (state.lastEval) {
    const ok = state.lastEval.satisfied;
    ctx.fillStyle = ok ? '#5fd38a' : '#ff8a8a';
    ctx.font = 'bold 14px monospace';
    ctx.fillText(ok ? 'CUE MATCH' : 'NO MATCH', 12, STAGE_H - 14);
  }

  // Conflict markers supplied by the caller (replay/live events).
  for (const marker of options.markers || []) {
    ctx.strokeStyle = '#ffd24a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(marker.object.x, marker.object.y, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = '#ffd24a';
    ctx.fillText(`CONFLICT t=${marker.tick}`, marker.object.x + 18, marker.object.y + 4);
  }

  if (options.banner) {
    ctx.fillStyle = options.bannerColor || '#ffffff';
    ctx.font = 'bold 28px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(options.banner, STAGE_W / 2, STAGE_H / 2);
    ctx.textAlign = 'left';
  }
}
