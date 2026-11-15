import test from "node:test";
import assert from "node:assert/strict";

import {
  FixedStepClock,
  DEFAULT_FIXED_DT,
  formatSimTime,
} from "../src/core/simulation-clock.js";
import { PhysicsWorld } from "../src/core/world.js";
import { scriptedInputAt } from "../src/core/scripted-input.js";

test("fixed-step clock caps catch-up and drops excess time", () => {
  const clock = new FixedStepClock({ maxSubSteps: 8 });
  let steps = 0;
  const result = clock.advance(1, {
    timeScale: 1,
    onStep: () => {
      steps += 1;
    },
  });

  assert.equal(steps, 8);
  assert.equal(result.steps, 8);
  assert.ok(result.droppedSteps > 0);
  assert.equal(clock.totalSteps, 8);
  assert.ok(clock.droppedSteps > 0);
  assert.ok(clock.alpha >= 0 && clock.alpha < 1);
});

test("paused clock cannot advance and resumes with a fresh accumulator", () => {
  const clock = new FixedStepClock();
  let steps = 0;
  clock.setPaused(true);
  const paused = clock.advance(2, {
    timeScale: 2,
    onStep: () => {
      steps += 1;
    },
  });
  assert.equal(paused.steps, 0);
  assert.equal(steps, 0);
  assert.equal(clock.alpha, 1);

  clock.setPaused(false);
  const resumed = clock.advance(DEFAULT_FIXED_DT * 2, {
    timeScale: 1,
    onStep: () => {
      steps += 1;
    },
  });
  assert.equal(resumed.steps, 2);
  assert.equal(steps, 2);
});

test("naive and spatial-hash broadphase return identical candidates", () => {
  const naive = new PhysicsWorld({ broadphase: "naive", cache: false });
  const grid = new PhysicsWorld({ broadphase: "grid", cache: true });
  const queryPoints = [
    [1200, 800],
    [980, 610],
    [1600, 410],
    [2200, 1500],
  ];

  for (const [x, y] of queryPoints) {
    const expected = naive.queryCandidates(x, y);
    const actual = grid.queryCandidates(x, y);
    assert.deepEqual(actual, expected, `candidate mismatch at ${x},${y}`);
  }
  assert.deepEqual(grid.queryCandidates(1200, 800), naive.queryCandidates(1200, 800));
  assert.ok(grid.getCacheHitRate() > 0);
});

test("optimization modes produce byte-identical public state", () => {
  const before = new PhysicsWorld({ broadphase: "naive", cache: false });
  const after = new PhysicsWorld({ broadphase: "grid", cache: true });
  for (let step = 0; step < 600; step += 1) {
    const beforeInput = scriptedInputAt(before.time + DEFAULT_FIXED_DT);
    const afterInput = scriptedInputAt(after.time + DEFAULT_FIXED_DT);
    before.step(DEFAULT_FIXED_DT, beforeInput);
    after.step(DEFAULT_FIXED_DT, afterInput);
  }
  assert.deepEqual(after.getPublicState(), before.getPublicState());
  assert.equal(after.metrics.collisionChecks, before.metrics.collisionChecks);
  assert.ok(after.metrics.distanceChecks < before.metrics.distanceChecks);
});

test("invalid physics and clock parameters fail fast", () => {
  assert.throws(() => new FixedStepClock({ fixedDt: 0 }), RangeError);
  assert.throws(() => new FixedStepClock({ maxSubSteps: 0 }), RangeError);
  assert.throws(() => new PhysicsWorld({ broadphase: "unknown" }), RangeError);
  assert.throws(() => new PhysicsWorld().step(0), RangeError);
});

test("simulation time formatting is stable", () => {
  assert.equal(formatSimTime(0), "00:00.000");
  assert.equal(formatSimTime(62.345), "01:02.345");
});
