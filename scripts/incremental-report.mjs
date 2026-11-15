import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runThreeRoundScenario } from "../src/core/scenario.js";
import { runAllParameterGroups } from "../src/core/diagnostics.js";
import { encodePng, pngDataUrl } from "../src/node/png.js";

const root = resolve(import.meta.dirname, "..");
const artifactRoot = join(root, "artifacts");
const directories = {
  atlas: join(artifactRoot, "atlas"),
  exports: join(artifactRoot, "exports"),
  snapshots: join(artifactRoot, "snapshots"),
  report: join(artifactRoot, "report"),
};
for (const directory of Object.values(directories)) {
  await mkdir(directory, { recursive: true });
}

const result = runThreeRoundScenario({
  seed: 628,
  count: 100,
  includeAtlasPixels: true,
});
if (!result.passed) {
  throw new Error(`Incremental report checks failed: ${JSON.stringify(result.checks)}`);
}

const reportRounds = [];
for (const round of result.rounds) {
  const png = encodePng(
    round.atlasPixels.width,
    round.atlasPixels.height,
    round.atlasPixels.pixels,
  );
  const imageDataUrl = pngDataUrl(png);
  round.package.atlas.imageDataUrl = imageDataUrl;
  round.beforeExport.atlas.imageDataUrl = imageDataUrl;
  const atlasFile = `atlas/round-${round.round}.png`;
  const exportFile = `exports/round-${round.round}-atlas.json`;
  const snapshotFile = `snapshots/round-${round.round}-pre-export.json`;
  await writeFile(join(artifactRoot, atlasFile), png);
  await writeFile(join(artifactRoot, exportFile), JSON.stringify(round.package, null, 2));
  await writeFile(join(artifactRoot, snapshotFile), JSON.stringify(round.beforeExport, null, 2));
  reportRounds.push({
    round: round.round,
    label: round.label,
    atlas: round.atlas,
    utilizationBefore: round.utilizationBefore,
    utilization: round.utilization,
    utilizationDelta: round.utilizationDelta,
    rearrangedRegion: round.rearrangedRegion,
    insertedFrames: round.insertedFrames,
    deletedFrames: round.deletedFrames,
    resizedFrames: round.resizedFrames,
    movedFrames: round.movedFrames,
    unaffectedMovement: round.unaffectedMovement,
    compacted: round.compacted,
    export: {
      ...round.export,
      atlasFile,
      exportFile,
      snapshotFile,
      pngBytes: png.length,
    },
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  seed: result.seed,
  frameCount: result.count,
  parameters: result.options,
  baseline: result.baseline,
  rounds: reportRounds,
  checks: result.checks,
  passed: result.passed,
};
await writeFile(
  join(directories.report, "incremental-report.json"),
  JSON.stringify(report, null, 2),
);

const parameterGroups = await runAllParameterGroups();
const suiteSummaries = parameterGroups.suites.map((suite) => ({
  group: suite.group,
  title: suite.title,
  passed: suite.passed,
  parameters: suite.parameters,
  checks: suite.checks,
  baseline: suite.result?.baseline,
  rounds: suite.result?.rounds?.map((round) => ({
    round: round.round,
    atlas: round.atlas,
    utilization: round.utilization,
    rearrangedRegion: round.rearrangedRegion,
    unaffectedMovement: round.unaffectedMovement,
    export: round.export,
  })),
}));
await writeFile(
  join(directories.report, "parameter-groups.json"),
  JSON.stringify({ passed: parameterGroups.passed, suites: suiteSummaries }, null, 2),
);

const percent = (value) => `${(value * 100).toFixed(2)}%`;
const table = reportRounds
  .map((round) => {
    const region = round.rearrangedRegion
      ? `x${round.rearrangedRegion.x},y${round.rearrangedRegion.y} ${round.rearrangedRegion.w}×${round.rearrangedRegion.h}`
      : "—";
    return `| ${round.round} | ${round.atlas.width}×${round.atlas.height} | ${percent(round.utilization)} | ${round.utilizationDelta >= 0 ? "+" : ""}${percent(round.utilizationDelta)} | ${region} | ${round.unaffectedMovement.moved}/${round.unaffectedMovement.compared} | ${round.export.pixelHash} | ${round.export.snapshotMatches ? "PASS" : "FAIL"} |`;
  })
  .join("\n");

const markdown = `# 100 帧三轮增量打包报告

- Seed: \`${result.seed}\`
- 初始帧数: \`${result.baseline.frameCount}\`
- 初始图集: \`${result.baseline.width}×${result.baseline.height}\`
- 初始利用率: \`${percent(result.baseline.utilization)}\`
- 参数: \`${JSON.stringify(result.options)}\`
- 全部检查: **${result.passed ? "PASS" : "FAIL"}**

| 轮次 | 图集 | 利用率 | 变化 | 重排区域 | 未受影响位移 | 导出像素哈希 | 快照 |
| --- | --- | ---: | ---: | --- | ---: | --- | --- |
${table}

## 导出产物

- 每轮 PNG: \`artifacts/atlas/round-*.png\`
- 每轮切片 JSON: \`artifacts/exports/round-*-atlas.json\`
- 每轮导出前工程快照: \`artifacts/snapshots/round-*-pre-export.json\`

## 验证项

${Object.entries(result.checks).map(([name, ok]) => `- ${ok ? "PASS" : "FAIL"} \`${name}\``).join("\n")}

## 参数组

${suiteSummaries.map((suite) => `- ${suite.passed ? "PASS" : "FAIL"} **${suite.group}**：${suite.checks.filter((entry) => entry.ok).length}/${suite.checks.length} 项`).join("\n")}
`;
await writeFile(join(directories.report, "incremental-report.md"), markdown);

console.log(markdown);
console.log(`Artifacts: ${artifactRoot}`);
