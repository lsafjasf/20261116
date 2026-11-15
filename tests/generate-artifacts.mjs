import { writeFileSync } from 'node:fs';
import * as C from '../src/constants.js';
import { createSim, step, recover, hashState } from '../src/engine.js';
import { autopilotInput } from '../src/autopilot.js';
import { replayHash } from '../src/replay.js';

const SEED = 2026;
const report = { generatedAt: new Date().toISOString(), seed: SEED, tickMs: C.TICK_MS, scenarios: {} };

function runScenario(mode, cap = 3000) {
  const s = createSim(SEED);
  const trace = [];
  let n = 0, maxClimb = 0, maxDepth = 0;
  while (n < cap && s.phase !== 'SURFACED' && s.phase !== 'FAILED') {
    step(s, autopilotInput(s, mode));
    maxClimb = Math.max(maxClimb, -s.vs);
    maxDepth = Math.max(maxDepth, s.depth);
    if (n % 25 === 0) trace.push({
      t: s.tick, phase: s.phase, depth: +s.depth.toFixed(1), vs: +s.vs.toFixed(2),
      bat: +s.battery.toFixed(1), o2: +s.o2.toFixed(1), temp: +s.temp.toFixed(1),
      hull: +s.hull.toFixed(1), samples: s.collected,
    });
    n++;
  }
  const replay = replayHash(SEED, s.inputLog);
  return {
    mode, ticks: s.tick, durationSec: s.timeMs / 1000, finalPhase: s.phase,
    failReason: s.failReason, success: s.success, collected: s.collected,
    maxClimbSpeed: +maxClimb.toFixed(2), maxDepth: +maxDepth.toFixed(1),
    runawayEvents: s.stateChanges.filter((c) => c.phase === 'RUNAWAY').length,
    finalHash: hashState(s), replayHash: replay.hash, hashesMatch: replay.hash === hashState(s),
    stateChanges: s.stateChanges.map((c) => ({ t: c.tick, phase: c.phase, text: c.text })),
    trace,
  };
}

report.scenarios.safe = runScenario('safe');
report.scenarios.mistake = runScenario('mistake');
report.scenarios.extreme = runScenario('extreme');

// Persist the successful run's full input record for later replay/hash checks.
{
  const s = createSim(SEED);
  let n = 0;
  while (n < 3000 && s.phase !== 'SURFACED' && s.phase !== 'FAILED') {
    step(s, autopilotInput(s, 'safe')); n++;
  }
  writeFileSync(new URL('../artifacts/safe-input-log.json', import.meta.url),
    JSON.stringify({ seed: SEED, ticks: s.tick, hash: hashState(s), log: s.inputLog }));
}

// Failure recovery flow on the mistake scenario, including post-recovery completion.
{
  const s = createSim(SEED);
  let n = 0;
  while (n < 600 && s.phase !== 'FAILED') { step(s, autopilotInput(s, 'mistake')); n++; }
  const before = { tick: s.tick, phase: s.phase, reason: s.failReason };
  const checkpointTick = s.checkpoints.at(-1).tick;
  const rngBeforeRecover = JSON.stringify(s.rng.save());
  const recovered = recover(s);
  let m = 0;
  while (m < 3000 && s.phase !== 'SURFACED' && s.phase !== 'FAILED') {
    step(s, autopilotInput(s, 'safe')); m++;
  }
  report.recovery = {
    failure: before, checkpointTick, rngRolledBack: JSON.stringify(s.rng.save()) !== rngBeforeRecover,
    recovered, postRecoveryPhase: s.phase, postRecoverySuccess: s.success,
    recoveredCount: s.recoveredCount, finalHash: hashState(s),
  };
}

// Full restart reset verification.
{
  const s = createSim(SEED);
  for (let t = 0; t < 120; t++) step(s, autopilotInput(s, 'safe'));
  const fresh = createSim(SEED);
  report.restartReset = {
    dirtyTick: s.tick, freshTick: fresh.tick, freshTimeMs: fresh.timeMs,
    resources: { battery: fresh.battery, o2: fresh.o2, hull: fresh.hull, temp: fresh.temp },
    inputLogCleared: fresh.inputLog.length === 0,
    rngReinitialized: JSON.stringify(fresh.rng.save()) === JSON.stringify(createSim(SEED).rng.save()),
    freshHash: hashState(fresh),
  };
}

writeFileSync(new URL('../artifacts/verification-report.json', import.meta.url), JSON.stringify(report, null, 2));

console.log(JSON.stringify({
  safe: { ...pick(report.scenarios.safe), hashesMatch: report.scenarios.safe.hashesMatch },
  mistake: pick(report.scenarios.mistake),
  extreme: pick(report.scenarios.extreme),
  recovery: report.recovery,
  restart: report.restartReset,
}, null, 2));

function pick(x) {
  return {
    finalPhase: x.finalPhase, failReason: x.failReason, success: x.success,
    ticks: x.ticks, maxClimbSpeed: x.maxClimbSpeed, maxDepth: x.maxDepth,
    runawayEvents: x.runawayEvents, finalHash: x.finalHash, hashesMatch: x.hashesMatch,
  };
}
