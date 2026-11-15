// 自动化验证：成功安装 + 过早松钩失败 + 回放确定性 + 读档恢复 + 冲突检测
// 运行：node test/run-tests.mjs
import {
  createGame, step, runSim, serialize, deserialize,
  inputEventsOf, detectConflicts, replayWithSnapshots, platePos, WORLD,
} from '../src/sim.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.error(`  FAIL ${name} ${detail}`); }
}

// ---- 自动驾驶：生成一份“成功安装”的输入事件 ----
function autopilot(seed) {
  const g = createGame(seed);
  let last = { vertical: null, move: null };
  let lastStage = 0;
  let unhooked = false;
  const push = (type, player) => {
    step1Events.push({ tick: g.tick, player, type });
  };
  const step1Events = [];
  for (let i = 0; i < 60000 && g.status !== 'success' && g.status !== 'failed'; i++) {
    if (g.stage !== lastStage) { last = { vertical: null, move: null }; lastStage = g.stage; }
    if (g.stage >= 3 && !unhooked) {
      push('unhook', 'L');
      unhooked = true;
    } else if (g.stage < 3) {
      const p = platePos(g);
      const err = p.x - WORLD.targets[g.stage];
      const hv = g.len * g.thetaDot;
      // PD 水平校正
      const aCmd = -3.2 * err - 1.4 * hv;
      const move = aCmd > 25 ? 'moveR' : aCmd < -25 ? 'moveL' : 'moveStop';
      if (move !== last.move) { push(move, 'R'); last.move = move; }
      // 对中良好才下降
      const vertical = (Math.abs(err) < g.tolerance * 0.5 && Math.abs(hv) < 45)
        ? 'lower' : 'hold';
      if (vertical !== last.vertical) { push(vertical, 'L'); last.vertical = vertical; }
    }
    step(g, step1Events.filter((e) => e.tick === g.tick));
  }
  return { game: g, events: inputEventsOf(g) };
}

console.log('== 测试 1：完整成功安装（3 连接点 + 车辆通过） ==');
const run1 = autopilot(1);
check('自动驾驶成功完成', run1.game.status === 'success',
  `status=${run1.game.status} stage=${run1.game.stage} reason=${run1.game.failReason}`);
check('三个连接点均已固定', run1.game.connected.every((c) => c !== null));
check('时间线含 3 次 connect 与 1 次 vehiclePass',
  run1.game.timeline.filter((e) => e.type === 'connect').length === 3
  && run1.game.timeline.some((e) => e.type === 'vehiclePass'));
check('碰撞结果记录在同一时间线上',
  run1.game.timeline.every((e) => typeof e.tick === 'number' && e.pos));

console.log('== 测试 2：回放确定性（暂停/单步/倍速不改变最终状态） ==');
const replayA = runSim(1, run1.events);
const replayB = runSim(1, run1.events);
check('两次完整回放结果一致',
  replayA.status === replayB.status && replayA.tick === replayB.tick
  && Math.abs(replayA.durability - replayB.durability) < 1e-9);
// 模拟“暂停 + 单步”：分段重放后继续
const midTick = Math.floor(replayA.tick / 2);
const paused = runSim(1, run1.events, midTick);
check('中途暂停的仪表状态与连续运行一致',
  (() => { const ref = runSim(1, run1.events, midTick);
    return Math.abs(paused.durability - ref.durability) < 1e-9
      && paused.stage === ref.stage; })());
const { snaps, final: snapFinal } = replayWithSnapshots(1, run1.events);
check('逐 tick 快照回放（单步模式）最终状态一致',
  snapFinal.status === replayA.status && snapFinal.tick === replayA.tick
  && Math.abs(snapFinal.durability - replayA.durability) < 1e-9);
check('快照数量与终局 tick 一致', snaps.length === replayA.tick);

console.log('== 测试 3：过早松钩失败 ==');
{
  const g = createGame(2);
  const evs = [
    { tick: 10, player: 'L', type: 'lower' },
    { tick: 200, player: 'L', type: 'unhook' }, // 第一个连接点未固定就松钩
  ];
  const r = runSim(2, evs);
  check('过早松钩导致失败', r.status === 'failed');
  check('失败原因指明松钩过早', /松钩过早/.test(r.failReason || ''));
  check('耐久因坠落受损', r.durability <= 60, `durability=${r.durability}`);
  check('时间线记录了 fall 事件及位置',
    r.timeline.some((e) => e.type === 'fall' && e.pos && typeof e.pos.x === 'number'));
  const rf = runSim(2, evs);
  check('失败回放同样确定', rf.status === 'failed' && rf.tick === r.tick);
}

console.log('== 测试 4：读档后仪表 / 耐久 / 进度恢复 ==');
{
  const g = createGame(1);
  const evs = run1.events;
  const targetTick = Math.floor(replayA.tick * 0.6);
  while (g.tick < targetTick) step(g, evs);
  const saved = serialize(g);
  const restored = deserialize(saved);
  check('进度（连接点）恢复', restored.stage === g.stage
    && JSON.stringify(restored.connected) === JSON.stringify(g.connected));
  check('耐久恢复', Math.abs(restored.durability - g.durability) < 1e-9);
  check('仪表（张力/风/温度/容差）恢复',
    Math.abs(restored.tension - g.tension) < 1e-9
    && Math.abs(restored.wind - g.wind) < 1e-9
    && Math.abs(restored.temp - g.temp) < 1e-9
    && Math.abs(restored.tolerance - g.tolerance) < 1e-9);
  check('吊索与摆角恢复',
    Math.abs(restored.len - g.len) < 1e-9 && Math.abs(restored.theta - g.theta) < 1e-9);
  // 恢复后继续到终局，与原始运行一致
  while (restored.status !== 'success' && restored.status !== 'failed') step(restored, evs);
  check('读档后继续运行最终状态一致',
    restored.status === replayA.status && restored.tick === replayA.tick
    && Math.abs(restored.durability - replayA.durability) < 1e-9);
}

console.log('== 测试 5：两侧动作顺序冲突检测 ==');
{
  const evs = [
    { tick: 50, player: 'R', type: 'moveL' },
    { tick: 50, player: 'L', type: 'lower' }, // 同 tick 双输入 => 冲突
    { tick: 120, player: 'L', type: 'unhook' },
  ];
  const conflicts = detectConflicts(evs);
  check('检测到同 tick 冲突', conflicts.length === 1 && conflicts[0].tick === 50);
  const g = runSim(3, evs);
  const c = g.conflicts[0];
  check('冲突记录了具体时刻与对象位置',
    c && c.tick === 50 && c.pos && typeof c.pos.x === 'number'
    && typeof c.pos.y === 'number' && typeof c.pos.theta === 'number');
  check('冲突双方动作被记录',
    c && c.actions.includes('L:lower') && c.actions.includes('R:moveL'));
  check('时间线含 conflict 条目', g.timeline.some((e) => e.type === 'conflict'));
}

console.log(failures === 0 ? '\n全部测试通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
