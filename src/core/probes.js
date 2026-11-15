import { FixedStepClock } from "./simulation-clock.js";
import { PhysicsWorld } from "./world.js";
import { scriptedInputAt } from "./scripted-input.js";
import { PAUSE_MAX_RESUME_JUMP_PX } from "./benchmark.js";

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const runFrames = (world, clock, { frameCount, frameSeconds, timeScale = 1 }) => {
  for (let frame = 0; frame < frameCount; frame += 1) {
    clock.advance(frameSeconds, {
      timeScale,
      onStep: (dt) => world.step(dt, scriptedInputAt(world.time + dt)),
    });
  }
};

export function runPauseResumeProbe({
  fps = 60,
  warmupSeconds = 2,
  pauseSeconds = 1.5,
  resumeSeconds = 1,
} = {}) {
  const world = new PhysicsWorld({ broadphase: "grid", cache: true });
  const clock = new FixedStepClock();
  const frameSeconds = 1 / fps;

  runFrames(world, clock, {
    frameCount: Math.round(warmupSeconds * fps),
    frameSeconds,
  });

  const pausedSnapshot = world.sample(1);
  const pausedStepCount = world.stepCount;
  const heldInput = scriptedInputAt(world.time);
  let erroneousPausedSteps = 0;
  clock.setPaused(true);
  world.freezeInterpolation();

  for (let frame = 0; frame < Math.round(pauseSeconds * fps); frame += 1) {
    clock.advance(frameSeconds, {
      timeScale: 1,
      onStep: () => {
        erroneousPausedSteps += 1;
      },
    });
  }

  const afterPause = world.sample(clock.paused ? 1 : clock.alpha);
  const pausedPositionDeltaPx = distance(pausedSnapshot, afterPause);
  const pausedSimTimeDelta = world.time - pausedSnapshot.time;
  const thrusterDuringPause = clock.paused ? false : world.thrusterActive;

  clock.setPaused(false);
  const resumeTarget = world.sample(0);
  clock.advance(frameSeconds, {
    timeScale: 1,
    onStep: (dt) => world.step(dt, scriptedInputAt(world.time + dt)),
  });
  const firstResumedFrame = world.sample(clock.alpha);
  const resumeJumpPx = distance(resumeTarget, firstResumedFrame);
  const resumeSteps = world.stepCount - pausedStepCount;
  const resumedThruster = world.thrusterActive && scriptedInputAt(world.time).thrust;

  runFrames(world, clock, {
    frameCount: Math.round(resumeSeconds * fps),
    frameSeconds,
  });
  const finalSnapshot = world.sample(clock.alpha);
  const postResumeTravelPx = distance(afterPause, finalSnapshot);

  const checks = {
    pausedPositionStable: pausedPositionDeltaPx === 0,
    pausedClockStable: pausedSimTimeDelta === 0 && erroneousPausedSteps === 0,
    thrusterStopped: thrusterDuringPause === false,
    noResumeJump: resumeJumpPx <= PAUSE_MAX_RESUME_JUMP_PX,
    resumedSimulationContinues: resumeSteps > 0 && postResumeTravelPx > 0,
    heldThrustRestored: resumedThruster === true,
  };

  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    heldThrustInput: heldInput.thrust,
    thrusterDuringPause,
    pausedPositionDeltaPx: Number(pausedPositionDeltaPx.toFixed(6)),
    pausedSimTimeDelta: Number(pausedSimTimeDelta.toFixed(9)),
    resumeJumpPx: Number(resumeJumpPx.toFixed(4)),
    maxResumeJumpPx: PAUSE_MAX_RESUME_JUMP_PX,
    resumeSteps,
    postResumeTravelPx: Number(postResumeTravelPx.toFixed(4)),
    simTimeBeforePause: Number(pausedSnapshot.time.toFixed(6)),
    simTimeAfterResumeProbe: Number(world.time.toFixed(6)),
  };
}

export function runTimeScaleProbe({ fps = 60, simulatedSeconds = 2 } = {}) {
  const frameSeconds = 1 / fps;
  const play = (timeScale, realSeconds) => {
    const world = new PhysicsWorld({ broadphase: "grid", cache: true });
    const clock = new FixedStepClock();
    runFrames(world, clock, {
      frameCount: Math.round(realSeconds * fps),
      frameSeconds,
      timeScale,
    });
    return {
      state: world.getPublicState(),
      drainedSteps: clock.totalSteps,
      droppedSteps: clock.droppedSteps,
    };
  };

  const normal = play(1, simulatedSeconds);
  const double = play(2, simulatedSeconds / 2);
  const half = play(0.5, simulatedSeconds * 2);
  const positionDelta = (a, b) =>
    Math.hypot(a.ship.x - b.ship.x, a.ship.y - b.ship.y);
  const doubleDelta = positionDelta(normal.state, double.state);
  const halfDelta = positionDelta(normal.state, half.state);

  return {
    passed:
      doubleDelta < 1e-9 &&
      halfDelta < 1e-9 &&
      Math.abs(normal.state.simTime - double.state.simTime) < 1e-9 &&
      Math.abs(normal.state.simTime - half.state.simTime) < 1e-9,
    normal,
    double,
    half,
    doublePositionDeltaPx: Number(doubleDelta.toFixed(9)),
    halfPositionDeltaPx: Number(halfDelta.toFixed(9)),
    simulationSeconds: simulatedSeconds,
  };
}
