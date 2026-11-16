import {
  WORLD, CRATE, ROPE, ICE, STEER, JERK, ZONES, zoneAt,
} from './config.mjs';
import { mulberry32 } from './rng.mjs';
import {
  clamp, movePlayers, applyWinch, ropePull, integrateCrate, checksum,
} from './engine.mjs';

function handleJerks(state, input, dt, events, conflicts) {
  const sides = ['left', 'right'];
  const ordered = input.order && input.order.length === 2 ? input.order.slice() : sides;
  for (const side of ordered) {
    const pressed = side === 'left' ? input.leftJerk : input.rightJerk;
    if (!pressed) continue;
    const other = side === 'left' ? 'right' : 'left';
    const overlap = state.lastJerk[other] >= state.tick - JERK.overlapWindow;
    const dir = side === 'left' ? -1 : 1;
    state.crate.vx += dir * JERK.impulse;
    state.players[side].brace = 1;
    let shock = JERK.shockStress;
    if (overlap) {
      // The second jerk lands on ice already loaded by the first one and pulls
      // against it, so it adds shear damage instead of an identical symmetric hit.
      shock = JERK.shockStress * (side === 'left' ? 1.85 : 1.35);
      state.crate.vy += (side === 'left' ? 1 : -1) * JERK.impulse * 0.35;
      conflicts.push({
        id: `conflict-${state.tick}-${side}`,
        tick: state.tick,
        time: +(state.tick * WORLD.dt).toFixed(2),
        kind: 'jerk-order',
        label: '同时急拽·顺序敏感',
        object: '物资箱',
        position: { x: +state.crate.x.toFixed(1), y: +state.crate.y.toFixed(1) },
        order: [
          { seq: 1, side: other, label: other === 'left' ? '左侧急拽' : '右侧急拽' },
          { seq: 2, side, label: side === 'left' ? '左侧急拽' : '右侧急拽' },
        ],
        detail: `后处理的${side === 'left' ? '左侧' : '右侧'}急拽落在已加载冰面上，冲击系数 ${side === 'left' ? 1.85 : 1.35}，并产生横向剪切`,
      });
    }
    const zi = zoneAt(state.crate.x, state.crate.y);
    if (zi !== null) {
      state.zones[zi].strength = clamp(state.zones[zi].strength - shock, 0, 1);
      events.push({ type: 'ice-shock', tick: state.tick, zone: state.zones[zi].id, stress: +shock.toFixed(3) });
    }
    state.lastJerk[side] = state.tick;
    events.push({ type: 'jerk', side, tick: state.tick, position: { x: +state.crate.x.toFixed(1), y: +state.crate.y.toFixed(1) } });
  }
}

function iceDamage(state, pullL, pullR, guide, events, rng) {
  const crate = state.crate;
  const zi = zoneAt(crate.x, crate.y);
  const imbalance = Math.abs(pullL.raw - pullR.raw) / Math.max(0.001, pullL.raw + pullR.raw);
  state.gauges.singleSide = imbalance > 0.62;
  let stress = 0;
  if (zi !== null) {
    const zone = state.zones[zi];
    const meta = zoneIdToMeta(zone.id);
    const load = (pullL.raw + pullR.raw) / ROPE.snapTension
      + Math.hypot(guide.guideFx, guide.guideFy) / STEER.guideK * 0.3
      + Math.hypot(crate.vx, crate.vy) / 900;
    stress = clamp(load * (0.55 + imbalance * 0.6), 0, 1.2);
    if (meta.weak) stress *= 1 + ICE.weakPenalty;
    zone.strength = clamp(zone.strength - stress * ICE.stressToDamage * WORLD.dt, 0, 1);

    // Load leaks into neighbouring plates, spreading cracks outward.
    for (const nz of neighbors(zi)) {
      state.zones[nz].strength = clamp(
        state.zones[nz].strength - stress * ICE.crackSpread * ICE.stressToDamage * WORLD.dt,
        0, 1,
      );
    }
    if (zone.strength <= ICE.crackThreshold && zone.crackTick === null) {
      zone.crackTick = state.tick;
      const crack = makeCrack(zone, rng);
      state.cracks.push(crack);
      events.push({ type: 'crack', tick: state.tick, zone: zone.id, position: { x: +crate.x.toFixed(1), y: +crate.y.toFixed(1) } });
    }
    if (zone.strength <= ICE.breakThreshold) {
      state.status = 'lost';
      state.endReason = 'ice-break';
      events.push({ type: 'ice-break', tick: state.tick, zone: zone.id, position: { x: +crate.x.toFixed(1), y: +crate.y.toFixed(1) } });
    }
  }
  state.gauges.stress = +stress.toFixed(4);
  state.integrity = +(100 * state.zones.reduce((s, z) => s + z.strength, 0) / state.zones.length).toFixed(2);
}

