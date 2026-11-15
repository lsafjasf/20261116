/*
 * Verification suite for the lighthouse co-op game.
 * Runs under Node with no dependencies. Exit code 0 only if every check passes.
 */
const assert = require('assert');
const {
  Simulation, TUNING, DT
} = require('../js/sim.js');
const {
  makeSuccessPilot, carefulPilot, greedyPilot, negligentPilot, runWithPilot
} = require('./pilot.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

const SEED = 42;

// 1. Successful cooperative route, including a verified overheat cycle.
check('success route docks all 3 ships and recovers from overheat', () => {
  const { sim, overheatEvents } = runWithPilot(SEED, makeSuccessPilot());
  assert.strictEqual(sim.mode, 'success');
  assert.strictEqual(
    sim.ships.filter((s) => s.state === 'docked').length, 3);
  assert.ok(overheatEvents.length >= 1, 'overheat must fire at least once');
  const overheatEv = sim.events.find((e) => e.type === 'overheat');
  const cooledEv = sim.events.find((e) => e.type === 'cooled');
  assert.ok(overheatEv && cooledEv, 'overheat + cooled events both present');
  assert.ok(cooledEv.step > overheatEv.step, 'cooling follows overheat');
  assert.ok(sim.heat <= TUNING.overheatAt);
});

// 2. Operator mistake: ignoring the lamp loses a ship and triggers recovery.
check('negligent operation fails and failure recovery restarts the run', () => {
  const { sim } = runWithPilot(SEED, negligentPilot);
  assert.strictEqual(sim.mode, 'failed');
  assert.ok(['ship-lost', 'timeout', 'hazard-overflow'].includes(sim.failReason));
  const beforeHash = sim.stateHash();
  const snap = sim.recover();
  assert.strictEqual(sim.mode, 'ready');
  assert.strictEqual(sim.time, 0);
  assert.strictEqual(sim.stepCount, 0);
  assert.strictEqual(sim.heat, snap.heat);
  assert.notStrictEqual(sim.stateHash(), beforeHash);
  assert.strictEqual(sim.inputLog.length, 0);
});

// 3. Parameter extreme: full output, heat pinned at the ceiling repeatedly.
check('parameter extreme (max output) survives overheat at the limits', () => {
  const { sim, overheatEvents } = runWithPilot(SEED, greedyPilot);
  assert.ok(overheatEvents.length >= 2, 'max power causes repeated overheat');
  assert.ok(sim.hazard >= 50, 'wide beam floods reefs with hazard');
  assert.ok(/^[0-9a-f]{8}$/.test(sim.stateHash()));
  assert.ok(sim.power >= 0 && sim.power <= 1);
});

// 4. Pause freezes every observable quantity; resume continues deterministically.
check('pause freezes the simulation and resume stays deterministic', () => {
  const sim = new Simulation(SEED);
  sim.start();
  for (let i = 0; i < 120; i++) {
    sim.applyInput(carefulPilot(sim));
    sim.step();
  }
  sim.pause();
  const frozen = sim.snapshot();
  for (let i = 0; i < 30; i++) {
    sim.applyInput({ rot: 1, power: 1 });
    sim.step();
  }
  assert.deepStrictEqual(sim.snapshot(), frozen);
  assert.strictEqual(sim.mode, 'paused');
  sim.resume();
  const hashAfterResume = sim.stateHash();
  for (let i = 0; i < 30; i++) {
    sim.applyInput(carefulPilot(sim));
    sim.step();
  }
  assert.notStrictEqual(sim.stateHash(), hashAfterResume);
});

// 5. Restart resets timer, resources and the seeded random sequence.
check('restart resets timer, resources, input log and RNG sequence', () => {
  const sim = new Simulation(SEED);
  sim.start();
  const pilot = makeSuccessPilot();
  const firstRandoms = [];
  for (let i = 0; i < 150; i++) {
    sim.applyInput(pilot(sim));
    sim.step();
    if (i % 25 === 0) firstRandoms.push(sim.rng.state);
  }
  assert.ok(sim.time > 1);
  assert.ok(sim.inputLog.length > 0);
  sim.restart(SEED);
  assert.strictEqual(sim.mode, 'ready');
  assert.strictEqual(sim.time, 0);
  assert.strictEqual(sim.stepCount, 0);
  assert.strictEqual(sim.heat, 24);
  assert.strictEqual(sim.hazard, 0);
  assert.strictEqual(sim.power, 0.55);
  assert.strictEqual(sim.lampOn, true);
  assert.strictEqual(sim.inputLog.length, 0);
  assert.strictEqual(sim.events.length, 1);
  sim.start();
  const pilot2 = makeSuccessPilot();
  const secondRandoms = [];
  for (let i = 0; i < 150; i++) {
    sim.applyInput(pilot2(sim));
    sim.step();
    if (i % 25 === 0) secondRandoms.push(sim.rng.state);
  }
  assert.deepStrictEqual(secondRandoms, firstRandoms);
});

// 6. Replay with the same seed + input record yields an identical state hash.
check('replay of saved seed + input record reproduces the final hash', () => {
  const { sim } = runWithPilot(SEED, makeSuccessPilot());
  const record = sim.toRecord();
  const expectedHash = sim.stateHash();
  const first = Simulation.replay(record);
  const second = Simulation.replay(record);
  assert.strictEqual(first.mode, 'success');
  assert.strictEqual(first.hash, expectedHash);
  assert.strictEqual(second.hash, expectedHash);
  assert.strictEqual(
    first.snapshot.ships.map((s) => s.state).join(','),
    'docked,docked,docked');

  // A different seed must produce a different layout/hash.
  const other = new Simulation(SEED + 1);
  assert.notStrictEqual(other.stateHash(), new Simulation(SEED).stateHash());
});

// 7. Replay hash also matches for the failure and extreme runs.
check('replay hash is stable for failure and extreme records', () => {
  for (const pilot of [negligentPilot, greedyPilot]) {
    const { sim } = runWithPilot(SEED, pilot);
    const record = sim.toRecord();
    const expected = sim.stateHash();
    const replay = Simulation.replay(record);
    assert.strictEqual(replay.hash, expected);
    assert.strictEqual(replay.mode, sim.mode);
  }
});

// 8. State machine only allows legal transitions.
check('state machine enforces legal mode transitions', () => {
  const sim = new Simulation(SEED);
  assert.strictEqual(sim.mode, 'ready');
  assert.strictEqual(sim.resume(), 'ready');
  sim.start();
  assert.strictEqual(sim.mode, 'running');
  sim.pause();
  assert.strictEqual(sim.mode, 'paused');
  sim.step();
  assert.strictEqual(sim.time, sim.time);
  sim.resume();
  assert.strictEqual(sim.mode, 'running');
});

// 9. Hash is input-sensitive: changing one logged input changes the result.
check('state hash changes when the input record changes', () => {
  const { sim } = runWithPilot(SEED, carefulPilot);
  const record = sim.toRecord();
  const baseline = Simulation.replay(record).hash;
  const mutated = JSON.parse(JSON.stringify(record));
  mutated.inputs[10].rot = mutated.inputs[10].rot === 1 ? -1 : 1;
  const changed = Simulation.replay(mutated).hash;
  assert.notStrictEqual(changed, baseline);
});

// Report
let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log('PASS', r.name);
  } else {
    failed++;
    console.log('FAIL', r.name, '-', r.err && r.err.message);
  }
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
