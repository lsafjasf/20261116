// Deterministic stage-lighting simulation core.
// Pure ES module shared by the browser UI and the Node test harness.
// Time is measured in fixed ticks (TICK_HZ per simulated second).

export const TICK_HZ = 20;
export const STAGE_W = 800;
export const STAGE_H = 480;
export const ZONE_COUNT = 4;
export const ZONE_W = STAGE_W / ZONE_COUNT;

export const COLORS = ['warm', 'blue', 'red', 'green'];
export const ANGLE_MIN = -70;
export const ANGLE_MAX = 70;
export const BRIGHT_MIN = 0;
export const BRIGHT_MAX = 100;

// Rig fixture is mounted at top-centre of the stage.
export const RIG_X = STAGE_W / 2;
export const RIG_Y = 24;
export const RIG_LEN = 340; // light-cone length used for rendering/collision

// Heat model (continuous rotation overheats the rig).
export const HEAT_ROTATE_PER_TICK = 1.1;
export const HEAT_PASSIVE_COOLDOWN = 0.25; // always shedding some heat
export const HEAT_FLASH_PER_TICK = 0.55;
export const HEAT_COOLDOWN_PER_TICK = 0.6;
export const HEAT_LIMIT = 100;
export const HEAT_REARM = 70;

// Cue judging.
export const TOLERANCE = 0.18; // fraction of zone width
export const BRIGHT_OK = 55;
export const CUE_WINDOW = 60; // ticks (3 s) where the cue must be satisfied
export const CUE_GAP = 10; // ticks (0.5 s) for rig traversal / gel changes
export const CUE_SLOT = CUE_WINDOW + CUE_GAP;
export const CUE_STREAK_PASS = 20; // 1 s of simultaneous satisfaction
export const DARK_STREAK_LIMIT = 30; // 1.5 s of unsatisfied cue => dark incident

export const SEGMENTS = 5;
export const CUES_PER_SEGMENT = 2;

const TARGET_ZONES = [0, 3, 1, 2, 0, 2, 3, 1, 2, 3];
const TARGET_COLORS = ['warm', 'blue', 'red', 'green', 'warm', 'red', 'blue', 'green', 'warm', 'blue'];

export function zoneCenter(zone) {
  return zone * ZONE_W + ZONE_W / 2;
}

export function buildScript() {
  const cues = [];
  for (let i = 0; i < SEGMENTS * CUES_PER_SEGMENT; i++) {
    cues.push({
      index: i,
      segment: Math.floor(i / CUES_PER_SEGMENT),
      start: i * CUE_SLOT,
      end: i * CUE_SLOT + CUE_WINDOW,
      targetZone: TARGET_ZONES[i],
      targetX: zoneCenter(TARGET_ZONES[i]),
      targetColor: TARGET_COLORS[i],
    });
  }
  return cues;
}

export const SCRIPT = buildScript();
export const SHOW_END_TICK = SCRIPT[SCRIPT.length - 1].end;

// Aim angle (degrees, 0 = straight down) needed to centre a zone.
export function angleForZone(zone) {
  const dx = zoneCenter(zone) - RIG_X;
  return Math.max(ANGLE_MIN, Math.min(ANGLE_MAX, (Math.atan2(dx, RIG_LEN) * 180) / Math.PI));
}

// Ground point of the light cone at the current rig angle.
export function spotX(angle) {
  return RIG_X + Math.tan((angle * Math.PI) / 180) * RIG_LEN;
}

export function zoneOfX(x) {
  return Math.max(0, Math.min(ZONE_COUNT - 1, Math.floor(x / ZONE_W)));
}

