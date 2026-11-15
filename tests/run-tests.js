import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAllScenarios } from './scenarios.js';

const here = dirname(fileURLToPath(import.meta.url));
const startedAt = new Date().toISOString();
let results;
try {
  results = runAllScenarios();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  results = [{ name: 'fatal', ok: false, error: error.message }];
}

const passed = results.filter((item) => item.ok).length;
const failed = results.length - passed;
const payload = {
  suite: 'multimedia-timeline self-check',
  startedAt,
  endedAt: new Date().toISOString(),
  passed,
  failed,
  results,
};

for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : ` -> ${item.error}`}`);
}
console.log(`\n${passed}/${results.length} passed, ${failed} failed`);

const outPath = resolve(here, '../artifacts/self-check-results.json');
writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`证据文件: ${outPath}`);

if (failed > 0) process.exitCode = 1;
