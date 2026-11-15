export const TICK_SECONDS = 0.05;
export const SAVE_VERSION = 1;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 2) => Number(value.toFixed(digits));

export const STAGES = {
  PREFLIGHT: "PREFLIGHT",
  TAKEOFF: "TAKEOFF",
  AIRBORNE: "AIRBORNE",
  PATTERN: "PATTERN",
  APPROACH: "APPROACH",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED"
};

export const STAGE_LABELS = {
  PREFLIGHT: "起飞前",
  TAKEOFF: "起飞滑跑",
  AIRBORNE: "离地爬升",
  PATTERN: "绕飞检查",
  APPROACH: "进近降落",
  SUCCESS: "任务成功",
  FAILED: "任务失败"
};

export function createInitialState() {
  return {
    version: SAVE_VERSION,
    tick: 0,
    time: 0,
    stage: STAGES.PREFLIGHT,
    progress: 0,
    x: 0,
    altitude: 0,
    verticalSpeed: 0,
    speed: 0,
    pitch: 0,
    roll: 0,
    controls: {
      left: { throttle: 0, fuelPump: 55 },
      right: { hydraulic: 50, gearLever: "DOWN" }
    },
    engine: {
      rpm: 0,
      thrust: 0,
      fuel: 100,
      temperature: 42,
      stress: 0,
      damage: 0,
      stopped: false
    },
    hydraulic: {
      pressure: 0,
      pump: 0,
      temperature: 38,
      stress: 0,
      damage: 0,
      gearPosition: 1,
      gearTransit: 0
    },
    shared: {
      hull: 100,
      crossDrag: 0,
      alerts: [],
      collisionCount: 0
    },
    mission: {
      takeoff: false,
      gearRetracted: false,
      orbitSeconds: 0,
      approachSeconds: 0,
      landed: false,
      failureReason: null
    },
    lastCollision: null,
    mode: "duo"
  };
}

function safeSystems(state) {
  return (
    state.engine.damage < 75 &&
    state.hydraulic.damage < 75 &&
    state.shared.hull > 35 &&
    state.engine.fuel > 1
  );
}

export function getSystemsSafe(state) {
  return safeSystems(state);
}

export function getSharedAlerts(state) {
  const alerts = [];
  if (state.stage === STAGES.FAILED && state.lastCollision) {
    alerts.push({
      level: "danger",
      text: `碰撞：${state.lastCollision.object} / ${state.lastCollision.reason}`
    });
  }
  if (state.engine.temperature > 110) alerts.push({ level: "danger", text: "左发过热" });
  if (state.engine.fuel < 18) alerts.push({ level: "warn", text: "燃油偏低" });
  if (state.hydraulic.pressure < 32 && (state.engine.rpm > 220 || state.stage !== STAGES.PREFLIGHT)) {
    alerts.push({ level: "danger", text: "液压不足" });
  }
  if (state.hydraulic.pressure > 94) alerts.push({ level: "warn", text: "液压超压" });
  if (state.hydraulic.gearTransit > 0) alerts.push({ level: "info", text: "起落架收放中" });
  if (state.shared.crossDrag > 0.12) alerts.push({ level: "warn", text: "交叉系统降效" });
  if (state.stage === STAGES.APPROACH && state.hydraulic.gearPosition < 0.98) {
    alerts.push({ level: "danger", text: "降落构型不安全" });
  }
  if (!safeSystems(state) && state.stage !== STAGES.FAILED) {
    alerts.push({ level: "danger", text: "机体安全裕度不足" });
  }
  return alerts;
}

function failure(state, reason, collision = null) {
  state.stage = STAGES.FAILED;
  state.mission.failureReason = reason;
  state.progress = Math.min(state.progress, 92);
  if (collision) {
    state.shared.collisionCount += 1;
    state.lastCollision = collision;
    state.shared.hull = round(clamp(state.shared.hull - collision.damage, 0, 100), 1);
  }
}

