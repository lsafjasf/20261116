// 仿真核心测试：正常流程 / 设备故障 / 参数越限 / 泄洪顺序错误 / 确定性回放 / 恢复后 soak
import test from 'node:test';
import assert from 'node:assert/strict';
import { Sim, SIM_DURATION, SOAK_DURATION, LIMITS } from '../js/sim.js';

// 通用自动调度策略：水位高于目标则按比例开闸，但限制总出流不越下游安全线
function autoDispatch(sim, levelGoal = 30, flowCap = 2350) {
  const s = sim.snapshot();
  const head = Math.max(0.01, Math.sqrt(Math.max(0, s.level - 18)));
  const per = 220 * head;
  const need = s.qIn > 0 && s.level > levelGoal ? 1 : s.level > levelGoal - 1 ? 0.6 : 0.15;
  let gateOpen = Math.min(1, need);
  // 下游流量约束：先闸后泄洪道，总量封顶
  const gateQ = () => sim.gates.reduce((a, g, i) => a + (g.stuck ? s.qGate[i] : per * (i < 3 ? gateOpen : 0)), 0);
  while (gateOpen > 0 && gateQ() > flowCap) gateOpen -= 0.05;
  for (let i = 0; i < 3; i++) if (!sim.gates[i].stuck) sim.setGateTarget(i, Math.max(0, gateOpen));
  const rem = flowCap - gateQ();
  const spillHead = Math.sqrt(Math.max(0, s.level - 20));
  const spillOpen = s.level > levelGoal + 1 && spillHead > 0
    ? Math.min(1, Math.max(0, rem / (400 * spillHead))) : 0;
  sim.setSpillTarget(spillOpen);
}

function run(sim, seconds, ctrl) {
  for (let i = 0; i < seconds && sim.status === 'running'; i++) {
    if (ctrl && sim.t % 30 === 0) ctrl(sim);
    sim.step();
  }
  return sim;
}

test('正常流程：六小时内坝体与下游均达标', () => {
  const sim = new Sim({ seed: 7, scenario: 'normal' });
  run(sim, SIM_DURATION, s => autoDispatch(s));
  assert.equal(sim.status, 'success');
  const snap = sim.snapshot();
  assert.ok(snap.level < LIMITS.levelMax, `水位 ${snap.level} 应低于 ${LIMITS.levelMax}`);
  assert.ok(snap.qOut <= LIMITS.downSafe, `出流 ${snap.qOut} 应低于 ${LIMITS.downSafe}`);
  assert.ok(sim.log.some(e => e.type === 'success'));
});

test('设备故障：2 号闸门卡涩，记录时刻/余量/响应，修复后恢复', () => {
  const sim = new Sim({ seed: 7, scenario: 'gateFault' });
  let repaired = false;
  run(sim, SIM_DURATION, s => {
    autoDispatch(s);
    if (!repaired && s.gates[1].stuck) { s.repairGate(1); repaired = true; }
  });
  const fault = sim.log.find(e => e.type === 'fault');
  assert.ok(fault, '应记录故障事件');
  assert.equal(fault.t, 5400);
  assert.equal(fault.device, 'gate2');
  assert.ok(typeof fault.margins.level === 'number' && typeof fault.margins.flow === 'number');
  assert.ok(fault.response.length > 0);
  const recover = sim.log.find(e => e.type === 'recover');
  assert.ok(recover, '修复后应有恢复事件');
  assert.ok(recover.t >= fault.t + 120 && recover.t <= fault.t + 180,
    `恢复时刻 ${recover.t} 应在故障后 120~180s 内`);
  assert.equal(sim.status, 'success');
});

test('参数越限：超标准洪水导致漫坝，记录失败时刻与余量', () => {
  const sim = new Sim({ seed: 7, scenario: 'extremeFlood' });
  run(sim, SIM_DURATION, s => autoDispatch(s));
  assert.equal(sim.status, 'failed');
  const failure = sim.log.find(e => e.type === 'failure');
  assert.ok(failure);
  assert.match(failure.detail, /漫坝/);
  assert.ok(failure.margins.level <= 0.05, `漫坝时水位余量应≈0，实际 ${failure.margins.level}`);
});

