export const TICK_MS = 1000 / 60;
export const KEYFRAME_EVERY = 3;
export const WORLD_WIDTH = 1000;
export const WORLD_HEIGHT = 620;
export const SAVE_VERSION = 1;
export const DURABILITY_MAX = 100;

export const RESCUE_POINTS = [
  { id: "low", name: "低台", x: 650, y: 438, ledgeX: 792 },
  { id: "bridge", name: "断桥", x: 672, y: 306, ledgeX: 804 },
  { id: "nest", name: "鹰巢", x: 696, y: 178, ledgeX: 818 },
];

export const BASE = { x: 252, y: 438 };
export const ANCHORS = {
  left: { x: 214, y: 82 },
  right: { x: 786, y: 82 },
};

const BASKET_HALF_WIDTH = 40;
const SAFE_REEL_SPEED = 232;
const MAX_TARGET_X = 758;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 2) => Number(value.toFixed(digits));
const distance = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function cableLength(anchor, x, y) {
  return Math.hypot(anchor.x - x, anchor.y - y);
}

export function cliffXAt(y) {
  return 792 - (y - 438) * 0.075;
}

function initialControls() {
  return {
    p1: { up: false, down: false },
    p2: { left: false, right: false, safety: false },
  };
}

export function createWorld(seed = 20261116) {
  const now = Date.now();
  const world = {
    version: SAVE_VERSION,
    seed,
    tick: 0,
    timeMs: 0,
    wallStartedAt: now,
    phase: "active",
    status: "ready",
    controls: initialControls(),
    previousControls: initialControls(),
    basket: {
      x: BASE.x,
      y: BASE.y,
      vx: 0,
      vy: 0,
      angle: 0,
      angularVelocity: 0,
    },
    cables: {
      left: { length: 0, previousLength: 0, speed: 0, tension: 42 },
      right: { length: 0, previousLength: 0, speed: 0, tension: 42 },
    },
    winches: {
      left: { state: "live", temperature: 34 },
      right: { state: "live", temperature: 34 },
    },
    safety: { engaged: false, strain: 8, locked: false },
    wind: { pressure: 0.35, gust: 0, direction: 1 },
    risk: { left: 0, right: 0, lastCollisionMs: -9999 },
    durability: DURABILITY_MAX,
    rescued: 0,
    targetIndex: 0,
    carrying: false,
    captureProgress: 0,
    returnProgress: 0,
    points: RESCUE_POINTS.map((point) => ({ ...point, state: "waiting" })),
    protection: null,
    notice: "等待双人协作",
    actionHistory: [],
    pendingEvents: [],
    timeline: [],
    events: [],
    conflictCount: 0,
    completedAt: null,
    finalHash: null,
  };
  updateCables(world, 1 / 60);
  return world;
}

function cloneControls(controls) {
  return {
    p1: { up: !!controls.p1.up, down: !!controls.p1.down },
    p2: {
      left: !!controls.p2.left,
      right: !!controls.p2.right,
      safety: !!controls.p2.safety,
    },
  };
}

export function setControl(world, player, control, pressed) {
  if (!world.controls[player] || !(control in world.controls[player])) return;
  world.controls[player][control] = !!pressed;
}

function controlWasPressed(world, player, control) {
  return !world.previousControls[player][control] &&
    world.controls[player][control];
}

function playerActionLabel(player, control) {
  if (player === "p1") {
    if (control === "up") return "升绳";
    if (control === "down") return "放绳";
    return control;
  }
  if (control === "left") return "向左摆臂";
  if (control === "right") return "向右摆臂";
  if (control === "safety") return "锁紧安全绳";
  return control;
}

function actionSnapshot(world, event) {
  return {
    ...event,
    t: round(world.timeMs, 3),
    x: round(world.basket.x),
    y: round(world.basket.y),
    leftLength: round(world.cables.left.length),
    rightLength: round(world.cables.right.length),
    leftTension: round(world.cables.left.tension),
    rightTension: round(world.cables.right.tension),
    armAngle: round(Math.atan2(
      world.basket.x - ANCHORS.left.x,
      ANCHORS.left.y - world.basket.y,
    ) * 180 / Math.PI),
  };
}

