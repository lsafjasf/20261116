import test from "node:test";
import assert from "node:assert/strict";
import {
  TICK_SECONDS,
  createInitialState,
  getSystemsSafe,
  stepSimulation
} from "../src/simulation.js";
import { createFailureDemo, createSuccessDemo } from "../src/demo.js";
import {
  ReplayController,
  inspectOrderConflict
} from "../src/timeline.js";

test("successful mission completes takeoff, pattern and landing on one timeline", () => {
  const run = createSuccessDemo();
  const final = run.timeline.frames.at(-1);

  assert.equal(run.success, true);
  assert.equal(run.finalState.stage, "SUCCESS");
  assert.equal(run.finalState.progress, 100);
  assert.equal(final.stage, "SUCCESS");
  assert.equal(final.mission.takeoff, true);
  assert.equal(final.mission.gearRetracted, true);
  assert.equal(final.mission.landed, true);
  assert.ok(final.t > 60);
  assert.ok(final.left.damage < 75);
  assert.ok(final.right.damage < 75);
  assert.ok(final.shared.hull > 35);
  assert.equal(getSystemsSafe(run.finalState), true);

  const inputSides = new Set(run.timeline.inputs.map((event) => event.source));
  assert.deepEqual([...inputSides].sort(), ["left", "right"]);
  assert.ok(run.timeline.events.some((event) => event.type === "stage"));
  assert.ok(run.timeline.frames.every((frame) => frame.left && frame.right && frame.shared));
});

test("success timeline includes an exact order-sensitive conflict with object coordinates", () => {
  const run = createSuccessDemo();
  assert.ok(run.timeline.conflicts.length >= 1);
  const conflict = run.timeline.conflicts[0];
  assert.ok(conflict.t > 0);
  assert.ok(conflict.tick > 0);
  assert.ok(conflict.objects.length >= 2);
  assert.ok(conflict.objects.every((object) => Number.isFinite(object.x) && Number.isFinite(object.y)));
  assert.ok(Number.isFinite(conflict.position.x));
  assert.ok(Number.isFinite(conflict.position.altitude));
  assert.equal(conflict.actualOrder, "left-first");
  assert.equal(conflict.alternateOrder, "right-first");
  assert.match(conflict.summary, /顺序/);
});

test("replay pause, step, seek and speed changes never alter the final frame", () => {
  const run = createSuccessDemo();
  const controller = new ReplayController(run.timeline.frames);
  const finalBefore = structuredClone(controller.final());
  const hashBefore = controller.finalHash;

  controller.pause();
  controller.step(1);
  controller.step(5);
  controller.step(-2);
  controller.setSpeed(0.5);
  controller.play();
  controller.advance(0.4);
  controller.setSpeed(4);
  controller.advance(2.4);
  controller.seek(0.63);
  controller.pause();
  controller.step(1);

  assert.deepEqual(controller.final(), finalBefore);
  assert.equal(controller.finalHash, hashBefore);
  assert.equal(controller.verifyFinalUnchanged(), true);
});

test("failure run retracts gear on the ground and records a collision", () => {
  const run = createFailureDemo();
  const collision = run.timeline.collisions[0];

  assert.equal(run.success, false);
  assert.equal(run.finalState.stage, "FAILED");
  assert.match(run.finalState.mission.failureReason, /起落架/);
  assert.equal(collision.reason, "GEAR_RETRACTED_ON_GROUND");
  assert.equal(collision.object, "left-main-gear");
  assert.ok(collision.x > 0);
  assert.ok(collision.y > 0);
  assert.ok(collision.damage > 0);
  assert.equal(run.timeline.frames.at(-1).stage, "FAILED");
  assert.equal(run.timeline.frames.at(-1).shared.collisionCount, 1);
});

test("left and right side updates can occur in the same simulation tick", () => {
  let state = createInitialState();
  state.controls.left.throttle = 72;
  state.controls.right.hydraulic = 74;

  for (let index = 0; index < 30; index += 1) {
    state = stepSimulation(state, TICK_SECONDS, { order: "left-first" }).state;
  }

  assert.equal(state.controls.left.throttle, 72);
  assert.equal(state.controls.right.hydraulic, 74);
  assert.ok(state.engine.rpm > 0);
  assert.ok(state.hydraulic.pressure > 0);
  assert.ok(state.speed > 0);
});

test("reversing simultaneous input order changes the cross-coupled result", () => {
  let state = createInitialState();
  state.controls.left.throttle = 78;
  state.controls.left.fuelPump = 68;
  state.controls.right.hydraulic = 68;
  for (let index = 0; index < 41; index += 1) {
    state = stepSimulation(state, TICK_SECONDS).state;
  }

  state.controls.left.throttle = 72;
  state.controls.right.hydraulic = 56;
  const conflict = inspectOrderConflict(state, ["left", "right"]);
  const leftFirst = stepSimulation(state, TICK_SECONDS, { order: "left-first" }).state;
  const rightFirst = stepSimulation(state, TICK_SECONDS, { order: "right-first" }).state;

  assert.ok(conflict);
  assert.notEqual(leftFirst.engine.rpm, rightFirst.engine.rpm);
  assert.equal(conflict.position.x, state.x);
  assert.equal(conflict.objects.length, 2);
  assert.match(conflict.objects[0].label, /发动机/);
  assert.match(conflict.objects[1].label, /液压/);
});

test("overloading one cockpit slows the opposite system", () => {
  const run = (leftThrottle, leftFuelPump, rightHydraulic) => {
    let state = createInitialState();
    state.controls.left.throttle = leftThrottle;
    state.controls.left.fuelPump = leftFuelPump;
    state.controls.right.hydraulic = rightHydraulic;
    for (let index = 0; index < 200; index += 1) {
      state = stepSimulation(state).state;
    }
    return state;
  };

  const normalForLeft = run(60, 55, 60);
  const leftOverloaded = run(100, 100, 60);
  assert.ok(leftOverloaded.shared.crossDrag > 0.1);
  assert.ok(leftOverloaded.hydraulic.pressure < normalForLeft.hydraulic.pressure);

  const normalForRight = run(60, 55, 60);
  const rightOverloaded = run(60, 55, 100);
  assert.ok(rightOverloaded.shared.crossDrag > 0.1);
  assert.ok(rightOverloaded.engine.rpm < normalForRight.engine.rpm);
});
