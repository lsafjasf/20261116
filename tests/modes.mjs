import { createSim, step, recover, hashState } from '../src/engine.js';
import { autopilotInput } from '../src/autopilot.js';
for (const mode of ['mistake', 'extreme']) {
  const s = createSim(2026);
  let n = 0, sawRunaway = false, maxSpeed = 0;
  while (n < 3000 && s.phase !== 'SURFACED' && s.phase !== 'FAILED') {
    step(s, autopilotInput(s, mode));
    sawRunaway = sawRunaway || s.phase === 'RUNAWAY';
    maxSpeed = Math.min(maxSpeed, s.vs);
    n++;
  }
  console.log(`\n[${mode}] end=${s.phase} reason=${s.failReason} runaway=${sawRunaway} maxClimb=${(-maxSpeed).toFixed(2)}m/s tick=${n}`);
  console.log('  depth', s.depth.toFixed(1), 'hull', s.hull.toFixed(1), 'bat', s.battery.toFixed(1),
    'temp', s.temp.toFixed(1), 'collected', s.collected);
  console.log('  timeline:', s.stateChanges.filter(c=>['RUNAWAY','FAILED','SURFACED'].includes(c.phase))
    .map(c=>`t${c.tick}:${c.phase}:${c.text}`).join(' | '));
  if (s.phase === 'FAILED') {
    const cpTicks = s.checkpoints.map(c => c.tick);
    const ok = recover(s);
    console.log('  RECOVER ->', ok, 'restored tick', s.tick, 'phase', s.phase, 'checkpoints', cpTicks);
    let m = 0;
    while (m < 3000 && s.phase !== 'SURFACED' && s.phase !== 'FAILED') {
      step(s, autopilotInput(s, 'safe')); m++;
    }
    console.log('  after recovery continue(safe):', s.phase, 'success', s.success, 'collected', s.collected, 'hash', hashState(s));
  }
}
