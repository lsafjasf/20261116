import test from "node:test";
import assert from "node:assert/strict";
import {
  Simulation,
  runScenario,
  TICK_SECONDS,
  VERIFY_SECONDS,
} from "../src/simulation.js";

function runUntil(sim, predicate, maxTicks = 6000) {
  let ticks = 0;
  while (!predicate(sim) && ticks < maxTicks) {
    sim._tick();
    ticks += 1;
  }
  return ticks;
}

function assertHealthyVerification(fault) {
  assert.equal(fault.verification.status, "passed");
  assert.equal(fault.verification.duration, VERIFY_SECONDS);
  assert.ok(fault.verification.samples >= Math.floor(VERIFY_SECONDS / TICK_SECONDS));
  assert.deepEqual(fault.verification.violations, []);
  assert.ok(fault.verification.maxDelta.sway < 0.22);
  assert.ok(fault.verification.maxDelta.wind < 2.2);
  assert.ok(fault.verification.maxDelta.humidity < 2.4);
  assert.ok(fault.stableAt !== null);
  assert.ok(fault.recoveredAt - fault.stableAt >= VERIFY_SECONDS - TICK_SECONDS * 2);
}

test("normal flow completes all three repairs and recovers the platform", () => {
  const { sim, view } = runScenario("normal");
  assert.equal(view.outcome, "success");
  assert.equal(view.mission.status, "complete");
  assert.equal(view.mission.repairedCount, 3);
  assert.equal(view.blades.filter((blade) => blade.repaired).length, 3);
  assert.equal(view.platform.mode, "docked");
  assert.ok(view.platform.gap > 0.7);
  assert.equal(view.faults.length, 0);
  assert.ok(view.window.remaining > 20);
  assert.ok(Math.abs(view.window.remaining - (view.window.duration - sim.terminalAt)) < 0.06);
});

test("pause, single-step and resume share one deterministic clock", () => {
  const sim = new Simulation("normal");
  sim.advance(0.26);
  const pausedAt = sim.t;
  assert.equal(pausedAt, 0.25);
  assert.equal(sim.pause("test"), true);
  sim.advance(2);
  assert.equal(sim.t, pausedAt);

  const stepped = sim.stepOnce();
  assert.equal(sim.running, false);
  assert.equal(stepped, pausedAt + TICK_SECONDS);
  assert.equal(sim.logs.at(-1).title, "单步推进");

  assert.equal(sim.resume(), true);
  sim.advance(0.11);
  assert.equal(sim.t, pausedAt + TICK_SECONDS * 3);
  assert.ok(sim.logs.every((entry) => entry.t <= sim.t));
});

test("equipment fault records time, margins, responses and passes fixed verification", () => {
  const sim = new Simulation("equipment");
  runUntil(sim, (instance) => instance.faults.length > 0);
  const fault = sim.getView().fault;
  assert.equal(fault.kind, "EQUIPMENT");
  assert.equal(fault.time, 34.5);
  assert.equal(fault.stage, "sand");
  assert.ok(fault.margin.motorC < 0);
  assert.ok(fault.margin.windowSec > 60);
  assert.ok(fault.margin.swayM > 0);
  assert.ok(fault.response.length >= 1);
  assert.equal(fault.response[0].source, "SAFETY");

  const ticks = runUntil(sim, (instance) => instance.terminal);
  const view = sim.getView();
  assert.ok(ticks > 0);
  assert.equal(view.outcome, "success");
  assert.equal(view.faults.length, 1);
  assert.equal(view.platform.mode, "docked");
  assert.equal(view.mission.repairedCount, 3);
  assertHealthyVerification(view.faults[0]);
  assert.ok(view.faults[0].response.length >= 5);
  assert.ok(view.faults[0].response.at(-1).at > view.faults[0].time);
});

test("parameter limit freezes curing, records negative humidity margin and recovers", () => {
  const sim = new Simulation("parameter");
  runUntil(sim, (instance) => instance.faults.length > 0);
  const fault = sim.getView().fault;
  assert.equal(fault.kind, "PARAMETER");
  assert.equal(fault.stage, "dry");
  assert.ok(fault.margin.humidityRH < 0);
  assert.equal(fault.response[0].source, "SAFETY");

  runUntil(sim, (instance) => instance.terminal);
  const view = sim.getView();
  assert.equal(view.outcome, "success");
  assert.equal(view.faults.length, 1);
  assert.equal(view.mission.repairedCount, 3);
  assertHealthyVerification(view.faults[0]);
  assert.ok(view.faults[0].response.some((item) => item.source === "ENV"));
});

test("platform instability aborts exactly once and ends in a safe stowed state", () => {
  const { sim, view } = runScenario("instability");
  assert.equal(view.outcome, "safe_abort");
  assert.equal(view.mission.status, "aborted_safe");
  assert.equal(view.faults.length, 1);
  assert.equal(view.faults[0].kind, "INSTABILITY");
  assert.equal(view.instabilityAbortUsed, true);
  assert.ok(view.faults[0].margin.swayM <= 0);
  assert.equal(view.platform.mode, "stowed");
  assert.ok(view.mission.repairedCount < 3);
  assertHealthyVerification(view.faults[0]);
  assert.ok(view.window.remaining > 0);
  assert.equal(sim.faults.filter((fault) => fault.kind === "INSTABILITY").length, 1);
});

test("same seed and step sequence reproduce byte-identical state", () => {
  const first = new Simulation("equipment");
  const second = new Simulation("equipment");
  for (let i = 0; i < 900; i += 1) {
    first._tick();
    second._tick();
  }
  assert.equal(JSON.stringify(first.getView()), JSON.stringify(second.getView()));
  assert.equal(first.t, 45);
  assert.ok(first.faults.length > 0);
});

test("failure replay exposes pre-fault frames ending at the recorded fault", () => {
  const { sim, view } = runScenario("instability");
  const fault = view.faults[0];
  const frames = sim.getFaultReplay(fault.id, 8);
  assert.ok(frames.length > 30);
  assert.ok(frames[0].t >= fault.time - 8.01);
  assert.ok(frames[0].t <= fault.time - 7);
  assert.ok(frames.at(-1).t >= fault.time);
  assert.equal(frames.at(-1).replay.faultId, fault.id);
  assert.equal(frames.at(-1).replay.atFault, true);

  const malformed = frames.filter(
    (frame) =>
      !Number.isFinite(frame.t) ||
      !Number.isFinite(frame.window.remaining) ||
      !Number.isFinite(frame.env.wind) ||
      !Number.isFinite(frame.platform.sway),
  );
  assert.deepEqual(malformed, []);
});

test("all scenarios stay finite and terminate within their wind windows", () => {
  for (const scenario of ["normal", "equipment", "parameter", "instability"]) {
    const { view } = runScenario(scenario);
    assert.ok(view.terminal, `${scenario} should terminate`);
    assert.ok(Number.isFinite(view.t));
    assert.ok(view.window.remaining >= 0);
    assert.ok(view.logs.length > 8);
    assert.ok(view.t < view.window.duration);
    assert.ok(["success", "safe_abort"].includes(view.outcome));
  }
});
