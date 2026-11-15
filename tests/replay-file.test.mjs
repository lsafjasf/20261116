import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replayHash } from '../src/replay.js';

const saved = JSON.parse(readFileSync(new URL('../artifacts/safe-input-log.json', import.meta.url)));
const { hash, sim } = replayHash(saved.seed, saved.log);

assert.equal(hash, saved.hash, 'replayed hash must equal the saved final hash');
assert.equal(sim.tick, saved.ticks);
assert.equal(sim.success, true);
assert.equal(sim.collected, 3);
assert.equal(sim.phase, 'SURFACED');
assert.equal(sim.inputLog.length, saved.log.length);
console.log('  ✓ saved seed + input record replays to identical hash:', hash);
console.log('  ✓ replayed mission success, samples', sim.collected, '/ 3, ticks', sim.tick);
console.log('\nreplay-file test passed');