function applyLeftInputs(state, dt) {
  const throttle = clamp(state.controls.left.throttle, 0, 100);
  const fuelPump = clamp(state.controls.left.fuelPump, 0, 100);
  const pressureSupport = 0.58 + 0.42 * clamp(state.hydraulic.pressure / 75, 0, 1);
  const overload = Math.max(0, throttle - 88) / 12;
  const targetRpm = state.engine.stopped || state.engine.fuel <= 0 ? 0 : throttle * 34 * pressureSupport;
  const spool = targetRpm > state.engine.rpm ? 980 : 640;
  state.engine.rpm = round(state.engine.rpm + clamp(targetRpm - state.engine.rpm, -spool * dt, spool * dt), 1);
  state.engine.thrust = round(Math.max(0, state.engine.rpm / 3400) * 124, 2);
  state.engine.fuel = round(Math.max(0, state.engine.fuel - (0.0025 + throttle * 0.000055) * dt * 100), 2);
  state.engine.temperature += ((42 + (state.engine.rpm / 3400) * 92 + overload * 34) - state.engine.temperature) * dt * 0.46;
  state.engine.stress = round(clamp(overload * 100 + Math.max(0, state.engine.temperature - 105) * 1.8, 0, 100), 1);
  state.engine.damage = round(clamp(state.engine.damage + state.engine.stress * dt * 0.006, 0, 100), 2);
  state.engine.fuelPumpFlow = round(fuelPump, 1);
}

function applyRightInputs(state, dt) {
  const hydraulic = clamp(state.controls.right.hydraulic, 0, 100);
  const rpmSupport = 0.25 + 0.75 * clamp(state.engine.rpm / 2800, 0, 1);
  const targetPump = hydraulic * rpmSupport;
  const overload = Math.max(0, hydraulic - 88) / 12;
  state.hydraulic.pump = round(state.hydraulic.pump + clamp(targetPump - state.hydraulic.pump, -34 * dt, 48 * dt), 1);
  state.hydraulic.pressure += ((state.hydraulic.pump * 0.97 + 4) - state.hydraulic.pressure) * dt * 1.7;
  state.hydraulic.temperature += ((36 + state.hydraulic.pressure * 0.58 + overload * 24) - state.hydraulic.temperature) * dt * 0.4;
  state.hydraulic.stress = round(clamp(overload * 100 + Math.max(0, state.hydraulic.temperature - 106) * 1.65, 0, 100), 1);
  state.hydraulic.damage = round(clamp(state.hydraulic.damage + state.hydraulic.stress * dt * 0.0065, 0, 100), 2);
}

export function applyControlSide(state, side, dt) {
  if (side === "left") applyLeftInputs(state, dt);
  else applyRightInputs(state, dt);
}

export function applyMutualLoad(state, dt) {
  const leftLoad = clamp((state.engine.rpm / 3400) * 0.7 + state.engine.stress / 180, 0, 1);
  const rightLoad = clamp(state.hydraulic.pump / 110 + state.hydraulic.stress / 150, 0, 1);
  const leftOverload = Math.max(0, leftLoad - 0.82) * 1.7;
  const rightOverload = Math.max(0, rightLoad - 0.82) * 1.7;
  state.shared.crossDrag = round(clamp(leftOverload + rightOverload, 0, 0.42), 3);

  const engineCap = 3400 * (1 - rightOverload * 3);
  if (state.engine.rpm > engineCap) {
    state.engine.rpm = round(
      Math.max(engineCap, state.engine.rpm + (engineCap - state.engine.rpm) * Math.min(1, dt * 5)),
      1
    );
  } else {
    state.engine.rpm = round(Math.max(0, state.engine.rpm - rightOverload * 210 * dt), 1);
  }

  const pressureCap = 96 * (1 - leftOverload * 3);
  if (state.hydraulic.pressure > pressureCap) {
    state.hydraulic.pressure = round(
      Math.max(
        pressureCap,
        state.hydraulic.pressure +
          (pressureCap - state.hydraulic.pressure) * Math.min(1, dt * 3.5)
      ),
      1
    );
  } else {
    state.hydraulic.pressure = round(
      Math.max(0, state.hydraulic.pressure - leftOverload * 18 * dt),
      1
    );
  }
  if (rightOverload > 0) {
    state.engine.temperature += rightOverload * 6 * dt;
    state.engine.damage = round(clamp(state.engine.damage + rightOverload * 0.8 * dt, 0, 100), 2);
  }
  if (leftOverload > 0) {
    state.hydraulic.temperature += leftOverload * 7 * dt;
    state.hydraulic.damage = round(clamp(state.hydraulic.damage + leftOverload * 0.9 * dt, 0, 100), 2);
  }
}

function addCollision(state, collision) {
  if (collision) {
    state.shared.collisionCount += 1;
    state.lastCollision = collision;
    state.shared.hull = round(clamp(state.shared.hull - collision.damage, 0, 100), 1);
  }
}

