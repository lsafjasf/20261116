// Scripted two-player controllers. Both emit the same per-tick input structure
// a human pair would produce through the keyboard, so a bot run and a live run
// are indistinguishable to the simulation core.

import {
  SCRIPT,
  COLORS,
  HEAT_LIMIT,
  angleForZone,
  emptyInput,
} from './engine.js';

function aimAt(input, state, targetAngle) {
  const deadzone = 0.6;
  if (state.angle < targetAngle - deadzone) input.p2.rightHold = true;
  else if (state.angle > targetAngle + deadzone) input.p2.leftHold = true;
}

function colorSteps(fromIndex, targetColor) {
  const target = COLORS.indexOf(targetColor);
  return (target - fromIndex + COLORS.length) % COLORS.length;
}

// A competent pair: P1 keeps the master light bright and powered,
// P2 pre-aims the rig and pre-cycles the gel for each upcoming cue.
export function successBot(state) {
  const input = emptyInput();
  if (state.status !== 'running') return input;

  // Cue whose window contains this tick; null during a transition gap.
  const current = SCRIPT.find((c) => state.tick >= c.start && state.tick < c.end);
  const cue = current || SCRIPT[Math.min(state.cueIndex + 1, SCRIPT.length - 1)];
  const inGap = !current;

  // P1: breaker + brightness target of 70 (above the 55 threshold).
  // Suppress the auto-restore while the scripted conflict sequence is armed.
  const conflictArmed = state.tick >= 60 && state.tick <= 62;
  if (!state.power && !conflictArmed) input.p1.powerEdge = true;
  if (state.brightness < 70) input.p1.brightDeltaHold = 3;

  const upcoming = SCRIPT[Math.min(cue.index + 1, SCRIPT.length - 1)];
  // During a gap, pre-cycle the gel and rotate toward the next cue.
  // Inside a window, hold the current cue's colour and position.
  const target = inGap && upcoming ? upcoming : cue;
  if (colorSteps(state.colorIndex, target.targetColor) > 0) input.p2.colorEdge = true;
  const targetAngle = angleForZone(target.targetZone);

  // Thermal discipline: ease off near the hard limit, and use transition gaps
  // to shed heat once the next cue is already roughly lined up.
  const tooHot = state.heat > HEAT_LIMIT * 0.82;
  const aligned = Math.abs(state.angle - targetAngle) < 6;
  if (!(tooHot || (inGap && aligned && state.heat > 45))) {
    aimAt(input, state, targetAngle);
  }

  // Deterministic shared-channel conflict in the first transition gap (the
  // rig is powered off first so the two orderings genuinely diverge):
  //   P1-first ordering -> interlock then wins -> power stays OFF
  //   P2-first ordering -> breaker toggle then wins -> power ends ON
  // Deterministic resolution: the safety interlock (P2) always wins.
  if (state.tick === 60) input.p1.powerEdge = true; // power off at gap start
  if (state.tick === 62) input.p1.powerEdge = true; // breaker press (would turn on)
  if (state.tick === 62) input.p2.cutEdge = true;   // simultaneous interlock press
  if (state.tick === 63) input.p1.powerEdge = true; // restore for the next cue

  return input;
}

// A careless pair: rig is left unrotated and the breaker is cut, so the first
// cue is never satisfied and a dark-field incident follows quickly.
export function failureBot(state) {
  const input = emptyInput();
  if (state.status !== 'running') return input;
  if (state.tick === 2) input.p1.powerEdge = true;   // briefly power on
  if (state.tick === 6) input.p2.cutEdge = true;      // P2 interlock cuts it
  if (state.tick === 10) input.p2.colorEdge = true;   // irrelevant: wrong zone anyway
  return input;
}
