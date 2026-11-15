import test from "node:test";
import assert from "node:assert/strict";
import { runAllParameterGroups, runBoundarySuite, runDefaultSuite, runExceptionSuite } from "../src/core/diagnostics.js";

test("default parameter group is repeatable and passes", () => {
  const first = runDefaultSuite();
  const second = runDefaultSuite();
  assert.equal(first.passed, true);
  assert.equal(second.passed, true);
  assert.deepEqual(
    first.result.rounds.map((round) => round.export.pixelHash),
    second.result.rounds.map((round) => round.export.pixelHash),
  );
});

test("boundary parameter group covers exact fit, one pixel and forced rotation", () => {
  const suite = runBoundarySuite();
  assert.equal(suite.passed, true, suite.checks.filter((entry) => !entry.ok).map((entry) => entry.name).join(", "));
  assert.ok(suite.checks.some((entry) => entry.name.includes("精确填满")));
  assert.ok(suite.checks.some((entry) => entry.name.includes("旋转")));
});

test("exception parameter group rejects invalid input and falls back cleanly", async () => {
  const suite = await runExceptionSuite();
  assert.equal(suite.passed, true, suite.checks.filter((entry) => !entry.ok).map((entry) => entry.name).join(", "));
});

test("all three parameter groups produce a green aggregate", async () => {
  const result = await runAllParameterGroups();
  assert.equal(result.suites.length, 3);
  assert.equal(result.passed, true);
});