function zoneIdToMeta(id) {
  const idx = Number(id.split('-')[1]) - 1;
  return ZONES[idx];
}

function neighbors(i) {
  const row = Math.floor(i / ICE.cols);
  const col = i % ICE.cols;
  const out = [];
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const r = row + dr;
    const c = col + dc;
    if (r >= 0 && r < ICE.rows && c >= 0 && c < ICE.cols) out.push(r * ICE.cols + c);
  }
  return out;
}

function makeCrack(zone, rng) {
  const meta = ZONES.find((z) => z.id === zone.id);
  const branches = [];
  let x = meta.x + meta.w / 2;
  let y = meta.y + meta.h / 2;
  let angle = rng() * Math.PI * 2;
  for (let i = 0; i < 6; i += 1) {
    const len = 10 + rng() * 16;
    angle += (rng() - 0.5) * 1.4;
    const nx = clamp(x + Math.cos(angle) * len, meta.x + 4, meta.x + meta.w - 4);
    const ny = clamp(y + Math.sin(angle) * len, meta.y + 4, meta.y + meta.h - 4);
    branches.push({ x1: +x.toFixed(1), y1: +y.toFixed(1), x2: +nx.toFixed(1), y2: +ny.toFixed(1) });
    x = nx; y = ny;
  }
  return { id: zone.id, tick: zone.crackTick, branches };
}

function checkRopes(state, events) {
  for (const side of ['left', 'right']) {
    const rope = state.ropes[side];
    if (!rope.snapped && rope.tension >= ROPE.snapTension) {
      rope.snapped = true;
      rope.tension = 0;
      events.push({ type: 'rope-snap', side, tick: state.tick, position: { x: +state.crate.x.toFixed(1), y: +state.crate.y.toFixed(1) } });
      state.status = 'lost';
      state.endReason = 'rope-snap';
    }
  }
}

// The guide (right) rope pays out so it never blocks the winch, while keeping
// light tension for steering feedback.
function payOutGuide(state, dt) {
  const rope = state.ropes.right;
  const target = rope.length - 26;
  if (rope.rest < target) {
    rope.rest = clamp(rope.rest + 260 * dt, 0, target);
  }
}

export function step(state, rawInput) {
  const input = {
    winch: clamp(rawInput.winch || 0, -1, 1),
    leftY: clamp(rawInput.leftY || 0, -1, 1),
    steerX: clamp(rawInput.steerX || 0, -1, 1),
    steerY: clamp(rawInput.steerY || 0, -1, 1),
    rightY: clamp(rawInput.rightY || 0, -1, 1),
    leftJerk: !!rawInput.leftJerk,
    rightJerk: !!rawInput.rightJerk,
    order: rawInput.order || ['left', 'right'],
  };
  const dt = WORLD.dt;
  const events = [];
  const conflicts = [];
  const rng = mulberry32(state.seed + state.rngCursor * 2654435761);

  if (state.status === 'running') {
    handleJerks(state, input, dt, events, conflicts);
    movePlayers(state, input, dt, events);
    applyWinch(state, input, dt);
    const pullL = ropePull(state, 'left', state.players.left.x, state.players.left.y);
    const pullR = ropePull(state, 'right', state.players.right.x, state.players.right.y);
    const guide = integrateCrate(state, input, pullL, pullR, dt, events);
    payOutGuide(state, dt);
    iceDamage(state, pullL, pullR, guide, events, rng);
    checkRopes(state, events);
    state.rngCursor += 1;
    state.tick += 1;
    state.elapsed = +(state.elapsed + dt).toFixed(2);

    state.gauges.steerX = input.steerX;
    state.gauges.steerY = input.steerY;
    state.gauges.tension = +clamp(
      (state.ropes.left.tension + state.ropes.right.tension) / (ROPE.snapTension * 2), 0, 1,
    ).toFixed(3);
    state.players.left.brace = +Math.max(0, state.players.left.brace - dt * 2).toFixed(3);
    state.players.right.brace = +Math.max(0, state.players.right.brace - dt * 2).toFixed(3);

    const span = CRATE.startX - WORLD.safeEdge;
    state.progress = clamp((CRATE.startX - state.crate.x) / span, 0, 1) * 100;
    state.gauges.safe = state.crate.x <= WORLD.safeEdge;
    if (state.status === 'running' && state.gauges.safe) {
      state.status = 'won';
      state.endReason = 'safe';
      state.progress = 100;
      events.push({ type: 'rescued', tick: state.tick, position: { x: +state.crate.x.toFixed(1), y: +state.crate.y.toFixed(1) } });
    }
  }
  return { events, conflicts, checksum: checksum(state) };
}

export { checksum };
