import { createSim, step, hashState } from './engine.js';

// Replays a recorded input log against a fresh sim of the same seed.
// onFrame fires after each tick so the UI can render frame-by-frame.
export function replayFromLog(seed, inputLog, onFrame, speedTicks = 1) {
  const sim = createSim(seed);
  let index = 0;
  const timer = setInterval(() => {
    for (let k = 0; k < speedTicks && index < inputLog.length; k++) {
      step(sim, inputLog[index].i);
      index += 1;
    }
    onFrame?.(sim, index, inputLog.length);
    if (index >= inputLog.length) {
      clearInterval(timer);
      onFrame?.(sim, index, inputLog.length, { done: true, hash: hashState(sim) });
    }
  }, 100);
  return {
    stop: () => clearInterval(timer),
    get sim() { return sim; },
  };
}

// Headless replay for tests / hash verification.
export function replayHash(seed, inputLog) {
  const sim = createSim(seed);
  for (const frame of inputLog) step(sim, frame.i);
  return { sim, hash: hashState(sim) };
}
