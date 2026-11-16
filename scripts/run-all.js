import { suite as defaultSuite } from "../test/default-params.test.js";
import { suite as boundarySuite } from "../test/boundary-params.test.js";
import { suite as exceptionSuite } from "../test/exception-params.test.js";

const started = performance.now();
const allResults = [];
for (const suite of [defaultSuite, boundarySuite, exceptionSuite]) {
  process.stdout.write(`\n${suite.suiteName}\n`);
  const results = await suite.run();
  for (const result of results) {
    allResults.push(result);
    process.stdout.write(`  ${result.ok ? "PASS" : "FAIL"}  ${result.name}\n`);
    if (!result.ok) process.stdout.write(`        ${result.error.stack}\n`);
  }
}

const passed = allResults.filter((result) => result.ok).length;
const failed = allResults.length - passed;
const elapsed = (performance.now() - started).toFixed(1);
process.stdout.write(`\n${passed} passed, ${failed} failed, ${allResults.length} total (${elapsed} ms)\n`);
process.exitCode = failed === 0 ? 0 : 1;
