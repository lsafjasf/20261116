import * as C from './constants.js';
import { fnv1a } from './rng.js';

// Stateful PRNG whose state can be snapshotted / restored (determinism).
class Rng {
  constructor(seed) { this.seed = seed >>> 0; this.a = this.seed; }
  next() {
    this.a = (this.a + 0x6D2B79F5) | 0;
    let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min, max) { return min + this.next() * (max - min); }
  save() { return { seed: this.seed, a: this.a }; }
  restore(s) { this.seed = s.seed; this.a = s.a; }
}

const EMPTY_INPUT = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0]);

export function createSim(seed = 1) {
  const rng = new Rng(seed);
  const samples = [];
  for (let i = 0; i < C.SAMPLE_COUNT_GOAL; i++) {
    samples.push({
      id: i,
      x: rng.range(-38, 38),
      depth: rng.range(C.SAMPLE_MIN_DEPTH, C.SAMPLE_MAX_DEPTH),
      taken: false,
      takenAt: -1,
    });
  }
  samples.sort((p, q) => p.depth - q.depth);
  samples.forEach((sample, index) => { sample.id = index; });
  const s = {
    seed,
    rng,
    tick: 0,
    timeMs: 0,
    phase: C.PHASE.READY,
    prevPhase: null,
    running: false,
    success: false,
    failReason: null,
    // physics
    depth: 0,
    vs: 0,             // vertical velocity (m/s-ish), negative = up
    x: 0,
    vx: 0,
    ballast: C.BALLAST_NEUTRAL,
    valveBlow: false,
    engineOn: true,
    lightMode: 0,
    // resources
    battery: C.BATTERY_MAX,
    o2: C.O2_MAX,
    temp: 20,
    hull: C.HULL_MAX,
    // mission
    samples,
    collected: 0,
    nextSampleId: 0,
    // events / recording
    stateChanges: [],
    warnings: [],
    lastChange: null,
    inputLog: [],
    checkpoints: [],
    currentEvent: null,   // {kind, ticksLeft, ...}
    runawayTicks: 0,
    recoveredCount: 0,
    sampleAttempts: 0,
  };
  note(s, 'READY', '系统就绪，等待下潜指令');
  return s;
}

export function note(s, phase, text) {
  const entry = { tick: s.tick, t: s.timeMs, phase, text };
  s.stateChanges.push(entry);
  s.lastChange = entry;
  if (s.stateChanges.length > 60) s.stateChanges.shift();
}

function setPhase(s, phase, text) {
  if (s.phase === phase) return;
  s.prevPhase = s.phase;
  s.phase = phase;
  note(s, phase, text ?? `${s.prevPhase} → ${phase}`);
}

function snapshot(s) {
  return {
    tick: s.tick, timeMs: s.timeMs, phase: s.phase, prevPhase: s.prevPhase,
    running: s.running, success: s.success, failReason: s.failReason,
    depth: s.depth, vs: s.vs, x: s.x, vx: s.vx,
    ballast: s.ballast, valveBlow: s.valveBlow, engineOn: s.engineOn,
    lightMode: s.lightMode, battery: s.battery, o2: s.o2, temp: s.temp,
    hull: s.hull, collected: s.collected, nextSampleId: s.nextSampleId,
    samples: s.samples.map((q) => ({ ...q })),
    runawayTicks: s.runawayTicks, recoveredCount: s.recoveredCount,
    sampleAttempts: s.sampleAttempts,
    currentEvent: s.currentEvent ? { ...s.currentEvent } : null,
    rng: s.rng.save(), lastChange: s.lastChange,
  };
}

function pushCheckpoint(s) {
  s.checkpoints.push(snapshot(s));
  if (s.checkpoints.length > C.CHECKPOINT_KEEP) s.checkpoints.shift();
}

function randomEvent(s) {
  if (s.currentEvent) {
    s.currentEvent.ticksLeft -= 1;
    if (s.currentEvent.ticksLeft <= 0) {
      note(s, s.phase, `随机事件结束：${eventLabel(s.currentEvent.kind)}`);
      s.currentEvent = null;
    }
    return;
  }
  if (s.depth < 8) return;
  const roll = s.rng.next();
  if (roll < 0.012) {
    s.currentEvent = { kind: 'current', ticksLeft: 12 };
    note(s, s.phase, '随机事件：强洋流（10–14 秒）');
  } else if (roll < 0.02) {
    s.currentEvent = { kind: 'leak', ticksLeft: 10 };
    note(s, s.phase, '随机事件：轻微管路渗漏（耐久下降）');
  } else if (roll < 0.026) {
    s.currentEvent = { kind: 'cold', ticksLeft: 14 };
    note(s, s.phase, '随机事件：冷水团经过（舱温下降）');
  }
}

