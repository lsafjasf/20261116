export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
export const MISSION_SECONDS = 180;

export const PHASE = Object.freeze({
  APPROACH: "approach",
  HOLD: "hold",
  LATCHING: "latching",
  TRANSFER: "transfer",
  RETREATING: "retreating",
  FAILED: "failed",
  COMPLETE: "complete",
});

export const LIMITS = Object.freeze({
  bearingDeg: 1.35,
  pitchDeg: 1.15,
  axialSpeed: 0.16,
  minRange: 0.7,
  maxRange: 1.45,
  maxLateralSpeed: 0.82,
  maxVerticalSpeed: 0.7,
  maxAxialSpeed: 1.3,
  safeRetreat: 12,
});

const START_RANGE = 18;
const HOLD_SECONDS = 2;
const LATCH_SECONDS = 0.9;
const TRANSFER_SECONDS = 1.8;

export const PHASE_LABELS = Object.freeze({
  [PHASE.APPROACH]: "进近修正",
  [PHASE.HOLD]: "三轴保持",
  [PHASE.LATCHING]: "锁扣启动",
  [PHASE.TRANSFER]: "转场至二号接口",
  [PHASE.RETREATING]: "安全撤离",
  [PHASE.FAILED]: "回合中止",
  [PHASE.COMPLETE]: "任务完成",
});

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function seedToUint32(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) {
    return seed >>> 0;
  }
  const text = String(seed ?? "ORBITAL-LATCH");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomUnit(state) {
  state.rngState = (state.rngState + 0x6d2b79f5) >>> 0;
  let value = state.rngState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function randomBetween(state, min, max) {
  return min + (max - min) * randomUnit(state);
}

function scheduleDrift(state) {
  state.nextDriftTick = state.tick + Math.floor(randomBetween(state, 210, 390));
}

function rollPort(state, dockNumber) {
  state.portOffset = {
    x: randomBetween(state, dockNumber === 1 ? -0.22 : -0.34, dockNumber === 1 ? 0.22 : 0.34),
    y: randomBetween(state, dockNumber === 1 ? -0.18 : -0.3, dockNumber === 1 ? 0.18 : 0.3),
  };
}

function initialResources() {
  return {
    propellant: 100,
    power: 100,
    latchCharges: 2,
    hull: 100,
  };
}

function baseState(seed) {
  return {
    version: 1,
    seed: String(seed),
    initialSeed: seedToUint32(seed),
    rngState: seedToUint32(seed),
    tick: 0,
    elapsed: 0,
    phase: PHASE.APPROACH,
    dockNumber: 1,
    latchCount: 0,
    holdTime: 0,
    latchTime: 0,
    transferTime: 0,
    x: 0,
    y: 0,
    d: START_RANGE,
    vx: 0,
    vy: 0,
    vd: -0.18,
    portOffset: { x: 0, y: 0 },
    commands: { yaw: 0, pitch: 0, throttle: 0 },
    resources: initialResources(),
    driftSerial: 0,
    nextDriftTick: 0,
    lastDrift: null,
    failure: null,
    lastChange: null,
    changeLog: [],
    inputLog: [],
  };
}

function noteChange(state, text, tone = "info") {
  const change = {
    tick: state.tick,
    elapsed: Number(state.elapsed.toFixed(3)),
    text,
    tone,
  };
  state.lastChange = change;
  state.changeLog.push(change);
  if (state.changeLog.length > 24) {
    state.changeLog.shift();
  }
}

export function createSimulation(seed = "ORBITAL-LATCH") {
  const state = baseState(seed);
  rollPort(state, 1);
  scheduleDrift(state);
  noteChange(state, "任务开始：三轴同步进近一号接口", "start");
  state.inputLog.push({ tick: 0, yaw: 0, pitch: 0, throttle: 0 });
  return state;
}

export function axisTelemetry(state) {
  const axialSpeed = -state.vd;
  const bearing = (Math.atan2(state.x, Math.max(state.d, 0.05)) * 180) / Math.PI;
  const pitch = (Math.atan2(state.y, Math.max(state.d, 0.05)) * 180) / Math.PI;
  const bearingIn = Math.abs(bearing) <= LIMITS.bearingDeg;
  const pitchIn = Math.abs(pitch) <= LIMITS.pitchDeg;
  const rangeIn = state.d >= LIMITS.minRange && state.d <= LIMITS.maxRange;
  const speedIn = Math.abs(state.vd) <= LIMITS.axialSpeed;
  return {
    bearing,
    pitch,
    axialSpeed,
    range: state.d,
    bearingIn,
    pitchIn,
    rangeIn,
    speedIn,
    allIn: bearingIn && pitchIn && rangeIn && speedIn,
  };
}

export function setCommands(state, commands, record = true) {
  const yaw = clamp(Number(commands.yaw) || 0, -1, 1);
  const pitch = clamp(Number(commands.pitch) || 0, -1, 1);
  const throttle = clamp(Number(commands.throttle) || 0, -1, 1);
  const previous = state.commands;
  if (previous.yaw === yaw && previous.pitch === pitch && previous.throttle === throttle) {
    return;
  }
  state.commands = { yaw, pitch, throttle };
  if (record) {
    state.inputLog.push({ tick: state.tick, yaw, pitch, throttle });
  }
}

export function fail(state, reason) {
  if (state.phase === PHASE.FAILED || state.phase === PHASE.COMPLETE) {
    return;
  }
  state.phase = PHASE.FAILED;
  state.failure = reason;
  state.commands = { yaw: 0, pitch: 0, throttle: 0 };
  state.resources.hull = Math.max(0, state.resources.hull - 100);
  noteChange(state, `回合中止：${reason}`, "danger");
}

function consumeResources(state) {
  const demand =
    Math.abs(state.commands.yaw) +
    Math.abs(state.commands.pitch) +
    Math.abs(state.commands.throttle);
  state.resources.propellant = Math.max(0, state.resources.propellant - demand * 0.045 * DT);
  state.resources.power = Math.max(
    0,
    state.resources.power - (0.055 + demand * 0.025 + (state.phase === PHASE.HOLD ? 0.05 : 0)) * DT,
  );
  if (state.resources.propellant === 0 && !state.failure) {
    noteChange(state, "推进剂耗尽：姿控权限下降至 15%", "warn");
  }
  if (state.resources.power === 0) {
    fail(state, "主电源耗尽");
  }
}

function integrate(state) {
  const authority =
    state.resources.propellant <= 0 ? 0.15 : state.phase === PHASE.HOLD ? 0.72 : 1;
  const yaw = state.commands.yaw * authority;
  const pitch = state.commands.pitch * authority;
  const throttle = state.commands.throttle * authority;

  state.vx += yaw * 0.52 * DT;
  state.vy += pitch * 0.46 * DT;
  state.vd -= throttle * 0.44 * DT;

  const drag = Math.exp(-0.16 * DT);
  state.vx *= drag;
  state.vy *= drag;
  state.vd *= Math.exp(-0.08 * DT);

  state.vx = clamp(state.vx, -LIMITS.maxLateralSpeed, LIMITS.maxLateralSpeed);
  state.vy = clamp(state.vy, -LIMITS.maxVerticalSpeed, LIMITS.maxVerticalSpeed);
  state.vd = clamp(state.vd, -LIMITS.maxAxialSpeed, LIMITS.maxAxialSpeed);

  state.x += state.vx * DT;
  state.y += state.vy * DT;
  state.d += state.vd * DT;
}

function applyDrift(state) {
  if (state.tick < state.nextDriftTick) {
    return;
  }
  if (![PHASE.APPROACH, PHASE.HOLD, PHASE.RETREATING].includes(state.phase)) {
    return;
  }

  const kindRoll = randomUnit(state);
  const sign = randomUnit(state) < 0.5 ? -1 : 1;
  const strength = randomBetween(state, 0.035, 0.12);
  let text = "微流星扰动：横向偏移";
  if (kindRoll < 0.36) {
    state.vx += sign * strength;
  } else if (kindRoll < 0.72) {
    state.vy += sign * strength;
    text = "太阳风扰动：纵向偏移";
  } else {
    state.vd += sign * strength * 1.4;
    text = "尾焰回压：距离速度变化";
  }
  state.driftSerial += 1;
  state.lastDrift = {
    serial: state.driftSerial,
    tick: state.tick,
    kind: kindRoll < 0.36 ? "lateral" : kindRoll < 0.72 ? "vertical" : "axial",
    strength: Number(strength.toFixed(4)),
    sign,
  };
  noteChange(state, `${text} #${state.driftSerial}`, "drift");
  scheduleDrift(state);
}

function collisionReason(state, telemetry) {
  if (state.d <= 0.18) {
    return "推进轴过冲，模块撞上接口平面";
  }
  if (state.d < 0.55 && (!telemetry.bearingIn || !telemetry.pitchIn)) {
    return "方位/俯仰轴过冲，锁扣外缘碰撞";
  }
  if (state.d < 2.2 && Math.abs(state.vd) > 1.08) {
    return "接近速度超过结构极限";
  }
  if (Math.abs(state.x) > 4.2) {
    return "方位轴越过安全走廊";
  }
  if (Math.abs(state.y) > 3.4) {
    return "俯仰轴越过安全走廊";
  }
  return null;
}

function beginTransfer(state) {
  state.phase = PHASE.TRANSFER;
  state.transferTime = 0;
  state.vx = 0;
  state.vy = 0;
  state.vd = 0;
  state.commands = { yaw: 0, pitch: 0, throttle: 0 };
  noteChange(state, "一号接口锁定。机械臂转场至二号接口", "success");
}

function beginSecondApproach(state) {
  state.phase = PHASE.APPROACH;
  state.dockNumber = 2;
  state.x = 0;
  state.y = 0;
  state.d = START_RANGE;
  state.vx = 0;
  state.vy = 0;
  state.vd = -0.18;
  state.holdTime = 0;
  state.transferTime = 0;
  state.resources.propellant = Math.min(100, state.resources.propellant + 22);
  state.resources.power = Math.min(100, state.resources.power + 18);
  state.resources.hull = Math.min(100, state.resources.hull + 4);
  rollPort(state, 2);
  scheduleDrift(state);
  noteChange(state, "二号接口进近：在线补加推进剂 +22 / 电力 +18", "start");
}

function updateLatch(state) {
  state.latchTime += DT;
  if (state.latchTime < LATCH_SECONDS) {
    return;
  }
  state.latchTime = LATCH_SECONDS;
  state.latchCount += 1;
  state.resources.latchCharges = Math.max(0, state.resources.latchCharges - 1);
  if (state.latchCount === 1) {
    beginTransfer(state);
    return;
  }
  state.phase = PHASE.RETREATING;
  state.commands = { yaw: 0, pitch: 0, throttle: 0 };
  noteChange(state, "二号接口锁定。双锁扣完成，执行安全撤离", "success");
}

function updateActivePhase(state) {
  const telemetry = axisTelemetry(state);
  state.elapsed = state.tick * DT;

  if (state.elapsed >= MISSION_SECONDS) {
    fail(state, "任务窗口关闭，未完成两次锁定");
    return;
  }

  if (state.phase === PHASE.TRANSFER) {
    state.transferTime += DT;
    if (state.transferTime >= TRANSFER_SECONDS) {
      beginSecondApproach(state);
    }
    return;
  }

  if (state.phase === PHASE.LATCHING) {
    updateLatch(state);
    return;
  }

  integrate(state);
  const nextTelemetry = axisTelemetry(state);
  const collision = collisionReason(state, nextTelemetry);
  if (collision) {
    fail(state, collision);
    return;
  }

  if (state.phase === PHASE.APPROACH) {
    if (nextTelemetry.allIn) {
      state.phase = PHASE.HOLD;
      state.holdTime = 0;
      noteChange(state, "三轴入窗，保持电路开始充电（2.0 秒）", "lock");
    }
    return;
  }

  if (state.phase === PHASE.HOLD) {
    if (!nextTelemetry.allIn) {
      state.phase = PHASE.APPROACH;
      state.holdTime = 0;
      noteChange(state, "容差丢失，保持计时清零", "warn");
      return;
    }
    state.holdTime += DT;
    if (state.holdTime >= HOLD_SECONDS) {
      state.holdTime = HOLD_SECONDS;
      state.phase = PHASE.LATCHING;
      state.latchTime = 0;
      state.vx = 0;
      state.vy = 0;
      state.vd = 0;
      noteChange(state, "两秒保持完成，锁扣启动", "success");
    }
    return;
  }

  if (state.phase === PHASE.RETREATING) {
    if (state.d >= LIMITS.safeRetreat && Math.abs(state.vd) <= 0.65) {
      state.phase = PHASE.COMPLETE;
      state.commands = { yaw: 0, pitch: 0, throttle: 0 };
      noteChange(state, "已撤离至安全距离，双接口任务完成", "complete");
    }
  }
}

export function step(state) {
  if (state.phase === PHASE.FAILED || state.phase === PHASE.COMPLETE) {
    return state;
  }
  state.tick += 1;
  state.elapsed = state.tick * DT;
  applyDrift(state);
  consumeResources(state);
  if (state.phase === PHASE.FAILED) {
    return state;
  }
  updateActivePhase(state);
  return state;
}

export function snapshotState(state) {
  return JSON.parse(JSON.stringify(state));
}

export function restoreSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

function rounded(value) {
  const number = Number(value.toFixed(6));
  return Object.is(number, -0) ? 0 : number;
}

export function canonicalState(state) {
  return {
    version: state.version,
    seed: state.seed,
    rngState: state.rngState,
    tick: state.tick,
    phase: state.phase,
    dockNumber: state.dockNumber,
    latchCount: state.latchCount,
    holdTime: rounded(state.holdTime),
    latchTime: rounded(state.latchTime),
    transferTime: rounded(state.transferTime),
    pose: {
      x: rounded(state.x),
      y: rounded(state.y),
      d: rounded(state.d),
      vx: rounded(state.vx),
      vy: rounded(state.vy),
      vd: rounded(state.vd),
    },
    portOffset: {
      x: rounded(state.portOffset.x),
      y: rounded(state.portOffset.y),
    },
    commands: {
      yaw: rounded(state.commands.yaw),
      pitch: rounded(state.commands.pitch),
      throttle: rounded(state.commands.throttle),
    },
    resources: {
      propellant: rounded(state.resources.propellant),
      power: rounded(state.resources.power),
      latchCharges: state.resources.latchCharges,
      hull: rounded(state.resources.hull),
    },
    driftSerial: state.driftSerial,
    nextDriftTick: state.nextDriftTick,
    failure: state.failure,
  };
}

export function hashState(state) {
  const text = JSON.stringify(canonicalState(state));
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 16777619);
    second ^= code + index;
    second = Math.imul(second, 3266489917);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

export function runReplay(seed, inputLog, endTick) {
  const state = createSimulation(seed);
  const eventsByTick = new Map();
  for (const event of inputLog) {
    const tick = Math.max(0, Math.floor(event.tick));
    if (!eventsByTick.has(tick)) {
      eventsByTick.set(tick, []);
    }
    eventsByTick.get(tick).push(event);
  }
  for (let tick = 0; tick < endTick; tick += 1) {
    const events = eventsByTick.get(tick);
    if (events) {
      for (const event of events) {
        setCommands(state, event, false);
      }
    }
    step(state);
  }
  return state;
}

export function makeReplayRecord(state, endTick = state.tick) {
  return {
    version: 1,
    seed: state.seed,
    endTick,
    finalHash: hashState(state),
    inputLog: state.inputLog.filter((event) => event.tick <= endTick),
  };
}
