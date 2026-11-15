const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../bridge/engine');
const SC = require('../bridge/scenarios');

const SOAK_STEPS = 300;

function fingerprint(sim) {
  const keys = ['stepIndex', 't', 'water', 'gap', 'speed', 'status', 'residual',
    'lastMargin', 'failed', 'reinforced', 'damage', 'ratio', 'demand', 'capacity'];
  return JSON.stringify(keys.map(k => JSON.stringify(sim[k]))) +
    '|' + sim.rng.a + '|' + JSON.stringify(sim.trains.map(t => [t.front, t.exited]));
}

function findEvent(sim, type) {
  return sim.events.filter(e => e.type === type);
}

function recordFaultMargin(sim) {
  const fault = findEvent(sim, 'fault')[0];
  return fault ? { t: fault.t, margin: fault.data.margin } : null;
}

function runScenario(name) {
  const sim = SC.build(name);
  E.run(sim);
  return sim;
}

function assertFinite(sim, label) {
  const bad = [];
  ['demand', 'capacity', 'ratio', 'peakRatio', 'damage'].forEach(k => {
    sim[k].forEach((v, i) => {
      if (!Number.isFinite(v)) bad.push(label + ' ' + k + '[' + i + ']=' + v);
    });
  });
  sim.supports.forEach(s => {
    if (!Number.isFinite(s.cap)) bad.push(label + ' support ' + (s.id || s.node) + ' cap=' + s.cap);
  });
  if (!Number.isFinite(sim.water) || !Number.isFinite(sim.lastMargin)) {
    bad.push(label + ' 水位或余量非有限值');
  }
  assert.strictEqual(bad.length, 0, bad.join('; '));
}

function assertNormal(sim) {
  assert.strictEqual(sim.status, 'success', '正常流程应成功，实际: ' + sim.status);
  assert.ok(sim.trains.every(t => t.exited), '三列车全部通过');
  assert.ok(sim.residual <= E.RESIDUAL_LIMIT, '残余应力达标');
  assert.deepStrictEqual(sim.failed, [], '无节点失稳');
  const peaks = sim.peakRatio;
  assert.ok(Math.max(...peaks) < 1, '全程应力比峰值 < 1, 峰值=' + Math.max(...peaks).toFixed(3));
  assert.ok(sim.water >= 18, '水位确实上升，water=' + sim.water);
}

function assertFault(sim) {
  const fault = findEvent(sim, 'fault');
  assert.strictEqual(fault.length, 1, '注入一次泵故障');
  const repair = findEvent(sim, 'repair');
  assert.strictEqual(repair.length, 1, '执行一次修复');
  assert.strictEqual(sim.status, 'success', '故障处置后应成功');
  assert.deepStrictEqual(sim.failed, [], '故障未造成失稳');
  const f = sim.faults['pump:P5'];
  assert.ok(f && f.repairedAt != null, '故障已标记修复');
  return { faultAt: fault[0].t, faultMargin: fault[0].data.margin,
    repairAt: repair[0].t, response: sim.failReason };
}

function assertOverlimit(sim) {
  const rejects = findEvent(sim, 'reject');
  assert.ok(rejects.length >= 3, '至少三条越限命令被拒绝，实际 ' + rejects.length);
  assert.strictEqual(sim.gap, 18, '越限间隔未生效');
  assert.strictEqual(sim.speed, 6, '越限速度未生效');
  assert.deepStrictEqual(sim.reinforced, [1, 9], '第三次加固被拒绝，仅两处生效');
  assert.strictEqual(sim.status, 'success', '拒绝越限后正常运输成功');
  return rejects.map(r => ({ t: r.t, msg: r.msg }));
}

