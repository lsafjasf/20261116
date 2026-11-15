import { mkdir, writeFile } from "node:fs/promises";
import { runComparison } from "../src/scenarios.js";

const result = runComparison();
await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/cache-benchmark.json",
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8",
);

const rows = [
  ["final visual", result.before.visualHash, result.after.visualHash, result.boundary.visualHash],
  ["public document", result.before.documentHash, result.after.documentHash, result.boundary.documentHash],
  ["exceptions", result.before.exceptions.length, result.after.exceptions.length, result.boundary.exceptions.length],
  ["recomputes", result.before.totalRecomputes, result.after.totalRecomputes, result.boundary.totalRecomputes],
  ["candidates", result.before.candidateTotal, result.after.candidateTotal, result.boundary.candidateTotal],
  ["hit rate", result.before.hitRate.toFixed(3), result.after.hitRate.toFixed(3), result.boundary.hitRate.toFixed(3)],
  ["dangling refs", result.before.danglingCount, result.after.danglingCount, result.boundary.danglingCount],
  ["nodes", result.before.nodeCount, result.after.nodeCount, result.boundary.nodeCount],
  ["cache entries", result.before.cacheEntries, result.after.cacheEntries, result.boundary.cacheEntries],
];

console.log("mode                 before      after       boundary");
for (const row of rows) {
  console.log(
    `${String(row[0]).padEnd(20)} ${String(row[1]).padEnd(11)} ${String(row[2]).padEnd(11)} ${row[3]}`,
  );
}
console.log("");
console.log(`semantic equivalent: ${result.summary.semanticEquivalent}`);
console.log(`boundary equivalent: ${result.summary.boundaryEquivalent}`);
console.log(`recompute saved: ${(result.summary.recomputeSaved * 100).toFixed(1)}%`);
console.log(`verdict: ${result.summary.pass ? "PASS" : "FAIL"}`);
console.log("report: artifacts/cache-benchmark.json");
if (!result.summary.pass) process.exitCode = 1;
