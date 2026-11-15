import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, stepSimulation } from "../src/simulation.js";
import { createFailureDemo, createSuccessDemo } from "../src/demo.js";
import { createTimeline, recordFrame } from "../src/timeline.js";
import {
  STORAGE_KEY,
  loadFromStorage,
  parseSavePayload,
  saveToStorage
} from "../src/persistence.js";

function memoryStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    }
  };
}

test("reload restores both side instruments, durability and mission progress", () => {
  let state = createInitialState();
  const timeline = createTimeline(state);
  state.controls.left.throttle = 63;
  state.controls.left.fuelPump = 71;
  state.controls.right.hydraulic = 67;
  state.stage = "PATTERN";
  state.progress = 63.4;
  state.engine.rpm = 2142.7;
  state.engine.fuel = 61.8;
  state.engine.temperature = 103.6;
  state.engine.damage = 13.7;
  state.hydraulic.pressure = 58.2;
  state.hydraulic.gearPosition = 0.08;
  state.hydraulic.damage = 8.2;
  state.shared.hull = 91.2;
  state.shared.alerts = [{ level: "warn", text: "左发过热" }];
  state.mission.takeoff = true;
  state.mission.gearRetracted = true;
  state.mission.orbitSeconds = 4.6;
  recordFrame(timeline, state);

  const storage = memoryStorage();
  assert.equal(saveToStorage(storage, state, timeline), true);
  assert.ok(storage.getItem(STORAGE_KEY));

  const loaded = loadFromStorage(storage);
  assert.ok(loaded);
  assert.equal(loaded.state.controls.left.throttle, 63);
  assert.equal(loaded.state.controls.left.fuelPump, 71);
  assert.equal(loaded.state.controls.right.hydraulic, 67);
  assert.equal(loaded.state.engine.rpm, 2142.7);
  assert.equal(loaded.state.engine.fuel, 61.8);
  assert.equal(loaded.state.engine.temperature, 103.6);
  assert.equal(loaded.state.engine.damage, 13.7);
  assert.equal(loaded.state.hydraulic.pressure, 58.2);
  assert.equal(loaded.state.hydraulic.gearPosition, 0.08);
  assert.equal(loaded.state.hydraulic.damage, 8.2);
  assert.equal(loaded.state.shared.hull, 91.2);
  assert.equal(loaded.state.progress, 63.4);
  assert.equal(loaded.state.stage, "PATTERN");
  assert.equal(loaded.state.mission.orbitSeconds, 4.6);
  assert.equal(loaded.timeline.frames.at(-1).progress, 63.4);
  assert.equal(loaded.timeline.frames.at(-1).right.gearPosition, 0.08);
});

test("saved successful and failed results retain their final timeline state", () => {
  for (const [run, expected] of [
    [createSuccessDemo(), "SUCCESS"],
    [createFailureDemo(), "FAILED"]
  ]) {
    const storage = memoryStorage();
    saveToStorage(storage, run.finalState, run.timeline);
    const loaded = loadFromStorage(storage);
    assert.equal(loaded.state.stage, expected);
    assert.equal(loaded.timeline.frames.at(-1).stage, expected);
    assert.equal(loaded.timeline.frames.length, run.timeline.frames.length);
    assert.equal(loaded.state.shared.hull, run.finalState.shared.hull);
  }
});

test("save parser rejects corrupted or incompatible payloads", () => {
  assert.equal(parseSavePayload("{oops"), null);
  assert.equal(parseSavePayload(JSON.stringify({ version: 999 })), null);
  assert.equal(parseSavePayload(JSON.stringify({ version: 1, state: {}, timeline: "{}" })), null);
});

test("a live state can continue after a save/load boundary", () => {
  let state = createInitialState();
  state.controls.left.throttle = 75;
  state.controls.right.hydraulic = 70;
  for (let index = 0; index < 120; index += 1) {
    state = stepSimulation(state).state;
  }
  const timeline = createTimeline(state);
  const storage = memoryStorage();
  saveToStorage(storage, state, timeline);
  const restored = loadFromStorage(storage).state;
  const continued = stepSimulation(restored).state;
  assert.equal(continued.tick, state.tick + 1);
  assert.ok(continued.engine.rpm > 0);
  assert.ok(continued.hydraulic.pressure > 0);
});
