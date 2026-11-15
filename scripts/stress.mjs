import { mkdir, writeFile } from "node:fs/promises";
import { runFixedScenarios } from "../src/benchmark.js";
import { LayoutEngine } from "../src/engine.js";
import { createApproxMeasurer } from "../src/measure.js";

const engine = new LayoutEngine(createApproxMeasurer());
const report = runFixedScenarios({ engine });

const pct = (value) => `${(value * 100).toFixed(1)}%`;
const ms = (value) => `${value.toFixed(3)} ms`;
const mb = (bytes) => (bytes === null ? "—" : `${(bytes / 1024 / 1024).toFixed(2)} MB`);
const reduction = (base, cached) =>
  base > 0 ? `${((1 - cached / base) * 100).toFixed(1)}%` : "—";

const rows = report.scenarios.map((scenario) => {
  const cacheLabel = scenario.mode === "cached" ? "开启" : "关闭";
  return [
    scenario.label,
    cacheLabel,
    ms(scenario.frameAvgMs),
    ms(scenario.frameP95Ms),
    ms(scenario.frameMaxMs),
    String(scenario.candidatesPerFrame),
    pct(scenario.hitRate),
    String(scenario.cacheEntries),
    scenario.outputDigest,
    String(scenario.errors.length),
    String(scenario.overlaps.length),
    mb(scenario.heapEnd),
    String(scenario.lineNodes)
  ];
});

const header = [
  "场景",
  "缓存",
  "帧时 avg",
  "帧时 p95",
  "帧时 max",
  "候选/帧",
  "命中率",
  "缓存条目",
  "输出摘要",
  "异常",
  "重叠",
  "堆结束",
  "布局节点"
];

const table = [
  `| ${header.join(" | ")} |`,
  `| ${header.map(() => "---").join(" | ")} |`,
  ...rows.map((row) => `| ${row.join(" | ")} |`)
].join("\n");

const [before, after, edge] = report.scenarios;
const parity = report.comparisons;
const commonCandidates = reduction(before.candidatesPerFrame, after.candidatesPerFrame);
const commonFrame = reduction(before.frameAvgMs, after.frameAvgMs);
const edgeCandidates = reduction(
  report.edgeBaseline.candidatesPerFrame,
  edge.candidatesPerFrame
);
const edgeFrame = reduction(report.edgeBaseline.frameAvgMs, edge.frameAvgMs);

const markdown = `# Subflow stress report

Generated: ${report.generatedAt}
Runtime: Node ${process.version} / ${process.platform} ${process.arch}

## Fixed scenarios

${table}

Edge uncached reference: ${ms(report.edgeBaseline.frameAvgMs)} avg,
${report.edgeBaseline.candidatesPerFrame} candidates/frame,
output ${report.edgeBaseline.outputDigest}, errors ${report.edgeBaseline.errors.length},
overlaps ${report.edgeBaseline.overlaps.length}.

## Cache effect

- Common workload frame time: ${ms(before.frameAvgMs)} -> ${ms(after.frameAvgMs)}
  (${commonFrame} lower, ${parity.beforeAfter.speedup.toFixed(2)}x).
- Common candidates/frame: ${before.candidatesPerFrame} -> ${after.candidatesPerFrame}
  (${commonCandidates} fewer); hit rate ${pct(after.hitRate)}.
- Edge workload frame time: ${ms(report.edgeBaseline.frameAvgMs)} -> ${ms(edge.frameAvgMs)}
  (${edgeFrame} lower).
- Edge candidates/frame: ${report.edgeBaseline.candidatesPerFrame} ->
  ${edge.candidatesPerFrame} (${edgeCandidates} fewer); hit rate ${pct(edge.hitRate)}.

## Semantic parity

- Common output sequence exact match: ${parity.beforeAfter.outputEqual}
- Common final output exact match: ${parity.beforeAfter.finalEqual}
- Common layout geometry match: ${parity.beforeAfter.layoutGeometryEqual}
- Common interaction trace match: ${parity.beforeAfter.interactionEqual}
- Common public data digest match: ${parity.beforeAfter.publicEqual}
- Edge output sequence exact match: ${parity.edge.outputEqual}
- Edge final output exact match: ${parity.edge.finalEqual}
- Edge layout geometry match: ${parity.edge.layoutGeometryEqual}
- Edge interaction trace match: ${parity.edge.interactionEqual}
- Edge public data digest match: ${parity.edge.publicEqual}
- Exceptions logged: ${before.errors.length + after.errors.length + edge.errors.length}
- Overlaps detected: ${before.overlaps.length + after.overlaps.length + edge.overlaps.length}

## Final common output (identical before/after)

\`\`\`text
${after.finalOutput}
\`\`\`

## Verdict

- Semantic equality: ${report.verdict.semanticEqual}
- Error-free: ${report.verdict.errorFree}
- Overlap-free: ${report.verdict.overlapFree}
- Only performance/error handling changed:
  ${report.verdict.onlyPerformanceChanged}
`;

await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/stress-report.json", `${JSON.stringify(report, null, 2)}\n`);
await writeFile("artifacts/stress-report.md", markdown);
console.log(markdown);
