import test from "node:test";
import assert from "node:assert/strict";
import {
  CYCLE_MINUTES,
  GATE_HEAD_LIMIT_M,
  GENERATION_TARGET_MWH,
  TidalSimulation,
} from "../src/sim.js";

test("same seed and command track reproduce identical state history", () => {
  const first = new TidalSimulation({ strategyKey: "balanced", seed: 605 });
  const second = new TidalSimulation({ strategyKey: "balanced", seed: 605 });
  first.complete();
  second.complete();
  assert.equal(first.stateHash, second.stateHash);
  assert.deepEqual(first.getResults(), second.getResults());
  assert.deepEqual(first.history, second.history);
  assert.deepEqual(
    first.log.map(({ tick, title, severity }) => ({ tick, title, severity })),
    second.log.map(({ tick, title, severity }) => ({ tick, title, severity })),
  );
});

test("normal cycle: navigation-first strategy meets all three goals", () => {
  const safe = new TidalSimulation({ strategyKey: "balanced", seed: 605 });
  const power = new TidalSimulation({ strategyKey: "power", seed: 605 });
  safe.complete();
  power.complete();
  const safeResult = safe.getResults();
  const powerResult = power.getResults();
  assert.equal(safeResult.success, true);
  assert.equal(safeResult.equipmentSafe, true);
  assert.equal(safeResult.navigationPassed, true);
  assert.ok(safeResult.energyMWh >= GENERATION_TARGET_MWH);
  assert.equal(powerResult.navigationPassed, false);
  assert.ok(powerResult.energyMWh > safeResult.energyMWh);
  assert.equal(powerResult.success, false);
});

test("bearing failure records time, negative margin, response and stable recovery", () => {
  const sim = new TidalSimulation({ scenarioKey: "bearing", strategyKey: "balanced" });
  while (!sim.incidents.length && !sim.ended) sim.step();
  const incident = sim.incidents[0];
  assert.ok(incident);
  assert.equal(incident.type, "equipment");
  assert.ok(incident.tick > 0 && incident.tick < CYCLE_MINUTES);
  assert.ok(incident.margin < 0);
  assert.match(incident.response, /联锁停机/);
  assert.equal(sim.state.safety.unresolved, 1);
  assert.equal(sim.state.powerMW, 0);
  const recovered = sim.recoverIncident();
  assert.equal(recovered.resolved, true);
  const auditStart = sim.tick;
  sim.runTo(Math.min(CYCLE_MINUTES, auditStart + sim.audit.required));
  assert.equal(sim.audit.elapsed, sim.audit.required);
  assert.equal(sim.audit.passed, true);
  assert.deepEqual(sim.audit.violations, []);
  const incidentCount = sim.incidents.length;
  sim.runTo(Math.min(CYCLE_MINUTES, sim.tick + 90));
  assert.equal(sim.incidents.length, incidentCount);
  assert.ok(Number.isFinite(sim.state.basinLevel));
  assert.ok(Number.isFinite(sim.state.head));
});

test("pressure-limit scenario interlocks the gate and passes fixed stability audit", () => {
  const sim = new TidalSimulation({ scenarioKey: "pressure", strategyKey: "balanced" });
  while (!sim.incidents.length && !sim.ended) sim.step();
  const incident = sim.incidents[0];
  assert.ok(incident);
  assert.equal(incident.type, "pressure");
  assert.ok(incident.value > GATE_HEAD_LIMIT_M);
  assert.ok(incident.margin < 0);
  assert.equal(sim.state.gate.interlocked, true);
  assert.equal(sim.state.gate.opening, 0);
  assert.match(incident.response, /闭锁/);
  sim.recoverIncident();
  assert.equal(sim.audit.active, true);
  sim.runTo(sim.tick + sim.audit.required);
  assert.equal(sim.audit.finished, true);
  assert.equal(sim.audit.passed, true);
  assert.deepEqual(sim.audit.violations, []);
});

test("failure replay reconstructs the same incident and state hash", () => {
  const original = new TidalSimulation({ scenarioKey: "bearing", strategyKey: "balanced" });
  while (!original.incidents.length && !original.ended) original.step();
  const incident = original.incidents[0];
  const replayTick = Math.max(0, incident.tick - 8);
  const replay = new TidalSimulation({
    scenarioKey: original.scenarioKey,
    strategyKey: original.strategyKey,
    seed: original.seed,
    commandTrack: original.commandTrack,
  });
  replay.runTo(replayTick);
  while (!replay.incidents.length && !replay.ended) replay.step();
  assert.equal(replay.tick, original.tick);
  assert.equal(replay.stateHash, original.stateHash);
  assert.equal(replay.incidents[0].tick, incident.tick);
  assert.equal(replay.incidents[0].stateHash, incident.stateHash);
});

test("manual operation is logged on the simulation clock and replayable", () => {
  const original = new TidalSimulation({ strategyKey: "balanced" });
  original.runTo(42);
  original.applyCommand("emergency-stop");
  original.runTo(60);
  assert.deepEqual(original.commandTrack[0], {
    id: "cmd-1",
    tick: 42,
    type: "emergency-stop",
    payload: {},
  });
  const replay = new TidalSimulation({
    strategyKey: "balanced",
    commandTrack: original.commandTrack,
  });
  replay.runTo(60);
  assert.equal(replay.stateHash, original.stateHash);
  assert.equal(
    replay.log.some((event) => event.detail.includes("人工紧急停机")),
    true,
  );
});
