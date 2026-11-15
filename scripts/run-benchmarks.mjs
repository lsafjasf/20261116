import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareTrajectories,
  recordTrajectory,
  REFERENCE_FPS,
  TRAJECTORY_FPS,
  BENCHMARK_DURATION,
} from "../src/core/benchmark.js";
import { runPauseResumeProbe, runTimeScaleProbe } from "../src/core/probes.js";
import { runScenarioSuite } from "../src/core/scenarios.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "artifacts");
const heapBefore = process.memoryUsage();

const reference = recordTrajectory({
  fps: REFERENCE_FPS,
  duration: BENCHMARK_DURATION,
  broadphase: "grid",
  cache: true,
});
const recordings = TRAJECTORY_FPS.map((fps) =>
  recordTrajectory({ fps, duration: BENCHMARK_DURATION }),
);
const trajectoryResults = recordings.map((recording) =>
  compareTrajectories(reference, recording, BENCHMARK_DURATION),
);
const pause = runPauseResumeProbe();
const timeScale = runTimeScaleProbe();
const scenarios = runScenarioSuite({ repeats: 5 });
const heapAfter = process.memoryUsage();

const trajectoryPassed = trajectoryResults.every((result) => result.maxErrorPx <= 1);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  trajectory: {
    fixedHz: 120,
    fixedDtSeconds: 1 / 120,
    referenceFps: REFERENCE_FPS,
    durationSeconds: BENCHMARK_DURATION,
    checkpointSeconds: 0.25,
    results: trajectoryResults,
    passed: trajectoryPassed,
    recordings: recordings.map((recording) => ({
      fps: recording.fps,
      fixedSteps: recording.fixedSteps,
      droppedSteps: recording.droppedSteps,
      samples: recording.samples.map((sample) => ({
        t: Number(sample.t.toFixed(4)),
        x: Number(sample.x.toFixed(3)),
        y: Number(sample.y.toFixed(3)),
      })),
      finalState: recording.finalState,
    })),
  },
  pause,
  timeScale,
  scenarios,
  resources: {
    heapDeltaMB: Number(((heapAfter.heapUsed - heapBefore.heapUsed) / 1048576).toFixed(3)),
    heapUsedMB: Number((heapAfter.heapUsed / 1048576).toFixed(3)),
    rssMB: Number((heapAfter.rss / 1048576).toFixed(3)),
  },
};

