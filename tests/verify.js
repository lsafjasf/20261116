/*
 * End-to-end verification entry point.
 * Runs every suite and prints one consolidated report. Exit non-zero on fail.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const suites = [
  ['Deterministic simulation (9 checks)', 'run-tests.js'],
  ['Web Audio lifecycle/reset', 'audio-test.js'],
  ['Browser bundle smoke (DOM/Canvas/Audio)', 'browser-smoke.js']
];

let failed = 0;
for (const [label, file] of suites) {
  process.stdout.write('\n=== ' + label + ' ===\n');
  try {
    const out = execFileSync(
      process.execPath, [path.join(__dirname, file)], { encoding: 'utf8' });
    process.stdout.write(out);
  } catch (err) {
    failed++;
    process.stdout.write(err.stdout || '');
    process.stdout.write(err.stderr || '');
    process.stdout.write('SUITE FAILED: ' + label + '\n');
  }
}

process.stdout.write('\n=== Replay hash verification (artifacts) ===\n');
const fs = require('fs');
const { Simulation } = require('../js/sim.js');
const dir = path.join(__dirname, '..', 'artifacts', 'records');
for (const name of ['success', 'mistake', 'extreme']) {
  const record = JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8'));
  const a = Simulation.replay(record).hash;
  const b = Simulation.replay(record).hash;
  const ok = a === b;
  if (!ok) failed++;
  process.stdout.write(
    (ok ? 'PASS' : 'FAIL') + ' ' + name + ' replay hash stable: ' + a + '\n');
}

process.exit(failed === 0 ? 0 : 1);
