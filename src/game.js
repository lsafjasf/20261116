import {
  CHECKPOINT_INTERVAL,
  EXIT_ACTION_RADIUS,
  FAILURE_LABELS,
  IDLE_DRAIN,
  MATERIAL_LIST,
  MAX_BATTERY,
  MAX_EXPOSURE,
  MAX_HULL,
  MAX_RANGE,
  MOVE_DRAIN,
  MOVE_SPEED,
  PATROL_KILL_RADIUS,
  RECOVERY_BATTERY_FLOOR,
  RECOVERY_COST,
  SCAN_COOLDOWN_TICKS,
  SCAN_COST,
  SCAN_EXPOSURE,
  SCAN_RAYS,
  STATUSES,
} from "./config.js";
import { RNG, round, stableHash } from "./rng.js";
import {
  detectPatrolEcho,
  generateWorld,
  isWalkableCell,
  orbitPosition,
  sampleCurrent,
  scanSonar,
  worldSignature,
} from "./world.js";

const AllowTransitions = {
  READY: new Set(["RUNNING"]),
  RUNNING: new Set(["PAUSED", "SUCCESS", "FAILED"]),
  PAUSED: new Set(["RUNNING", "READY"]),
  SUCCESS: new Set(["READY", "RUNNING"]),
  FAILED: new Set(["RUNNING", "READY"]),
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clonePatrols(patrols) {
  return patrols.map((patrol) => ({
    ...patrol,
    anchor: { ...patrol.anchor },
    target: patrol.target ? { ...patrol.target } : null,
  }));
}

function normalizeInput(input = {}) {
  let dx = Number.isFinite(input.dx) ? clamp(input.dx, -1, 1) : 0;
  let dy = Number.isFinite(input.dy) ? clamp(input.dy, -1, 1) : 0;
  const magnitude = Math.hypot(dx, dy);
  if (magnitude > 1) {
    dx /= magnitude;
    dy /= magnitude;
  }
  return { dx: round(dx, 6), dy: round(dy, 6) };
}

function freshState(world, runtimeRng) {
  return {
    status: STATUSES.READY,
    seed: world.seed,
    tick: 0,
    battery: MAX_BATTERY,
    hull: MAX_HULL,
    exposure: 0,
    recoveries: 1,
    position: { x: world.start.x, y: world.start.y },
    heading: -Math.PI / 2,
    current: sampleCurrent(world, world.start.x, world.start.y),
    scanCooldown: 0,
    scanCount: 0,
    pulses: [],
    echoes: [],
    lastScan: null,
    patrols: clonePatrols(world.initialPatrols),
    patrolPings: [],
    trail: [{ x: round(world.start.x, 4), y: round(world.start.y, 4) }],
    checkpoint: {
      x: round(world.start.x, 4),
      y: round(world.start.y, 4),
      tick: 0,
      safe: true,
    },
    runtimeRngState: runtimeRng.state,
    visualClock: 0,
    audioSeq: 0,
    lastChange: "系统就绪：监听器等待下潜",
    outcome: null,
    failureReason: null,
    revealMap: false,
    collisionCooldown: 0,
  };
}

function publicState(state) {
  return state;
}

function patrolPosition(patrol, tick, rng) {
  const orbit = orbitPosition(patrol, tick);
  const wobble = (rng.next() - 0.5) * 0.11;
  return { x: orbit.x + wobble, y: orbit.y - wobble * 0.6 };
}

export function createGame(seedInput, options = {}) {
  const world = generateWorld(seedInput);
  let recording = options.recording !== false;
  let runtimeRng = new RNG(world.runtimeSeed);
  let state = freshState(world, runtimeRng);
  let audioEvents = [];
  let record = {
    version: 1,
    seed: world.seed,
    worldSignature: worldSignature(world),
    events: [],
    finalTick: 0,
    finalStatus: state.status,
    finalHash: null,
  };
  let audioEventSerial = 0;

  function pushAudio(event) {
    state.audioSeq += 1;
    audioEventSerial += 1;
    audioEvents.push({
      ...event,
      id: audioEventSerial,
      tick: state.tick,
    });
  }

  function note(message) {
    state.lastChange = message;
  }

  function setStatus(next) {
    if (state.status === next) return;
    if (!AllowTransitions[state.status]?.has(next)) {
      throw new Error(`Invalid state transition: ${state.status} -> ${next}`);
    }
    state.status = next;
  }

  function appendRecord(event) {
    if (!recording) return;
    record.events.push({ tick: state.tick, ...event });
  }

  function finalizeRecord() {
    record.finalTick = state.tick;
    record.finalStatus = state.status;
    record.finalHash = getHash();
  }

  function resetRun({ keepStatus = false } = {}) {
    runtimeRng = new RNG(world.runtimeSeed);
    state = freshState(world, runtimeRng);
    audioEvents = [];
    audioEventSerial = 0;
    if (!keepStatus) state.status = STATUSES.READY;
    record = {
      version: 1,
      seed: world.seed,
      worldSignature: worldSignature(world),
      events: [],
      finalTick: 0,
      finalStatus: state.status,
      finalHash: null,
    };
    note("系统复位：计时、电量、声呐与随机序列已重置");
    return state;
  }

  function start({ log = true } = {}) {
    if (state.status === STATUSES.PAUSED) {
      return resume({ log });
    }
    setStatus(STATUSES.RUNNING);
    note("下潜开始：寻找正确出口，避免主动扫描暴露位置");
    pushAudio({ type: "start" });
    if (log) appendRecord({ type: "start" });
    return state;
  }

  function pause({ log = true } = {}) {
    if (state.status !== STATUSES.RUNNING) return false;
    if (log) appendRecord({ type: "pause" });
    setStatus(STATUSES.PAUSED);
    note("已暂停：计时与声呐同步冻结");
    pushAudio({ type: "pause" });
    return true;
  }

  function resume({ log = true } = {}) {
    if (state.status !== STATUSES.PAUSED) return false;
    if (log) appendRecord({ type: "resume" });
    setStatus(STATUSES.RUNNING);
    note("继续监听：巡逻声源仍在水下活动");
    pushAudio({ type: "resume" });
    return true;
  }

  function fail(reason) {
    if (state.status !== STATUSES.RUNNING) return;
    state.outcome = "failed";
    state.failureReason = reason;
    setStatus(STATUSES.FAILED);
    note(`任务失败：${FAILURE_LABELS[reason] ?? reason}`);
    pushAudio({ type: "fail", reason });
    state.scanCooldown = 0;
    finalizeRecord();
  }

  function succeed() {
    if (state.status !== STATUSES.RUNNING) return;
    state.outcome = "success";
    state.failureReason = null;
    state.revealMap = true;
    setStatus(STATUSES.SUCCESS);
    note(`任务成功：用时 ${(state.tick * 0.05).toFixed(1)} 秒，抵达正确出口`);
    pushAudio({ type: "success" });
    finalizeRecord();
  }

  function updateCheckpoint() {
    const nearest = state.patrols.reduce(
      (minimum, patrol) =>
        Math.min(minimum, Math.hypot(patrol.x - state.position.x, patrol.y - state.position.y)),
      Infinity,
    );
    if (nearest < 6) return;
    state.checkpoint = {
      x: round(state.position.x, 4),
      y: round(state.position.y, 4),
      tick: state.tick,
      safe: true,
    };
  }

  function moveByIntent(input) {
    const flowX = state.current.vx * state.current.strength * 0.045;
    const flowY = state.current.vy * state.current.strength * 0.045;
    const deltaX = input.dx * MOVE_SPEED + flowX;
    const deltaY = input.dy * MOVE_SPEED + flowY;
    let collided = false;
    const nextX = state.position.x + deltaX;
    if (isWalkableCell(world, nextX, state.position.y)) {
      state.position.x = nextX;
    } else {
      collided = Math.abs(deltaX) > 0.002;
    }
    const nextY = state.position.y + deltaY;
    if (isWalkableCell(world, state.position.x, nextY)) {
      state.position.y = nextY;
    } else {
      collided = collided || Math.abs(deltaY) > 0.002;
    }
    if (input.dx !== 0 || input.dy !== 0) {
      state.heading = Math.atan2(input.dy, input.dx);
    }
    if (collided) {
      state.hull = Math.max(0, state.hull - 0.22);
      if (state.collisionCooldown <= 0) {
        pushAudio({ type: "bump" });
        state.collisionCooldown = 12;
        note("监听器擦碰岩壁，结构完整度下降");
      }
    }
  }

  function updatePatrols() {
    for (const patrol of state.patrols) {
      if (patrol.alertTicks > 0 && patrol.target) {
        const dx = patrol.target.x - patrol.x;
        const dy = patrol.target.y - patrol.y;
        const distance = Math.hypot(dx, dy);
        const step = Math.min(distance, 0.026);
        if (distance > 0.01) {
          patrol.x += (dx / distance) * step;
          patrol.y += (dy / distance) * step;
        }
        patrol.alertTicks -= 1;
      } else {
        const next = patrolPosition(patrol, state.tick, runtimeRng);
        patrol.x = next.x;
        patrol.y = next.y;
        patrol.alertTicks = 0;
        patrol.target = null;
      }

      const distance = Math.hypot(patrol.x - state.position.x, patrol.y - state.position.y);
      if (distance < 9) {
        state.exposure = Math.min(MAX_EXPOSURE, state.exposure + 0.025);
      }
      if (state.tick > 0 && state.tick % patrol.pingInterval === 0) {
        const panned = distance > 0.1 ? (patrol.x - state.position.x) / distance : 0;
        pushAudio({
          type: "patrolPing",
          distance: round(distance, 3),
          pan: round(panned, 3),
          patrolId: patrol.id,
        });
        if (distance <= MAX_RANGE) {
          state.patrolPings.push({
            id: patrol.id,
            x: round(patrol.x, 4),
            y: round(patrol.y, 4),
            age: 0,
            maxAge: 24,
          });
        }
      }
      if (distance < PATROL_KILL_RADIUS) {
        fail("patrol");
        return;
      }
    }
  }

  function updateTickEffects() {
    state.tick += 1;
    state.visualClock += 1;
    state.scanCooldown = Math.max(0, state.scanCooldown - 1);
    state.collisionCooldown = Math.max(0, state.collisionCooldown - 1);
    state.exposure = Math.max(0, state.exposure - 0.035);
    state.current = sampleCurrent(world, state.position.x, state.position.y);
    for (const pulse of state.pulses) pulse.age += 1;
    state.pulses = state.pulses.filter((pulse) => pulse.age <= pulse.maxAge);
    for (const ping of state.patrolPings) ping.age += 1;
    state.patrolPings = state.patrolPings.filter((ping) => ping.age <= ping.maxAge);
    if (state.tick % 3 === 0) {
      state.trail.push({
        x: round(state.position.x, 4),
        y: round(state.position.y, 4),
      });
      if (state.trail.length > 500) state.trail.shift();
    }
    if (state.tick % CHECKPOINT_INTERVAL === 0) updateCheckpoint();
  }

  function simulate(input, { log = true } = {}) {
    if (state.status !== STATUSES.RUNNING) return false;
    const clean = normalizeInput(input);
    if (log) appendRecord({ type: "tick", dx: clean.dx, dy: clean.dy });
    const moving = clean.dx !== 0 || clean.dy !== 0;
    moveByIntent(clean);
    state.battery = Math.max(
      0,
      state.battery - (moving ? MOVE_DRAIN : IDLE_DRAIN),
    );
    updateTickEffects();
    updatePatrols();
    state.runtimeRngState = runtimeRng.state;
    if (state.status !== STATUSES.RUNNING) return true;
    if (state.battery <= 0) fail("battery");
    else if (state.hull <= 0) fail("hull");
    else if (state.exposure >= MAX_EXPOSURE) fail("exposure");
    return true;
  }

  function tick(input = { dx: 0, dy: 0 }, optionsForTick = {}) {
    return simulate(input, optionsForTick);
  }

  function scan({ log = true } = {}) {
    if (state.status !== STATUSES.RUNNING) return { ok: false, reason: "not_running" };
    if (state.scanCooldown > 0) {
      note(`声呐换能器冷却中：还需 ${(state.scanCooldown * 0.05).toFixed(1)} 秒`);
      return { ok: false, reason: "cooldown" };
    }
    if (state.battery < SCAN_COST) {
      note("电量不足，无法发射主动声呐");
      pushAudio({ type: "denied" });
      return { ok: false, reason: "battery" };
    }
    if (log) appendRecord({ type: "scan" });

    const wallHits = scanSonar(world, state.position, SCAN_RAYS, MAX_RANGE);
    const patrolHits = [];
    for (const patrol of state.patrols) {
      const hit = detectPatrolEcho(world, state.position, patrol, MAX_RANGE);
      if (hit) patrolHits.push(hit);
    }
    const hits = [...wallHits, ...patrolHits];
    const materialSummary = {};
    for (const material of MATERIAL_LIST) materialSummary[material.key] = 0;
    materialSummary.gate = 0;
    materialSummary.patrol = 0;
    for (const hit of hits) {
      materialSummary[hit.materialKey] = (materialSummary[hit.materialKey] ?? 0) + 1;
    }

    state.scanCount += 1;
    state.scanCooldown = SCAN_COOLDOWN_TICKS;
    state.battery = Math.max(0, state.battery - SCAN_COST);
    state.exposure = Math.min(MAX_EXPOSURE, state.exposure + SCAN_EXPOSURE);
    state.echoes = hits;
    state.lastScan = {
      id: state.scanCount,
      tick: state.tick,
      origin: { x: round(state.position.x, 4), y: round(state.position.y, 4) },
      count: hits.length,
      hits,
      materialSummary,
    };
    state.pulses.push({
      id: state.scanCount,
      age: 0,
      maxAge: 44,
      origin: { x: round(state.position.x, 4), y: round(state.position.y, 4) },
    });

    for (const patrol of state.patrols) {
      patrol.alertTicks = Math.max(patrol.alertTicks, 180);
      patrol.target = { x: round(state.position.x, 4), y: round(state.position.y, 4) };
    }

    const strongest = [...hits]
      .sort((left, right) => right.intensity - left.intensity)
      .slice(0, 26)
      .map((hit) => ({
        angle: hit.angle,
        distance: hit.distance,
        intensity: hit.intensity,
        materialKey: hit.materialKey,
      }));
    pushAudio({
      type: "scan",
      echoes: strongest,
      count: hits.length,
      materialSummary,
    });
    note(
      `主动扫描 #${state.scanCount}：${hits.length} 个回声，电量 -${SCAN_COST}，暴露 +${SCAN_EXPOSURE}`,
    );
    if (state.exposure >= MAX_EXPOSURE) fail("exposure");
    else if (state.battery <= 0) fail("battery");
    return {
      ok: true,
      hits,
      materialSummary,
      battery: state.battery,
      exposure: state.exposure,
    };
  }

  function nearestExit() {
    let nearest = null;
    let minimum = Infinity;
    for (const exit of world.exits) {
      const distance = Math.hypot(exit.x - state.position.x, exit.y - state.position.y);
      if (distance < minimum) {
        minimum = distance;
        nearest = exit;
      }
    }
    return nearest ? { ...nearest, distance: round(minimum, 4) } : null;
  }

  function submitExit({ log = true } = {}) {
    if (state.status !== STATUSES.RUNNING) return { ok: false, reason: "not_running" };
    const exit = nearestExit();
    if (!exit || exit.distance > EXIT_ACTION_RADIUS) {
      note("提交失败：必须靠近一个出口裂隙");
      pushAudio({ type: "denied" });
      return { ok: false, reason: "too_far" };
    }
    if (log) appendRecord({ type: "submit", exitId: exit.id });
    state.revealMap = true;
    if (exit.id === world.correctExitIndex) {
      succeed();
      return { ok: true, correct: true, exit };
    }
    fail("wrong_exit");
    return { ok: true, correct: false, exit };
  }

  function recover({ log = true } = {}) {
    if (state.status !== STATUSES.FAILED) return { ok: false, reason: "not_failed" };
    if (state.recoveries <= 0) return { ok: false, reason: "no_recovery" };
    if (log) appendRecord({ type: "recover" });
    state.recoveries -= 1;
    state.position = {
      x: state.checkpoint.x,
      y: state.checkpoint.y,
    };
    state.battery = Math.max(RECOVERY_BATTERY_FLOOR, state.battery - RECOVERY_COST);
    state.hull = MAX_HULL;
    state.exposure = 6;
    state.scanCooldown = 0;
    state.collisionCooldown = 0;
    state.outcome = null;
    state.failureReason = null;
    state.revealMap = false;
    state.pulses = [];
    state.echoes = [];
    state.patrolPings = [];
    state.current = sampleCurrent(world, state.position.x, state.position.y);
    state.patrols = clonePatrols(world.initialPatrols).map((patrol) => {
      const position = orbitPosition(patrol, state.tick);
      return {
        ...patrol,
        x: position.x,
        y: position.y,
        alertTicks: 0,
        target: null,
      };
    });
    state.trail.push({
      x: round(state.position.x, 4),
      y: round(state.position.y, 4),
    });
    setStatus(STATUSES.RUNNING);
    note("紧急回收完成：返回最近安全航点，电量与暴露受到惩罚");
    audioEvents = [];
    pushAudio({ type: "recover" });
    record.finalHash = null;
    record.finalStatus = state.status;
    record.finalTick = state.tick;
    return { ok: true, recoveries: state.recoveries };
  }

  function hashSnapshot() {
    return {
      status: state.status,
      seed: state.seed,
      tick: state.tick,
      battery: round(state.battery, 6),
      hull: round(state.hull, 6),
      exposure: round(state.exposure, 6),
      recoveries: state.recoveries,
      position: {
        x: round(state.position.x, 6),
        y: round(state.position.y, 6),
      },
      heading: round(state.heading, 6),
      current: state.current,
      scanCooldown: state.scanCooldown,
      scanCount: state.scanCount,
      pulses: state.pulses.map((pulse) => ({
        id: pulse.id,
        age: pulse.age,
        maxAge: pulse.maxAge,
        origin: pulse.origin,
      })),
      echoes: state.echoes.map((hit) => [
        hit.angle,
        hit.distance,
        hit.intensity,
        hit.materialKey,
      ]),
      patrols: state.patrols.map((patrol) => ({
        id: patrol.id,
        x: round(patrol.x, 6),
        y: round(patrol.y, 6),
        alertTicks: patrol.alertTicks,
        target: patrol.target,
      })),
      patrolPings: state.patrolPings,
      trail: state.trail,
      checkpoint: state.checkpoint,
      runtimeRngState: runtimeRng.state,
      visualClock: state.visualClock,
      audioSeq: state.audioSeq,
      outcome: state.outcome,
      failureReason: state.failureReason,
      revealMap: state.revealMap,
      collisionCooldown: state.collisionCooldown,
      world: record.worldSignature,
    };
  }

  function getHash() {
    return stableHash(hashSnapshot());
  }

  function drainAudioEvents() {
    const drained = audioEvents;
    audioEvents = [];
    return drained;
  }

  function exportRecord() {
    record.finalTick = state.tick;
    record.finalStatus = state.status;
    record.finalHash = getHash();
    return JSON.parse(JSON.stringify(record));
  }

  function applyRecordedEvent(event) {
    if (event.tick !== state.tick) {
      throw new Error(
        `Replay tick mismatch: event ${event.type}@${event.tick}, state@${state.tick}`,
      );
    }
    switch (event.type) {
      case "start":
        return;
      case "tick":
        return simulate({ dx: event.dx, dy: event.dy }, { log: false });
      case "scan":
        return scan({ log: false });
      case "pause":
        return pause({ log: false });
      case "resume":
        return resume({ log: false });
      case "submit":
        return submitExit({ log: false });
      case "recover":
        return recover({ log: false });
      default:
        throw new Error(`Unknown replay event: ${event.type}`);
    }
  }

  function getDiagnostics() {
    return {
      status: state.status,
      tick: state.tick,
      elapsedMs: state.tick * 50,
      battery: round(state.battery, 4),
      exposure: round(state.exposure, 4),
      hull: round(state.hull, 4),
      recoveries: state.recoveries,
      rngState: runtimeRng.state,
      audioSeq: state.audioSeq,
      audioQueueLength: audioEvents.length,
      visualClock: state.visualClock,
      pulseCount: state.pulses.length,
      patrolPingCount: state.patrolPings.length,
      recordEvents: record.events.length,
      hash: getHash(),
    };
  }

  return {
    get state() {
      return publicState(state);
    },
    get world() {
      return world;
    },
    start,
    pause,
    resume,
    tick,
    step: tick,
    scan,
    submitExit,
    nearestExit,
    recover,
    restart: resetRun,
    resetRun,
    getHash,
    exportRecord,
    applyRecordedEvent,
    drainAudioEvents,
    getDiagnostics,
  };
}

export function replayRecord(record) {
  if (!record || !Array.isArray(record.events)) {
    throw new Error("Invalid replay record");
  }
  const game = createGame(record.seed, { recording: false });
  if (record.worldSignature !== worldSignature(game.world)) {
    throw new Error("World signature mismatch");
  }
  game.start({ log: false });
  for (const event of record.events) game.applyRecordedEvent(event);
  return game;
}

export function isTerminal(status) {
  return status === STATUSES.SUCCESS || status === STATUSES.FAILED;
}

export function canRecover(state) {
  return state.status === STATUSES.FAILED && state.recoveries > 0;
}
