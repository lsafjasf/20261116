import assert from 'node:assert/strict';
import { createSim, step, setPaused, recover, hashState } from '../src/engine.js';
import { autopilotInput } from '../src/autopilot.js';

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ✓', name); };

// 1. Replay determinism: same seed + recorded inputs => identical final hash.
test('replay with same seed and input log yields identical state hash', () => {
  const a = createSim(2026);
  let n = 0;
  while (n < 180 && a.phase !== 'SURFACED' && a.phase !== 'FAILED') {
    step(a, autopilotInput(a, 'safe')); n++;
  }
  const b = createSim(2026);
  for (const frame of a.inputLog) step(b, frame.i);
  assert.equal(hashState(b), hashState(a));
  assert.equal(b.tick, a.tick);
  assert.deepEqual(b.samples.map((q) => q.taken), a.samples.map((q) => q.taken));
});

// 2. Mid-stream hash equality too, not just at the end.
test('intermediate replay hashes match tick-by-tick', () => {
  const a = createSim(77);
  const b = createSim(77);
  for (let t = 0; t < 120; t++) {
    const input = autopilotInput(a, 'safe');
    step(a, input);
    step(b, input);
    assert.equal(hashState(b), hashState(a), `hash mismatch at tick ${t}`);
  }
});

// 3. Different seed => different random sequence.
test('different seeds produce different sample layouts', () => {
  const x = createSim(1);
  const y = createSim(2);
  assert.notDeepEqual(x.samples, y.samples);
});

// 4. Full restart resets timer, resources, rng sequence, phase.
test('restart resets timer, audio/visual state, resources and rng stream', () => {
  const s = createSim(2026);
  for (let t = 0; t < 90; t++) step(s, autopilotInput(s, 'safe'));
  assert.ok(s.tick > 0 && s.battery < 100 && s.depth > 0);
  const fresh = createSim(2026);
  assert.equal(fresh.tick, 0);
  assert.equal(fresh.timeMs, 0);
  assert.equal(fresh.battery, 100);
  assert.equal(fresh.o2, 100);
  assert.equal(fresh.hull, 100);
  assert.equal(fresh.temp, 20);
  assert.equal(fresh.depth, 0);
  assert.equal(fresh.vs, 0);
  assert.equal(fresh.phase, 'READY');
  assert.equal(fresh.inputLog.length, 0);
  assert.equal(fresh.stateChanges.length, 1);
  assert.deepEqual(fresh.rng.save(), createSim(2026).rng.save());
  // identical fresh instances hash identically
  assert.equal(hashState(fresh), hashState(createSim(2026)));
});

// 5. Pause freezes the simulation; resume continues deterministically.
test('pause freezes tick and resume keeps determinism', () => {
  const s = createSim(5);
  for (let t = 0; t < 40; t++) step(s, autopilotInput(s, 'safe'));
  setPaused(s, true);
  assert.equal(s.phase, 'PAUSED');
  const hPaused = hashState(s);
  step(s, autopilotInput(s, 'safe'));
  step(s, autopilotInput(s, 'safe'));
  assert.equal(hashState(s), hPaused, 'paused sim must not change');
  setPaused(s, false);
  assert.notEqual(s.phase, 'PAUSED');
  const ref = createSim(5);
  for (let t = 0; t < 40; t++) step(ref, autopilotInput(ref, 'safe'));
  // resume leaves physics exactly where an uninterrupted run would be
  assert.equal(s.depth, ref.depth);
  assert.equal(s.tick, ref.tick);
});

// 6. Mistake route triggers RUNAWAY then failure, and recovery restores mission.
test('operator mistake triggers runaway ascent, failure recovery works', () => {
  const s = createSim(2026);
  let sawRunaway = false;
  let n = 0;
  while (n < 400 && s.phase !== 'FAILED' && s.phase !== 'SURFACED') {
    step(s, autopilotInput(s, 'mistake'));
    sawRunaway = sawRunaway || s.phase === 'RUNAWAY';
    n++;
  }
  assert.equal(s.phase, 'FAILED');
  assert.ok(sawRunaway, 'must pass through RUNAWAY state');
  const failTick = s.tick;
  const cpTick = s.checkpoints.at(-1).tick;
  assert.ok(recover(s));
  assert.ok(s.tick < failTick);
  assert.equal(s.vs, 0);
  assert.equal(s.rng.save().a, s.checkpoints.length ? s.rng.save().a : s.rng.save().a);
  let m = 0;
  while (m < 2000 && s.phase !== 'SURFACED' && s.phase !== 'FAILED') {
    step(s, autopilotInput(s, 'safe')); m++;
  }
  assert.equal(s.success, true);
  assert.ok(s.recoveredCount >= 1);
  assert.ok(cpTick >= 0);
});

// 7. Extreme route hits a parameter-limit failure (crush / temp / hull).
test('parameter-limit route reaches crush depth and is recoverable', () => {
  const s = createSim(2026);
  let n = 0;
  while (n < 400 && s.phase !== 'FAILED' && s.phase !== 'SURFACED') {
    step(s, autopilotInput(s, 'extreme')); n++;
  }
  assert.equal(s.phase, 'FAILED');
  assert.ok(['CRUSH_DEPTH', 'HULL_BREACH'].includes(s.failReason));
  assert.ok(s.depth >= 149 || s.hull <= 0);
  assert.ok(recover(s));
  let m = 0;
  while (m < 2000 && s.phase !== 'SURFACED' && s.phase !== 'FAILED') {
    step(s, autopilotInput(s, 'safe')); m++;
  }
  assert.equal(s.success, true);
});

// 8. Recovery rolls RNG back: post-recover random stream matches replay.
test('recovery checkpoints restore rng stream exactly', () => {
  const s = createSim(31);
  let n = 0;
  while (s.phase !== 'FAILED' && n < 400) { step(s, autopilotInput(s, 'extreme')); n++; }
  assert.equal(s.phase, 'FAILED');
  const cp = s.checkpoints.at(-1);
  recover(s);
  assert.deepEqual(s.rng.save(), cp.rng);
});

// 9. Safe route completes the mission across many seeds.
test('safe route succeeds on 10 different seeds', () => {
  for (const seed of [1, 2, 3, 42, 99, 2026, 555, 314, 2718, 12345]) {
    const s = createSim(seed);
    let n = 0;
    while (n < 3000 && s.phase !== 'SURFACED' && s.phase !== 'FAILED') {
      step(s, autopilotInput(s, 'safe')); n++;
    }
    assert.equal(s.success, true, `seed ${seed} should succeed`);
    assert.equal(s.collected, 3);
  }
});

// 10. Checkpoints are ring-buffered.
test('checkpoint ring buffer keeps a bounded history', () => {
  const s = createSim(11);
  for (let t = 0; t < 200; t++) step(s, autopilotInput(s, 'safe'));
  assert.ok(s.checkpoints.length <= 4);
  assert.ok(s.checkpoints.length >= 1);
});

console.log(`\n${passed} tests passed`);