function emitEvent(world, event) {
  const complete = {
    seq: world.events.length + 1,
    t: world.timeMs,
    tick: world.tick,
    ...actionSnapshot(world, event),
  };
  world.events.push(complete);
  world.pendingEvents.push(complete);
  if (event.type === "COLLISION") {
    world.conflictCount += event.conflict ? 1 : 0;
  }
  return complete;
}

function trackInputTransitions(world) {
  for (const player of ["p1", "p2"]) {
    for (const control of Object.keys(world.controls[player])) {
      if (!controlWasPressed(world, player, control)) continue;
      const action = actionSnapshot(world, {
        seq: world.events.length + 1,
        type: "INPUT",
        player,
        control,
        label: playerActionLabel(player, control),
      });
      world.actionHistory.push(action);
      world.events.push(action);
      world.pendingEvents.push(action);
    }
  }
  world.previousControls = cloneControls(world.controls);
  const cutoff = world.timeMs - 4500;
  world.actionHistory = world.actionHistory.filter((action) => action.t >= cutoff);
}

function updateCables(world, dt) {
  const basketTopY = world.basket.y - 25;
  for (const side of ["left", "right"]) {
    const cable = world.cables[side];
    const pointX = world.basket.x + (side === "left" ? -35 : 35);
    cable.previousLength = cable.length || cableLength(
      ANCHORS[side],
      pointX,
      basketTopY,
    );
    cable.length = cableLength(ANCHORS[side], pointX, basketTopY);
    const rawSpeed = (cable.previousLength - cable.length) / Math.max(dt, 0.001);
    cable.speed = Math.abs(rawSpeed) < 0.8 ? 0 : rawSpeed;
  }

  const sideBias = (world.basket.x - BASE.x) / (MAX_TARGET_X - BASE.x);
  const liftDemand = Math.abs(world.basket.vy) * 0.105;
  const safetyLoad = world.controls.p2.safety ? 9 + world.safety.strain * 0.08 : 0;
  const carryingLoad = world.carrying ? 7 : 0;
  const leftSupport = 1.06 - sideBias * 0.22;
  const rightSupport = 0.92 + sideBias * 0.26;
  const leftReel = Math.max(0, world.cables.left.speed);
  const rightReel = Math.max(0, world.cables.right.speed);

  world.cables.left.tension = clamp(
    31 + leftSupport * 24 + liftDemand * leftSupport +
      leftReel * 0.085 + safetyLoad + carryingLoad + world.wind.pressure * 6,
    18,
    99,
  );
  world.cables.right.tension = clamp(
    31 + rightSupport * 24 + liftDemand * rightSupport +
      rightReel * 0.085 + safetyLoad + carryingLoad + world.wind.pressure * 6,
    18,
    99,
  );

  for (const side of ["left", "right"]) {
    const cable = world.cables[side];
    const reel = Math.max(0, cable.speed);
    const hot = reel > SAFE_REEL_SPEED;
    const targetTemp = 30 + reel * 0.055 + cable.tension * 0.16 + (hot ? 12 : 0);
    const winch = world.winches[side];
    winch.temperature += (targetTemp - winch.temperature) * clamp(dt * 0.42, 0, 1);
  }
}

function updateWind(world) {
  const t = world.timeMs / 1000;
  const primary = Math.sin(t * 1.18 + world.seed * 0.001);
  const gustPulse = Math.pow(0.5 + 0.5 * Math.sin(t * 0.39 - 0.9), 3);
  world.wind.gust = gustPulse;
  world.wind.direction = Math.sin(t * 0.23) >= -0.25 ? 1 : -1;
  world.wind.pressure = clamp(0.22 + Math.abs(primary) * 0.32 + gustPulse * 0.46, 0, 1);
}

function updateRisk(world, dt) {
  for (const side of ["left", "right"]) {
    const reel = Math.max(0, world.cables[side].speed);
    const inDangerZone = world.basket.x > 405;
    if (inDangerZone && reel > SAFE_REEL_SPEED && !world.controls.p2.safety) {
      world.risk[side] += dt * (0.7 + (reel - SAFE_REEL_SPEED) / 260);
    } else {
      world.risk[side] = Math.max(0, world.risk[side] - dt * 1.8);
    }
  }
}

export function maxReelSpeed(world) {
  return Math.max(world.cables.left.speed, world.cables.right.speed, 0);
}

