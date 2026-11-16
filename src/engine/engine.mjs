import {
  WORLD, CRATE, ANCHOR, ROPE, STEER,
} from './config.mjs';
import { checksum } from './state.mjs';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function movePlayers(state, input, dt, events) {
  const left = state.players.left;
  const right = state.players.right;
  left.vy = input.leftY * ANCHOR.moveSpeed;
  right.vy = input.rightY * ANCHOR.moveSpeed;
  const ly = clamp(left.y + left.vy * dt, ANCHOR.railTop, ANCHOR.railBottom);
  const ry = clamp(right.y + right.vy * dt, ANCHOR.railTop, ANCHOR.railBottom);
  if (ly === ANCHOR.railTop || ly === ANCHOR.railBottom) {
    events.push({ type: 'anchor-limit', side: 'left', tick: state.tick, position: { x: left.x, y: ly } });
  }
  if (ry === ANCHOR.railTop || ry === ANCHOR.railBottom) {
    events.push({ type: 'anchor-limit', side: 'right', tick: state.tick, position: { x: right.x, y: ry } });
  }
  left.y = ly;
  right.y = ry;
}

function applyWinch(state, input, dt) {
  const rope = state.ropes.left;
  const next = clamp(
    rope.rest - input.winch * ROPE.winchSpeed * dt,
    ROPE.minRest,
    ROPE.maxRest,
  );
  state.gauges.spoolSpeed = (rope.rest - next) / dt;
  rope.rest = next;
  state.gauges.winchInput = input.winch;
}

function ropePull(state, side, px, py) {
  const crate = state.crate;
  const rope = state.ropes[side];
  const dx = px - crate.x;
  const dy = py - crate.y;
  const dist = Math.hypot(dx, dy) || 1e-6;
  rope.length = dist;
  if (rope.snapped) {
    rope.tension = 0;
    return { fx: 0, fy: 0, raw: 0, dist, dirX: dx / dist, dirY: dy / dist };
  }
  const stretch = dist - rope.rest;
  const dirX = dx / dist;
  const dirY = dy / dist;
  const relV = (state.players[side].vy * dirY) - (crate.vx * dirX + crate.vy * dirY);
  const raw = Math.max(0, ROPE.k * stretch + ROPE.damping * relV);
  rope.tension = raw;
  return { fx: raw * dirX, fy: raw * dirY, raw, dist, dirX, dirY };
}

function integrateCrate(state, input, pullL, pullR, dt, events) {
  const crate = state.crate;
  const guideFx = input.steerX * STEER.guideK;
  const guideFy = input.steerY * STEER.guideK;
  state.gauges.guideLoad = clamp(Math.hypot(guideFx, guideFy) / STEER.guideK, 0, 1);

  const ax = (pullL.fx + pullR.fx + guideFx) / CRATE.mass;
  const ay = (pullL.fy + pullR.fy + guideFy) / CRATE.mass;
  crate.vx += ax * dt;
  crate.vy += ay * dt;
  const damp = Math.exp(-0.5 * dt);
  crate.vx *= damp;
  crate.vy *= damp;

  crate.x += crate.vx * dt;
  crate.y += crate.vy * dt;

  crate.va += ((pullL.raw - pullR.raw) * 0.0004 + crate.vy * 0.0006) * dt;
  crate.va *= Math.pow(CRATE.angularDamping, dt * 10);
  crate.angle += crate.va * dt;

  if (crate.y - CRATE.half < WORLD.lakeTop) {
    crate.y = WORLD.lakeTop + CRATE.half;
    crate.vy = Math.abs(crate.vy) * 0.35;
    events.push({ type: 'collision', object: '湖北岸冰层', tick: state.tick, position: { x: crate.x, y: crate.y } });
  }
  if (crate.y + CRATE.half > WORLD.lakeBottom) {
    crate.y = WORLD.lakeBottom - CRATE.half;
    crate.vy = -Math.abs(crate.vy) * 0.35;
    events.push({ type: 'collision', object: '湖南岸冰层', tick: state.tick, position: { x: crate.x, y: crate.y } });
  }
  for (const side of ['left', 'right']) {
    const p = state.players[side];
    if (Math.hypot(p.x - crate.x, p.y - crate.y) < CRATE.half + 26) {
      events.push({ type: 'collision', object: side === 'left' ? '左侧救援位' : '右侧救援位', tick: state.tick, position: { x: crate.x, y: crate.y } });
    }
  }
  return { guideFx, guideFy };
}

export { clamp, movePlayers, applyWinch, ropePull, integrateCrate, checksum };
