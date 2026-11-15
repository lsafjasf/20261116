import test from 'node:test';
import assert from 'node:assert/strict';

import * as C from '../src/config.js';
import { Simulation, hashObject } from '../src/simulation.js';
import { saveGame, loadGame, clearSave, MemoryStore } from '../src/storage.js';
import { runScenario, createGatePlayer, createPumpPlayer, SCENARIOS } from '../src/controllers.js';

globalThis.localStorage = new MemoryStore();

test('mid-sim save restores gauges, durability and progress after reload', () => {
  clearSave();
  const sim = new Simulation(C.DEFAULT_SEED);
  const [gateStyle, pumpStyle] = SCENARIOS.success;
  const p1 = createGatePlayer(gateStyle);
  const p2 = createPumpPlayer(pumpStyle);
  const ctx = { p1GateTick: -1 };
  const stopAt = Math.floor(C.TOTAL_TICKS * 0.35);
  while (sim.tick < stopAt && !sim.ended) {
    ctx.p1GateTick = -1;
    p1.act(sim, ctx);
    p2.act(sim, ctx);
    sim.step();
  }

  const before = sim.snapshot();
  const payload = saveGame(sim, 'success');

  // Simulate a full page reload: brand new process state, then load.
  const { sim: restored, payload: reloaded } = loadGame();
  assert.equal(hashObject(restored.snapshot()), payload.snapshotHash);
  assert.equal(restored.tick, before.tick);
  assert.equal(restored.pump.durability, before.pump.durability);
  assert.equal(restored.pump.heat, before.pump.heat);
  assert.ok(Math.abs(restored.channelLevel - before.channelLevel) < 1e-12);
  assert.ok(Math.abs(restored.upstreamLevel - before.upstreamLevel) < 1e-12);
  assert.equal(restored.pump.speed, before.pump.speed);
  assert.equal(restored.gate.position, before.gate.position);
  assert.equal(reloaded.progress.percent, payload.progress.percent);
  assert.ok(reloaded.progress.percent > 30 && reloaded.progress.percent < 40);

  // Continuing after restore reaches the same ending as an uninterrupted run.
  const reference = new Simulation(C.DEFAULT_SEED);
  runScenario('reference', gateStyle, pumpStyle, reference);
  const continued = restored;
  const p1b = createGatePlayer(gateStyle);
  const p2b = createPumpPlayer(pumpStyle);
  const ctxb = { p1GateTick: -1 };
  while (!continued.ended) {
    ctxb.p1GateTick = -1;
    p1b.act(continued, ctxb);
    p2b.act(continued, ctxb);
    continued.step();
  }
  assert.notEqual(continued, reference);
  assert.equal(continued.ended.result, 'success');
});

test('corrupted save slot is rejected', () => {
  clearSave();
  const sim = new Simulation(C.DEFAULT_SEED);
  saveGame(sim, 'success');
  const raw = JSON.parse(localStorage.getItem(C.SAVE_KEY));
  raw.snapshot.pump.durability = 7;
  localStorage.setItem(C.SAVE_KEY, JSON.stringify(raw));
  assert.throws(() => loadGame(), /hash mismatch/);
});