test('泄洪顺序错误：高水位先全开泄洪道，下游叠加流量超限冲刷', () => {
  const sim = new Sim({ seed: 7, scenario: 'normal' });
  // 错误操作：t=60 时不开闸门削峰，反而直接全开泄洪道
  run(sim, 60);
  sim.setSpillTarget(1);
  sim.setGateTarget(0, 1); sim.setGateTarget(1, 1); sim.setGateTarget(2, 1);
  run(sim, SIM_DURATION);
  assert.equal(sim.status, 'failed');
  const failure = sim.log.find(e => e.type === 'failure');
  assert.match(failure.detail, /下游冲刷/);
  assert.ok(failure.margins.flow < 0, `失败时流量余量应为负，实际 ${failure.margins.flow}`);
  assert.ok(sim.snapshot().scour > 0, '应有河岸冲刷累积');
});

test('确定性回放：同种子同操作日志，轨迹完全一致', () => {
  const sim = new Sim({ seed: 42, scenario: 'gateFault' });
  let repaired = false;
  run(sim, SIM_DURATION, s => {
    autoDispatch(s);
    if (!repaired && s.gates[1].stuck) { s.repairGate(1); repaired = true; }
  });
  const replayed = Sim.replay(sim.log);
  const a = sim.snapshot(), b = replayed.snapshot();
  assert.equal(a.status, b.status);
  assert.equal(a.level, b.level);
  assert.equal(a.qOut, b.qOut);
  assert.deepEqual(a.gates, b.gates);
  assert.equal(a.t, b.t);
});

test('失败回放：可精确重放到失败前一刻', () => {
  const sim = new Sim({ seed: 7, scenario: 'extremeFlood' });
  run(sim, SIM_DURATION, s => autoDispatch(s));
  assert.equal(sim.status, 'failed');
  const failT = sim.log.find(e => e.type === 'failure').t;
  const replayed = Sim.replay(sim.log, { until: failT });
  assert.equal(replayed.status, 'running', '重放到失败前一刻应仍在运行');
  const next = Sim.replay(sim.log, { until: failT + 1 });
  assert.equal(next.status, 'failed', '再推进一秒应复现失败');
  assert.equal(next.failReason, sim.failReason);
});

test('恢复后 soak：持续运行固定时间，无连锁错误与状态跳变', () => {
  const sim = new Sim({ seed: 7, scenario: 'gateFault', soak: true });
  let repaired = false;
  // 先跑到恢复安全状态
  run(sim, SIM_DURATION, s => {
    autoDispatch(s);
    if (!repaired && s.gates[1].stuck) { s.repairGate(1); repaired = true; }
  });
  assert.equal(sim.status, 'running'); // soak 模式下 6h 不终止
  assert.ok(sim.safeSince !== null, '应已回到安全区');
  // 恢复安全后再持续运行 SOAK_DURATION，逐秒检查状态连续性
  const eventsBefore = sim.log.filter(e => e.type === 'fault' || e.type === 'failure').length;
  const maxLevelStep = (sim.qIn + 5000) / sim.surfaceArea + 1e-9; // 单步水位变化物理上界
  let prevLevel = sim.level, prevQ = sim.qOut;
  for (let i = 0; i < SOAK_DURATION && sim.status === 'running'; i++) {
    if (sim.t % 30 === 0) autoDispatch(sim);
    sim.step();
    assert.ok(Number.isFinite(sim.level) && Number.isFinite(sim.qOut), '状态不得出现 NaN');
    assert.ok(Math.abs(sim.level - prevLevel) <= maxLevelStep,
      `t=${sim.t} 水位跳变 ${Math.abs(sim.level - prevLevel)} 超过物理上界`);
    assert.ok(Math.abs(sim.qOut - prevQ) <= 200, `t=${sim.t} 出流跳变过大`);
    prevLevel = sim.level; prevQ = sim.qOut;
  }
  const eventsAfter = sim.log.filter(e => e.type === 'fault' || e.type === 'failure').length;
  assert.equal(eventsAfter, eventsBefore, 'soak 期间不应出现新故障/失败');
  assert.ok(sim.log.every(e => Number.isFinite(e.t)), '日志时钟应全部有效');
  assert.ok(sim.snapshot().qOut <= LIMITS.downSafe, 'soak 末段下游应达标');
});
