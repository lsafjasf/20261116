/*
 * Scripted co-pilot: deterministic stand-in for the two human players.
 * Player A steers rotation toward the next sailing ship;
 * Player B manages power / lamp so heat and hazard stay survivable.
 */
const {
  Simulation, CENTER, clamp, angDiff, dist
} = require('../js/sim.js');

function bearingTo(sim, obj) {
  return Math.atan2(obj.y - CENTER.y, obj.x - CENTER.x);
}

function pickTarget(sim) {
  const sailing = sim.ships.filter((s) => s.state === 'sailing');
  if (sailing.length === 0) return null;
  let best = null;
  let bestScore = Infinity;
  for (const ship of sailing) {
    let nearestReef = Infinity;
    for (const reef of sim.reefs) {
      const d = dist(ship.x, ship.y, reef.x, reef.y) - reef.r;
      if (d < nearestReef) nearestReef = d;
    }
    // Leftmost ships have spent longest drifting; reef proximity adds danger.
    const score = ship.x - Math.max(0, 120 - nearestReef) * 1.5;
    if (score < bestScore) {
      bestScore = score;
      best = ship;
    }
  }
  return best;
}

// Careful cooperative pilot: escort one ship to the harbour at a time.
function carefulPilot(sim) {
  const ship = pickTarget(sim);
  if (!ship) return { rot: 0, power: 0, lamp: null, target: null };

  const target = bearingTo(sim, ship);
  const diff = angDiff(target, sim.angle);
  const rot = clamp(diff * 4, -1, 1);

  let power = 0;
  const aligned = Math.abs(diff) < Math.max(0.05, sim.beam.half * 0.6);
  if (sim.heat > 90) power = -1;
  else if (sim.hazard > 45) power = -0.8;
  else if (sim.hazard > 55) power = -0.4;
  else if (sim.reefLitMask !== 0 && sim.power > 0.55) power = -0.15;
  else if (aligned && sim.power > 0.66) power = -0.15;
  else if (sim.power < 0.46) power = 0.9;

  let lamp = null;
  if (sim.mode === 'running') {
    if (sim.heat >= 95) lamp = false;
    else if (sim.heat <= 55 && !sim.lampOn) lamp = true;
  }
  return { rot, power, lamp, target: ship.id };
}

// Greedy pilot: max output, never manages heat. Used for the extreme run.
function greedyPilot(sim) {
  const ship = sim.ships.find((s) => s.state === 'sailing');
  if (!ship) return { rot: 0, power: 1, lamp: null };
  const diff = angDiff(bearingTo(sim, ship), sim.angle);
  return { rot: clamp(diff / 0.12, -1, 1), power: 1, lamp: null };
}

// Negligent pilot: lamp pointed away, ships drift onto reefs / out of map.
function negligentPilot(sim) {
  return { rot: 1, power: -1, lamp: sim.stepCount % 240 < 30 ? true : null };
}

// Success-route pilot factory: deliberately push full output until the
// chamber overheats (overheat -> forced cooldown -> recovery), then fly
// carefully to dock every ship. Closure state keeps replays independent.
function makeSuccessPilot() {
  let phase = 'overheat-demo';
  return function successPilot(sim) {
    if (phase === 'overheat-demo') {
      const ship = pickTarget(sim);
      const target = ship ? bearingTo(sim, ship) : sim.angle;
      const rot = clamp(angDiff(target, sim.angle) * 4, -1, 1);
      if (sim.mode === 'overheat') phase = 'careful';
      return { rot, power: 1, lamp: null, target: ship ? ship.id : null };
    }
    return carefulPilot(sim);
  };
}

function runWithPilot(seed, pilot, opts) {
  opts = opts || {};
  const sim = new Simulation(seed);
  sim.start();
  const maxSteps = opts.maxSteps || 3000;
  const overheatEvents = [];
  const hashTrace = [];

  for (let i = 0; i < maxSteps; i++) {
    const input = pilot(sim, i) || {};
    sim.applyInput(input);
    const prevMode = sim.mode;
    sim.step();
    if (prevMode !== 'overheat' && sim.mode === 'overheat') {
      overheatEvents.push(sim.stepCount);
    }
    if (opts.traceEvery && i % opts.traceEvery === 0) {
      hashTrace.push({ step: sim.stepCount, hash: sim.stateHash() });
    }
    if (sim.mode === 'success' || sim.mode === 'failed') break;
  }
  return { sim, overheatEvents, hashTrace };
}

module.exports = {
  carefulPilot,
  greedyPilot,
  negligentPilot,
  runWithPilot,
  bearingTo,
  pickTarget,
  makeSuccessPilot
};