function recentActionsForConflict(world) {
  const cutoff = world.timeMs - 3000;
  const p1 = world.actionHistory.filter(
    (action) => action.player === "p1" && action.t >= cutoff,
  ).at(-1);
  const p2 = world.actionHistory.filter(
    (action) => action.player === "p2" && action.t >= cutoff,
  ).at(-1);
  if (!p1 || !p2) return null;
  const ordered = [p1, p2].sort((a, b) => a.t - b.t);
  return {
    first: ordered[0],
    second: ordered[1],
    deltaMs: ordered[1].t - ordered[0].t,
    text: `${ordered[0].player === "p1" ? "P1" : "P2"} ${ordered[0].label}` +
      ` → ${Math.round(ordered[1].t - ordered[0].t)}ms → ` +
      `${ordered[1].player === "p1" ? "P1" : "P2"} ${ordered[1].label}`,
  };
}

function impactBasket(world, reason, side, loss) {
  if (world.timeMs - world.risk.lastCollisionMs < 850) return null;
  world.risk.lastCollisionMs = world.timeMs;
  const order = recentActionsForConflict(world);
  const strength = clamp(maxReelSpeed(world) / 280, 0.65, 1.7);
  const contact = {
    x: round(world.basket.x),
    y: round(world.basket.y),
    leftCable: round(world.cables.left.length),
    rightCable: round(world.cables.right.length),
  };
  world.basket.vx = -Math.max(85, Math.abs(world.basket.vx) * 0.8 + 58);
  world.basket.vy *= 0.35;
  world.basket.x = clamp(world.basket.x - 36 * strength, 226, MAX_TARGET_X);
  world.basket.y = clamp(world.basket.y + 5, 130, 486);
  world.basket.angularVelocity += (reason === "cliff" ? -1.8 : 1.2) * strength;
  world.durability = clamp(world.durability - loss, 0, DURABILITY_MAX);
  world.notice = reason === "cliff"
    ? `崖壁撞击 · ${side === "left" ? "左" : "右"}索负载异常`
    : `${side === "left" ? "左" : "右"}卷扬机收绳超速`;
  const event = emitEvent(world, {
    type: "COLLISION",
    reason,
    side,
    loss,
    severity: round(maxReelSpeed(world)),
    conflict: !!order,
    orderText: order?.text || "未检测到双人近时动作",
    orderDeltaMs: order?.deltaMs ?? null,
    object: reason === "cliff" ? "吊篮右舷 / 崖壁" : "吊篮 / 事故侧卷扬机",
    position: contact,
  });
  if (world.durability <= 0) {
    world.phase = "failed";
    world.status = "failed";
    world.notice = "吊篮结构失效 · 救援失败";
    emitEvent(world, {
      type: "MISSION_FAILED",
      object: "吊篮结构与双侧卷扬机",
      position: { x: round(world.basket.x), y: round(world.basket.y) },
    });
  }
  return event;
}

function checkCollisions(world) {
  const basket = world.basket;
  const wallX = cliffXAt(basket.y);
  const closeToPoint = RESCUE_POINTS.some(
    (point) => Math.abs(basket.x - point.x) < 45 &&
      Math.abs(basket.y - point.y) < 42,
  );
  if (!world.carrying && !closeToPoint && basket.x + BASKET_HALF_WIDTH > wallX) {
    const side = basket.vx >= -12 ? "right" : "left";
    impactBasket(world, "cliff", side, 28);
    return;
  }
  const fastestSide = world.cables.left.speed > world.cables.right.speed
    ? "left"
    : "right";
  if (world.risk[fastestSide] >= 1) {
    impactBasket(world, "reel", fastestSide, 22);
  }
}