export function createInitialState() {
  return {
    tick: 0,
    // Player 1: master light + brightness.
    brightness: 22,
    power: false,
    // Player 2: gel colour + rig rotation.
    colorIndex: 0,
    angle: 0,
    heat: 0,
    overheated: false,
    // Shared consequences.
    actor: { x: zoneCenter(0), y: STAGE_H - 60 },
    durabilityP1: 100,
    durabilityP2: 100,
    // Cue bookkeeping.
    cueIndex: 0,
    streaks: SCRIPT.map(() => 0),
    badStreaks: SCRIPT.map(() => 0),
    passed: SCRIPT.map(() => false),
    failedCue: -1,
    status: 'running', // running | success | failed
    failReason: null,
    // Last per-tick evaluation, consumed by the renderer.
    lastEval: null,
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Empty per-tick input. The UI fills held flags and edge flags.
export function emptyInput() {
  return {
    p1: { brightDeltaHold: 0, flashHold: false, powerEdge: false },
    p2: { leftHold: false, rightHold: false, colorEdge: false, cutEdge: false },
  };
}

function applyEdgesAndHolds(state, input) {
  const events = [];
  const { p1, p2 } = input;

  // --- Shared channel: master power. Both players can write it. ---
  // P1 `E` toggles the breaker; P2 `L` is the safety interlock that cuts power.
  // Writes arriving on the same tick are order-dependent and reported.
  if (p1.powerEdge || p2.cutEdge) {
    if (p1.powerEdge && p2.cutEdge) {
      // The two operations are not commutative, so the outcome depends on the
      // ordering. Both hypothetical end states are stored for the conflict log.
      const afterP1First = false; // toggle first, then interlock cut
      const afterP2First = !state.power; // cut (no-op when already off), then toggle
      events.push({
        type: 'conflict',
        tick: state.tick,
        channel: 'power',
        object: { x: RIG_X, y: RIG_Y },
        p1Action: 'toggle-breaker',
        p2Action: 'interlock-cut',
        resultIfP1First: afterP1First,
        resultIfP2First: afterP2First,
        resolution: 'p2-safety-first',
      });
    }
    if (p2.cutEdge) state.power = false; // safety interlock wins deterministically
    else if (p1.powerEdge) state.power = !state.power;
  }

  // P1 brightness (held), capped while flash is held.
  if (p1.brightDeltaHold) {
    state.brightness = clamp(state.brightness + p1.brightDeltaHold, BRIGHT_MIN, BRIGHT_MAX);
  }
  if (p1.flashHold) state.brightness = BRIGHT_MAX;

  // P2 gel colour (edge).
  if (p2.colorEdge) state.colorIndex = (state.colorIndex + 1) % COLORS.length;

  // P2 rig rotation (held) with thermal lockout.
  let rotating = false;
  if (!state.overheated) {
    if (p2.leftHold) { state.angle = clamp(state.angle - 3.5, ANGLE_MIN, ANGLE_MAX); rotating = true; }
    if (p2.rightHold) { state.angle = clamp(state.angle + 3.5, ANGLE_MIN, ANGLE_MAX); rotating = true; }
  }

  // Thermal model.
  if (rotating) state.heat = clamp(state.heat + HEAT_ROTATE_PER_TICK, 0, HEAT_LIMIT);
  else if (p1.flashHold) state.heat = clamp(state.heat + HEAT_FLASH_PER_TICK - HEAT_PASSIVE_COOLDOWN, 0, HEAT_LIMIT);
  else state.heat = clamp(state.heat - HEAT_COOLDOWN_PER_TICK, 0, HEAT_LIMIT);
  if (rotating) state.heat = clamp(state.heat - HEAT_PASSIVE_COOLDOWN, 0, HEAT_LIMIT);

  if (!state.overheated && state.heat >= HEAT_LIMIT - 0.5) {
    state.heat = HEAT_LIMIT;
    state.overheated = true;
    state.durabilityP2 = Math.max(0, state.durabilityP2 - 20);
    events.push({ type: 'overheat', tick: state.tick, object: { x: RIG_X, y: RIG_Y } });
  } else if (state.overheated && state.heat <= HEAT_REARM) {
    state.overheated = false;
    events.push({ type: 'rearm', tick: state.tick });
  }
  if (state.durabilityP2 <= 0 && state.status === 'running') {
    state.status = 'failed';
    state.failReason = 'rig-burnout';
  }
  return events;
}

function moveActor(state) {
  const cue = SCRIPT[Math.min(state.cueIndex, SCRIPT.length - 1)];
  const target = cue.targetX;
  const speed = 9; // px per tick
  const dx = target - state.actor.x;
  if (Math.abs(dx) <= speed) state.actor.x = target;
  else state.actor.x += Math.sign(dx) * speed;
}

function activeCue(state) {
  let idx = state.cueIndex;
  while (idx < SCRIPT.length && state.tick >= SCRIPT[idx].end) idx += 1;
  if (idx >= SCRIPT.length) return null;
  if (state.tick < SCRIPT[idx].start) return null; // inside a transition gap
  state.cueIndex = idx;
  return SCRIPT[idx];
}

function evaluateCue(state) {
  const cue = activeCue(state);
  const events = [];
  if (!cue) return events;

  const ground = spotX(state.angle);
  const posOk = Math.abs(ground - cue.targetX) <= ZONE_W * TOLERANCE;
  const colorOk = COLORS[state.colorIndex] === cue.targetColor;
  const brightOk = state.power && state.brightness >= BRIGHT_OK;
  const satisfied = posOk && colorOk && brightOk;

  const evalInfo = {
    cue: cue.index,
    posOk,
    colorOk,
    brightOk,
    satisfied,
    spotX: ground,
    actorX: state.actor.x,
  };
  state.lastEval = evalInfo;

  if (satisfied && !state.passed[cue.index]) {
    state.streaks[cue.index] += 1;
    state.badStreaks[cue.index] = 0;
    if (state.streaks[cue.index] >= CUE_STREAK_PASS && !state.passed[cue.index]) {
      state.passed[cue.index] = true;
      state.durabilityP1 = clamp(state.durabilityP1 + 4, 0, 100);
      events.push({
        type: 'cue-pass',
        tick: state.tick,
        cue: cue.index,
        object: { x: cue.targetX, y: state.actor.y },
      });
    }
  } else if (!state.passed[cue.index]) {
    state.streaks[cue.index] = 0;
    state.badStreaks[cue.index] += 1;
    if (state.badStreaks[cue.index] >= DARK_STREAK_LIMIT) {
      state.status = 'failed';
      state.failReason = 'dark-incident';
      state.failedCue = cue.index;
      state.durabilityP1 = Math.max(0, state.durabilityP1 - 25);
      events.push({
        type: 'dark-incident',
        tick: state.tick,
        cue: cue.index,
        object: { x: state.actor.x, y: state.actor.y },
      });
    }
  }

  // A cue that reaches its window end without passing is a dark incident.
  if (state.tick + 1 >= cue.end && !state.passed[cue.index] && state.status === 'running') {
    state.status = 'failed';
    state.failReason = 'cue-missed';
    state.failedCue = cue.index;
    events.push({ type: 'cue-missed', tick: state.tick, cue: cue.index });
  }
  return events;
}

export function step(state, input) {
  const events = applyEdgesAndHolds(state, input);
  moveActor(state);
  events.push(...(evaluateCue(state) || []));
  state.tick += 1;

  if (state.status === 'running' && state.passed.every(Boolean)) {
    state.status = 'success';
    events.push({ type: 'show-complete', tick: state.tick });
  }
  return events;
}

// Deterministic FNV-1a hash over a canonical JSON encoding of the state.
export function hashState(state) {
  const json = JSON.stringify(state, Object.keys(state).sort());
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
