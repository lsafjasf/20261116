import * as C from './constants.js';

// Deterministic input generator shared by live runs and replays.
// mode: 'safe' = full successful mission; 'mistake' = keeps blowing ballast
// (triggers runaway ascent); 'extreme' = floodlights on + full speed + max depth.
export function autopilotInput(s, mode = 'safe') {
  const input = [0, 0, 0, 0, 0, 0, 1, 0]; // engine on by default
  const target = s.samples[s.nextSampleId];

  if (mode === 'mistake') {
    // First dive properly, then a panicked emergency blow with no flooding
    // reaction while the alarm is screaming -> runaway ascent.
    if (s.depth < 40 && s.ballast > C.BALLAST_NEUTRAL - 0.05) {
      input[C.INPUT.FLOOD] = 1;
      input[C.INPUT.LIGHT] = 1;
    } else {
      input[C.INPUT.BLOW] = 1;
      input[C.INPUT.LIGHT] = 0;
      if (s.phase === C.PHASE.RUNAWAY) input[C.INPUT.FLOOD] = 0; // operator error
    }
    return input;
  }

  if (mode === 'extreme') {
    input[C.INPUT.LIGHT] = 2;               // floodlights the whole dive
    input[C.INPUT.THRUST] = 1;              // full forward, light starves power
    input[C.INPUT.FLOOD] = 1;               // keep flooding toward crush depth
    if (s.depth > C.SAFE_DEPTH + 8) input[C.INPUT.FLOOD] = 0;
    return input;
  }

  // ---- safe mission ----
  if (s.phase === C.PHASE.RUNAWAY) {
    input[C.INPUT.FLOOD] = 1;               // correct runaway reaction
    return input;
  }
  const allDone = s.collected >= C.SAMPLE_COUNT_GOAL;
  const goalDepth = allDone ? 0 : target.depth;
  const depthErr = goalDepth - s.depth;
  input[C.INPUT.LIGHT] = (!allDone && s.depth > 15) ? 1 : 0;

  // Station B: damped P-controller. Ballast > 0.5 sinks, < 0.5 rises.
  // Braking authority increases with speed to avoid runaway / overshoot.
  const wantSink = depthErr * 0.045 - s.vs * 1.1;
  if (allDone) {
    // Rate-controlled ascent: hold ~0.6 m/s climb, brake harder near surface.
    const targetVs = s.depth < 6 ? -0.35 : -0.6;
    if (s.vs <= targetVs - 0.3) input[C.INPUT.FLOOD] = 1;
    else if (s.vs >= targetVs + 0.3) input[C.INPUT.VENT] = 1;
    else if (s.vs > targetVs) input[C.INPUT.VENT] = 1;
    else input[C.INPUT.NEUTRAL] = 1;
  } else if (wantSink > 0.12) {
    input[C.INPUT.FLOOD] = 1;
  } else if (wantSink < -0.12) {
    input[C.INPUT.VENT] = 1;
  } else {
    input[C.INPUT.NEUTRAL] = 1;
  }

  // Station A: horizontal alignment and sampler.
  if (!allDone) {
    const dx = target.x - s.x;
    if (dx > 1.2) input[C.INPUT.THRUST] = 1;
    else if (dx < -1.2) input[C.INPUT.THRUST] = -1;
    if (Math.abs(dx) <= C.SAMPLE_RADIUS
        && Math.abs(s.depth - target.depth) <= C.SAMPLE_RADIUS) {
      input[C.INPUT.SAMPLE] = 1;
    }
  }
  return input;
}

// Run a simulation headlessly until a terminal phase or tick cap.
export function runHeadless(seed, mode, maxTicks = 4000, stepFn, createFn) {
  const s = createFn(seed);
  let frames = 0;
  while (frames < maxTicks
    && s.phase !== C.PHASE.SURFACED
    && s.phase !== C.PHASE.FAILED) {
    stepFn(s, autopilotInput(s, mode));
    frames += 1;
  }
  return { s, frames };
}