function eventLabel(k) {
  return k === 'current' ? '强洋流' : k === 'leak' ? '管路渗漏' : '冷水团';
}

function powerStep(s, input) {
  if (input[C.INPUT.ENGINE] === 1) s.engineOn = true;
  else if (input[C.INPUT.ENGINE] === -1) s.engineOn = false;
  const engine = s.engineOn;
  s.engineOn = engine;
  const lm = Number.isFinite(input[C.INPUT.LIGHT]) ? input[C.INPUT.LIGHT] : s.lightMode;
  s.lightMode = lm;
  const draw = C.POWER_BASE
    + (engine ? C.THRUST_MAX * Math.abs(input[C.INPUT.THRUST] || 0) * 10 : 0)
    + C.POWER_LIGHT[lm];
  s.powerDraw = draw;
  if (s.depth <= C.SURFACE_DEPTH) {
    s.battery = Math.min(C.BATTERY_MAX, s.battery + C.CHARGE_RATE);
  } else {
    s.battery = Math.max(0, s.battery - draw * C.DISCHARGE_K);
  }
  // Lights starving propulsion: floodlight caps effective thrust.
  const lightPenalty = lm === 2 ? 0.55 : lm === 1 ? 0.9 : 1;
  s.thrustScale = engine && s.battery > 0 ? lightPenalty * (s.battery < C.LOW_BATTERY ? 0.6 : 1) : 0;
  if (s.battery <= 0 && s.depth > C.SURFACE_DEPTH) {
    fail(s, C.FAIL_REASON.BATTERY);
  }
  s.o2 = Math.max(0, s.o2 - C.O2_DRAIN);
  if (s.o2 <= 0) fail(s, C.FAIL_REASON.O2);
}

function ballastStep(s, input) {
  const runaway = s.phase === C.PHASE.RUNAWAY;
  if (input[C.INPUT.BLOW]) {
    s.ballast = Math.max(C.BALLAST_MIN, s.ballast - C.BLOW_RATE);
    s.valveBlow = true;
  } else {
    s.valveBlow = false;
    // During RUNAWAY only flooding (add weight) is permitted by the state machine.
    if (!runaway || input[C.INPUT.FLOOD]) {
      if (input[C.INPUT.FLOOD]) s.ballast = Math.min(C.BALLAST_MAX, s.ballast + C.BALLAST_RATE);
      if (!runaway && input[C.INPUT.VENT]) s.ballast = Math.max(C.BALLAST_MIN, s.ballast - C.BALLAST_RATE);
    }
    if (!runaway && input[C.INPUT.NEUTRAL]) {
      s.ballast += (C.BALLAST_NEUTRAL - s.ballast) * 0.5;
    }
  }
}

function motionStep(s, input) {
  // vertical: ballast 1 => sinks (positive vs), 0 => rises (negative vs)
  const buoy = (s.ballast - C.BALLAST_NEUTRAL) * C.ACCEL_K;
  s.vs = s.vs * C.DRAG + buoy;
  // horizontal thrust with light / battery penalty
  const thrust = (input[C.INPUT.THRUST] || 0) * C.THRUST_MAX * s.thrustScale;
  s.vx = s.vx * 0.85 + thrust * 0.5;
  if (s.currentEvent && s.currentEvent.kind === 'current') {
    s.vx += s.rng.range(-C.CURRENT_PUSH, C.CURRENT_PUSH);
  }
  s.x += s.vx;
  s.depth += s.vs;
  if (s.depth <= 0) {
    s.depth = 0;
    if (s.vs < 0) s.vs = 0;
  }
  if (s.depth > C.MAX_DEPTH) fail(s, C.FAIL_REASON.CRUSH);
}

function tempStep(s) {
  const ambient = Math.max(10, 22 - Math.min(12, s.depth * 0.1));
  s.temp += (ambient - s.temp) * C.TEMP_SETTLE;
  // rapid ascent/descent swings cabin temperature
  s.temp += s.vs * C.TEMP_GRAD_K;
  if (s.currentEvent && s.currentEvent.kind === 'cold') s.temp -= 0.08;
  s.temp = Math.max(2, Math.min(38, s.temp));
}

function hullStep(s) {
  let wear = 0;
  if (s.depth > C.SAFE_DEPTH) wear += (s.depth - C.SAFE_DEPTH) * C.HULL_DEPTH_K;
  if (s.phase === C.PHASE.RUNAWAY) wear += C.HULL_SPEED_K * Math.abs(s.vs);
  if (s.temp < C.TEMP_SAFE_LOW || s.temp > C.TEMP_SAFE_HIGH) wear += C.HULL_TEMP_K;
  if (s.currentEvent && s.currentEvent.kind === 'leak') wear += 0.12;
  if (wear > 0) s.hull = Math.max(0, s.hull - wear);
  if (s.hull <= 0) fail(s, C.FAIL_REASON.HULL);
}

