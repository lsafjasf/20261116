import test from "node:test";
import assert from "node:assert/strict";

import {
  runTrajectoryBenchmark,
  recordTrajectory,
  TRAJECTORY_FPS,
} from "../src/core/benchmark.js";
import { runPauseResumeProbe, runTimeScaleProbe } from "../src/core/probes.js";
import { runScenarioSuite } from "../src/core/scenarios.js";

test("30/60/144 FPS recordings share the same fixed-step final state", () => {
  const recordings = TRAJECTORY_FPS.map((fps) => recordTrajectory({ fps }));
  assert.deepEqual(
    recordings.map((recording) => recording.fixedSteps),
    [960, 960, 960],
  );
  for (const recording of recordings) {
    assert.deepEqual(recording.finalState, recordings[0].finalState);
  }
});

test("interpolated trajectories stay within one pixel across frame rates", () => {
  const report = runTrajectoryBenchmark({ includeCheckpoints: false });
  assert.equal(report.results.length, 3);
  for (const result of report.results) {
    assert.ok(result.recordedSamples > 200);
    assert.ok(result.meanErrorPx <= 1, `${result.fps} FPS mean error too high`);
    assert.ok(result.maxErrorPx <= 1, `${result.fps} FPS max error too high`);
    assert.equal(result.droppedSteps, 0);
  }
  assert.equal(report.referenceFps, 480);
  assert.ok(report.passed);
});

test("pause freezes physics and thrust, then resumes without a jump", () => {
  const probe = runPauseResumeProbe();
  assert.equal(probe.checks.pausedPositionStable, true);
  assert.equal(probe.checks.pausedClockStable, true);
  assert.equal(probe.checks.thrusterStopped, true);
  assert.equal(probe.checks.noResumeJump, true);
  assert.equal(probe.checks.resumedSimulationContinues, true);
  assert.equal(probe.pausedPositionDeltaPx, 0);
  assert.ok(probe.resumeJumpPx <= probe.maxResumeJumpPx);
  assert.equal(probe.thrusterDuringPause, false);
  assert.ok(probe.passed);
});

test("0.5x and 2x time scales preserve simulation logic", () => {
  const probe = runTimeScaleProbe();
  assert.equal(probe.doublePositionDeltaPx, 0);
  assert.equal(probe.halfPositionDeltaPx, 0);
  assert.equal(probe.double.droppedSteps, 0);
  assert.equal(probe.half.droppedSteps, 0);
  assert.ok(probe.passed);
});

test("before/after/boundary scenarios preserve semantics and contain errors", () => {
  const suite = runScenarioSuite({ repeats: 1 });
  assert.equal(suite.checks.outputsMatch, true);
  assert.equal(suite.checks.optimizationEffective, true);
  assert.equal(suite.checks.boundaryStable, true);
  assert.equal(suite.checks.noExceptions, true);
  assert.equal(suite.scenarios.before.outputHash, suite.scenarios.after.outputHash);
  assert.deepEqual(suite.scenarios.after.finalOutput, suite.scenarios.before.finalOutput);
  assert.equal(suite.scenarios.boundary.errors.length, 0);
  assert.ok(suite.scenarios.boundary.clock.droppedSteps > 0);
  assert.ok(suite.scenarios.boundary.maxFrameDisplacementPx < 12);
  assert.ok(suite.passed);
});
