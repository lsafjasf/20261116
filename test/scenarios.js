// 场景验证: 正常流程 / 设备故障 / 参数越限 / 超载 / 回放一致性
// 运行: node test/scenarios.js
'use strict';
const S = require('../js/sim.js');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✔ ' + msg); }
  else { failed++; console.log('  ✘ ' + msg); }
}

// 通用驱动: 在指定 tick 应用脚本操作, 其余时间推进时钟
function drive(sim, script, maxTicks) {
  const ticks = Object.keys(script).map(Number).sort((a, b) => a - b);
  while (!sim.result && sim.tick < maxTicks) {
    while (ticks.length && ticks[0] === sim.tick) {
      script[ticks.shift()].forEach(([op, args]) => S.applyOp(sim, op, args));
    }
    S.step(sim);
    const bad = S.checkInvariants(sim);
    if (bad) throw new Error('不变量违反 @tick ' + sim.tick + ': ' + bad);
  }
  return sim;
}

const RESCUE_ALL = ['W1','W2','W3','W4','W5','W6','W7','W8','W9']
  .map(id => ['enqueue', { type: 'rescue', actorId: id }]);
const RESCUE_DEEP_FIRST = ['W9','W8','W7','W6','W5','W4','W3','W2','W1']
  .map(id => ['enqueue', { type: 'rescue', actorId: id }]);

// ---------- 场景 1: 正常流程 ----------
console.log('\n[场景1] 正常流程: 深部优先撤离 + 设备 EA 下送');
{
  const sim = S.createSim(42);
  const script = { 0: [
    ['enqueue', { type: 'deliver', actorId: 'EA' }],
    ...['W9','W8','W7','W6','W5','W4','W3','W2','W1']
      .map(id => ['enqueue', { type: 'rescue', actorId: id }])
  ]};
  drive(sim, script, 20000);
  assert(sim.result === 'success', '全部 9 人升井且 EA 到位, 任务成功');
  assert(sim.failures.length === 0, '无故障记录');
  assert(sim.brakeWear < sim.cfg.brakeWearLimit,
    `制动磨损 ${sim.brakeWear} 低于限值 ${sim.cfg.brakeWearLimit}`);
  console.log(`  完成于 tick=${sim.tick} t=${sim.time.toFixed(1)}s 电量=${sim.battery.toFixed(1)}`);
}

// ---------- 场景 2: 设备故障(制动磨损) + 恢复后浸泡 ----------
console.log('\n[场景2] 设备故障: 制动磨损超限 -> 紧急抱闸检修 -> 恢复 -> 浸泡观察');
{
  const sim = S.createSim(7);
  sim.brakeWear = 80; // 老旧提升机, 初始磨损偏高
  const script = { 0: [
    ...RESCUE_DEEP_FIRST,
    ['enqueue', { type: 'deliver', actorId: 'EA' }]
  ]};
  drive(sim, script, 30000);
  const f = sim.failures.find(x => x.type === 'brake_wear');
  assert(!!f, '发生制动磨损故障');
  if (f) {
    console.log(`  故障时刻 tick=${f.tick} t=${f.time}s 余量=${f.margin} 响应=${f.response}`);
    assert(f.margin <= 0, '故障时余量<=0 (磨损触及限值)');
    assert(/检修/.test(f.response), '系统响应: 闭锁并检修');
  }
  assert(sim.log.some(e => /检修完成/.test(e.msg)), '检修完成, 恢复运行');
  assert(sim.log.some(e => /浸泡观察结束/.test(e.msg)),
    '恢复后持续运行固定时长, 无连锁错误/状态跳变');
  assert(sim.result === 'success', '故障恢复后任务最终成功');
}

// ---------- 场景 3: 参数越限(井段温度) + 恢复后浸泡 ----------
console.log('\n[场景3] 参数越限: 段1 温度越限 -> 强制通风 -> 回落 -> 浸泡观察');
{
  const sim = S.createSim(99);
  const script = {
    0: RESCUE_ALL.slice(0, 4),
    100: [['__inject', null]] // 占位, 下面直接注入
  };
  // 注入越限: 在 tick=100 把段1 温度推到硬阈值之上
  const origStep = S.step;
  const ticks = Object.keys(script).map(Number);
  while (!sim.result && sim.tick < 20000) {
    if (sim.tick === 100) {
      sim.segments[1].temp = 58;
      sim.log.push({ tick: sim.tick, time: sim.time, cat: 'env',
                     msg: '外部注入: 段1 温度传感器读数 58℃' });
    }
    if (sim.tick === 0) script[0].forEach(([op, a]) => S.applyOp(sim, op, a));
    origStep(sim);
    const bad = S.checkInvariants(sim);
    if (bad) throw new Error('不变量违反: ' + bad);
  }
  const f = sim.failures.find(x => x.type === 'param_overtemp');
  assert(!!f, '检测到温度越限故障');
  if (f) {
    console.log(`  故障时刻 tick=${f.tick} t=${f.time}s 余量=${f.margin}℃ 响应=${f.response}`);
    assert(f.margin < 0, '越限时余量为负');
  }
  assert(sim.segments[1].temp <= sim.cfg.tempHardLimit,
    `系统响应后温度回落到 ${sim.segments[1].temp.toFixed(1)}℃`);
  assert(sim.log.some(e => /浸泡观察结束/.test(e.msg)),
    '越限恢复后浸泡观察通过, 无隐藏连锁错误');
}

// ---------- 场景 4: 一次超载失败 ----------
console.log('\n[场景4] 超载: EA(180kg)+EB(250kg) 强行同载 > 400kg 限值');
{
  const sim = S.createSim(5);
  S.applyOp(sim, 'overload', { actorId: 'EA' });
  S.applyOp(sim, 'overload', { actorId: 'EB' });
  const f = sim.failures.find(x => x.type === 'overload');
  assert(!!f, '触发超载失败');
  if (f) console.log(`  故障时刻 tick=${f.tick} 余量=${f.margin}kg 响应=${f.response}`);
  assert(S.loadWeight(sim) <= sim.cfg.capacity, '保护动作后载荷回到限值内');
  const ea = S.findActor(sim, 'EA');
  assert(ea.level === -1, 'EA 仍在轿厢内, EB 被卸载');
}

// ---------- 场景 5: 回放一致性(含重排操作) ----------
console.log('\n[场景5] 可重复仿真: 操作日志回放 -> 状态哈希一致');
{
  const sim = S.createSim(123);
  const script = {
    0: [...RESCUE_ALL, ['enqueue', { type: 'deliver', actorId: 'EA' }]],
    50: [['reorder', { from: 9, to: 0 }]],
    51: [['reorder', { from: 0, to: 5 }]]
  };
  drive(sim, script, 6000);
  const h1 = S.stateHash(sim);
  const rep = S.replay(123, sim.opLog, sim.tick);
  const h2 = S.stateHash(rep);
  assert(h1 === h2, `回放哈希一致 (${h1} === ${h2})`);
  assert(rep.log.length === sim.log.length, '日志长度一致, 环境变化可复现');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