function updateGear(state, dt) {
  if (state.stage === STAGES.FAILED || state.stage === STAGES.SUCCESS) return;
  const leverUp = state.controls.right.gearLever === "UP";
  const target = leverUp ? 0 : 1;
  const grounded = state.altitude < 2.5;

  if (leverUp && grounded && state.hydraulic.gearPosition > 0.82) {
    failure(state, "地面误收起落架：左侧主起落架折断", {
      tick: state.tick,
      time: round(state.time, 2),
      x: round(state.x + 3.8, 2),
      y: 1.2,
      object: "left-main-gear",
      reason: "GEAR_RETRACTED_ON_GROUND",
      damage: 52,
      severity: "critical"
    });
    state.hydraulic.gearPosition = 0.25;
    state.hydraulic.damage = round(clamp(state.hydraulic.damage + 34, 0, 100), 1);
    state.pitch = -8;
    state.speed = Math.max(0, state.speed - 16);
    return;
  }

  if (state.hydraulic.pressure < 24 && Math.abs(state.hydraulic.gearPosition - target) > 0.02) {
    state.mission.gearStalled = true;
    return;
  }
  state.mission.gearStalled = false;
  const transitRate = 0.2 + state.hydraulic.pressure / 210;
  const delta = target - state.hydraulic.gearPosition;
  if (Math.abs(delta) > 0.001) {
    state.hydraulic.gearPosition = round(
      state.hydraulic.gearPosition + clamp(delta, -transitRate * dt, transitRate * dt),
      4
    );
  }
  state.hydraulic.gearTransit = round(Math.abs(1 - state.hydraulic.gearPosition), 3);
  if (target === 0 && state.hydraulic.gearPosition < 0.1) state.mission.gearRetracted = true;
}

function updateAttitude(state, dt) {
  const targetPitch = clamp((state.verticalSpeed / Math.max(28, state.speed)) * 55, -12, 14);
  state.pitch = round(state.pitch + (targetPitch - state.pitch) * Math.min(1, dt * 2.4), 2);
  const targetRoll = state.stage === STAGES.PATTERN ? Math.sin(state.time * 0.72) * 8.5 : 0;
  state.roll = round(state.roll + (targetRoll - state.roll) * Math.min(1, dt * 1.5), 2);
}

function updateGround(state, dt) {
  const thrustAccel = state.engine.thrust / 20.5;
  const drag = state.speed * state.speed * 0.00056;
  const rolling = state.speed > 0.2 ? 0.22 : 0;
  const brake = state.controls.left.throttle < 3 ? 0.55 : 0;
  state.speed = round(Math.max(0, state.speed + (thrustAccel - drag - rolling - brake) * dt), 2);
  state.x = round(state.x + state.speed * dt, 2);
  state.altitude = 0;
  state.verticalSpeed = 0;
  updateAttitude(state, dt);

  if (state.speed > 4 && state.stage === STAGES.PREFLIGHT) {
    state.stage = STAGES.TAKEOFF;
  }
  if (state.speed >= 64) {
    state.stage = STAGES.AIRBORNE;
    state.altitude = Math.max(1.5, (state.speed - 61) * 0.22);
    state.verticalSpeed = 1.5;
    state.mission.takeoff = true;
  }
}

function updateAirborne(state, dt) {
  const gearDrag = (1 - state.hydraulic.gearPosition) * 0.02;
  const targetSpeed = 48 + state.controls.left.throttle * 0.5 - gearDrag * 100;
  state.speed = round(state.speed + (targetSpeed - state.speed) * 0.31 * dt, 2);

  let targetVs;
  if (state.stage === STAGES.AIRBORNE) {
    targetVs = clamp(1.8 + (state.speed - 62) * 0.14, 0.8, 5.2);
  } else if (state.stage === STAGES.PATTERN) {
    targetVs = clamp((185 - state.altitude) * 0.055, -2.4, 3.4);
  } else {
    targetVs = -2.7 - Math.max(0, 52 - state.controls.left.throttle) * 0.045;
  }
  state.verticalSpeed = round(state.verticalSpeed + (targetVs - state.verticalSpeed) * Math.min(1, dt * 0.9), 3);
  state.altitude = round(Math.max(0, state.altitude + state.verticalSpeed * dt), 2);
  state.x = round(state.x + state.speed * dt, 2);
  updateAttitude(state, dt);
}

