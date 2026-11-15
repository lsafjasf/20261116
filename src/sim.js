// 滑翔器核心模拟：三层风带、结冰、失速、状态机。纯逻辑，无 DOM 依赖，可在 Node 中回放验证。
import { createRng, hashState } from "./rng.js";

export const CONFIG = {
  dt: 0.1,               // 固定步长（秒）
  startAlt: 2500,        // 起始高度（米）
  airport: { x: 50000, y: 0, radius: 1000, maxAlt: 400 },
  fuelMax: 3000,         // 燃料即任务时限，1 单位/秒
  batteryMax: 100,
  batteryDrainBase: 0.02,   // 仪表耗电 /秒
  batteryDrainFlaps: 0.15,  // 襟翼额外耗电 /秒
  stallBase: 15,         // 基础失速速度 m/s
  maxTurnRate: 0.9,      // 弧度/秒（输入满幅）
  layers: [
    { name: "低层", top: 600 },
    { name: "中层", top: 1400 },
    { name: "高层", top: Infinity },
  ],
};

// 由种子生成风场系数、云层、风暴核心。重新开始时同 seed 完全复现。
export function generateWorld(seed) {
  const rng = createRng(seed);
  const layers = CONFIG.layers.map((l, i) => ({
    name: l.name,
    top: l.top,
    baseDir: rng.next() * Math.PI * 2,
    baseSpeed: 3 + rng.next() * 7,
    k1: 0.00008 + rng.next() * 0.00012,
    p1: rng.next() * Math.PI * 2,
    k2: 0.00008 + rng.next() * 0.00012,
    p2: rng.next() * Math.PI * 2,
    dirWave: 0.3 + rng.next() * 0.5,
    spdWave: 0.25 + rng.next() * 0.35,
    idx: i,
  }));
  const clouds = [];
  for (let i = 0; i < 6; i++) {
    clouds.push({
      x: 5000 + rng.next() * 42000,
      y: (rng.next() - 0.5) * 16000,
      r: 1800 + rng.next() * 2500,
      base: 900 + rng.next() * 900,     // 云底高度
      thickness: 400 + rng.next() * 400,
      humidity: 0.4 + rng.next() * 0.6, // >0.65 且低温时结冰
    });
  }
  const storm = {
    x: 22000 + rng.next() * 8000,
    y: (rng.next() - 0.5) * 6000,
    r: 2200 + rng.next() * 800,
  };
  return { layers, clouds, storm, rngStateAfterGen: rng.state() };
}

export function windAt(world, x, y, alt) {
  const layer =
    world.layers.find((l) => alt <= l.top) || world.layers[world.layers.length - 1];
  const dir =
    layer.baseDir +
    layer.dirWave * Math.sin(x * layer.k1 + layer.p1) +
    layer.dirWave * 0.6 * Math.sin(y * layer.k2 + layer.p2);
  const spd =
    layer.baseSpeed *
    (1 +
      layer.spdWave * Math.sin(y * layer.k2 + layer.p2) +
      layer.spdWave * 0.5 * Math.sin(x * layer.k1 + layer.p1));
  return { dir, spd, vx: Math.cos(dir) * spd, vy: Math.sin(dir) * spd, layer: layer.name };
}

export function cloudAt(world, x, y, alt) {
  for (const c of world.clouds) {
    const dx = x - c.x, dy = y - c.y;
    if (dx * dx + dy * dy < c.r * c.r && alt >= c.base && alt <= c.base + c.thickness) {
      return c;
    }
  }
  return null;
}

// 状态机：READY -> FLYING <-> PAUSED, FLYING <-> STALL, -> SUCCESS / FAILED
export function createGame(seed) {
  const world = generateWorld(seed);
  return {
    seed,
    world,
    status: "READY",
    tick: 0,
    time: 0,
    glider: {
      x: 0, y: 0, alt: CONFIG.startAlt,
      heading: 0, // 0 弧度 = 朝东（+x 方向，机场方位）
      speed: 20,            // 空速 m/s
      pitch: 0,             // 玩家俯仰输入 -1..1
      turn: 0,              // 玩家转向输入 -1..1
      ballast: 0.5,         // 压舱水量 0..1
      flaps: false,
      fuel: CONFIG.fuelMax,
      battery: CONFIG.batteryMax,
      ice: 0,
    },
    input: { pitch: 0, turn: 0, flaps: false, dumpBallast: false },
    records: [],        // 输入记录 [{tick, input}]
    transitions: [{ tick: 0, from: "-", to: "READY", reason: "初始化" }],
    trail: [],
    failReason: null,
  };
}

export function transition(game, to, reason) {
  const from = game.status;
  game.status = to;
  game.transitions.push({ tick: game.tick, from, to, reason });
}

export function lastTransition(game) {
  return game.transitions[game.transitions.length - 1];
}

export function stallSpeed(g) {
  return CONFIG.stallBase + g.ballast * 3 + g.ice * 5 - (g.flaps ? 4 : 0);
}

export function sinkRate(g) {
  let s = 0.55 + Math.pow(g.speed - 17, 2) * 0.004;
  s += g.ballast * 0.5 + g.ice * 1.2 + (g.flaps ? 0.25 : 0);
  return s;
}

// 应用一帧输入并记录（仅记录变化）
export function applyInput(game, input) {
  const prev = game.input;
  const changed =
    input.pitch !== prev.pitch || input.turn !== prev.turn ||
    input.flaps !== prev.flaps || input.dumpBallast !== prev.dumpBallast;
  if (changed) {
    game.records.push({ tick: game.tick, input: { ...input } });
    game.input = { ...input };
  }
}

