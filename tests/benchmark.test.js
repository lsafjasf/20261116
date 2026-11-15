import test from "node:test";
import assert from "node:assert/strict";
import { runWorkload, compareRuns } from "../src/benchmark.js";
import { LayoutEngine } from "../src/engine.js";
import { createApproxMeasurer } from "../src/measure.js";
import { WORKLOADS } from "../src/data.js";

const engine = new LayoutEngine(createApproxMeasurer());

test("cached and uncached common workloads are semantically identical", () => {
  const baseline = runWorkload(WORKLOADS.common, {
    engine,
    cacheEnabled: false,
    frames: 42
  });
  const cached = runWorkload(WORKLOADS.common, {
    engine,
    cacheEnabled: true,
    frames: 42
  });
  const parity = compareRuns(baseline, cached);
  assert.equal(parity.semanticEqual, true);
  assert.equal(parity.errorFree, true);
  assert.equal(parity.overlapFree, true);
  assert.equal(cached.finalOutput, baseline.finalOutput);
  assert.ok(cached.cache.hits > 0);
  assert.ok(cached.candidatesTotal < baseline.candidatesTotal);
});

test("edge parameters preserve output under cache and never overlap", () => {
  const baseline = runWorkload(WORKLOADS.edge, {
    engine,
    cacheEnabled: false,
    frames: 60
  });
  const cached = runWorkload(WORKLOADS.edge, {
    engine,
    cacheEnabled: true,
    frames: 60
  });
  const parity = compareRuns(baseline, cached);
  assert.equal(parity.semanticEqual, true);
  assert.equal(parity.errorFree, true);
  assert.equal(parity.overlapFree, true);
  assert.equal(cached.overlaps.length, 0);
  assert.equal(baseline.overlaps.length, 0);
});
