// Scripted two-player inputs (each tick = 0.05s). These are the actual rescue
// runs verified in Node and replayed in the browser; they also double as the
// autopilot demo for human review.

// Successful cooperative rescue: measured winch, gentle steering around weak
// ice, rail repositioning kept inside the anchor rails, no overlapping jerks.
export function successInput(tick) {
  const input = {
    winch: 0.6,
    leftY: 0,
    steerX: 0,
    steerY: 0,
    rightY: 0,
    leftJerk: false,
    rightJerk: false,
    order: ['left', 'right'],
  };
  // Guide away from the lower-right weak pocket (Z rows 3-4, cols 7-8).
  if (tick >= 30 && tick < 95) input.steerY = -0.7;
  if (tick >= 120 && tick < 170) input.steerY = 0.55;
  // Rail travel demonstrates the anchor-limited movement range on both sides.
  if (tick >= 10 && tick < 46) input.leftY = -1;
  if (tick >= 150 && tick < 190) input.rightY = 1;
  // Ease off the winch near the shore to avoid snap tension.
  if (tick >= 300) input.winch = 0.42;
  if (tick >= 380) input.winch = 0.3;
  return input;
}

// Failed rescue: aggressive winch plus repeated simultaneous opposite jerks.
// Crack propagation reaches a weak zone and the ice breaks.
export function failureInput(tick) {
  const input = {
    winch: tick < 60 ? 0.72 : 0.85,
    leftY: 0,
    steerX: tick % 24 < 12 ? 0.6 : -0.6,
    steerY: 0,
    rightY: tick % 60 < 30 ? 0.5 : -0.5,
    leftJerk: tick >= 40 && tick % 8 === 2,
    rightJerk: tick >= 40 && tick % 8 === 2,
    order: ['left', 'right'],
  };
  if (tick > 150) {
    input.leftJerk = false;
    input.rightJerk = false;
  }
  return input;
}

export const SCENARIOS = [
  { id: 'success', label: '协同救援·成功', input: successInput, expect: 'success' },
  { id: 'failure', label: '粗暴牵引·冰裂失败', input: failureInput, expect: 'failure' },
];