function updateMission(world, dt) {
  const point = RESCUE_POINTS[world.targetIndex];
  const speed = Math.hypot(world.basket.vx, world.basket.vy);
  const safetyReady = world.controls.p2.safety && !world.protection;

  if (!world.carrying && point && !world.protection) {
    world.points.forEach((item, index) => {
      if (item.state !== "rescued") {
        item.state = index === world.targetIndex ? "active" : "waiting";
      }
    });
    const aligned = Math.abs(world.basket.x - point.x) < 42 &&
      Math.abs(world.basket.y - point.y) < 38;
    if (aligned && speed < 58 && safetyReady) {
      world.captureProgress = clamp(world.captureProgress + dt * 1.15, 0, 1);
      world.status = "grabbing";
      world.notice = `抓取 ${point.name} · ${Math.round(world.captureProgress * 100)}%`;
    } else {
      world.captureProgress = clamp(world.captureProgress - dt * 0.75, 0, 1);
      world.status = speed > 42 ? "traversing" : "ready";
      world.notice = aligned && !safetyReady
        ? "P2 请锁紧安全绳"
        : "调整吊篮至救援点";
    }

    if (world.captureProgress >= 1) {
      world.carrying = true;
      world.status = "returning";
      world.captureProgress = 0;
      world.returnProgress = 0;
      world.points[world.targetIndex].state = "carried";
      world.notice = `已抓取 ${point.name} · 返回左侧平台`;
      emitEvent(world, {
        type: "GRAB",
        object: `吊篮 / ${point.name}伤员`,
        pointId: point.id,
        position: {
          x: round(world.basket.x),
          y: round(world.basket.y),
          leftCable: round(world.cables.left.length),
          rightCable: round(world.cables.right.length),
        },
      });
    }
  }

  if (world.carrying && !world.protection) {
    world.status = "returning";
    const atDock = Math.abs(world.basket.x - BASE.x) < 48 &&
      Math.abs(world.basket.y - BASE.y) < 48;
    if (atDock && speed < 62 && safetyReady) {
      world.returnProgress = clamp(world.returnProgress + dt * 1.3, 0, 1);
      world.notice = `移交伤员 · ${Math.round(world.returnProgress * 100)}%`;
    } else {
      world.returnProgress = clamp(world.returnProgress - dt * 0.8, 0, 1);
      world.notice = "将伤员送回左侧平台并锁绳";
    }
    if (world.returnProgress >= 1) {
      const rescuedPoint = world.points[world.targetIndex];
      rescuedPoint.state = "rescued";
      world.rescued += 1;
      world.carrying = false;
      world.returnProgress = 0;
      world.targetIndex += 1;
      world.captureProgress = 0;
      emitEvent(world, {
        type: "RESCUE_COMPLETE",
        object: `平台 / ${rescuedPoint.name}伤员`,
        pointId: rescuedPoint.id,
        rescued: world.rescued,
        position: {
          x: round(world.basket.x),
          y: round(world.basket.y),
          leftCable: round(world.cables.left.length),
          rightCable: round(world.cables.right.length),
        },
      });
      if (world.rescued >= RESCUE_POINTS.length) {
        world.phase = "complete";
        world.status = "complete";
        world.completedAt = world.timeMs;
        world.notice = "三处救援完成 · 全员生还";
        emitEvent(world, {
          type: "MISSION_COMPLETE",
          object: "崖壁绞车 / 三名伤员",
          position: { x: round(world.basket.x), y: round(world.basket.y) },
        });
      } else {
        world.status = "ready";
        world.notice = `已送回 ${world.rescued}/3 · 前往${RESCUE_POINTS[world.targetIndex].name}`;
      }
    }
  }
}

function updatePhysics(world, dt) {
  const basket = world.basket;
  const p1 = world.controls.p1;
  const p2 = world.controls.p2;
  const safetyScale = p2.safety ? 0.35 : 1;
  const lift = (p1.down ? 1 : 0) - (p1.up ? 1 : 0);
  const swing = (p2.right ? 1 : 0) - (p2.left ? 1 : 0);
  const windVelocity = world.wind.direction * world.wind.pressure * 27;
  const desiredVx = swing * 174 * safetyScale + windVelocity;
  const desiredVy = lift * 164 * safetyScale;
  const response = p2.safety ? 9.2 : 5.7;

  basket.vx += (desiredVx - basket.vx) * clamp(response * dt, 0, 1);
  basket.vy += (desiredVy - basket.vy) * clamp(response * dt, 0, 1);
  basket.x += basket.vx * dt;
  basket.y += basket.vy * dt;

  if (basket.x < 226 || basket.x > MAX_TARGET_X) {
    basket.x = clamp(basket.x, 226, MAX_TARGET_X);
    basket.vx *= -0.18;
  }
  if (basket.y < 130 || basket.y > 486) {
    basket.y = clamp(basket.y, 130, 486);
    basket.vy *= -0.12;
  }

  const targetAngle = clamp(basket.vx * 0.0022, -0.18, 0.18);
  basket.angularVelocity += (targetAngle - basket.angle) * 7 * dt;
  basket.angularVelocity *= Math.pow(0.08, dt);
  basket.angle = clamp(basket.angle + basket.angularVelocity, -0.32, 0.32);

  world.safety.engaged = p2.safety;
  const load = (world.cables.left.tension + world.cables.right.tension) / 2;
  world.safety.strain = clamp(
    8 + load * 0.62 + Math.max(0, basket.vx) * 0.12,
    8,
    100,
  );
}

