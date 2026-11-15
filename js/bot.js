import { DT, PAN_SPEED, TILT_SPEED, APERTURE_STOPS, SHUTTER_STOPS, FOCUS_SPEED } from './constants.js';
import { allTargetPositions, TARGETS, lightAt } from './scene.js';
import { project, emptyInput } from './sim.js';

function aimAt(input, state, pos, gain = 0.55) {
  const pr = project(state, pos);
  if (!pr) return;
  const yawStep = PAN_SPEED * DT;
  const tiltStep = TILT_SPEED * DT;
  input.left.pan = Math.max(-1, Math.min(1, pr.u * gain / yawStep));
  input.left.tilt = Math.max(-1, Math.min(1, pr.v * gain / tiltStep));
}

function trackFocus(input, state, pos) {
  const pr = project(state, pos);
  if (!pr) return;
  const diff = pr.depth - state.focus;
  if (Math.abs(diff) > 0.35) {
    input.right.focusDir = Math.sign(diff) * Math.min(1, Math.abs(diff) / (FOCUS_SPEED * DT));
  }
}

// Drive shutter (primary) and aperture (fallback) to bring camera EV onto
// the metered scene EV. Index up = slower shutter = lower camera EV.
function trackExposure(input, state, targetEv) {
  const evNow = Math.log2(
    APERTURE_STOPS[state.apertureIdx] ** 2 / SHUTTER_STOPS[state.shutterIdx],
  );
  const stopError = targetEv - evNow;
  if (Math.abs(stopError) <= 0.3) return;
  // Pick the fastest shutter whose smear stays under the blur gate, then let
  // the aperture ring absorb whatever EV difference remains.
  const fastShutterIdx = 4; // 1/250 s
  const candidateAperture = clampStep(
    state.apertureIdx + Math.round(
      targetEv - Math.log2(
        APERTURE_STOPS[state.apertureIdx] ** 2 / SHUTTER_STOPS[fastShutterIdx],
      ),
    ),
    0, APERTURE_STOPS.length - 1,
  );
  const evCandidate = Math.log2(
    APERTURE_STOPS[candidateAperture] ** 2 / SHUTTER_STOPS[fastShutterIdx],
  );
  let shutterIdx = fastShutterIdx;
  if (targetEv - evCandidate < -0.35 && fastShutterIdx < SHUTTER_STOPS.length - 1) {
    shutterIdx = fastShutterIdx + 1;   // aperture maxed out: one stop slower
  }
  if (state.shutterIdx !== shutterIdx) {
    input.right.shutterStep = shutterIdx - state.shutterIdx;
  }
  const evWithShutter = Math.log2(
    APERTURE_STOPS[state.apertureIdx] ** 2 / SHUTTER_STOPS[shutterIdx],
  );
  const apertureNeeded = Math.round(targetEv - evWithShutter);
  if (apertureNeeded !== 0) {
    input.right.apertureStep = clampStep(
      apertureNeeded, -state.apertureIdx,
      APERTURE_STOPS.length - 1 - state.apertureIdx,
    );
  }
}

function clampStep(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function evFor(pos) {
  return lightAt(pos.x, 0) - Math.log2(Math.max(1, pos.z / 10));
}

// Cooperative autopilot: left player tracks the gimbal, right player dials
// focus and exposure. Fire ticks are the moments the two players agree on.
export function botFrame(state, tick, opts = {}) {
  const input = emptyInput();
  const target = TARGETS.find((item) => item.id === opts.targetId) || TARGETS[0];
  const pos = allTargetPositions(tick).find((item) => item.id === target.id);
  if (opts.aimAway) {
    input.left.pan = 1;
  } else {
    aimAt(input, state, pos);
    trackFocus(input, state, pos);
    trackExposure(input, state, evFor(pos));
  }
  if (opts.defocus) input.right.focusDir = 1; // pull focus far while shooting
  if (opts.fireTicks && opts.fireTicks.includes(state.tick + 1)) {
    input.right.shutter = true;
  }
  return input;
}

export function planSuccess() {
  // Three distinct targets plus one deliberately out-of-focus verification
  // shot; 6 rolls -> 4 used, leaving 2 spare rolls.
  return [
    { start: 80, end: 160, targetId: 'bird', fireTicks: [120] },
    { start: 270, end: 320, targetId: 'cyclist', fireTicks: [310], defocus: true },
    { start: 321, end: 352, targetId: 'cyclist', fireTicks: [345] },
    { start: 450, end: 550, targetId: 'lantern', fireTicks: [500] },
  ];
}

export function planFailure() {
  // Every shutter press points at empty sky; six rejected shots burn all film.
  const fire = [60, 120, 180, 240, 300, 360];
  return [{ start: 0, end: 400, targetId: 'bird', fireTicks: fire, aimAway: true }];
}

export function scriptInput(state, tick, plan) {
  const phase = plan.find((item) => tick >= item.start && tick <= item.end);
  if (!phase) return emptyInput();
  return botFrame(state, tick, phase);
}

export function describeControls() {
  return {
    left: { pan: 'W/S 或方向上下', tilt: 'A/D' },
    right: { focus: 'I/K', aperture: 'T/G', shutter: 'R/F', zoom: 'Q/E', fire: '空格' },
  };
}
