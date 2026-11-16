import { CRATE, ANCHOR, ROPE, ICE, ZONES } from './config.mjs';
import { hash32 } from './rng.mjs';

export function createInitialState(seed = 20261116) {
  return {
    status: 'running',
    tick: 0,
    elapsed: 0,
    seed,
    rngCursor: 0,
    progress: 0,
    integrity: ICE.startIntegrity,
    endReason: null,
    crate: {
      x: CRATE.startX,
      y: CRATE.startY,
      vx: 0,
      vy: 0,
      angle: 0,
      va: 0,
    },
    players: {
      left: { x: ANCHOR.leftX, y: ANCHOR.startY, vy: 0, brace: 0 },
      right: { x: ANCHOR.rightX, y: ANCHOR.startY, vy: 0, brace: 0 },
    },
    ropes: {
      left: { rest: ROPE.restLeft, length: ROPE.restLeft, tension: 0, snapped: false },
      right: { rest: ROPE.restRight, length: ROPE.restRight, tension: 0, snapped: false },
    },
    gauges: {
      winchInput: 0,
      spoolSpeed: 0,
      steerX: 0,
      steerY: 0,
      guideLoad: 0,
      stress: 0,
      tension: 0,
      singleSide: false,
      safe: false,
    },
    zones: ZONES.map((z) => ({
      id: z.id,
      row: z.row,
      col: z.col,
      strength: 1,
      crackTick: null,
    })),
    cracks: [],
    lastJerk: { left: -999, right: -999 },
  };
}

function round(v) {
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  return v;
}

// Stable fingerprint of every simulation-relevant number.
export function checksum(state) {
  const c = state.crate;
  const p = state.players;
  const r = state.ropes;
  const g = state.gauges;
  const parts = [
    state.status, state.tick, round(state.progress), round(state.integrity),
    round(c.x), round(c.y), round(c.vx), round(c.vy), round(c.angle), round(c.va),
    round(p.left.x), round(p.left.y), round(p.left.vy), round(p.left.brace),
    round(p.right.x), round(p.right.y), round(p.right.vy), round(p.right.brace),
    round(r.left.rest), round(r.left.length), round(r.left.tension), r.left.snapped,
    round(r.right.rest), round(r.right.length), round(r.right.tension), r.right.snapped,
    round(g.winchInput), round(g.spoolSpeed), round(g.steerX), round(g.steerY),
    round(g.guideLoad), round(g.stress), round(g.tension), g.singleSide, g.safe,
    state.zones.map((z) => `${z.id}:${round(z.strength)}:${z.crackTick ?? '-'}`).join('|'),
    state.cracks.map((k) => k.id).join(','),
    round(state.rngCursor),
  ];
  return hash32(parts.join(';')).toString(16).padStart(8, '0');
}

export function fingerprint(state) {
  return {
    status: state.status,
    tick: state.tick,
    progress: round(state.progress),
    integrity: round(state.integrity),
    tension: round(state.gauges.tension),
    guideLoad: round(state.gauges.guideLoad),
    crate: {
      x: round(state.crate.x),
      y: round(state.crate.y),
      vx: round(state.crate.vx),
      vy: round(state.crate.vy),
      angle: round(state.crate.angle),
    },
    endReason: state.endReason,
  };
}

export function cloneState(state) {
  return structuredClone(state);
}

export function emptyInput() {
  return {
    winch: 0,
    leftY: 0,
    steerX: 0,
    steerY: 0,
    rightY: 0,
    leftJerk: false,
    rightJerk: false,
    order: ['left', 'right'],
  };
}

