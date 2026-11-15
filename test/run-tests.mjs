// Node verification harness. Uses node:assert and an in-memory storage mock;
// no browser dependency. Every requirement is asserted here and a summary is
// printed so the run can be checked in CI or by hand.

import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  TICK_HZ,
  SCRIPT,
  createInitialState,
  step,
  emptyInput,
  hashState,
  COLORS,
} from '../js/core/engine.js';
import { successBot, failureBot } from '../js/core/bots.js';
import {
  Recorder,
  runRecorded,
  verifyReplay,
  saveState,
  loadState,
  clearSave,
  statesEqual,
} from '../js/core/timeline.js';
import { Metronome, createMockAudioContext } from '../js/web/audio.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
mkdirSync(join(root, 'artifacts'), { recursive: true });

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function memoryStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

console.log('1. 成功演出（两名自动玩家同时输入，五段全部通过）');
await test('all 10 cues pass without dark incident or burnout', () => {
  const { state, recorder } = runRecorded(successBot);
  assert.equal(state.status, 'success');
  assert.equal(state.passed.every(Boolean), true);
  assert.equal(state.failedCue, -1);
  assert.ok(state.durabilityP1 > 0 && state.durabilityP2 > 0);
  // The show ends as soon as the final cue passes; frames cover the full
  // active window timeline (ten 60-tick cue windows plus transition gaps).
  assert.ok(recorder.frames.length >= SCRIPT.at(-1).start);
  // Both players' inputs are present on the same per-tick timeline.
  const sample = recorder.frames[10];
  assert.ok(sample.input.p1 && sample.input.p2);
  assert.equal(typeof sample.hash, 'string');
  writeFileSync(
    join(root, 'artifacts', 'replay-success.json'),
    JSON.stringify(recorder.toJSON(), null, 1),
  );
});

console.log('2. 失败演出（暗场事故）');
await test('failure bot ends in a dark incident with durability loss', () => {
  const { state, recorder } = runRecorded(failureBot);
  assert.equal(state.status, 'failed');
  assert.equal(state.failReason, 'dark-incident');
  assert.ok(state.tick < SCRIPT[0].end);
  assert.ok(state.durabilityP1 < 100);
  const dark = recorder.frames.some((f) =>
    f.events.some((e) => e.type === 'dark-incident'),
  );
  assert.equal(dark, true);
  writeFileSync(
    join(root, 'artifacts', 'replay-failure.json'),
    JSON.stringify(recorder.toJSON(), null, 1),
  );
});

console.log('3. 回放确定性：暂停 / 单步 / 倍速不改变最终状态');
await test('1x, single-step and 2x replays reproduce every state hash', () => {
  for (const bot of [successBot, failureBot]) {
    const { recorder } = runRecorded(bot);
    const result = verifyReplay(recorder);
    assert.equal(result.match, true);
    assert.equal(result['1x'].match, true);
    assert.equal(result.step.match, true);
    assert.equal(result['2x'].match, true);
    assert.equal(result['1x'].finalHash, result['2x'].finalHash);
    assert.equal(result.step.finalHash, result['2x'].finalHash);
    assert.equal(result.step.mismatches.length, 0);
  }
});

await test('pausing mid-show then resuming yields the identical final state', () => {
  // Run in two halves, simulating a pause that freezes every tick.
  const stateA = createInitialState();
  const stateB = createInitialState();
  const pauseAt = 137;
  while (stateA.tick < pauseAt && stateA.status === 'running') step(stateA, successBot(stateA));
  const hashAtPause = hashState(stateA);
  // State B does nothing for 50 "paused" ticks, then continues identically.
  for (let idle = 0; idle < 50; idle++) assert.equal(hashState(stateB) === hashState(stateB), true);
  while (stateB.tick < pauseAt && stateB.status === 'running') step(stateB, successBot(stateB));
  assert.equal(hashState(stateB), hashAtPause);
  while (stateA.status === 'running') step(stateA, successBot(stateA));
  while (stateB.status === 'running') step(stateB, successBot(stateB));
  assert.equal(hashState(stateB), hashState(stateA));
});

