"use strict";

const assert = require("node:assert/strict");
const core = require("../js/core.js");

function runPlan(plan) {
  const sim = new core.Simulation({ scenarioId: "normal" });
  const actions = plan.slice().sort((a, b) => a.time - b.time);
  let index = 0;
  while (!sim.finished && !sim.failed && sim.t < core.DURATION) {
    while (index < actions.length && actions[index].time <= sim.t) {
      actions[index].run(sim);
      index += 1;
    }
    sim.advance();
  }
  return sim;
}

const results = core.runReliabilitySuite();
assert.equal(results.length, 3, "three deterministic scenarios must run");
assert.ok(results.every((result) => result.passed), "all reliability scenarios must pass");

const normal = results.find((result) => result.id === "normal");
assert.equal(normal.success, true);
assert.equal(normal.faultTime, null);

const device = results.find((result) => result.id === "device");
assert.equal(device.faultTime, "00:22:00");
assert.ok(device.faultMargin > 0);
assert.match(device.faultResponse, /隔离故障通道/);
assert.equal(device.observation, "通过，无状态跳变");

const parameter = results.find((result) => result.id === "parameter");
assert.equal(parameter.faultTime, "00:31:00");
assert.ok(parameter.faultMargin > 0);
assert.match(parameter.faultResponse, /超量程/);
assert.equal(parameter.observation, "通过，无状态跳变");

const failingPlan = [
  {
    time: 0,
    run(sim) {
      sim.addSensor("displacement", "A");
      sim.addSensor("pore", "C");
    },
  },
  { time: 36 * 60, run: (sim) => sim.issueWarning() },
  { time: 20 * 60, run: (sim) => sim.setRoadMode("CONTROLLED") },
];

const original = runPlan(failingPlan);
const replay = runPlan(failingPlan);
assert.equal(original.failed, true);
assert.equal(original.failureTime, replay.failureTime, "failure replay must reach the same clock time");
assert.equal(original.failureReason, replay.failureReason, "failure replay must reach the same state");
assert.equal(original.trueState.stability, replay.trueState.stability);
assert.equal(original.logs.length, replay.logs.length);

const uncontrolled = new core.Simulation({ scenarioId: "normal" });
while (!uncontrolled.finished && !uncontrolled.failed && uncontrolled.t < core.DURATION) {
  uncontrolled.advance();
}
assert.equal(uncontrolled.failed, true, "untreated slope must eventually interrupt the road");
assert.ok(uncontrolled.metrics.injuries > 0, "open traffic at collapse must produce an injury");

const earlyClosure = new core.Simulation({ scenarioId: "normal" });
while (earlyClosure.t < 30 * 60) earlyClosure.advance();
earlyClosure.setRoadMode("FULL_CLOSED");
while (earlyClosure.t < 36 * 60) earlyClosure.advance();
assert.ok(earlyClosure.metrics.rescueDelays > 0, "full closure must delay the rescue window");
assert.ok(earlyClosure.metrics.routeUnavailableSeconds > 0, "full closure must count as route unavailability");

console.log("Reliability suite");
for (const result of results) {
  console.log(
    `  PASS ${result.label}: ${result.faultTime || "no fault"}, ` +
    `margin ${result.faultMargin == null ? "n/a" : result.faultMargin + "%"}, ` +
    `observation ${result.observation}`
  );
}
console.log(
  `Deterministic failure replay: ${core.formatTime(original.failureTime)} / ` +
  `${original.failureReason} / ${original.logs.length} events`
);
console.log(
  `Boundary checks: untreated collapse ${core.formatTime(uncontrolled.failureTime)}; ` +
  `early closure rescue delays ${earlyClosure.metrics.rescueDelays}`
);
console.log("All smoke tests passed.");
