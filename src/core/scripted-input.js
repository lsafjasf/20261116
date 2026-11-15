const smoothTurn = (time, start, end, from, to) => {
  if (time <= start) return from;
  if (time >= end) return to;
  const t = (time - start) / (end - start);
  const eased = t * t * (3 - 2 * t);
  return from + (to - from) * eased;
};

export function scriptedInputAt(simTime) {
  let thrust = false;
  let turn = 0;

  if (simTime < 1.15) {
    thrust = true;
  } else if (simTime < 2.55) {
    thrust = true;
    turn = smoothTurn(simTime, 1.15, 1.55, 0, 0.52);
  } else if (simTime < 3.35) {
    thrust = false;
    turn = smoothTurn(simTime, 2.55, 3.05, 0.52, -0.42);
  } else if (simTime < 4.85) {
    thrust = true;
    turn = smoothTurn(simTime, 3.35, 4.15, -0.42, 0.18);
  } else if (simTime < 6.1) {
    thrust = false;
    turn = smoothTurn(simTime, 4.85, 5.45, 0.18, -0.72);
  } else if (simTime < 7.55) {
    thrust = true;
    turn = smoothTurn(simTime, 6.1, 6.7, -0.72, 0);
  }

  return { thrust, turn };
}

export const scriptedInputLabel = (input) => {
  if (input.thrust && input.turn) return "THRUST + TURN";
  if (input.thrust) return "THRUST";
  if (input.turn) return "ATTITUDE";
  return "COAST";
};