function stepPhysics(game) {
  const g = game.glider;
  const inp = game.input;
  const dt = CONFIG.dt;

  if (g.battery <= 0 && g.flaps) g.flaps = false; // 电池耗尽襟翼失效
  if (inp.flaps && g.battery > 0) g.flaps = true;
  if (!inp.flaps) g.flaps = false;
  if (inp.dumpBallast && g.ballast > 0) g.ballast = Math.max(0, g.ballast - 0.2 * dt * 10);

  // 转向：过陡转弯（|turn|>0.6）产生额外阻力损失速度
  const turnRate = inp.turn * CONFIG.maxTurnRate;
  g.heading += turnRate * dt;
  const steepDrag = Math.abs(inp.turn) > 0.6 ? (Math.abs(inp.turn) - 0.6) * 6 : 0;

  // 俯仰决定目标空速：拉杆慢、推杆快
  const targetSpeed = 16 + ((inp.pitch + 1) / 2) * 30;
  let accel = (targetSpeed - g.speed) * 0.6 - steepDrag;
  if (game.status === "STALL") accel = -1.5 + Math.max(0, inp.pitch) * 8; // 失速：仅推杆能增速改出，持续拉杆持续掉速
  g.speed = Math.max(4, Math.min(60, g.speed + accel * dt));

  // 垂直运动
  let sink = sinkRate(g);
  if (game.status === "STALL") sink = 8;
  g.alt -= sink * dt;

  // 风与地速
  const w = windAt(game.world, g.x, g.y, g.alt);
  g.x += (Math.cos(g.heading) * g.speed + w.vx) * dt;
  g.y += (Math.sin(g.heading) * g.speed + w.vy) * dt;

  // 结冰：云内、湿度高、温度低（高度>700m）
  const cloud = cloudAt(game.world, g.x, g.y, g.alt);
  if (cloud && cloud.humidity > 0.65 && g.alt > 700) {
    g.ice = Math.min(1, g.ice + 0.02 * dt * cloud.humidity * 10);
  } else {
    g.ice = Math.max(0, g.ice - 0.01 * dt * 10);
  }

  // 资源
  g.fuel -= dt;
  g.battery = Math.max(0, g.battery - (CONFIG.batteryDrainBase + (g.flaps ? CONFIG.batteryDrainFlaps : 0)) * dt);

  game.time += dt;
  game.tick += 1;
  if (game.tick % 10 === 0) game.trail.push([Math.round(g.x), Math.round(g.y), Math.round(g.alt)]);
}

// 单步推进（含状态机迁移）。PAUSED/SUCCESS/FAILED 下不推进物理。
export function step(game, input) {
  if (input) applyInput(game, input);
  if (game.status === "READY") transition(game, "FLYING", "起飞");
  if (game.status !== "FLYING" && game.status !== "STALL") return;

  stepPhysics(game);
  const g = game.glider;

  // 失速判定与恢复
  const vs = stallSpeed(g);
  if (game.status === "FLYING" && g.speed < vs) {
    transition(game, "STALL", `空速 ${g.speed.toFixed(1)} < 失速速度 ${vs.toFixed(1)}`);
  } else if (game.status === "STALL" && g.speed > vs + 3) {
    transition(game, "FLYING", "推杆增速，失速恢复");
  }

  // 终止条件
  const s = game.world.storm;
  const dStorm = Math.hypot(g.x - s.x, g.y - s.y);
  if (dStorm < s.r) {
    game.failReason = "进入风暴核心";
    transition(game, "FAILED", game.failReason);
    return;
  }
  if (g.fuel <= 0) {
    g.fuel = 0;
    game.failReason = "燃料耗尽";
    transition(game, "FAILED", game.failReason);
    return;
  }
  if (g.alt <= 0) {
    g.alt = 0;
    game.failReason = "高度耗尽触地";
    transition(game, "FAILED", game.failReason);
    return;
  }
  const a = CONFIG.airport;
  if (Math.hypot(g.x - a.x, g.y - a.y) < a.radius && g.alt < a.maxAlt) {
    transition(game, "SUCCESS", "抵达机场空域并安全着陆");
  }
}

export function togglePause(game) {
  if (game.status === "FLYING" || game.status === "STALL") {
    game.pausedFrom = game.status;
    transition(game, "PAUSED", "玩家暂停");
  } else if (game.status === "PAUSED") {
    transition(game, game.pausedFrom || "FLYING", "继续飞行");
  }
}

// 状态快照（四舍五入避免浮点尾差）与一致性哈希
export function snapshot(game) {
  const g = game.glider;
  const r = (v) => Math.round(v * 1000) / 1000;
  return {
    status: game.status,
    tick: game.tick,
    time: r(game.time),
    x: r(g.x), y: r(g.y), alt: r(g.alt),
    heading: r(g.heading), speed: r(g.speed),
    ballast: r(g.ballast), flaps: g.flaps,
    fuel: r(g.fuel), battery: r(g.battery), ice: r(g.ice),
    failReason: game.failReason,
    transitions: game.transitions.length,
  };
}

export function stateHash(game) {
  return hashState(snapshot(game));
}

// 用同 seed + 输入记录重放，返回最终哈希（确定性验证核心）
export function replay(seed, records, maxTicks = 40000) {
  const game = createGame(seed);
  let ri = 0;
  while (
    game.tick < maxTicks &&
    game.status !== "SUCCESS" && game.status !== "FAILED"
  ) {
    while (ri < records.length && records[ri].tick === game.tick) {
      applyInput(game, records[ri].input);
      ri++;
    }
    step(game);
  }
  return { game, hash: stateHash(game) };
}