function assertInteractiveCommands() {
  const sim = E.createSim({ seed: 7, gap: 18, speed: 6 });
  E.sendCommand(sim, { type: 'reinforce', at: 0.5, node: 1 });
  E.sendCommand(sim, { type: 'reinforce', at: 0.8, node: 9 });
  E.sendCommand(sim, { type: 'movePier', at: 1.0, id: 'P3', node: 1 });
  E.sendCommand(sim, { type: 'movePier', at: 1.2, id: 'P7', node: 9 });
  E.sendCommand(sim, { type: 'movePier', at: 1.4, id: 'P5', node: 6 });
  E.run(sim);
  assert.strictEqual(sim.movesUsed, 2, '两次桥墩移动生效');
  const rejects = sim.events.filter(e => e.type === 'reject');
  assert.ok(rejects.some(e => e.msg.includes('移动次数已用尽')), '第三次移动被拒绝');
  const piers = sim.supports.filter(s => s.kind === 'pier');
  assert.strictEqual(piers.find(p => p.id === 'P3').node, 1);
  assert.strictEqual(piers.find(p => p.id === 'P7').node, 9);

  const late = E.createSim({ seed: 7 });
  E.sendCommand(late, { type: 'setGap', at: 12, value: 25 });
  E.run(late);
  assert.ok(late.events.some(e => e.type === 'reject' && e.msg.includes('列车已上桥')));
  assert.strictEqual(late.gap, 18, '上桥后改间隔被拒绝，原值保留');
  return { movesUsed: 2, rejectsLogged: rejects.length + 1 };
}

function assertWrongReinforce(sim) {
  assert.strictEqual(sim.status, 'failed', '错误加固必须失败');
  assert.ok(sim.failTime != null, '记录失败时刻');
  assert.ok(sim.failed.length >= 1, '至少一个节点失稳');
  const chain = findEvent(sim, 'nodefail');
  assert.ok(chain.length >= 1, '存在失稳事件');
  const marginAtFail = sim.events.find(e => e.type === 'nodefail').data.ratio;
  return { failTime: sim.failTime, reason: sim.failReason,
    failedNodes: sim.failed.slice(), overloadRatio: marginAtFail,
    events: chain.map(e => ({ t: e.t, msg: e.msg })) };
}

function checkStateJumps(before, after, label) {
  const problems = [];
  for (let i = 0; i < E.NODE_COUNT; i++) {
    const jump = Math.abs(after.ratio[i] - before.ratio[i]);
    if (jump > 0.9) problems.push(label + ' 节点' + i + ' 应力跳变 ' + jump.toFixed(2));
  }
  const expectedWater = Math.min(28, before.water + E.STEP * 1.6);
  if (Math.abs(after.water - expectedWater) > 0.21) {
    problems.push(label + ' 水位增量异常');
  }
  if (after.stepIndex - before.stepIndex !== 1) {
    problems.push(label + ' 时钟步数非单步递增');
  }
  for (let i = 0; i < E.NODE_COUNT; i++) {
    if (after.damage[i] < before.damage[i] - 0.051 ||
        after.damage[i] > before.damage[i] + E.DAMAGE_PER_STEP + 0.001) {
      problems.push(label + ' 节点' + i + ' 损伤非单调累积');
    }
  }
  return problems;
}

function soakAfterRecovery() {
  const sim = SC.build('fault');
  const repairEvent = sim.pending.find(c => c.type === 'repair');
  E.run(sim);
  const start = E.snapshot(sim);
  const startHash = fingerprint(sim);
  const violations = [];
  let prev = start;
  for (let k = 0; k < SOAK_STEPS; k++) {
    const pre = E.snapshot(sim);
    E.step(sim);
    violations.push(...checkStateJumps(pre, sim, 'soak#' + k));
    if (sim.failed.length !== prev.failed.length) {
      violations.push('浸泡期出现新失稳 @t=' + sim.t);
    }
    prev = E.snapshot(sim);
  }
  assert.deepStrictEqual(sim.failed, [], '浸泡期无连锁失稳');
  assert.strictEqual(sim.status, 'success', '浸泡后仍为成功状态');
  assert.ok(sim.damage.every(d => d === 0), '无列车时损伤完全回落');
  assert.ok(violations.length === 0, violations.join('; '));

  const replay = E.createSim({ seed: 20261116, gap: 20, speed: 5.5 });
  const fresh = SC.build('fault');
  E.run(fresh);
  for (let k = 0; k < SOAK_STEPS; k++) E.step(fresh);
  assert.strictEqual(fingerprint(fresh), fingerprint(sim), '故障剧本二次运行指纹一致');
  assert.notStrictEqual(startHash, fingerprint(sim));
  return { soakSteps: SOAK_STEPS, soakSeconds: (SOAK_STEPS * E.STEP).toFixed(1),
    endT: sim.t, endStatus: sim.status };
}