function compactState(world) {
  return {
    phase: world.phase,
    status: world.status,
    x: round(world.basket.x),
    y: round(world.basket.y),
    vx: round(world.basket.vx),
    vy: round(world.basket.vy),
    angle: round(world.basket.angle, 4),
    leftCable: round(world.cables.left.length),
    rightCable: round(world.cables.right.length),
    leftSpeed: round(world.cables.left.speed),
    rightSpeed: round(world.cables.right.speed),
    leftTension: round(world.cables.left.tension),
    rightTension: round(world.cables.right.tension),
    leftWinch: world.winches.left.state,
    rightWinch: world.winches.right.state,
    leftTemperature: round(world.winches.left.temperature),
    rightTemperature: round(world.winches.right.temperature),
    safety: {
      engaged: world.safety.engaged,
      strain: round(world.safety.strain),
      locked: world.safety.locked,
    },
    wind: {
      pressure: round(world.wind.pressure, 3),
      direction: world.wind.direction,
    },
    risk: {
      left: round(world.risk.left, 3),
      right: round(world.risk.right, 3),
    },
    durability: round(world.durability),
    rescued: world.rescued,
    targetIndex: world.targetIndex,
    carrying: world.carrying,
    captureProgress: round(world.captureProgress, 3),
    returnProgress: round(world.returnProgress, 3),
    points: world.points.map((point) => point.state),
    protection: world.protection ? {
      active: world.protection.active,
      side: world.protection.side,
      at: round(world.protection.at, 3),
      brake: world.protection.brake,
      safetyRope: world.protection.safetyRope,
      survivingTension: round(world.protection.survivingTension),
    } : null,
    notice: world.notice,
  };
}

