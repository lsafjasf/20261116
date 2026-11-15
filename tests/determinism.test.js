import test from 'node:test';
import assert from 'node:assert/strict';

import * as C from '../src/config.js';
import { Simulation, hashObject } from '../src/simulation.js';
import { Recording, Replayer } from '../src/recorder.js';
import { runScenario, SCENARIOS } from '../src/controllers.js';
import { analyzeOrderSensitivity } from '../src/analysis.js';

function build(name) {
  const [gateStyle, pumpStyle] = SCENARIOS[name];
  const sim = new Simulation(C.DEFAULT_SEED);
  runScenario(name, gateStyle, pumpStyle, sim);
  return { sim, recording: Recording.capture(sim, name) };
}

test('success scenario holds the safe level for 30 minutes', () => {
  const { sim, recording } = build('success');
  assert.equal(sim.ended.result, 'success');
  assert.equal(sim.tick, C.TOTAL_TICKS);
  assert.equal(recording.timeline.metrics.length, C.TOTAL_TICKS);
  assert.ok(sim.pump.durability > C.MIN_DURABILITY);
  assert.ok(sim.streetDepth < C.STREET_FAILURE_LEVEL);
});

test('overheat scenario destroys the pump', () => {
  const { sim } = build('failure_overheat');
  assert.equal(sim.ended.result, 'failure');
  assert.equal(sim.ended.reason, 'pump-destroyed');
  assert.ok(sim.pump.tripCount >= 2);
});

test('flood scenario submerges the street', () => {
  const { sim } = build('failure_flood');
  assert.equal(sim.ended.result, 'failure');
  assert.equal(sim.ended.reason, 'street-flooded');
  assert.ok(sim.streetDepth >= C.STREET_FAILURE_LEVEL);
});

test('replay reproduces the identical final snapshot under all control patterns', () => {
  for (const name of Object.keys(SCENARIOS)) {
    const { recording } = build(name);
    const expected = recording.finalHash;

    const continuous = new Replayer(Recording.parse(JSON.stringify(recording)));
    continuous.runToEnd();
    assert.equal(hashObject(continuous.sim.snapshot()), expected, `${name} continuous`);

    // Pause, single step and speed toggles must not change the final state.
    const stepped = new Replayer(Recording.parse(JSON.stringify(recording)));
    stepped.playing = false;
    while (!stepped.sim.ended) {
      for (let i = 0; i < 257 && !stepped.sim.ended; i++) stepped.step();
      stepped.speed = stepped.speed === 1 ? 4 : 0.5;
      stepped.playing = !stepped.playing;
    }
    assert.equal(hashObject(stepped.sim.snapshot()), expected, `${name} step/speed`);

    const seeker = new Replayer(Recording.parse(JSON.stringify(recording)));
    seeker.seekFromCheckpoint(recording.finalSnapshot.tick);
    assert.equal(hashObject(seeker.sim.snapshot()), expected, `${name} checkpoint seek`);
  }
});

test('checkpoint hashes match a from-scratch replay at each checkpoint', () => {
  const { recording } = build('success');
  for (const cp of recording.checkpoints) {
    const replayer = new Replayer(Recording.parse(JSON.stringify(recording)));
    replayer.seek(cp.tick);
    assert.equal(hashObject(replayer.sim.snapshot()), cp.hash, `tick ${cp.tick}`);
  }
});

test('order analysis reports concrete conflict time and object position', () => {
  const { recording } = build('order_demo');
  const analysis = analyzeOrderSensitivity(recording);
  assert.ok(analysis.conflicts.length > 0);
  assert.equal(analysis.conflicts[0].object, 'sluice-gate');
  assert.match(analysis.conflicts[0].position, /x=\d+m/);
  assert.ok(typeof analysis.conflicts[0].simTime === 'number');
  assert.equal(analysis.reorderDiverges, true);
  assert.notEqual(analysis.finalHashIfP1Wins, analysis.finalHashIfP2Wins);
});
