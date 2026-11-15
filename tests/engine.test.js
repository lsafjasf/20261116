import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AssemblyEngine,
  FIXED_MS,
  ACTION_WINDOW_MS
} from '../src/engine.js';

function applyAction(engine, action, events) {
  if (action === 'left-press' && !engine.state.leftHeld) {
    const tick = engine.state.tick;
    engine.press('left');
    events.push({ tick, kind: 'press', side: 'left' });
  }
  if (action === 'left-release' && engine.state.leftHeld) {
    const tick = engine.state.tick;
    engine.release('left');
    events.push({ tick, kind: 'release', side: 'left' });
  }
  if (action === 'right-press' && !engine.state.rightHeld) {
    const tick = engine.state.tick;
    engine.press('right');
    events.push({ tick, kind: 'press', side: 'right' });
  }
  if (action === 'right-release' && engine.state.rightHeld) {
    const tick = engine.state.tick;
    engine.release('right');
    events.push({ tick, kind: 'release', side: 'right' });
  }
}

function successPolicy(engine) {
  const state = engine.state;
  const elapsed = state.tick - state.cycleStartTick;
  const actions = [];
  if (elapsed === 5) actions.push('left-press');
  if (elapsed === 12) actions.push('right-press');
  if (elapsed >= 12) {
    if (!state.rightHeld && state.pressure < 56) actions.push('right-press');
    if (state.rightHeld && state.pressure > 73) actions.push('right-release');
  }
  return actions;
}

function runUntilSettled(policy, maxTicks = 3000) {
  const engine = new AssemblyEngine({ seed: 0x7a11ce });
  const events = [];
  for (let index = 0; index < maxTicks; index += 1) {
    if (engine.state.phase === 'active') {
      for (const action of policy(engine, events)) {
        applyAction(engine, action, events);
      }
    }
    engine.tick();
    if (engine.state.phase === 'complete' || engine.state.phase === 'failed') break;
  }
  return {
    engine,
    events,
    endTick: engine.state.tick,
    expected: {
      phase: engine.state.phase,
      completed: engine.state.completed,
      inventory: engine.state.inventory,
      durability: engine.state.durability,
      fingerprint: engine.fingerprint()
    }
  };
}

function replay(record, advance, onPause) {
  const engine = new AssemblyEngine({ seed: 0x7a11ce });
  let eventIndex = 0;
  let paused = false;
  const applyEvents = () => {
    while (
      eventIndex < record.events.length &&
      record.events[eventIndex].tick <= engine.state.tick
    ) {
      const event = record.events[eventIndex];
      if (engine.state.phase === 'active') {
        if (event.kind === 'press') engine.press(event.side);
        if (event.kind === 'release') engine.release(event.side);
      }
      eventIndex += 1;
    }
  };
  while (engine.state.tick < record.endTick) {
    if (paused) {
      paused = false;
      continue;
    }
    for (let step = 0; step < advance && engine.state.tick < record.endTick; step += 1) {
      applyEvents();
      engine.tick();
    }
    if (onPause?.(engine.state.tick)) paused = true;
  }
  return engine;
}

test('three synchronized assemblies complete with one spare kit', () => {
  const run = runUntilSettled(successPolicy);
  assert.equal(run.expected.phase, 'complete');
  assert.equal(run.expected.completed, 3);
  assert.equal(run.expected.inventory, 1);
  assert.equal(run.expected.durability, 94);
  assert.equal(run.engine.state.timeline.collisions.length, 0);
  assert.equal(
    run.engine.state.timeline.results.filter((item) => item.kind === 'assembly-clear').length,
    3
  );
  assert.ok(run.events.length >= 9);
});

test('holding both sides too long crushes the gasket and records collision coordinates', () => {
  const run = runUntilSettled((engine) => {
    const elapsed = engine.state.tick - engine.state.cycleStartTick;
    if (elapsed === 5) return ['left-press'];
    if (elapsed === 12) return ['right-press'];
    return [];
  });
  assert.equal(run.expected.phase, 'failed');
  assert.equal(run.expected.completed, 0);
  assert.equal(run.expected.inventory, 3);
  assert.equal(run.expected.durability, 65);
  const collision = run.engine.state.timeline.collisions[0];
  assert.equal(collision.type, 'crush');
  assert.equal(collision.object, '密封垫圈');
  assert.equal(collision.tick, 129);
  assert.ok(collision.position.x > 0);
  assert.ok(collision.position.y > 0);
});

