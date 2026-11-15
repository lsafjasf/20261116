import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, snapshotHash } from '../src/core/engine.js';
import { createRecorder, replayRecording } from '../src/core/recorder.js';
import { CONFIG, PHASE, FAULT } from '../src/core/config.js';

function runToEnd(engine, maxTicks = 20000) {
  let guard = 0;
  while (![PHASE.SUCCESS, PHASE.FAILED, PHASE.STOPPED].includes(engine.state.phase) && guard < maxTicks) {
    engine.step();
    guard += 1;
  }
  return engine.state.phase;
}

test('三种图案都能在安全速度下完成十厘米无缺陷布面', () => {
  for (const patternId of ['plain', 'twill', 'satin']) {
    const engine = createEngine({ seed: 42, patternId });
    const recorder = createRecorder(engine, 42, patternId);
    recorder.record(0, 'START');
    engine.start();
    const phase = runToEnd(engine);
    assert.equal(phase, PHASE.SUCCESS, `${patternId} 应成功`);
    assert.equal(engine.state.defects, 0, `${patternId} 无缺陷`);
    assert.ok(engine.state.clothCm >= CONFIG.targetLengthCm);
    assert.ok(engine.state.weft > 0);
    assert.equal(engine.state.fault, FAULT.NONE);
  }
});

test('梭速过慢会漏纬并自动停机，修复后可继续直到成功', () => {
  const engine = createEngine({ seed: 7 });
  const recorder = createRecorder(engine, 7, 'plain');
  engine.setSpeed(CONFIG.speedMin);
  recorder.record(0, 'SPEED', { value: CONFIG.speedMin });
  engine.start();
  recorder.record(0, 'START');

  const stoppedAt = runToEnd(engine);
  assert.equal(stoppedAt, PHASE.STOPPED);
  assert.equal(engine.state.fault, FAULT.MISS_PICK);
  assert.ok(engine.state.defects >= 1);

  engine.repair();
  recorder.record(engine.state.tick, 'REPAIR');
  assert.equal(engine.state.openDefects, 0);
  engine.setSpeed(CONFIG.speedStart);
  recorder.record(engine.state.tick, 'SPEED', { value: CONFIG.speedStart });
  engine.start();
  const phase = runToEnd(engine);
  assert.equal(phase, PHASE.SUCCESS);
});

test('极限高速会触发张力异常/断线并自动停机', () => {
  const faults = new Set();
  let hitSeed = null;
  for (let seed = 1; seed <= 40 && hitSeed === null; seed++) {
    const engine = createEngine({ seed });
    engine.setSpeed(CONFIG.speedMax);
    engine.start();
    runToEnd(engine);
    if (engine.state.phase === PHASE.STOPPED) {
      faults.add(engine.state.fault);
      if (engine.state.fault === FAULT.BREAK) hitSeed = seed;
    }
  }
  assert.ok(faults.has(FAULT.ANOMALY) || faults.has(FAULT.BREAK));
  assert.ok(hitSeed !== null, '至少一个 seed 触发断线');

  const engine = createEngine({ seed: hitSeed });
  engine.setSpeed(CONFIG.speedMax);
  engine.start();
  runToEnd(engine);
  assert.equal(engine.state.fault, FAULT.BREAK);
  engine.repair();
  assert.equal(engine.state.phase, PHASE.READY);
  assert.ok(engine.state.repaired === 1);
});

test('纬纱用尽会停机，换梭芯后恢复', () => {
  const engine = createEngine({ seed: 3 });
  engine.state.weft = 1;
  engine.start();
  runToEnd(engine);
  assert.equal(engine.state.fault, FAULT.NO_WEFT);
  const bobbinsBefore = engine.state.bobbins;
  engine.repair();
  assert.equal(engine.state.bobbins, bobbinsBefore - 1);
  assert.equal(engine.state.weft, CONFIG.bobbinWeft);
});

test('重新开始后计时、音画相关资源与随机序列全部复位', () => {
  const engine = createEngine({ seed: 99, patternId: 'twill' });
  engine.setSpeed(2.8);
  engine.start();
  runToEnd(engine);
  assert.notEqual(engine.state.tick, 0);
  assert.notEqual(engine.state.rngState, 99);

  engine.reset();
  const s = engine.state;
  assert.equal(s.tick, 0);
  assert.equal(s.runningTimeMs, 0);
  assert.equal(s.picks, 0);
  assert.equal(s.clothCm, 0);
  assert.equal(s.weft, CONFIG.initialWeft);
  assert.equal(s.bobbins, CONFIG.initialBobbins);
  assert.equal(s.defects, 0);
  assert.equal(s.rngState, 99);
  assert.equal(s.phase, PHASE.READY);
  assert.deepEqual(s.tensions, new Array(16).fill(CONFIG.tensionBase));
});

test('同 seed 与输入记录回放，最终状态哈希一致', () => {
  function drive(seed) {
    const engine = createEngine({ seed });
    const recorder = createRecorder(engine, seed, 'plain');
    recorder.record(0, 'SPEED', { value: CONFIG.speedMin });
    engine.setSpeed(CONFIG.speedMin);
    recorder.record(0, 'START');
    engine.start();
    runToEnd(engine);
    recorder.record(engine.state.tick, 'REPAIR');
    engine.repair();
    recorder.record(engine.state.tick, 'SPEED', { value: CONFIG.speedStart });
    engine.setSpeed(CONFIG.speedStart);
    recorder.record(engine.state.tick, 'START');
    engine.start();
    runToEnd(engine);
    return { text: recorder.exportJson(), hash: snapshotHash(engine).hash };
  }

  const first = drive(123);
  const second = drive(123);
  assert.equal(first.hash, second.hash);

  const replay = replayRecording(first.text);
  assert.equal(replay.snapshot.hash, first.hash);
});
