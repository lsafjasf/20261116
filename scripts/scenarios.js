// Runs the three fixed scenarios and writes a machine-readable report plus a
// human summary. Semantic equivalence is asserted on canonical hashes:
// pre vs post must produce identical game output with different perf counters.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS, runScenario } from "./scenario_lib.js";
import { stableStringify } from "../src/core/checksum.js";

const outDir = join(process.cwd(), "userdata", "reports");
mkdirSync(outDir, { recursive: true });

const results = Object.entries(SCENARIOS).map(([name, config]) =>
  runScenario(name, config),
);

const [pre, post, edge] = results;

// The cache must change only performance, never the paths/state. Compare the
// full canonical snapshots excluding nothing: maps, progress, settings and
// replay summaries are all part of the public data contract.
const semanticEqual =
  stableStringify(pre.snapshot) === stableStringify(post.snapshot);

const performanceImproved =
  post.metrics.nodesExpanded <= pre.metrics.nodesExpanded &&
  post.metrics.cache.hits > 0 &&
  post.metrics.cache.hitRate > 0;

// Edge runs a different, deliberately hostile configuration, so its output is
// expected to differ; the contract there is "no crash and structured errors".
const edgeSurvived =
  edge.errors.every((entry) => entry.code === "UNREACHABLE") ||
  edge.errors.length === 0;

const report = {
  generatedAt: new Date().toISOString(),
  scenarios: results.map(stripSnapshot),
  assertions: {
    prePostSemanticEqual: semanticEqual,
    preOutputHash: pre.outputHash,
    postOutputHash: post.outputHash,
    cacheImprovement: performanceImproved,
    edgeHandledWithoutUnexpectedError: edgeSurvived,
  },
};

function stripSnapshot(result) {
  const { snapshot, ...rest } = result;
  return rest;
}

writeFileSync(
  join(outDir, "scenario-report.json"),
  JSON.stringify(report, null, 2),
);

for (const result of results) {
  console.log("\n=== " + result.label + " (" + result.name + ") ===");
  console.log("output hash      :", result.outputHash);
  console.log(
    "progress         : score=" +
      result.progress.score +
      " moves=" +
      result.progress.moves +
      " gems=" +
      result.progress.collected.length,
  );
  console.log(
    "frame ms (avg)   :",
    result.metrics.avgFrameMs,
    "| last:",
    result.metrics.frameMs,
  );
  console.log(
    "candidates (peak):",
    result.metrics.candidatesPeak,
    "| avg:",
    result.metrics.avgCandidates,
  );
  console.log(
    "cache hit rate   :",
    result.metrics.hitRate,
    "| hits/misses:",
    result.metrics.cache.hits + "/" + result.metrics.cache.misses,
  );
  console.log("nodes expanded   :", result.metrics.nodesExpanded);
  console.log("heap delta bytes :", result.resources.heapDeltaBytes);
  console.log(
    "error log        :",
    result.errors.length ? JSON.stringify(result.errors) : "none",
  );
}

console.log("\n=== contract assertions ===");
console.log("pre/post output identical :", semanticEqual);
console.log("cache only changes perf    :", performanceImproved);
console.log("edge scenario contained    :", edgeSurvived);

if (!semanticEqual || !performanceImproved || !edgeSurvived) {
  console.error("\nScenario contract failed");
  process.exit(1);
}
console.log("\nReport written to userdata/reports/scenario-report.json");