test('one player holding only the left side cannot complete the mission', () => {
  const run = runUntilSettled((engine) => {
    const elapsed = engine.state.tick - engine.state.cycleStartTick;
    return elapsed === 5 ? ['left-press'] : [];
  });
  assert.equal(run.expected.phase, 'failed');
  assert.equal(run.expected.completed, 0);
  assert.equal(run.engine.state.timeline.collisions[0].type, 'timeout');
  assert.equal(run.engine.state.tick, ACTION_WINDOW_MS / FIXED_MS);
});

test('one player holding only the right side collides before completion', () => {
  const run = runUntilSettled((engine) => {
    const elapsed = engine.state.tick - engine.state.cycleStartTick;
    return elapsed === 5 ? ['right-press'] : [];
  });
  assert.equal(run.expected.phase, 'failed');
  assert.equal(run.expected.completed, 0);
  assert.equal(run.engine.state.timeline.collisions[0].type, 'lateral');
});

test('right-side-first input records conflict time and object position', () => {
  const run = runUntilSettled((engine) => {
    const state = engine.state;
    const elapsed = state.tick - state.cycleStartTick;
    const actions = [];
    if (state.completed === 0 && elapsed === 3) actions.push('right-press');
    if (state.completed === 0 && elapsed === 30) actions.push('left-press');
    if (state.completed > 0 && elapsed === 5) actions.push('left-press');
    if (elapsed >= 30) {
      if (!state.rightHeld && state.pressure < 56) actions.push('right-press');
      if (state.rightHeld && state.pressure > 73) actions.push('right-release');
    }
    return actions;
  });
  const conflict = run.engine.state.timeline.conflicts[0];
  assert.equal(run.expected.phase, 'complete');
  assert.equal(conflict.tick, 15);
  assert.equal(conflict.object, '上部模块');
  assert.ok(conflict.position.x > 0);
  assert.ok(conflict.position.y > 0);
  assert.match(conflict.message, /右侧先于左侧/);
});

test('pause, single-step and playback speed do not alter replayed final state', () => {
  const run = runUntilSettled(successPolicy);
  const normal = replay(run, 1);
  const stepped = replay(run, 1, (tick) => tick > 100 && tick < 106);
  const fast = replay(run, 4);
  for (const engine of [normal, stepped, fast]) {
    assert.equal(engine.state.phase, run.expected.phase);
    assert.equal(engine.state.completed, run.expected.completed);
    assert.equal(engine.state.inventory, run.expected.inventory);
    assert.equal(engine.state.durability, run.expected.durability);
    assert.equal(engine.fingerprint(), run.expected.fingerprint);
  }
});

test('snapshot restore preserves both meters, durability, progress and timeline', () => {
  const engine = new AssemblyEngine();
  for (let tick = 0; tick < 220; tick += 1) {
    const elapsed = engine.state.tick - engine.state.cycleStartTick;
    if (engine.state.phase === 'active') {
      if (elapsed === 5) engine.press('left');
      if (elapsed === 12) engine.press('right');
      if (engine.state.rightHeld && engine.state.pressure > 70) engine.release('right');
    }
    engine.tick();
  }
  const snapshot = engine.serialize();
  const restored = AssemblyEngine.fromSnapshot(snapshot, { releaseInputs: false });
  assert.equal(restored.state.completed, engine.state.completed);
  assert.equal(restored.state.inventory, engine.state.inventory);
  assert.equal(restored.state.durability, engine.state.durability);
  assert.equal(restored.state.offset, engine.state.offset);
  assert.equal(restored.state.pressure, engine.state.pressure);
  assert.equal(restored.state.timeline.events.length, engine.state.timeline.events.length);
  assert.equal(restored.fingerprint(), engine.fingerprint());
});
