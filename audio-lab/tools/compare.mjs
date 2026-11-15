// Produces the three fixed-scenario comparison artifacts:
//   1) before   – naive baseline (pre-optimization)
//   2) after    – centralized ResourceManager
//   3) boundary – degenerate parameters on the optimized path
// For each: final output fingerprint, exception log, and resource usage.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAudioContext } from '../test/mockAudio.mjs';
import { ResourceManager, NaiveResourceManager } from '../src/resourceManager.mjs';
import {
  SceneConfigCache, SCENE_LIBRARY, BOUNDARY_LIBRARY,
} from '../src/sceneConfig.mjs';
import { SceneController } from '../src/sceneController.mjs';
import { runScenario, compareReports } from '../src/runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'artifacts');
const ITERATIONS = 20;

function assemble(mode, library, capacity) {
  const context = new MockAudioContext();
  const violations = [];
  const manager = mode === 'managed'
    ? new ResourceManager(context, { onViolation: (e) => violations.push(e) })
    : new NaiveResourceManager(context, { onViolation: (e) => violations.push(e) });
  const cache = new SceneConfigCache(capacity);
  const controller = new SceneController(context, manager, cache);
  return {
    context, manager, cache, controller,
    run: () => runScenario({
      context, manager, cache, controller, library,
      iterations: ITERATIONS, label: mode,
      flush: async () => context.flushEndedEvents(),
    }),
    violations,
  };
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const before = assemble('naive', SCENE_LIBRARY, 5);
  const after = assemble('managed', SCENE_LIBRARY, 5);
  const boundary = assemble('managed', BOUNDARY_LIBRARY, 2);

  const beforeReport = await before.run();
  const afterReport = await after.run();
  const boundaryReport = await boundary.run();
  const diff = compareReports(beforeReport, afterReport);

  const payload = {
    generatedAt: new Date().toISOString(),
    iterations: ITERATIONS,
    scenarios: {
      before: strip(beforeReport, before.violations),
      after: strip(afterReport, after.violations),
      boundary: strip(boundaryReport, boundary.violations),
    },
    beforeAfterDiff: diff,
    guarantees: {
      outputSemanticsUnchanged: diff.sameFingerprints
        && beforeReport.fingerprintStable
        && afterReport.fingerprintStable,
      noSustainedNodeGrowth: isBounded(afterReport.nodeSeries, SCENE_LIBRARY.length),
      fullTeardown: afterReport.summary.lastActiveNodes === 0
        && afterReport.summary.lastConnections === 0
        && afterReport.summary.lastListeners === 0,
      noExceptions: beforeReport.errors.length === 0
        && afterReport.errors.length === 0
        && boundaryReport.errors.length === 0,
    },
  };

  fs.writeFileSync(path.join(outDir, 'comparison.json'), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, 'comparison.md'), renderMarkdown(payload));
  console.log(renderMarkdown(payload));
  console.log(`\nartifacts written to ${path.relative(process.cwd(), outDir)}`);
}

function strip(report, violations) {
  return {
    summary: report.summary,
    headNodes: report.headNodes,
    tailNodes: report.tailNodes,
    nodeSeries: report.nodeSeries,
    heapSeries: report.heapSeries,
    fingerprintStable: report.fingerprintStable,
    uniqueFingerprints: report.uniqueFingerprints,
    errors: report.errors,
    violations,
  };
}

function isBounded(series, cycle) {
  const steady = series.slice(0, ITERATIONS);
  for (let index = cycle; index < steady.length; index += 1) {
    if (steady[index] !== steady[index - cycle]) return false;
  }
  return series[ITERATIONS] === 0;
}

function renderMarkdown(data) {
  const rows = Object.entries(data.scenarios).map(([name, scenario]) => {
    const s = scenario.summary;
    return `| ${name} | ${s.firstActiveNodes}→${s.lastActiveNodes} (峰值 ${s.peakActiveNodes}) | ${s.firstConnections}→${s.lastConnections} | ${s.totalCandidates}/${s.totalReleases} | ${(s.finalCacheHitRate * 100).toFixed(1)}% | ${s.avgFrameMs.toFixed(4)} | ${s.errorCount} | ${scenario.fingerprintStable} |`;
  });
  return [
    '# 固定场景对比报告',
    '',
    `- 生成时间：${data.generatedAt}`,
    `- 循环次数：每组 ${data.iterations} 次场景切换`,
    '',
    '| 场景 | 活动节点(首→尾/峰值) | 连接数(首→尾) | 候选/实际释放 | 缓存命中率 | 平均帧时间(ms) | 异常 | 输出指纹稳定 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## 优化前 → 优化后 差异',
    '',
    `- 输出指纹完全一致：${data.beforeAfterDiff.sameFingerprints}`,
    `- 末次活动节点差值：${data.beforeAfterDiff.nodeDelta}`,
    `- 释放数差值：${data.beforeAfterDiff.releaseDelta}`,
    `- 平均帧时间差值(ms)：${data.beforeAfterDiff.frameAvgDeltaMs.toFixed(4)}`,
    `- 堆内存差值：${data.beforeAfterDiff.heapDeltaBytes} B`,
    '',
    '## 结论（仅性能/错误处理变化）',
    '',
    ...Object.entries(data.guarantees).map(([key, value]) => `- ${key}: **${value}**`),
    '',
  ].join('\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