function calculateProgress(state) {
  const stageProgress = {
    PREFLIGHT: clamp(state.speed / 64, 0, 1) * 18,
    TAKEOFF: 18 + clamp(state.speed / 70, 0, 1) * 15,
    AIRBORNE: 33 + clamp(state.altitude / 65, 0, 1) * 22,
    PATTERN: 55 + clamp(state.mission.orbitSeconds / 10, 0, 1) * 25,
    APPROACH: 80 + clamp(state.mission.approachSeconds / 14, 0, 1) * 19,
    SUCCESS: 100,
    FAILED: state.progress
  };
  return round(clamp(stageProgress[state.stage] ?? state.progress, 0, 100), 1);
}

function updateMission(state, dt) {
  if (state.stage === STAGES.AIRBORNE && state.altitude > 55 && state.hydraulic.gearPosition < 0.16) {
    state.stage = STAGES.PATTERN;
    state.mission.orbitSeconds = 0;
  }
  if (state.stage === STAGES.PATTERN) {
    state.mission.orbitSeconds = round(state.mission.orbitSeconds + dt, 2);
    if (state.mission.orbitSeconds >= 10) {
      state.stage = STAGES.APPROACH;
      state.mission.approachSeconds = 0;
    }
  }
  if (state.stage === STAGES.APPROACH) {
    state.mission.approachSeconds = round(state.mission.approachSeconds + dt, 2);
  }

  if (state.altitude > 620 && state.stage !== STAGES.FAILED) {
    failure(state, "超出结构安全高度，机翼过载");
  }
  if (state.engine.fuel <= 0 && state.stage !== STAGES.FAILED) {
    failure(state, "燃油耗尽，动力丧失");
  }
  if (!safeSystems(state) && state.stage !== STAGES.FAILED && state.stage !== STAGES.SUCCESS) {
    failure(state, "双侧系统耐久低于安全阈值");
  }

  if (
    (state.stage === STAGES.APPROACH || state.stage === STAGES.AIRBORNE) &&
    state.altitude <= 0.04 &&
    state.mission.takeoff
  ) {
    const gearDown = state.hydraulic.gearPosition > 0.96;
    const hardLanding = Math.abs(state.verticalSpeed) > 4.2;
    const fastLanding = state.speed > 104;
    if (!gearDown) {
      failure(state, "未放起落架触地，机腹擦地", {
        tick: state.tick,
        time: round(state.time, 2),
        x: round(state.x, 2),
        y: 0,
        object: "belly",
        reason: "BELLY_LANDING",
        damage: 61,
        severity: "critical"
      });
    } else if (hardLanding) {
      failure(state, `重着陆：垂直速度 ${Math.abs(state.verticalSpeed).toFixed(1)} m/s`, {
        tick: state.tick,
        time: round(state.time, 2),
        x: round(state.x, 2),
        y: 0,
        object: "main-gear",
        reason: "HARD_LANDING",
        damage: 44,
        severity: "critical"
      });
    } else if (fastLanding) {
      failure(state, "接地速度过高，轮胎爆裂", {
        tick: state.tick,
        time: round(state.time, 2),
        x: round(state.x, 2),
        y: 0,
        object: "main-gear",
        reason: "FAST_LANDING",
        damage: 38,
        severity: "critical"
      });
    } else {
      state.stage = STAGES.SUCCESS;
      state.mission.landed = true;
      state.progress = 100;
      state.altitude = 0;
      state.verticalSpeed = 0;
      state.speed = round(state.speed * 0.74, 2);
      return;
    }
  }
  state.progress = calculateProgress(state);
}

export function stepSimulation(state, dt = TICK_SECONDS, options = {}) {
  const next = structuredClone(state);
  const order = options.order === "right-first" ? "right-first" : "left-first";
  next.tick += 1;
  next.time = round(next.time + dt, 4);
  next.mode = options.mode || next.mode;

  if (next.stage !== STAGES.FAILED && next.stage !== STAGES.SUCCESS) {
    if (order === "left-first") {
      applyControlSide(next, "left", dt);
      applyControlSide(next, "right", dt);
    } else {
      applyControlSide(next, "right", dt);
      applyControlSide(next, "left", dt);
    }
    applyMutualLoad(next, dt);
    updateGear(next, dt);

    if (next.stage !== STAGES.FAILED) {
      if (next.altitude <= 0.05) updateGround(next, dt);
      else updateAirborne(next, dt);
      updateMission(next, dt);
    }
  }

  next.shared.alerts = getSharedAlerts(next);
  const collision =
    next.lastCollision && next.lastCollision.tick === next.tick ? next.lastCollision : null;
  return { state: next, collision };
}
