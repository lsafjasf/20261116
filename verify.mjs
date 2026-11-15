// 验证脚本：成功路线 / 失速恢复 / 操作失误 / 参数极限 / 复位一致性 / 回放哈希一致
import {
  CONFIG, createGame, step, applyInput, replay, stateHash, snapshot, stallSpeed,
} from "./src/sim.js";

const SEED = 20261116;
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  | " + extra : ""}`);
  if (!cond) failures++;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// 自动领航：朝机场飞行，绕开风暴核心，能量管理（过高则加速消耗高度）
function autopilot(game) {
  const g = game.glider;
  const a = CONFIG.airport;
  const s = game.world.storm;
  const dx = a.x - g.x, dy = a.y - g.y;
  const dist = Math.hypot(dx, dy);
  let desired = Math.atan2(dy, dx);
  const dStorm = Math.hypot(g.x - s.x, g.y - s.y);
  if (dStorm < s.r + 2500) {
    const toStorm = Math.atan2(s.y - g.y, s.x - g.x);
    const side = norm(desired - toStorm) > 0 ? -1 : 1;
    desired = toStorm + side * Math.PI / 2;
  }
  const turn = clamp(norm(desired - g.heading) * 2, -0.55, 0.55);
  // 能量管理：目标下滑比 25:1，过高就加速
  const altNeeded = 200 + dist / 25;
  const desiredSpeed = g.alt > altNeeded + 150 ? 30 : 20;
  const pitch = clamp(((desiredSpeed - 16) / 30) * 2 - 1, -1, 1);
  return { pitch, turn, flaps: dist < 3000 && g.alt < 500, dumpBallast: g.ballast > 0 };
}

function runWith(scriptFn, seed = SEED, maxTicks = 40000) {
  const game = createGame(seed);
  while (game.tick < maxTicks && game.status !== "SUCCESS" && game.status !== "FAILED") {
    step(game, scriptFn(game));
  }
  return game;
}

// 1) 成功路线
const win = runWith(autopilot);
check("成功路线抵达机场", win.status === "SUCCESS",
  `t=${win.time.toFixed(0)}s fuel=${win.glider.fuel.toFixed(0)} alt=${win.glider.alt.toFixed(0)}`);
check("成功时燃料未耗尽", win.glider.fuel > 0);
check("未进入风暴核心", win.failReason !== "进入风暴核心");

// 2) 失速与恢复
const stallGame = createGame(SEED);
for (let i = 0; i < 50; i++) step(stallGame, { pitch: 0, turn: 0, flaps: false, dumpBallast: false });
step(stallGame, { pitch: -1, turn: 0, flaps: false, dumpBallast: false });
for (let i = 0; i < 200 && stallGame.status !== "STALL"; i++) step(stallGame);
check("满拉杆触发失速", stallGame.status === "STALL",
  `speed=${stallGame.glider.speed.toFixed(1)} vs=${stallSpeed(stallGame.glider).toFixed(1)}`);
step(stallGame, { pitch: 1, turn: 0, flaps: false, dumpBallast: false });
for (let i = 0; i < 300 && stallGame.status === "STALL"; i++) step(stallGame);
check("推杆后失速恢复", stallGame.status === "FLYING",
  `speed=${stallGame.glider.speed.toFixed(1)}`);
const stallTransitions = stallGame.transitions.filter((t) => t.to === "STALL" || t.reason.includes("恢复"));
check("失速/恢复状态迁移已记录", stallTransitions.length >= 2);

// 3) 操作失误：直飞风暴核心
const mistake = runWith((game) => {
  const g = game.glider, s = game.world.storm;
  const desired = Math.atan2(s.y - g.y, s.x - g.x);
  return { pitch: 0, turn: clamp(norm(desired - g.heading) * 2, -0.5, 0.5), flaps: false, dumpBallast: false };
});
check("操作失误：进入风暴核心失败", mistake.status === "FAILED" && mistake.failReason === "进入风暴核心");

// 4) 参数极限：满转+满压舱+襟翼+满拉杆起步，随后推杆改出
const extreme = createGame(SEED);
step(extreme, { pitch: -1, turn: 1, flaps: true, dumpBallast: false });
for (let i = 0; i < 300; i++) step(extreme);
step(extreme, { pitch: 1, turn: 0, flaps: true, dumpBallast: false });
for (let i = 0; i < 2000 && extreme.status !== "SUCCESS" && extreme.status !== "FAILED"; i++) step(extreme);
const exg = extreme.glider;
const sane = [exg.x, exg.y, exg.alt, exg.speed, exg.fuel, exg.battery, exg.ice].every(Number.isFinite);
check("参数极限下数值稳定无 NaN", sane,
  `status=${extreme.status} speed=${exg.speed.toFixed(1)} ice=${exg.ice.toFixed(2)}`);
check("参数极限下状态机可达终态或仍受控", ["FLYING", "STALL", "SUCCESS", "FAILED"].includes(extreme.status));

// 5) 复位一致性：同 seed 重开，初始快照与随机序列完全一致
const fresh1 = createGame(SEED);
const fresh2 = createGame(SEED);
check("重新开始后初始状态哈希一致", stateHash(fresh1) === stateHash(fresh2));
check("重新开始后计时器复位", fresh2.tick === 0 && fresh2.time === 0);
check("重新开始后资源复位",
  fresh2.glider.fuel === CONFIG.fuelMax && fresh2.glider.battery === CONFIG.batteryMax &&
  fresh2.glider.ice === 0 && fresh2.glider.ballast === 0.5);
check("重新开始后世界随机序列一致（云层/风暴/风带）",
  JSON.stringify(fresh1.world) === JSON.stringify(fresh2.world));

// 6) 同 seed + 输入记录回放，最终状态哈希必须一致
const winHash = stateHash(win);
const { hash: replayHash, game: replayGame } = replay(SEED, win.records);
check("回放最终状态哈希一致", winHash === replayHash, `hash=${replayHash}`);
check("回放状态机结果一致", replayGame.status === win.status);

// 7) 暂停状态机：暂停时步进冻结，恢复后继续
import { togglePause } from "./src/sim.js";
const pg = createGame(SEED);
for (let i = 0; i < 100; i++) step(pg);
togglePause(pg);
check("暂停进入 PAUSED", pg.status === "PAUSED");
const tickAtPause = pg.tick;
step(pg); step(pg);
check("暂停时物理步进冻结", pg.tick === tickAtPause);
togglePause(pg);
step(pg);
check("恢复后继续推进", pg.status === "FLYING" && pg.tick === tickAtPause + 1);

// 8) 不同 seed 产生不同世界（随机性生效）
const other = createGame(SEED + 1);
check("不同 seed 生成不同风暴核心",
  other.world.storm.x !== fresh1.world.storm.x || other.world.storm.y !== fresh1.world.storm.y);

console.log(failures === 0 ? "\n全部验证通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
