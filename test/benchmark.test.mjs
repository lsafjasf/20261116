import test from "node:test";
import assert from "node:assert/strict";
import { benchmarkAllScenarios, benchmarkScenario } from "../src/benchmark.js";
import { SCENARIOS } from "../src/scenarios.js";

test("three fixed scenarios retain output and resource telemetry", () => {
  for (const scenario of SCENARIOS) {
    const result = benchmarkScenario(scenario.id, { frames: 3, warmupFrames: 1 });
    assert.equal(result.outputEqual, true, `${scenario.id} output`);
    assert.equal(result.semanticEqual, true, `${scenario.id} semantics`);
    assert.equal(result.parity.digestEqual, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.brute.completedFrames, 3);
    assert.equal(result.grid.completedFrames, 3);
    assert.ok(result.grid.averageCandidates < result.brute.totalPairs);
    assert.ok(result.brute.averageFrameMs > 0);
    assert.ok(result.grid.averageFrameMs > 0);
    assert.ok(result.grid.memory);
    assert.equal(result.grid.memory.source.length > 0, true);
  }
});

test("aggregate benchmark proves all-output equality and zero exceptions", async () => {
  const report = await benchmarkAllScenarios({ frames: 2, warmupFrames: 1 });
  assert.equal(report.results.length, 3);
  assert.equal(report.allOutputsEqual, true);
  assert.equal(report.allSemanticsEqual, true);
  assert.equal(report.totalErrors, 0);
  for (const result of report.results) {
    assert.ok(result.pairReduction > 0.9);
    assert.equal(result.brute.contactDigest, result.grid.contactDigest);
    assert.equal(result.brute.finalObjectDigest, result.grid.finalObjectDigest);
  }
});
