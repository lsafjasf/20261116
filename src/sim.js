// 双人协作桥面安装 —— 纯逻辑模拟核心（无 DOM，可在 Node 中运行）。
// 固定步长 DT，所有状态推进都是 tick 的确定函数：
// 同一 seed + 同一输入事件序列 => 完全相同的最终状态（回放/暂停/单步/倍速均不改变结果）。

export const DT = 1 / 60;

export const WORLD = {
  width: 900,
  height: 560,
  anchorY: 60,
  supportY: 430,
  targets: [250, 450, 650],
  plateW: 96,
  plateH: 14,
  len0: 70,
  lowerRate: 52,
  raiseRate: 40,
  g: 392,
  moveAccel: 300,
  windAccel: 8,
  damping: 0.12,
  swingInject: 1.6,
  tensionLimit: 14,
  vehicleSpeed: 95,
  durabilityMin: 25,
};

// 确定性的伪噪声（仅依赖 tick 与 seed，不依赖调用历史）
function noise(tick, seed) {
  const x = Math.sin(tick * 12.9898 + seed * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

export function windAt(tick, seed = 0) {
  const t = tick * DT;
  return 6 * Math.sin(t * 0.7 + seed) + 4 * Math.sin(t * 0.13 + 1.7 + seed * 0.5)
    + 2.5 * noise(tick >> 3, seed);
}

export function tempAt(tick, seed = 0) {
  const t = tick * DT;
  return 18 + 14 * Math.sin(t * 0.045 + seed * 0.3) + 1.5 * noise(tick >> 4, seed + 3);
}

// 允许误差：风速越大、温度越偏离 20°C，容差越小
export function toleranceAt(wind, temp) {
  const tol = 26 - 1.1 * Math.abs(wind) - 0.5 * Math.abs(temp - 20);
  return Math.max(6, Math.min(30, tol));
}

export function createGame(seed = 1) {
  return {
    seed,
    tick: 0,
    stage: 0,
    connected: [null, null, null],
    anchor: { x: WORLD.targets[0], y: WORLD.anchorY },
    len: WORLD.len0,
    theta: 0.12,
    thetaDot: 0,
    lenDot: 0,
    ctrl: { vertical: 0, move: 0 },
    wind: 0, temp: 20, tolerance: 26, tension: 0,
    durability: 100,
    status: 'playing',
    failReason: null,
    vehicle: { x: -80 },
    fall: null,
    timeline: [],
    conflicts: [],
  };
}

export function platePos(g) {
  return {
    x: g.anchor.x + g.len * Math.sin(g.theta),
    y: g.anchor.y + g.len * Math.cos(g.theta),
  };
}

function snapshotPos(g) {
  const p = platePos(g);
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10,
    theta: Math.round(g.theta * 1000) / 1000 };
}

function logEvent(g, entry) {
  g.timeline.push({ tick: g.tick, pos: snapshotPos(g), ...entry });
}

// ---- 输入事件 ----
// { tick, player: 'L'|'R', type }
// L: lower / hold / raise / unhook   R: moveL / moveR / moveStop / unhook
export function applyInput(g, ev) {
  if (g.status !== 'playing' && ev.type !== 'unhook') return;
  switch (ev.type) {
    case 'lower': g.ctrl.vertical = 1; break;
    case 'raise': g.ctrl.vertical = -1; break;
    case 'hold': g.ctrl.vertical = 0; break;
    case 'moveL': g.ctrl.move = -1; break;
    case 'moveR': g.ctrl.move = 1; break;
    case 'moveStop': g.ctrl.move = 0; break;
    case 'unhook': doUnhook(g, ev.player); break;
    default: return;
  }
  logEvent(g, { src: ev.player, type: ev.type });
}

function doUnhook(g, player) {
  if (g.status !== 'playing') return;
  if (g.stage >= 3) {
    logEvent(g, { src: 'sys', type: 'release', note: '三点已连接，安全松钩' });
    g.status = 'vehicle';
    g.vehicle = { x: -80 };
  } else {
    // 松钩过早：桥板坠落
    g.status = 'failed';
    g.failReason = `玩家${player}松钩过早（第 ${g.stage + 1} 个连接点尚未固定）`;
    g.fall = { vy: 0 };
    g.durability = Math.max(0, g.durability - 40);
    logEvent(g, { src: 'sys', type: 'fall', reason: g.failReason });
  }
}

// 同 tick 两侧玩家都有输入 => 顺序敏感冲突，记录时刻与位置
export function detectConflicts(events) {
  const byTick = new Map();
  for (const ev of events) {
    if (!byTick.has(ev.tick)) byTick.set(ev.tick, []);
    byTick.get(ev.tick).push(ev);
  }
  const out = [];
  for (const [tick, evs] of byTick) {
    const players = new Set(evs.map((e) => e.player));
    if (players.size > 1) {
      out.push({ tick, actions: evs.map((e) => `${e.player}:${e.type}`) });
    }
  }
  return out.sort((a, b) => a.tick - b.tick);
}

// ---- 主步进：events 为按 tick 升序的输入事件数组 ----
export function step(g, events) {
  // 1) 应用本 tick 输入（规范顺序：L 先于 R，保证确定性），并检测冲突
  const todays = (events || []).filter((e) => e.tick === g.tick);
  todays.sort((a, b) => (a.player === b.player ? 0 : a.player === 'L' ? -1 : 1));
  const playersHere = new Set(todays.map((e) => e.player));
  if (playersHere.size > 1) {
    const conflict = {
      tick: g.tick,
      actions: todays.map((e) => `${e.player}:${e.type}`),
      pos: snapshotPos(g),
    };
    g.conflicts.push(conflict);
    logEvent(g, { src: 'sys', type: 'conflict', actions: conflict.actions });
  }
  for (const ev of todays) applyInput(g, ev);

  if (g.status === 'failed') { stepFall(g); g.tick++; return g; }
  if (g.status === 'vehicle') { stepVehicle(g); g.tick++; return g; }
  if (g.status !== 'playing') { g.tick++; return g; }

  // 2) 环境：风速 / 温度 / 允许误差
  g.wind = windAt(g.tick, g.seed);
  g.temp = tempAt(g.tick, g.seed);
  g.tolerance = toleranceAt(g.wind, g.temp);

  // 3) 吊索收放
  const targetLenDot = g.ctrl.vertical > 0 ? WORLD.lowerRate
    : g.ctrl.vertical < 0 ? -WORLD.raiseRate : 0;
  g.lenDot += (targetLenDot - g.lenDot) * Math.min(1, 8 * DT);
  g.len = Math.max(30, Math.min(WORLD.supportY - WORLD.anchorY - WORLD.plateH / 2 + 30,
    g.len + g.lenDot * DT));

  // 4) 摆动：重力摆 + 下降速度耦合 + 风 + 右侧玩家推力
  const inject = (g.lenDot / Math.max(40, g.len)) * noise(g.tick, g.seed) * WORLD.swingInject;
  const ax = g.wind * WORLD.windAccel + g.ctrl.move * WORLD.moveAccel;
  const thetaDDot = -(WORLD.g / g.len) * Math.sin(g.theta)
    - WORLD.damping * g.thetaDot
    - 2 * (g.lenDot / Math.max(40, g.len)) * g.thetaDot
    + ax / g.len
    + inject;
  g.thetaDot += thetaDDot * DT;
  g.theta += g.thetaDot * DT;

  // 5) 张力与耐久
  const lenM = g.len / 40;
  g.tension = (1000 * (9.8 * Math.cos(g.theta) + lenM * g.thetaDot * g.thetaDot)
    + 900 * Math.abs(g.lenDot) / WORLD.lowerRate) / 1000;
  if (g.tension > WORLD.tensionLimit) {
    g.durability = Math.max(0, g.durability - (g.tension - WORLD.tensionLimit) * 0.02);
  }

  // 6) 连接 / 碰撞判定
  checkLanding(g);

  g.tick++;
  return g;
}

function checkLanding(g) {
  if (g.stage >= 3) return;
  const p = platePos(g);
  const bottom = p.y + WORLD.plateH / 2;
  if (bottom < WORLD.supportY) return;
  const targetX = WORLD.targets[g.stage];
  const err = p.x - targetX;
  const horizSpeed = Math.abs(g.len * g.thetaDot);
  if (Math.abs(err) <= g.tolerance && horizSpeed < 70) {
    // 成功连接
    g.connected[g.stage] = Math.round(err * 10) / 10;
    logEvent(g, { src: 'sys', type: 'connect', stage: g.stage, err: g.connected[g.stage] });
    g.stage++;
    if (g.stage < 3) {
      g.anchor = { x: WORLD.targets[g.stage], y: WORLD.anchorY };
      g.len = WORLD.len0;
      g.theta = 0.1 * noise(g.tick, g.seed + 7);
      g.thetaDot = 0;
      g.lenDot = 0;
      g.ctrl.vertical = 0;
      g.ctrl.move = 0;
    }
  } else {
    // 撞上支撑边缘：耐久损失 + 弹起，需要重新对位
    g.durability = Math.max(0, g.durability - 12);
    logEvent(g, { src: 'sys', type: 'collision', stage: g.stage,
      err: Math.round(err * 10) / 10, horizSpeed: Math.round(horizSpeed) });
    g.len = Math.max(40, g.len - 46);
    g.thetaDot *= -0.35;
    g.theta *= 0.6;
    g.lenDot = Math.min(g.lenDot, 0);
    g.ctrl.vertical = 0;
  }
}

function stepFall(g) {
  if (g.fall) g.fall.vy += WORLD.g * DT;
}

function stepVehicle(g) {
  g.vehicle.x += WORLD.vehicleSpeed * DT;
  if (g.vehicle.x > WORLD.width + 60) {
    if (g.durability >= WORLD.durabilityMin) {
      g.status = 'success';
      logEvent(g, { src: 'sys', type: 'vehiclePass', durability: Math.round(g.durability) });
    } else {
      g.status = 'failed';
      g.failReason = `桥面耐久不足（${Math.round(g.durability)} < ${WORLD.durabilityMin}），车辆压塌桥段`;
      logEvent(g, { src: 'sys', type: 'collapse', reason: g.failReason });
    }
  }
}

// ---- 运行 / 回放 / 存档 ----

// 从 seed 与输入事件序列重放到指定 tick（缺省跑到终局）。
// 回放是纯函数：暂停、单步、倍速只是 UI 层的播放方式，不影响此结果。
export function runSim(seed, events, uptoTick = Infinity, maxTicks = 200000) {
  const g = createGame(seed);
  const sorted = [...events].sort((a, b) => a.tick - b.tick);
  let n = 0;
  while (n++ < maxTicks && g.tick < uptoTick) {
    step(g, sorted);
    if (uptoTick === Infinity && (g.status === 'success' || g.status === 'failed')) break;
  }
  return g;
}

export function inputEventsOf(g) {
  return g.timeline.filter((e) => e.src === 'L' || e.src === 'R')
    .map((e) => ({ tick: e.tick, player: e.src, type: e.type }));
}

// 存档：只存 seed + 输入事件 + 当前 tick，读档时确定性重放恢复全部仪表/耐久/进度
export function serialize(g) {
  return JSON.stringify({
    v: 1,
    seed: g.seed,
    tick: g.tick,
    events: inputEventsOf(g),
  });
}

export function deserialize(json) {
  const data = JSON.parse(json);
  return runSim(data.seed, data.events, data.tick);
}

// 供 UI 回放使用：逐 tick 快照（位置、仪表、进度）
export function replayWithSnapshots(seed, events, maxTicks = 200000) {
  const g = createGame(seed);
  const sorted = [...events].sort((a, b) => a.tick - b.tick);
  const snaps = [];
  let n = 0;
  while (n++ < maxTicks) {
    step(g, sorted);
    snaps.push({
      tick: g.tick, pos: platePos(g), theta: g.theta, len: g.len,
      anchor: { ...g.anchor }, tension: g.tension, wind: g.wind, temp: g.temp,
      tolerance: g.tolerance, durability: g.durability, stage: g.stage,
      connected: [...g.connected], status: g.status, vehicleX: g.vehicle.x,
      failReason: g.failReason,
    });
    if (g.status === 'success' || g.status === 'failed') break;
  }
  return { snaps, final: g };
}