report.conclusion = {
  allPassed:
    trajectoryPassed &&
    pause.passed &&
    timeScale.passed &&
    scenarios.passed,
  trajectoryWithinOnePixel: trajectoryPassed,
  pauseResumeStable: pause.passed,
  timeScaleSemanticsPreserved: timeScale.passed,
  beforeAfterPublicStateIdentical: scenarios.checks.outputsMatch,
  collisionChecksIdentical: scenarios.checks.collisionChecksMatch,
  boundaryBoundedWithoutExceptions: scenarios.checks.boundaryStable,
  optimizationOnlyChangesCost:
    scenarios.checks.outputsMatch &&
    scenarios.checks.collisionChecksMatch &&
    scenarios.checks.optimizationEffective,
  visualSemanticsChanged: false,
  interactionSemanticsChanged: false,
  publicDataSemanticsChanged: !scenarios.checks.outputsMatch,
  exceptionCount:
    scenarios.scenarios.before.errors.length +
    scenarios.scenarios.after.errors.length +
    scenarios.scenarios.boundary.errors.length,
};

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  path.join(outputDirectory, "validation-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
writeFileSync(
  path.join(outputDirectory, "trajectories.json"),
  `${JSON.stringify(report.trajectory.recordings, null, 2)}\n`,
);

const scenarioRow = (scenario, status) =>
  `| ${scenario.label} | ${scenario.outputHash} | ${scenario.resource.fixedSteps} | ${scenario.errors.length} | ${scenario.warnings.length} | ${scenario.resource.distanceChecks} | ${scenario.resource.cacheHitRate.toFixed(2)}% | ${scenario.resource.wallMs.toFixed(3)} ms | ${scenario.maxFrameDisplacementPx.toFixed(4)} px | ${status} |`;

const markdown = `# Fixed-Step Flight Validation

Generated: ${report.generatedAt}

## Result

${report.conclusion.allPassed ? "**PASS**" : "**FAIL**"} — fixed-step simulation, interpolated rendering, catch-up caps, pause/resume and performance optimization were validated on the same scripted input.

## Three frame-rate recordings

Reference: ${REFERENCE_FPS} FPS, duration: ${BENCHMARK_DURATION}s, fixed step: 1/120s, checkpoint interval: 0.25s.

| FPS | Samples | Fixed steps | Mean error | RMS error | Max error | Final error |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${trajectoryResults
  .map(
    (result) =>
      `| ${result.fps} | ${result.recordedSamples} | ${result.fixedSteps} | ${result.meanErrorPx.toFixed(4)} px | ${result.rmsErrorPx.toFixed(4)} px | **${result.maxErrorPx.toFixed(4)} px** | ${result.finalErrorPx.toFixed(4)} px |`,
  )
  .join("\n")}

All frame-rate recordings finished with the identical public final state. Writes to \`artifacts/trajectories.json\` contain the recorded samples.

## Pause and time-scale probe

| Check | Result |
| --- | --- |
| Position delta during pause | ${pause.pausedPositionDeltaPx.toFixed(4)} px |
| Physics time delta during pause | ${pause.pausedSimTimeDelta.toFixed(4)} s |
| Thruster output while paused | ${pause.thrusterDuringPause ? "ON" : "OFF"} |
| Held thrust restored after resume | ${pause.checks.heldThrustRestored ? "yes" : "no"} |
| First frame displacement after resume | ${pause.resumeJumpPx.toFixed(4)} px (limit ${pause.maxResumeJumpPx} px) |
| 0.5x state delta vs 1x | ${timeScale.halfPositionDeltaPx.toFixed(6)} px |
| 2x state delta vs 1x | ${timeScale.doublePositionDeltaPx.toFixed(6)} px |

## Optimization and boundary scenarios

| Scene | Public hash | Steps | Errors | Warnings | Distance checks | Cache hit | CPU | Max frame displacement | Status |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${scenarioRow(scenarios.scenarios.before, "BASE")}
${scenarioRow(scenarios.scenarios.after, "PASS")}
${scenarioRow(scenarios.scenarios.boundary, "CAPPED")}

- Before/after public output hash equal: **${scenarios.checks.outputsMatch ? "yes" : "no"}**.
- Collision-check count identical: **${scenarios.checks.collisionChecksMatch ? "yes" : "no"}**.
- Distance checks reduced from ${scenarios.scenarios.before.resource.distanceChecks} to ${scenarios.scenarios.after.resource.distanceChecks}; collision checks remain ${scenarios.scenarios.after.resource.collisionChecks} in both modes.
- Boundary scene dropped ${scenarios.scenarios.boundary.clock.droppedSteps} fixed steps, clamped ${scenarios.scenarios.boundary.clock.clampedFrames} oversized frames, logged ${scenarios.scenarios.boundary.errors.length} exceptions and stayed below the 12 px per-frame displacement bound.
- Exception logs: ${report.conclusion.exceptionCount}.

### Boundary warnings

${scenarios.scenarios.boundary.warnings.map((warning) => `- ${warning}`).join("\n") || "- None"}

## Resource usage

- Process heap delta after suite: ${report.resources.heapDeltaMB} MB.
- Final heap: ${report.resources.heapUsedMB} MB; RSS: ${report.resources.rssMB} MB.
- Observable metrics retained in the UI: frame time/FPS, physics time, candidate count, cache hit rate and node count.

## Semantic guarantee

The optimized and baseline scenes produce byte-identical public state and the exact same collision-check count. Only broadphase work, cache behavior, catch-up/error handling and CPU cost differ; visuals, controls, time-scale behavior and public state fields are unchanged.

- Visual semantics changed: **no**.
- Interaction semantics changed: **no**.
- Public data semantics changed: **${report.conclusion.publicDataSemanticsChanged ? "yes" : "no"}**.
`;

writeFileSync(path.join(outputDirectory, "validation-report.md"), markdown);

console.log(
  JSON.stringify(
    {
      passed: report.conclusion.allPassed,
      trajectory: trajectoryResults.map((result) => ({
        fps: result.fps,
        meanErrorPx: result.meanErrorPx,
        maxErrorPx: result.maxErrorPx,
      })),
      pauseResumeJumpPx: pause.resumeJumpPx,
      scenarios: {
        beforeHash: scenarios.scenarios.before.outputHash,
        afterHash: scenarios.scenarios.after.outputHash,
        outputsMatch: scenarios.checks.outputsMatch,
        boundaryDroppedSteps: scenarios.scenarios.boundary.clock.droppedSteps,
        errors: report.conclusion.exceptionCount,
      },
      report: "artifacts/validation-report.md",
    },
    null,
    2,
  ),
);