function replayFromSnapshot(failedSim) {
  const snap = failedSim.snapshots[Math.max(0, failedSim.snapshots.length - 6)];
  const replay = E.restore(E.createSim({ seed: 20261116 }), snap, true);
  const target = failedSim.failTime;
  let guard = 500;
  while (replay.t < target && guard-- > 0) E.step(replay);
  assert.strictEqual(replay.status, 'failed', '回放重现失败状态');
  const refNodes = failedSim.events.filter(e => e.type === 'nodefail' && e.t <= target + 0.11)
    .map(e => e.data.node);
  assert.deepStrictEqual(replay.failed, refNodes, '回放重现同一失稳节点序列');
  assert.ok(Math.abs(replay.failTime - failedSim.failTime) < 0.11,
    '失败时刻一致');
  const ref = E.restore(E.createSim({ seed: 20261116 }),
    JSON.parse(JSON.stringify(snap)), true);
  guard = 500;
  while (ref.t < target && guard-- > 0) E.step(ref);
  const refRatio = ref.ratio;
  const ratioMatch = replay.ratio.every((r, i) => Math.abs(r - refRatio[i]) < 1e-9);
  assert.ok(ratioMatch, '回放应力带与原运行完全一致');
  return { fromT: snap.t, failTime: replay.failTime, failedNodes: replay.failed.slice() };
}

function determinismCheck() {
  const pairs = SC.NAMES.map(name => {
    const a = runScenario(name);
    const b = runScenario(name);
    assert.strictEqual(fingerprint(a), fingerprint(b), name + ' 两次运行确定性一致');
    return [name, fingerprint(a).slice(0, 18)];
  });
  return pairs;
}

function main() {
  const report = { generatedAt: new Date().toISOString(), step: E.STEP, cases: [] };
  const normal = runScenario('normal');
  assertNormal(normal);
  assertFinite(normal, 'normal');
  report.cases.push({ case: 'normal', status: normal.status,
    finishTime: normal.finishTime, residual: Number(normal.residual.toFixed(4)),
    peakRatio: Number(Math.max(...normal.peakRatio).toFixed(4)),
    water: Number(normal.water.toFixed(2)),
    trainExitTimes: normal.trains.map(t => Number(t.exitTime.toFixed(1))) });

  const faultSim = runScenario('fault');
  const faultInfo = assertFault(faultSim);
  assertFinite(faultSim, 'fault');
  const faultProbe = SC.build('fault');
  let windowMin = 1, windowMinT = 0;
  while (!faultProbe.finished) {
    E.step(faultProbe);
    if (faultProbe.t >= faultInfo.faultAt && faultProbe.t <= faultInfo.repairAt &&
        faultProbe.lastMargin < windowMin) {
      windowMin = faultProbe.lastMargin;
      windowMinT = faultProbe.t;
    }
  }
  report.cases.push({ case: 'equipmentFault', status: faultSim.status,
    faultAt: faultInfo.faultAt, marginAtFault: faultInfo.faultMargin,
    repairAt: faultInfo.repairAt,
    windowMinMargin: Number(windowMin.toFixed(3)), windowMinMarginAt: windowMinT,
    response: '泵故障使P5容量被压到故障上限，系统记录故障时刻与余量、' +
      '在窗口内完成修复恢复容量，最终残余应力=' + Number(faultSim.residual.toFixed(3)),
    residual: Number(faultSim.residual.toFixed(4)) });

  const over = runScenario('overlimit');
  const rejects = assertOverlimit(over);
  assertFinite(over, 'overlimit');
  report.cases.push({ case: 'parameterOverlimit', status: over.status,
    rejectedCommands: rejects, effectiveGap: over.gap, effectiveSpeed: over.speed,
    reinforced: over.reinforced, residual: Number(over.residual.toFixed(4)) });

  const wrong = runScenario('wrongReinforce');
  const wrongInfo = assertWrongReinforce(wrong);
  assertFinite(wrong, 'wrongReinforce');
  const replayInfo = replayFromSnapshot(wrong);
  report.cases.push({ case: 'wrongReinforceCascade', status: wrong.status,
    failTime: wrongInfo.failTime, marginAtOverload: Number((1 - wrongInfo.overloadRatio).toFixed(3)),
    reason: wrongInfo.reason, failedNodes: wrongInfo.failedNodes,
    chain: wrongInfo.events, replay: replayInfo });

  report.cases.push({ case: 'determinism', fingerprints: determinismCheck() });
  report.cases.push({ case: 'postRecoverySoak', ...soakAfterRecovery() });
  report.cases.push({ case: 'interactiveCommands', ...assertInteractiveCommands() });

  const out = path.join(__dirname, '..', 'artifacts', 'test-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('\n全部断言通过，报告已写入 ' + out);
}

main();
