import { FixedStepClock, DEFAULT_FIXED_DT } from "./simulation-clock.js";
import { PhysicsWorld } from "./world.js";
import { scriptedInputAt } from "./scripted-input.js";

export const TRAJECTORY_FPS = Object.freeze([30, 60, 144]);
export const REFERENCE_FPS = 480;
export const BENCHMARK_DURATION = 8;
export const CHECKPOINT_INTERVAL = 0.25;
export const PAUSE_MAX_RESUME_JUMP_PX = 12;

const runFixedStep = (world, dt) => {
  world.step(dt, scriptedInputAt(world.time + dt));
};

const clonePoint = (world, wallTime, alpha) => {
  const sample = world.sample(alpha);
  return { t: wallTime, x: sample.x, y: sample.y };
};

export function recordTrajectory({
  fps,
  duration = BENCHMARK_DURATION,
  fixedDt = DEFAULT_FIXED_DT,
  maxSubSteps = 8,
  broadphase = "grid",
  cache = true,
  frameDeltas,
} = {}) {
  if (!(fps > 0)) throw new RangeError("fps must be positive");
  const world = new PhysicsWorld({ broadphase, cache });
  const clock = new FixedStepClock({ fixedDt, maxSubSteps });
  const samples = [clonePoint(world, 0, 0)];
  const frameDt = 1 / fps;
  const frameCount = Math.ceil(duration * fps);
  let wallTime = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const delta = frameDeltas ? frameDeltas[frame % frameDeltas.length] : frameDt;
    wallTime += delta;
    clock.advance(delta, {
      timeScale: 1,
      onStep: (dt) => runFixedStep(world, dt),
    });
    samples.push(clonePoint(world, wallTime, clock.alpha));
  }

  return {
    fps,
    duration,
    samples,
    finalState: world.getPublicState(),
    fixedSteps: world.stepCount,
    droppedSteps: clock.droppedSteps,
  };
}

export function sampleTrajectoryAt(samples, time) {
  if (!samples.length) return null;
  if (time <= samples[0].t) return { x: samples[0].x, y: samples[0].y };
  const last = samples[samples.length - 1];
  if (time >= last.t) return { x: last.x, y: last.y };

  let low = 0;
  let high = samples.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (samples[middle].t <= time) low = middle;
    else high = middle;
  }
  const a = samples[low];
  const b = samples[high];
  const span = b.t - a.t;
  const t = span > 0 ? (time - a.t) / span : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

const distanceBetween = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function compareTrajectories(reference, candidate, duration = BENCHMARK_DURATION) {
  const checkpoints = [];
  const errors = [];
  const steps = Math.floor(duration / CHECKPOINT_INTERVAL);

  for (let index = 1; index <= steps; index += 1) {
    const time = Math.min(duration, index * CHECKPOINT_INTERVAL);
    const expected = sampleTrajectoryAt(reference.samples, time);
    const actual = sampleTrajectoryAt(candidate.samples, time);
    const error = distanceBetween(expected, actual);
    checkpoints.push({
      t: Number(time.toFixed(3)),
      expected: { x: Number(expected.x.toFixed(3)), y: Number(expected.y.toFixed(3)) },
      actual: { x: Number(actual.x.toFixed(3)), y: Number(actual.y.toFixed(3)) },
      errorPx: Number(error.toFixed(6)),
    });
    errors.push(error);
  }

  const mean = errors.reduce((sum, value) => sum + value, 0) / Math.max(1, errors.length);
  const rms = Math.sqrt(
    errors.reduce((sum, value) => sum + value * value, 0) / Math.max(1, errors.length),
  );
  const max = Math.max(0, ...errors);

  return {
    fps: candidate.fps,
    recordedSamples: candidate.samples.length,
    fixedSteps: candidate.fixedSteps,
    droppedSteps: candidate.droppedSteps,
    meanErrorPx: Number(mean.toFixed(4)),
    rmsErrorPx: Number(rms.toFixed(4)),
    maxErrorPx: Number(max.toFixed(4)),
    finalErrorPx: Number(errors[errors.length - 1].toFixed(4)),
    checkpoints,
  };
}

export function runTrajectoryBenchmark({
  duration = BENCHMARK_DURATION,
  includeCheckpoints = true,
} = {}) {
  const reference = recordTrajectory({
    fps: REFERENCE_FPS,
    duration,
    broadphase: "grid",
    cache: true,
  });
  const recordings = TRAJECTORY_FPS.map((fps) => recordTrajectory({ fps, duration }));
  const results = recordings.map((recording) => {
    const comparison = compareTrajectories(reference, recording, duration);
    if (!includeCheckpoints) delete comparison.checkpoints;
    return comparison;
  });
  const worstErrorPx = Math.max(...results.map((result) => result.maxErrorPx));

  return {
    duration,
    referenceFps: REFERENCE_FPS,
    results,
    worstErrorPx,
    passed: worstErrorPx <= 1,
  };
}