export function hashState(state) {
  const serialized = JSON.stringify(state);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function recordTimeline(world, force = false) {
  const important = world.pendingEvents.some((event) => event.type !== "INPUT");
  if (!force && !important && world.tick % KEYFRAME_EVERY !== 0) return;
  const state = compactState(world);
  const frame = {
    index: world.timeline.length,
    tick: world.tick,
    t: round(world.timeMs, 3),
    inputs: cloneControls(world.controls),
    state,
    events: world.pendingEvents.map((event) => ({ ...event })),
    hash: hashState(state),
  };
  world.timeline.push(frame);
  world.pendingEvents = [];
  world.finalHash = frame.hash;
}

export function stepWorld(world, dt = TICK_MS / 1000) {
  const safeDt = clamp(dt, 0.001, 0.05);
  world.tick += 1;
  world.timeMs += safeDt * 1000;
  updateWind(world);

  if (world.phase === "active") {
    trackInputTransitions(world);
    updatePhysics(world, safeDt);
    updateCables(world, safeDt);
    updateRisk(world, safeDt);
    updateMission(world, safeDt);
    checkCollisions(world);
  } else {
    world.previousControls = cloneControls(world.controls);
    world.safety.engaged = !!world.protection?.active;
  }

  recordTimeline(world);
  return world.pendingEvents;
}

export function captureCheckpoint(world) {
  recordTimeline(world, true);
  return world.finalHash;
}

export function triggerSideDisconnect(world, side = "right") {
  if (world.phase !== "active" || !["left", "right"].includes(side)) return null;
  const survivingSide = side === "left" ? "right" : "left";
  world.phase = "protected";
  world.status = "protected";
  world.notice = `${side === "left" ? "左" : "右"}索断开 · 全制动保护生效`;
  world.basket.vx = 0;
  world.basket.vy = 0;
  world.basket.angularVelocity = 0;
  world.cables[side].tension = 0;
  world.cables[side].speed = 0;
  world.winches[side].state = "severed";
  world.winches[survivingSide].state = "brake";
  world.safety.locked = true;
  world.safety.engaged = true;
  world.controls = initialControls();
  world.previousControls = cloneControls(world.controls);
  world.protection = {
    active: true,
    side,
    at: world.timeMs,
    brake: "all-stop",
    safetyRope: "load-sharing",
    survivingSide,
    survivingTension: round(world.cables[survivingSide].tension),
    basket: {
      x: round(world.basket.x),
      y: round(world.basket.y),
    },
  };
  emitEvent(world, {
    type: "SIDE_DISCONNECT",
    side,
    object: `${side === "left" ? "左" : "右"}索 / 吊篮`,
    protection: "全制动 + 安全绳负载转移",
    survivingSide,
    position: {
      x: round(world.basket.x),
      y: round(world.basket.y),
      leftCable: round(world.cables.left.length),
      rightCable: round(world.cables.right.length),
    },
  });
  recordTimeline(world, true);
  return world.protection;
}

export function releaseProtection(world) {
  if (world.phase !== "protected") return false;
  world.protection = null;
  world.phase = "active";
  world.status = "ready";
  world.notice = "保护已复位 · 卷扬机重新待命";
  for (const side of ["left", "right"]) {
    world.winches[side].state = "live";
    world.cables[side].speed = 0;
  }
  world.safety.locked = false;
  world.safety.engaged = false;
  emitEvent(world, {
    type: "PROTECTION_RESET",
    object: "双索卷扬机",
    position: { x: round(world.basket.x), y: round(world.basket.y) },
  });
  recordTimeline(world, true);
  return true;
}

export function resetMission(world, seed = world.seed) {
  const fresh = createWorld(seed);
  fresh.timeline = world.timeline;
  fresh.events = world.events;
  fresh.actionHistory = [];
  fresh.pendingEvents = [];
  return fresh;
}

export function formatExactTime(milliseconds) {
  const total = Math.max(0, Number(milliseconds) || 0);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = Math.floor(total % 1000);
  return `${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function getMissionView(world) {
  const state = compactState(world);
  return {
    ...state,
    controls: cloneControls(world.controls),
    leftLength: round(world.cables.left.length),
    rightLength: round(world.cables.right.length),
    target: world.targetIndex < RESCUE_POINTS.length
      ? { ...RESCUE_POINTS[world.targetIndex] }
      : null,
    totalRescued: world.rescued,
    totalPoints: RESCUE_POINTS.length,
    conflicts: world.events.filter((event) => event.type === "COLLISION" && event.conflict),
    finalHash: world.finalHash,
    timelineLength: world.timeline.length,
  };
}

export function serializeWorld(world) {
  return JSON.parse(JSON.stringify(world));
}

export function restoreWorld(raw) {
  if (!raw || raw.version !== SAVE_VERSION || !raw.basket || !raw.timeline) {
    return null;
  }
  const fresh = createWorld(raw.seed);
  const restored = {
    ...fresh,
    ...raw,
    controls: cloneControls(raw.controls || fresh.controls),
    previousControls: cloneControls(
      raw.previousControls || raw.controls || fresh.controls,
    ),
    basket: { ...fresh.basket, ...raw.basket },
    cables: {
      left: { ...fresh.cables.left, ...raw.cables?.left },
      right: { ...fresh.cables.right, ...raw.cables?.right },
    },
    winches: {
      left: { ...fresh.winches.left, ...raw.winches?.left },
      right: { ...fresh.winches.right, ...raw.winches?.right },
    },
    safety: { ...fresh.safety, ...raw.safety },
    wind: { ...fresh.wind, ...raw.wind },
    risk: { ...fresh.risk, ...raw.risk },
    points: Array.isArray(raw.points) && raw.points.length === RESCUE_POINTS.length
      ? raw.points
      : fresh.points,
    actionHistory: Array.isArray(raw.actionHistory) ? raw.actionHistory : [],
    pendingEvents: [],
    timeline: Array.isArray(raw.timeline) ? raw.timeline : [],
    events: Array.isArray(raw.events) ? raw.events : [],
    protection: raw.protection || null,
  };
  if (restored.phase === "protected" && restored.protection) {
    restored.status = "protected";
    restored.controls = initialControls();
    restored.basket.vx = 0;
    restored.basket.vy = 0;
  }
  return restored;
}