function fail(s, reason) {
  if (s.phase === C.PHASE.FAILED) return;
  s.failReason = reason;
  s.running = false;
  setPhase(s, C.PHASE.FAILED, `任务失败：${reason}（可按 R 恢复检查点）`);
}

function trySample(s) {
  if (s.phase === C.PHASE.RUNAWAY || s.phase === C.PHASE.FAILED) return;
  const target = s.samples[s.nextSampleId];
  if (!target || target.taken) return;
  s.sampleAttempts += 1;
  const nearDepth = Math.abs(s.depth - target.depth) <= C.SAMPLE_RADIUS;
  const nearX = Math.abs(s.x - target.x) <= 5.5;
  if (nearDepth && nearX && s.battery > 2) {
    target.taken = true;
    target.takenAt = s.tick;
    s.collected += 1;
    s.nextSampleId += 1;
    s.battery = Math.max(0, s.battery - 2);
    setPhase(s, C.PHASE.SAMPLING, `样本点 ${target.id + 1} 采集成功（${s.collected}/${C.SAMPLE_COUNT_GOAL}）`);
  } else {
    s.warnings.push({ tick: s.tick, text: nearDepth ? '横向偏差过大，无法采样' : '深度不匹配，无法采样' });
    if (s.warnings.length > 20) s.warnings.shift();
  }
}

function phaseMachine(s) {
  const runaway = s.phase === C.PHASE.RUNAWAY;
  if (s.phase === C.PHASE.FAILED || s.phase === C.PHASE.SURFACED) return;
  if (s.phase === C.PHASE.READY && s.running) {
    setPhase(s, C.PHASE.DIVING, '开始下潜，目标：采集三个样本点');
  }
  // runaway detection
  if (s.depth > C.RUNAWAY_DEPTH && s.vs < -C.RUNAWAY_SPEED) {
    s.runawayTicks += 1;
    if (!runaway && s.runawayTicks >= 3) {
      setPhase(s, C.PHASE.RUNAWAY, `失控上浮！升降速度 ${(-s.vs).toFixed(2)} 超限，立即注水压载`);
    }
  } else {
    s.runawayTicks = Math.max(0, s.runawayTicks - 1);
  }
  // recovery from runaway
  if (runaway && Math.abs(s.vs) <= C.RECOVER_SPEED && s.depth > C.SURFACE_DEPTH) {
    s.recoveredCount += 1;
    setPhase(s, C.PHASE.RECOVERED, '控制恢复：上浮已被抑制，继续任务');
    setPhase(s, s.collected >= C.SAMPLE_COUNT_GOAL ? C.PHASE.ASCENDING : C.PHASE.DIVING, '返回任务流程');
  }
  // surface handling
  if (s.depth <= C.SURFACE_DEPTH && s.tick > 1) {
    if (s.vs < -C.SURFACE_SAFE_SPEED) {
      s.hull = Math.max(0, s.hull - 8);
      fail(s, C.FAIL_REASON.HULL);
      note(s, C.PHASE.FAILED, '高速冲出水面，船体严重受损');
      return;
    }
    if (s.collected >= C.SAMPLE_COUNT_GOAL) {
      s.success = true;
      s.running = false;
      setPhase(s, C.PHASE.SURFACED, '三个样本全部回收，上浮成功！任务完成');
    } else if (s.phase !== C.PHASE.READY) {
      setPhase(s, s.phase, `已在水面（样本 ${s.collected}/${C.SAMPLE_COUNT_GOAL}），重新下潜或充电`);
    }
  } else if (s.collected >= C.SAMPLE_COUNT_GOAL && s.phase !== C.PHASE.RUNAWAY) {
    if (s.phase !== C.PHASE.ASCENDING) setPhase(s, C.PHASE.ASCENDING, '样本已齐，目标：上浮回收');
  } else if (s.phase === C.PHASE.SAMPLING || s.phase === C.PHASE.RECOVERED) {
    setPhase(s, C.PHASE.DIVING, '继续前往下一目标');
  }
}

export function step(s, rawInput = EMPTY_INPUT) {
  if (s.phase === C.PHASE.PAUSED) return s;
  if (s.phase === C.PHASE.FAILED || s.phase === C.PHASE.SURFACED) return s;
  const input = Array.from(rawInput, (v) => v || 0);
  s.inputLog.push({ t: s.tick, i: input.slice() });
  s.tick += 1;
  s.timeMs = s.tick * C.TICK_MS;
  s.running = true;
  randomEvent(s);
  powerStep(s, input);
  if (s.phase === C.PHASE.FAILED) return finalize(s);
  ballastStep(s, input);
  motionStep(s, input);
  if (s.phase === C.PHASE.FAILED) return finalize(s);
  tempStep(s);
  hullStep(s);
  if (s.phase === C.PHASE.FAILED) return finalize(s);
  if (input[C.INPUT.SAMPLE]) trySample(s);
  phaseMachine(s);
  if (s.tick % C.CHECKPOINT_EVERY === 0) pushCheckpoint(s);
  return finalize(s);
}

