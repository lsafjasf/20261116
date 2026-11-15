import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTimeline, recordFrame, replayFrames, findOrderConflicts } from '../js/timeline.js';
import { createInitialState, step, emptyInput, evaluateShot } from '../js/sim.js';
import { planSuccess, planFailure, scriptInput } from '../js/bot.js';
import { runLength, allTargetPositions } from '../js/scene.js';
import { saveSession, loadSession, memoryStorage, clearSession } from '../js/storage.js';
import { DURABILITY_BAD_SHOT, DURABILITY_GOOD_SHOT, FILM_START } from '../js/constants.js';

function recordPlan(plan) {
  const timeline = createTimeline();
  for (let tick = 1; tick <= runLength(); tick += 1) {
    recordFrame(timeline, scriptInput(timeline.state, tick, plan));
  }
  return timeline;
}

test('success script saves three distinct targets with spare film', () => {
  const timeline = recordPlan(planSuccess());
  const { state } = timeline;
  assert.equal(state.result, 'success');
  assert.equal(state.photos.length, 3);
  assert.deepEqual(
    state.photos.map((photo) => photo.target).sort(),
    ['bird', 'cyclist', 'lantern'],
  );
  assert.ok(state.film >= 1, 'at least one spare roll must remain');
  assert.equal(state.film, FILM_START - state.shots.length);
});

test('one shutter press is rejected for out-of-focus and nothing else', () => {
  const timeline = recordPlan(planSuccess());
  const defocused = timeline.state.shots.find((shot) => shot.tick === 310);
  assert.ok(defocused, 'the planned defocus shot exists');
  assert.equal(defocused.ok, false);
  assert.deepEqual(defocused.reasons, ['out-of-focus']);
  assert.ok(defocused.metrics.focusError > 0.18);
});

test('failed script burns every roll without completing the mission', () => {
  const timeline = recordPlan(planFailure());
  const { state } = timeline;
  assert.equal(state.result, 'failed');
  assert.equal(state.film, 0);
  assert.equal(state.photos.length, 0);
  assert.equal(state.shots.length, FILM_START);
  assert.ok(state.shots.every((shot) => !shot.ok));
});

test('durability wear differs between accepted and rejected shots', () => {
  const success = recordPlan(planSuccess());
  const accepted = success.state.photos.length;
  const rejected = success.state.shots.length - accepted;
  const expected = 100 - accepted * DURABILITY_GOOD_SHOT - rejected * DURABILITY_BAD_SHOT;
  assert.equal(success.state.durability, expected);

  const failed = recordPlan(planFailure());
  assert.equal(failed.state.durability, 100 - FILM_START * DURABILITY_BAD_SHOT);
});

test('replay at 1x, 2x and 4x reaches the identical final state', () => {
  const timeline = recordPlan(planSuccess());
  for (const speed of [1, 2, 4]) {
    let state = timeline.initial;
    let index = 0;
    const batch = speed;
    while (index < timeline.frames.length) {
      const slice = timeline.frames.slice(index, index + batch);
      for (const frame of slice) {
        state = step(state, frame, 'lr').state;
      }
      index += batch;
    }
    assert.equal(state.hash, timeline.state.hash, `speed ${speed}x changed the result`);
  }
});

test('pause and single-step replay never alter the final hash', () => {
  const timeline = recordPlan(planSuccess());
  let state = timeline.initial;
  let index = 0;
  while (index < timeline.frames.length) {
    state = step(state, timeline.frames[index], 'lr').state;
    index += 1;
  }
  assert.equal(replayFrames(timeline, 'lr').state.hash, timeline.state.hash);
  assert.equal(state.hash, timeline.state.hash);
});

test('replaying every tick reproduces every recorded snapshot hash', () => {
  const timeline = recordPlan(planSuccess());
  const { conflicts } = replayFrames(timeline, 'lr');
  assert.equal(conflicts.length, 0);
});

test('swapped player order reports the exact tick and object positions', () => {
  const timeline = createTimeline();
  for (let tick = 1; tick <= 8; tick += 1) {
    const input = emptyInput();
    input.left.pan = 0.9;
    input.left.tilt = 0.3;
    if (tick === 5) input.right.shutter = true;
    recordFrame(timeline, input);
  }
  const divergences = findOrderConflicts(timeline, 'lr');
  assert.ok(divergences.length >= 1);
  const first = divergences[0];
  assert.equal(first.tick, 5);
  assert.equal(first.targetPositions.length, 3);
  assert.notEqual(first.stateA.hash, first.stateB.hash);
  const expected = allTargetPositions(5).map((pos) => pos.id).sort();
  assert.deepEqual(first.targetPositions.map((pos) => pos.id).sort(), expected);
});

test('reload restores gauges, durability and mission progress', () => {
  const storage = memoryStorage();
  const timeline = recordPlan(planSuccess());
  saveSession({ timeline, mode: 'demo', order: 'lr', label: 'success' }, storage);
  const restored = loadSession(storage);
  assert.equal(restored.state.film, timeline.state.film);
  assert.equal(restored.state.durability, timeline.state.durability);
  assert.equal(restored.state.photos.length, 3);
  assert.equal(restored.state.result, 'success');
  assert.equal(restored.frames.length, timeline.frames.length);
  assert.deepEqual(restored.state.shots, timeline.state.shots);

  const replay = replayFrames(
    { initial: restored.initial, frames: restored.frames },
    'lr',
  );
  assert.equal(replay.state.hash, timeline.state.hash);
});

test('failed-run reload keeps the failed verdict and zero film', () => {
  const storage = memoryStorage();
  const timeline = recordPlan(planFailure());
  saveSession({ timeline, mode: 'demo', order: 'lr', label: 'failure' }, storage);
  const restored = loadSession(storage);
  assert.equal(restored.state.result, 'failed');
  assert.equal(restored.state.film, 0);
  assert.equal(restored.state.photos.length, 0);
  clearSession(storage);
  assert.equal(loadSession(storage), null);
});

test('a shot with no target inside the frame reports no-target', () => {
  const state = createInitialState();
  state.yaw = 1.2;
  const verdict = evaluateShot(state, 1);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.includes('no-target'));
});

test('every timeline frame binds both inputs, snapshot hash and verdict', () => {
  const timeline = recordPlan(planSuccess());
  for (const frame of timeline.frames) {
    assert.ok(frame.left && frame.right);
    assert.match(frame.snapshotHash, /^[0-9a-f]{8}$/);
    assert.ok(frame.verdict === null || typeof frame.verdict.ok === 'boolean');
  }
});

test('manual two-player input records and survives a storage round trip', () => {
  const storage = memoryStorage();
  const timeline = createTimeline();
  for (let tick = 1; tick <= 45; tick += 1) {
    const input = emptyInput();
    input.left.pan = tick < 20 ? 0.7 : 0;   // left player turns the gimbal
    input.right.focusDir = tick < 25 ? 1 : 0; // right player racks focus
    if (tick === 30) input.right.shutter = true;
    recordFrame(timeline, input);
  }
  assert.equal(timeline.frames.length, 45);
  assert.equal(timeline.state.shots.length, 1);
  assert.equal(timeline.state.film, FILM_START - 1);
  saveSession({ timeline, mode: 'live', order: 'lr', label: 'manual' }, storage);
  const restored = loadSession(storage);
  const replay = replayFrames({ initial: restored.initial, frames: restored.frames }, 'lr');
  assert.equal(replay.state.hash, timeline.state.hash);
  assert.equal(restored.state.durability, timeline.state.durability);
});
