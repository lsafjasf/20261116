import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = ['engine.test.mjs', 'crew.test.mjs', 'replay-file.test.mjs', 'app.test.mjs'];
let failed = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const r = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit' });
  if (r.status !== 0) failed += 1;
}
if (failed) { console.error(`\n${failed} suite(s) failed`); process.exit(1); }
console.log('\nALL SUITES GREEN');
