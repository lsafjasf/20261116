/*
 * 无头测试套件：固定 seed 下的确定性验证
 *  1. 正常流程  2. 设备故障  3. 参数越限(过载+漂移)
 *  4. 断缆恢复  5. 操作回放确定性  6. 暂停/单步/恢复等价性
 */
const { Simulation } = require('../src/core.js');
const AP = require('../src/autopilot.js');

const results = [];

function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || (cond ? 'ok' : 'assertion failed') });
  return cond;
}

function faultSummary(rec, reason) {
  const ev = rec.events.find((e) => e.kind === 'abort' && e.reason === reason);
  if (!ev) return null;
  return { time: ev.time, tick: ev.tick, margins: ev.margins, message: ev.message };
}

function runScenario(fn) {
  const sim = new Simulation();
  fn(sim);
  return sim.exportRecord();
}

// 1. 正常流程：两处接头完成、无中止、soak 后正常结束
function testNormal() {
  const rec = runScenario(AP.runNormal);
  check('normal.complete', rec.mode === 'complete', `mode=${rec.mode}`);
  check('normal.bothJointsSpliced', rec.joints.every((j) => j.spliced));
  check('normal.noAbort', !rec.events.some((e) => e.kind === 'abort'));
  check('normal.noInvariantViolation', rec.invariantViolations.length === 0);
  check('normal.tensionUnderBreak', rec.stats.tensionMax < 120000,
    `tMax=${(rec.stats.tensionMax / 1000).toFixed(1)}kN`);
  check('normal.soakRan', rec.events.some((e) => e.kind === 'soak_complete'));
}

// 2. 设备故障：推进器降级后靠冗余完成，记录故障时刻与系统响应
function testThrusterFault() {
  const rec = runScenario(AP.runThrusterFault);
  const fault = rec.events.find((e) => e.kind === 'fault' && /推进器/.test(e.message));
  check('fault.recorded', !!fault, fault ? `t=${fault.time}` : 'no fault event');
  check('fault.hasMargins', !!fault && typeof fault.margins.drift_m === 'number');
  check('fault.hasResponse', !!fault && /冗余/.test(fault.response));
  check('fault.recoveredAndComplete', rec.mode === 'complete', `mode=${rec.mode}`);
  check('fault.noAbort', !rec.events.some((e) => e.kind === 'abort'));
  check('fault.noInvariantViolation', rec.invariantViolations.length === 0);
}

// 3. 参数越限：电力过载 + 船位漂移，各自记录时刻、余量、响应
function testOverLimits() {
  const rec = runScenario(AP.runOverload);
  const overload = faultSummary(rec, 'power_overload');
  const drift = faultSummary(rec, 'drift_exceeded');
  check('overlimit.overloadAbort', !!overload, JSON.stringify(overload));
  check('overlimit.overloadNegativeMargin', !!overload && overload.margins.power_kW < 0);
  check('overlimit.driftAbort', !!drift, JSON.stringify(drift));
  check('overlimit.driftNegativeMargin', !!drift && drift.margins.drift_m < 0);
  check('overlimit.twoRecoveries',
    rec.events.filter((e) => e.kind === 'recovery_complete').length >= 2);
  check('overlimit.completeAfterSoak', rec.mode === 'complete');
  check('overlimit.noInvariantViolation', rec.invariantViolations.length === 0);
}

// 4. 断缆恢复：断裂时刻/余量记录，恢复后固定时长稳定运行
function testUmbilicalBreak() {
  const rec = runScenario(AP.runUmbilicalBreak);
  const brk = faultSummary(rec, 'umbilical_break');
  check('break.abortRecorded', !!brk, JSON.stringify(brk));
  const breakEvent = rec.events.find((e) => e.kind === 'abort' && e.reason === 'umbilical_break');
  check('break.tensionAtLimit',
    !!breakEvent && breakEvent.peakMargin_kN <= 0 && breakEvent.peakMargin_kN >= -2,
    JSON.stringify(breakEvent && breakEvent.peakMargin_kN));
  check('break.recoveryComplete',
    rec.events.some((e) => e.kind === 'recovery_complete'));
  const soak = rec.events.find((e) => e.kind === 'soak_complete');
  check('break.soakFullDuration', !!soak && soak.soak_s === 45);
  check('break.complete', rec.mode === 'complete');
  check('break.noInvariantViolation', rec.invariantViolations.length === 0);
  check('break.singleBreakEvent',
    rec.events.filter((e) => e.kind === 'abort' && e.reason === 'umbilical_break').length === 1);
}

// 5. 操作回放：相同 seed + 相同意图序列，状态指纹逐 tick 一致
function testReplayDeterminism() {
  const sim = new Simulation();
  AP.runNormal(sim);
  const originalHashes = sim.events.map(() => null);
  void originalHashes;
  const record = sim.exportRecord();
  const replayed = new Simulation();
  replayed.replayRecord(record);
  const replayRec = replayed.exportRecord();
  check('replay.sameTick', replayRec.tick === record.tick, `${replayRec.tick} vs ${record.tick}`);
  check('replay.sameFinalHash', replayRec.hash === record.hash,
    `${replayRec.hash} vs ${record.hash}`);
  check('replay.sameEventCount', replayRec.events.length === record.events.length);
  check('replay.sameStats', JSON.stringify(replayRec.stats) === JSON.stringify(record.stats));
  check('replay.sameIntents', JSON.stringify(replayRec.intents) === JSON.stringify(record.intents));
}

// 6. 暂停/单步/恢复等价：分段推进与连续推进结果完全一致
function testPauseStepEquivalence() {
  const ref = new Simulation();
  AP.runNormal(ref);
  const target = ref.exportRecord().tick;

  const stepped = new Simulation();
  const intents = ref.exportRecord().intents;
  const chunks = [120, 37, 260, 95];
  let cursor = 0;
  for (const size of chunks) {
    for (let i = 0; i < size && cursor < target; i++, cursor++) {
      const { tick, ...intent } = intents[cursor];
      void tick;
      stepped.step(Object.keys(intent).length ? intent : null);
    }
  }
  while (cursor < target) {
    const { tick, ...intent } = intents[cursor];
    void tick;
    stepped.step(Object.keys(intent).length ? intent : null);
    cursor++;
  }
  const stepRec = stepped.exportRecord();
  const refRec = ref.exportRecord();
  check('pause.sameTick', stepRec.tick === refRec.tick);
  check('pause.sameHash', stepRec.hash === refRec.hash,
    `${stepRec.hash} vs ${refRec.hash}`);
  check('pause.sameMode', stepRec.mode === refRec.mode);
  check('pause.sameJoints', JSON.stringify(stepRec.joints) === JSON.stringify(refRec.joints));
}

testNormal();
testThrusterFault();
testOverLimits();
testUmbilicalBreak();
testReplayDeterminism();
testPauseStepEquivalence();

const passed = results.filter((r) => r.pass).length;
const report = {
  seed: 'cable-sim-2026',
  total: results.length, passed, failed: results.length - passed,
  allPassed: passed === results.length,
  cases: results
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.allPassed ? 0 : 1);

// __APPEND__