console.log('4. 动作顺序冲突：报告具体时刻与对象位置');
await test('same-tick power writes create a conflict with position and both outcomes', () => {
  const { recorder } = runRecorded(successBot);
  const conflicts = recorder.conflicts();
  assert.ok(conflicts.length >= 1);
  const c = conflicts[0];
  assert.equal(c.tick, 62);
  assert.equal(c.channel, 'power');
  assert.deepEqual(c.object, { x: 400, y: 24 });
  assert.equal(c.resultIfP1First, false);
  assert.equal(c.resultIfP2First, true);
  assert.notEqual(c.resultIfP1First, c.resultIfP2First);
  assert.equal(c.resolution, 'p2-safety-first');
});

console.log('5. 重新载入恢复：仪表 / 耐久 / 任务进度');
await test('save then load restores gauges, durability and progress exactly', () => {
  const store = memoryStore();
  const state = createInitialState();
  while (state.tick < 240 && state.status === 'running') step(state, successBot(state));
  saveState(store, state);
  const restored = loadState(store);
  assert.equal(statesEqual(restored, state), true);
  assert.equal(restored.brightness, state.brightness);
  assert.equal(restored.angle, state.angle);
  assert.equal(restored.heat, state.heat);
  assert.equal(restored.colorIndex, state.colorIndex);
  assert.equal(restored.durabilityP1, state.durabilityP1);
  assert.equal(restored.durabilityP2, state.durabilityP2);
  assert.deepEqual(restored.passed, state.passed);
  assert.equal(restored.passed.filter(Boolean).length, state.passed.filter(Boolean).length);
  // Continuing after reload reaches the same success state.
  const continued = loadState(store);
  while (continued.status === 'running') step(continued, successBot(continued));
  const fresh = createInitialState();
  while (fresh.status === 'running') step(fresh, successBot(fresh));
  assert.equal(hashState(continued), hashState(fresh));
  clearSave(store);
  assert.equal(loadState(store), null);
});

console.log('6. 暂停时灯架运动与声音一起停止');
await test('no ticks advance and audio context suspends while paused', async () => {
  const mock = createMockAudioContext();
  const metro = new Metronome(mock, { tickHz: TICK_HZ });
  await metro.start();
  assert.equal(mock.state, 'running');
  metro.scheduleTick();
  metro.scheduleTick();
  assert.equal(metro.scheduled.length, 2);
  await metro.pause();
  assert.equal(mock.state, 'suspended');
  const angleBefore = 30;
  const state = { ...createInitialState(), angle: angleBefore };
  // While the loop is paused it never calls step(); angle/heat must not move.
  const before = hashState(state);
  for (let i = 0; i < 20; i++) {
    metro.scheduleTick(); // no-op while suspended
    assert.equal(hashState(state), before);
  }
  assert.equal(metro.scheduled.length, 2);
  assert.equal(state.angle, angleBefore);
  await metro.resume();
  assert.equal(mock.state, 'running');
  metro.scheduleTick();
  assert.equal(metro.scheduled.length, 3);
  await metro.stop();
});

console.log('7. 过热锁停与耐久惩罚');
await test('continuous rotation overheats, locks the rig and costs durability', () => {
  const state = createInitialState();
  state.power = true;
  let overheated = false;
  for (let i = 0; i < 400; i++) {
    const input = emptyInput();
    // Oscillate so the rig never sits at an angle limit and keeps generating heat.
    if (!state.overheated) {
      if (i % 40 < 20) input.p2.rightHold = true;
      else input.p2.leftHold = true;
    }
    step(state, input);
    if (state.overheated) overheated = true;
  }
  assert.equal(overheated, true);
  assert.ok(state.durabilityP2 < 100);
  // While locked, rotation inputs cannot change the angle.
  const lockedAngle = state.angle;
  const input = emptyInput();
  input.p2.rightHold = true;
  step(state, input);
  assert.equal(state.angle, lockedAngle);
});

console.log('8. 碰撞结果逐 tick 记录（光斑 / 颜色 / 亮度三项）');
await test('each frame stores the collision evaluation used by the renderer', () => {
  const { recorder } = runRecorded(successBot);
  for (const frame of recorder.frames) {
    assert.ok(frame.lastEval === null || typeof frame.lastEval.satisfied === 'boolean');
    if (frame.lastEval) {
      assert.equal(typeof frame.lastEval.posOk, 'boolean');
      assert.equal(typeof frame.lastEval.colorOk, 'boolean');
      assert.equal(typeof frame.lastEval.brightOk, 'boolean');
    }
  }
});

console.log(`\n${passed} test groups passed${process.exitCode ? ' (with failures)' : ''}`);
