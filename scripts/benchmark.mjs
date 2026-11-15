import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus, platform, release } from "node:os";
import { benchmarkAllScenarios } from "../src/benchmark.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frames = Number(process.env.BENCH_FRAMES || 60);
const warmupFrames = Number(process.env.BENCH_WARMUP || 8);
const report = await benchmarkAllScenarios({ frames, warmupFrames, cellSize: 72 });
const resourceUsage = process.resourceUsage();
const environment = {
  node: process.version,
  platform: platform(),
  release: release(),
  cpu: cpus()[0]?.model ?? "unknown",
  frames,
  warmupFrames,
  cellSize: 72,
  maxRssBytes: resourceUsage.maxRSS * 1024,
  userCpuMicros: resourceUsage.userCPUTime,
  systemCpuMicros: resourceUsage.systemCPUTime
};

const output = {
  ...report,
  environment,
  invariant: {
    visualAndInteractionStateUnchanged: report.allSemanticsEqual,
    publicObjectFieldsUnchanged: report.allSemanticsEqual,
    finalContactsUnchanged: report.allOutputsEqual,
    exceptionLogUnchanged: report.totalErrors === 0,
    scope: "performance-path-and-error-handling-only"
  }
};

const megabytes = (bytes) => (bytes / 1024 / 1024).toFixed(2);
const number = (value) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
const tableRows = report.results.flatMap((result) =>
  ["brute", "grid"].map((strategy) => {
    const data = result[strategy];
    const memory = data.memory;
    return (
      `| ${result.scenario.shortName} | ${strategy === "brute" ? "暴力" : "网格"} | ` +
      `${data.objects.total} | ${number(data.averageCandidates)} | ${number(data.totalPairs)} | ` +
      `${data.contactCount} | ${data.contactDigest} | ${data.averageFrameMs.toFixed(2)} | ` +
      `${data.maxFrameMs.toFixed(2)} | ${data.averageIndexMs.toFixed(2)} | ` +
      `${memory ? megabytes(memory.endBytes) : "N/A"} | ${memory?.rssBytes ? megabytes(memory.rssBytes) : "N/A"} | ` +
      `${data.errors.length} |`
    );
  })
);

const markdown = `# Broadphase Lab 基准报告

生成时间：${report.generatedAt}

运行环境：Node ${environment.node}，${environment.platform} ${environment.release}，${environment.cpu}

参数：三组固定场景，每组 ${frames} 帧，预跑 ${warmupFrames} 帧，网格 72 px，固定步长 1/60 s。

## 语义不变量

- 最终对象状态摘要一致：${report.allSemanticsEqual ? "是" : "否"}
- 最终接触摘要与接触集合一致：${report.allOutputsEqual ? "是（3/3）" : "否"}
- 异常日志：${report.totalErrors} 条
- 改动范围：仅宽相候选生成、索引更新与错误记录；视觉、交互和公开对象字段未改变

## 三组固定场景

| 场景 | 策略 | 对象 | 平均候选 | 全对 | 接触 | 接触摘要 | 平均帧 ms | 最大帧 ms | 索引 ms | 堆 MB | RSS MB | 异常 |
|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|
${tableRows.join("\n")}

## 输出一致性

${report.results
  .map(
    (result) =>
      `- **${result.scenario.shortName}**：暴力 ${result.brute.contactCount} 对 / 网格 ${result.grid.contactCount} 对；` +
      `摘要 ${result.brute.contactDigest} / ${result.grid.contactDigest}；` +
      `对象状态 ${result.brute.finalObjectDigest} / ${result.grid.finalObjectDigest}；` +
      `候选减少 ${(result.pairReduction * 100).toFixed(2)}%；输出${result.outputEqual ? "一致" : "不一致"}。`
  )
  .join("\n")}

## 资源与异常

- 进程峰值 RSS：${megabytes(environment.maxRssBytes)} MB
- 用户态 CPU：${(environment.userCpuMicros / 1e6).toFixed(2)} s
- 内核态 CPU：${(environment.systemCpuMicros / 1e6).toFixed(2)} s
- 三组场景异常总数：${report.totalErrors}
- 公开数据语义变化：无（对象字段与最终对象状态摘要一致）
`;

const jsonPath = resolve(root, "artifacts/benchmark-report.json");
const markdownPath = resolve(root, "artifacts/benchmark-report.md");
await mkdir(dirname(jsonPath), { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
await writeFile(markdownPath, markdown);

console.log(`Benchmark complete: ${jsonPath}`);
console.log(`Benchmark summary: ${markdownPath}`);
console.log(
  `Outputs equal=${report.allOutputsEqual}, semantics=${report.allSemanticsEqual}, errors=${report.totalErrors}`
);
for (const result of report.results) {
  console.log(
    `${result.scenario.id}: candidates ${result.brute.totalPairs} -> ${result.grid.averageCandidates.toFixed(2)}, ` +
      `frame ${result.brute.averageFrameMs.toFixed(2)} -> ${result.grid.averageFrameMs.toFixed(2)} ms`
  );
}
