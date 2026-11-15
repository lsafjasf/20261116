import { PHASE, axisTelemetry, setCommands, step } from "./sim.js";

export function autopilotCommands(state) {
  const telemetry = axisTelemetry(state);
  if (state.phase === PHASE.RETREATING) {
    const desiredVd = 0.58;
    return {
      yaw: 0,
      pitch: 0,
      throttle: clamp((state.vd - desiredVd) * 8, -1, 1),
    };
  }
  if (state.phase !== PHASE.APPROACH && state.phase !== PHASE.HOLD) {
    return { yaw: 0, pitch: 0, throttle: 0 };
  }

  const desiredVx = clamp(-state.x * 0.6, -0.48, 0.48);
  const desiredVy = clamp(-state.y * 0.65, -0.42, 0.42);
  const desiredVd = clamp((1.02 - state.d) * 0.62, -0.55, 0.42);
  return {
    yaw: clamp((desiredVx - state.vx) * 8, -1, 1),
    pitch: clamp((desiredVy - state.vy) * 8, -1, 1),
    throttle: clamp((state.vd - desiredVd) * 8, -1, 1),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function runAutopilot(state, maxTicks, stepFn = step) {
  for (let index = 0; index < maxTicks; index += 1) {
    if (state.phase === PHASE.COMPLETE || state.phase === PHASE.FAILED) {
      break;
    }
    const commands = autopilotCommands(state);
    setCommands(state, commands);
    stepFn(state);
  }
  return state;
}