function finalize(s) {
  s.objective = currentObjective(s);
  return s;
}

export function currentObjective(s) {
  if (s.phase === C.PHASE.FAILED) return '失败恢复：按 R 回到检查点';
  if (s.phase === C.PHASE.RUNAWAY) return '紧急处置：注水（W）抑制失控上浮';
  if (s.phase === C.PHASE.SURFACED) return '任务完成';
  if (s.collected >= C.SAMPLE_COUNT_GOAL) return '上浮：减小压载并在低速出水';
  const target = s.samples[s.nextSampleId];
  if (!target) return '上浮回收';
  return `前往样本点 ${target.id + 1}：深度 ${target.depth.toFixed(0)}m，横向 ${target.x.toFixed(0)}m`;
}

export function setPaused(s, paused) {
  if (paused && s.phase !== C.PHASE.FAILED && s.phase !== C.PHASE.SURFACED) {
    s._resumePhase = s.phase;
    setPhase(s, C.PHASE.PAUSED, '仿真已暂停');
  } else if (!paused && s.phase === C.PHASE.PAUSED) {
    const back = s._resumePhase || C.PHASE.DIVING;
    s.phase = back;
    note(s, back, '仿真继续');
  }
}

// Failure recovery: roll back to the latest pre-failure / pre-runaway checkpoint.
export function recover(s) {
  const cp = s.checkpoints[s.checkpoints.length - 1];
  if (!cp) return false;
  restoreSnapshot(s, cp);
  // Stabilize: stop the momentum that caused the failure in the first place.
  s.vs = 0;
  s.vx = 0;
  s.ballast = C.BALLAST_NEUTRAL;
  s.currentEvent = null;
  // Recovery grants a small safety margin so the crew has room to act.
  s.o2 = Math.max(s.o2, 60);
  s.battery = Math.max(s.battery, 60);
  s.hull = Math.max(s.hull, 45);
  s.recoveredCount += 1;
  s.running = true;
  setPhase(s, C.PHASE.DIVING, `检查点恢复（tick ${cp.tick}），随机序列同步回滚`);
  s.checkpoints.pop(); // allow stepping back through older checkpoints
  return true;
}

function restoreSnapshot(s, cp) {
  s.tick = cp.tick; s.timeMs = cp.timeMs;
  s.phase = cp.phase; s.prevPhase = cp.prevPhase;
  s.running = cp.running; s.success = cp.success; s.failReason = cp.failReason;
  s.depth = cp.depth; s.vs = cp.vs; s.x = cp.x; s.vx = cp.vx;
  s.ballast = cp.ballast; s.valveBlow = cp.valveBlow;
  s.engineOn = cp.engineOn; s.lightMode = cp.lightMode;
  s.battery = cp.battery; s.o2 = cp.o2; s.temp = cp.temp; s.hull = cp.hull;
  s.collected = cp.collected; s.nextSampleId = cp.nextSampleId;
  s.samples = cp.samples.map((q) => ({ ...q }));
  s.runawayTicks = cp.runawayTicks;
  s.sampleAttempts = cp.sampleAttempts;
  s.currentEvent = cp.currentEvent ? { ...cp.currentEvent } : null;
  s.rng.restore(cp.rng);
  s.lastChange = cp.lastChange;
}

export function hashState(s) {
  const core = {
    seed: s.seed, tick: s.tick, phase: s.phase, success: s.success,
    failReason: s.failReason, depth: r3(s.depth), vs: r3(s.vs),
    x: r3(s.x), vx: r3(s.vx), ballast: r3(s.ballast),
    engineOn: s.engineOn, lightMode: s.lightMode,
    battery: r3(s.battery), o2: r3(s.o2), temp: r3(s.temp), hull: r3(s.hull),
    collected: s.collected, nextSampleId: s.nextSampleId,
    samples: s.samples.map((q) => [q.id, q.taken, q.takenAt, r3(q.depth), r3(q.x)]),
    runawayTicks: s.runawayTicks, recoveredCount: s.recoveredCount,
    sampleAttempts: s.sampleAttempts, rng: s.rng.save(),
  };
  return fnv1a(JSON.stringify(core));
}

const r3 = (n) => Math.round(n * 1000) / 1000;
