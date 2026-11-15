import { FixedStepClock, DEFAULT_FIXED_DT } from "./simulation-clock.js";
import { PhysicsWorld } from "./world.js";
import { scriptedInputAt } from "./scripted-input.js";

export const FIXED_SCENE_DURATION = 8;
export const OPERATION_FPS = 60;
export const BOUNDARY_MAX_FRAME_PX = 12;

export const SCENARIO_PROFILES = Object.freeze({
  before: {
    label: "BEFORE",
    broadphase: "naive",
    cache: false,
    maxSubSteps: 8,
    frameSeconds: 1 / OPERATION_FPS,
    frameCount: FIXED_SCENE_DURATION * OPERATION_FPS,
    timeScale: 1,
  },
  after: {
    label: "AFTER",
    broadphase: "grid",
    cache: true,
    maxSubSteps: 8,
    frameSeconds: 1 / OPERATION_FPS,
    frameCount: FIXED_SCENE_DURATION * OPERATION_FPS,
    timeScale: 1,
  },
  boundary: {
    label: "BOUNDARY",
    broadphase: "grid",
    cache: true,
    maxSubSteps: 2,
    frameDeltas: [1 / 60, 0.28, 1 / 30, 0.62, 0.25, 1 / 144],
    frameCount: 240,
    timeScale: 2,
  },
});

export function stableHash(value) {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const invalidNumbers = (state) => {
  const values = [
    state.ship.x,
    state.ship.y,
    state.ship.vx,
    state.ship.vy,
    state.ship.angle,
    state.ship.angularVelocity,
    state.simTime,
  ];
  return values.some((value) => !Number.isFinite(value));
};

export function runFixedScenario(profile, { includeOutput = true } = {}) {
  const start = performance.now();
  const world = new PhysicsWorld({
    broadphase: profile.broadphase,
    cache: profile.cache,
  });
  const clock = new FixedStepClock({
    fixedDt: DEFAULT_FIXED_DT,
    maxSubSteps: profile.maxSubSteps,
  });
  const errors = [];
  const warnings = [];
  let clampedFrames = 0;
  let maxFrameDisplacementPx = 0;
  let previousPoint = world.sample(0);

  try {
    for (let frame = 0; frame < profile.frameCount; frame += 1) {
      const delta = profile.frameDeltas
        ? profile.frameDeltas[frame % profile.frameDeltas.length]
        : profile.frameSeconds;
      const result = clock.advance(delta, {
        timeScale: profile.timeScale,
        onStep: (dt) => world.step(dt, scriptedInputAt(world.time + dt)),
      });
      if (result.clampedFrame) clampedFrames += 1;
      const point = world.sample(clock.alpha);
      const displacement = Math.hypot(point.x - previousPoint.x, point.y - previousPoint.y);
      maxFrameDisplacementPx = Math.max(maxFrameDisplacementPx, displacement);
      previousPoint = point;
      if (invalidNumbers(world.getPublicState())) {
        throw new Error("Non-finite state detected after fixed step");
      }
    }
  } catch (error) {
    errors.push({
      type: error.name || "Error",
      message: error.message,
    });
  }

  if (clock.droppedSteps > 0) {
    warnings.push(
      `Catch-up capped: dropped ${clock.droppedSteps} fixed steps (${clock.droppedSimTime.toFixed(3)} s)`,
    );
  }
  if (clampedFrames > 0) {
    warnings.push(`Clamped ${clampedFrames} oversized frame interval(s) at 250 ms`);
  }

  const finalOutput = world.getPublicState();
  const wallMs = performance.now() - start;
  return {
    id: "scenario",
    label: profile.label,
    passed:
      errors.length === 0 &&
      !invalidNumbers(finalOutput) &&
      maxFrameDisplacementPx <= BOUNDARY_MAX_FRAME_PX,
    outputHash: stableHash(finalOutput),
    finalOutput: includeOutput ? finalOutput : undefined,
    errors,
    warnings,
    resource: {
      wallMs: Number(wallMs.toFixed(3)),
      fixedSteps: world.stepCount,
      distanceChecks: world.metrics.distanceChecks,
      collisionChecks: world.metrics.collisionChecks,
      candidateCount: world.metrics.candidateCount,
      cacheHitRate: Number((world.getCacheHitRate() * 100).toFixed(2)),
      nodeCount: world.metrics.nodeCount,
    },
    clock: {
      droppedSteps: clock.droppedSteps,
      droppedSimTime: Number(clock.droppedSimTime.toFixed(4)),
      clampedFrames,
    },
    maxFrameDisplacementPx: Number(maxFrameDisplacementPx.toFixed(4)),
  };
}

export function runScenarioSuite({ repeats = 3 } = {}) {
  const runProfile = (key) => {
    const runs = [];
    for (let index = 0; index < repeats; index += 1) {
      runs.push(runFixedScenario(SCENARIO_PROFILES[key], { includeOutput: index === 0 }));
    }
    const times = runs.map((run) => run.resource.wallMs).sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    return {
      ...runs[0],
      id: key,
      resource: { ...runs[0].resource, wallMs: Number(median.toFixed(3)) },
      sampleRunsMs: runs.map((run) => run.resource.wallMs),
    };
  };

  const before = runProfile("before");
  const after = runProfile("after");
  const boundary = runProfile("boundary");
  const outputsMatch =
    before.outputHash === after.outputHash &&
    JSON.stringify(before.finalOutput) === JSON.stringify(after.finalOutput);
  const optimizationEffective =
    after.resource.distanceChecks < before.resource.distanceChecks &&
    after.resource.cacheHitRate > before.resource.cacheHitRate;
  const collisionChecksMatch =
    after.resource.collisionChecks === before.resource.collisionChecks;
  const boundaryStable =
    boundary.passed &&
    boundary.clock.droppedSteps > 0 &&
    boundary.clock.clampedFrames > 0 &&
    boundary.errors.length === 0;

  return {
    scene: {
      seed: 613,
      nodeCount: before.resource.nodeCount,
      duration: FIXED_SCENE_DURATION,
      fps: OPERATION_FPS,
    },
    scenarios: { before, after, boundary },
    checks: {
      outputsMatch,
      optimizationEffective,
      collisionChecksMatch,
      boundaryStable,
      noExceptions: Object.values({ before, after, boundary }).every(
        (scenario) => scenario.errors.length === 0,
      ),
    },
    passed: outputsMatch && optimizationEffective && collisionChecksMatch && boundaryStable,
  };
}
