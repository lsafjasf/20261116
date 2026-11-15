import {
  DT, FILM_START, DURABILITY_START, DURABILITY_BAD_SHOT, DURABILITY_GOOD_SHOT,
  PAN_SPEED, TILT_SPEED, PAN_LIMIT, TILT_LIMIT, FOCUS_MIN, FOCUS_MAX, FOCUS_SPEED,
  APERTURE_STOPS, SHUTTER_STOPS, FOCAL_MIN, FOCAL_MAX, ZOOM_SPEED,
  COMPOSE_EDGE, COMPOSE_SIZE_MIN, COMPOSE_SIZE_MAX, FOCUS_TOLERANCE,
  EXPOSURE_LO, EXPOSURE_HI, BLUR_LIMIT,
} from './constants.js';
import { allTargetPositions, lightAt, TARGETS } from './scene.js';

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// FNV-1a style hash over a deterministic string; used to prove that replay
// controls (pause / step / speed) never mutate the resulting state.
export function hashState(state) {
  const parts = [
    state.tick, state.yaw.toFixed(5), state.pitch.toFixed(5),
    state.focus.toFixed(4), state.apertureIdx, state.shutterIdx,
    state.focal.toFixed(3), state.film, state.durability.toFixed(2),
    state.photos.map((p) => `${p.target}@${p.tick}`).join('|'),
    state.shots.map((s) => {
      const metrics = Object.entries(s.metrics)
        .map(([key, value]) => `${key}=${Number(value).toFixed(4)}`).join(',');
      return `${s.tick}:${s.ok ? 1 : 0}:${s.target ?? '-'}:${s.reasons.join('+')}:${metrics}`;
    }).join('|'),
  ];
  let hash = 0x811c9dc5;
  const str = parts.join('#');
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function createInitialState() {
  const state = {
    tick: 0,
    yaw: 0,
    pitch: 0,
    focus: 14,
    apertureIdx: 3,          // f/4
    shutterIdx: 5,           // 1/125
    focal: 35,
    film: FILM_START,
    durability: DURABILITY_START,
    photos: [],              // accepted photos, one entry per distinct target
    shots: [],               // every shutter press and its verdict
    result: null,            // 'success' | 'failed' | null
    finished: false,
  };
  state.hash = hashState(state);
  return state;
}

export function aperture(state) {
  return APERTURE_STOPS[state.apertureIdx];
}

export function shutter(state) {
  return SHUTTER_STOPS[state.shutterIdx];
}

// Horizontal full-frame FOV from focal length on a 36 mm wide sensor.
export function hFov(state) {
  return 2 * Math.atan(18 / state.focal);
}

export function vFov(state) {
  const h = hFov(state);
  return 2 * Math.atan(Math.tan(h / 2) * (480 / 720));
}

// Project a world point into the logical 720x480 frame. Null means outside.
export function project(state, pos) {
  const dx = pos.x;
  const dy = pos.y;
  const dz = pos.z;
  const cy = Math.cos(state.yaw);
  const sy = Math.sin(state.yaw);
  const rx = cy * dx - sy * dz;
  const rz = sy * dx + cy * dz;
  const cp = Math.cos(state.pitch);
  const sp = Math.sin(state.pitch);
  const ry = cp * dy - sp * rz;
  const depth = sp * dy + cp * rz;
  if (depth <= 0.5) return null;
  const nx = rx / depth;
  const ny = ry / depth;
  const u = nx / Math.tan(hFov(state) / 2);
  const v = ny / Math.tan(vFov(state) / 2);
  return { x: 360 + u * 360, y: 240 - v * 240, depth, u, v };
}

// Scene luminance EV reaching the sensor for a target (incoming light +
// distance attenuation).
function sceneEv(pos) {
  return lightAt(pos.x, 0) - Math.log2(Math.max(1, pos.z / 10));
}

// Camera exposure EV: log2(aperture^2 / shutter).
function cameraEv(state) {
  return Math.log2(aperture(state) ** 2 / shutter(state));
}

// Evaluate one shutter press against the target currently aimed at.
// Collision = viewfinder ray vs target bounding sphere; every failed gate
// records the measured value so the UI can explain the rejection.
export function evaluateShot(state, tick) {
  const positions = allTargetPositions(tick);
  const verdict = {
    tick, ok: false, target: null, reasons: [],
    metrics: {},
  };
  let best = null;
  for (const pos of positions) {
    const pr = project(state, pos);
    if (!pr) continue;
    const radius = Math.hypot(pr.u, pr.v);
    if (!best || radius < best.radius) best = { pos, pr, radius };
  }
  if (!best) {
    verdict.reasons.push('no-target');
    return verdict;
  }
  const { pos, pr } = best;
  verdict.target = pos.id;
  const target = TARGETS.find((item) => item.id === pos.id);
  verdict.metrics.distance = pr.depth;
  verdict.metrics.frameU = pr.u;
  verdict.metrics.frameV = pr.v;

  // Composition gate: centring + angular size.
  const angular = 2 * Math.atan(target.size / pr.depth);
  const sizeFrac = angular / vFov(state);
  verdict.metrics.sizeFrac = sizeFrac;
  if (Math.max(Math.abs(pr.u), Math.abs(pr.v)) > COMPOSE_EDGE) {
    verdict.reasons.push('off-center');
  }
  if (sizeFrac < COMPOSE_SIZE_MIN || sizeFrac > COMPOSE_SIZE_MAX) {
    verdict.reasons.push('bad-framing');
  }

  // Focus gate: depth must sit inside the acceptable focus band.
  const focusError = Math.abs(pr.depth - state.focus) / state.focus;
  verdict.metrics.focusError = focusError;
  if (focusError > FOCUS_TOLERANCE) verdict.reasons.push('out-of-focus');

  // Exposure gate: camera EV inside the metered band.
  const evIn = sceneEv(pos);
  const evCam = cameraEv(state);
  const evDelta = evCam - evIn;
  verdict.metrics.evIn = evIn;
  verdict.metrics.evCam = evCam;
  verdict.metrics.evDelta = evDelta;
  if (evDelta < EXPOSURE_LO || evDelta > EXPOSURE_HI) {
    verdict.reasons.push('bad-exposure');
  }

  // Motion blur gate: target smear + shutter time + fast gimbal turns.
  const prev = allTargetPositions(Math.max(0, tick - 1));
  const prevPos = prev.find((item) => item.id === pos.id);
  const targetSpeed = Math.hypot(pos.x - prevPos.x, pos.y - prevPos.y) / DT;
  const smear = (targetSpeed * shutter(state)) / pr.depth / Math.tan(vFov(state) / 2);
  verdict.metrics.smear = smear;
  if (smear > BLUR_LIMIT) verdict.reasons.push('motion-blur');

  verdict.ok = verdict.reasons.length === 0;
  return verdict;
}

function applyLeft(state, input) {
  state.yaw = clamp(state.yaw + input.pan * PAN_SPEED * DT, -PAN_LIMIT, PAN_LIMIT);
  state.pitch = clamp(state.pitch + input.tilt * TILT_SPEED * DT, -TILT_LIMIT, TILT_LIMIT);
}

function applyRight(state, input) {
  if (input.focusDir) {
    state.focus = clamp(state.focus + input.focusDir * FOCUS_SPEED * DT, FOCUS_MIN, FOCUS_MAX);
  }
  if (input.apertureStep) {
    state.apertureIdx = clamp(state.apertureIdx + input.apertureStep, 0, APERTURE_STOPS.length - 1);
  }
  if (input.shutterStep) {
    state.shutterIdx = clamp(state.shutterIdx + input.shutterStep, 0, SHUTTER_STOPS.length - 1);
  }
  if (input.zoomDir) {
    state.focal = clamp(state.focal + input.zoomDir * ZOOM_SPEED * DT, FOCAL_MIN, FOCAL_MAX);
  }
}

function applyCapture(state, tick) {
  const verdict = evaluateShot(state, tick);
  state.shots = [...state.shots, verdict];
  state.film -= 1;
  if (verdict.ok) {
    state.durability = Math.max(0, state.durability - DURABILITY_GOOD_SHOT);
    if (!state.photos.some((photo) => photo.target === verdict.target)) {
      state.photos = [...state.photos, {
        target: verdict.target, tick,
        metrics: { ...verdict.metrics },
      }];
    }
  } else {
    state.durability = Math.max(0, state.durability - DURABILITY_BAD_SHOT);
  }
  if (state.photos.length >= TARGETS.length && state.film >= 1) {
    state.finished = true;
    state.result = 'success';
  } else if (state.film <= 0) {
    state.finished = true;
    state.result = state.photos.length >= TARGETS.length ? 'success' : 'failed';
  }
  return verdict;
}

// Advance one fixed tick. `order` chooses which player's inputs are applied
// first; running both orders exposes action-order conflicts on the timeline.
export function step(state, input, order = 'lr') {
  const next = {
    ...state,
    photos: state.photos.map((p) => ({ ...p, metrics: { ...p.metrics } })),
    shots: state.shots.map((s) => ({
      ...s,
      metrics: { ...s.metrics },
      reasons: [...s.reasons],
    })),
  };
  if (next.finished) {
    next.hash = hashState(next);
    return { state: next, verdict: null };
  }
  // The shutter is the right player's action. In lr order it is evaluated
  // after the gimbal has already moved this tick; in rl order it fires before
  // the gimbal move, so the same inputs can produce different collisions.
  let verdict = null;
  if (order === 'lr') {
    applyLeft(next, input.left);
    applyRight(next, input.right);
    if (input.right.shutter) verdict = applyCapture(next, next.tick + 1);
  } else {
    applyRight(next, input.right);
    if (input.right.shutter) verdict = applyCapture(next, next.tick + 1);
    applyLeft(next, input.left);
  }
  next.tick += 1;
  next.hash = hashState(next);
  return { state: next, verdict };
}

export function emptyInput() {
  return {
    left: { pan: 0, tilt: 0 },
    right: { focusDir: 0, apertureStep: 0, shutterStep: 0, zoomDir: 0, shutter: false },
  };
}

// Run a full recorded timeline of input frames.
export function runTimeline(initial, frames, order = 'lr', untilTick = null) {
  let state = initial;
  const verdicts = [];
  for (let i = 0; i < frames.length; i += 1) {
    if (untilTick !== null && state.tick >= untilTick) break;
    const out = step(state, frames[i], order);
    state = out.state;
    if (out.verdict) verdicts.push(out.verdict);
  }
  return { state, verdicts };
}
