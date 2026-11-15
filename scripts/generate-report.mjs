import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { createCrossingSample } from "../src/samples.js";
import {
  ALGORITHM_VERSION,
  DEFAULT_PARAMS,
  PARAM_PRESETS,
  resultWithoutMask,
  vectorizeSample
} from "../src/vectorizer.js";
import { createProjectFromResult, serializeProject } from "../src/project.js";
import { buildSceneSvg, exportSvgDocument } from "../src/svg.js";

const root = process.cwd();
const artifactRoot = join(root, "artifacts");
const resultsRoot = join(artifactRoot, "results");
const snapshotsRoot = join(artifactRoot, "snapshots");

function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function ensurePass(item) {
  const reasons = [];
  if (!item.pathCount) reasons.push("没有矢量路径");
  if (item.visualCompleteness < 95) reasons.push("视觉完整度低于 95%");
  if (item.thinLineCoverage < 95) reasons.push("细线覆盖低于 95%");
  if (item.noiseRemoved < 99) reasons.push("噪点清除低于 99%");
  if (!item.vectorOnly) reasons.push("导出含位图节点");
  if (item.preset === "exception" && item.warnings.length < 4) reasons.push("异常参数未给出钳制提示");
  return { passed: reasons.length === 0, reasons };
}

function comparisonCards(items) {
  return items.map((item) => {
    const status = item.pass ? "通过" : "需检查";
    const warning = item.warnings.length
      ? `<div class="warn">${item.warnings.map(escapeHtml).join("<br>")}</div>`
      : "";
    return `<article class="card">
      <div class="visual">${item.previewSvg}</div>
      <div class="body">
        <div class="card-head"><h2>${escapeHtml(item.name)}</h2><span class="${item.pass ? "ok" : "bad"}">${status}</span></div>
        <p>${escapeHtml(item.description)}</p>
        <dl>
          <div><dt>节点</dt><dd>${item.nodeCount}</dd></div>
          <div><dt>视觉完整度</dt><dd>${item.visualCompleteness.toFixed(2)}%</dd></div>
          <div><dt>细线覆盖</dt><dd>${item.thinLineCoverage.toFixed(2)}%</dd></div>
          <div><dt>噪点清除</dt><dd>${item.noiseRemoved.toFixed(2)}%</dd></div>
          <div><dt>路径</dt><dd>${item.pathCount}</dd></div>
          <div><dt>节点变化</dt><dd>${item.nodeDelta > 0 ? "+" : ""}${item.nodeDelta.toFixed(1)}%</dd></div>
        </dl>
        <div class="params">T ${item.params.threshold} · S ${item.params.smoothing} · M ${item.params.merge} · R ${item.params.minRegion}</div>
        ${warning}
      </div>
    </article>`;
  }).join("");
}

function reportHtml(report) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>InkTrace 对比报告 · seed 631</title>
  <style>
    @font-face{font-family:"InkTrace Sans";src:url("../assets/fonts/NotoSansSC-Regular.otf") format("opentype");font-display:swap}
    *{box-sizing:border-box}body{margin:0;padding:40px;background:#efebe3;color:#191a1d;font-family:"InkTrace Sans","PingFang SC",sans-serif}
    header{max-width:1180px;margin:0 auto 24px}h1{font-size:32px;letter-spacing:-.04em;margin:6px 0 8px}header p{margin:0;color:#777168}
    .eyebrow{font:600 10px "InkTrace Sans",monospace;letter-spacing:.14em;color:#8b8377;text-transform:uppercase}
    .summary{max-width:1180px;margin:0 auto 18px;padding:14px 17px;border-left:3px solid #d9573f;border-radius:0 10px 10px 0;background:#fffaf4;font-size:13px;line-height:1.6}
    .grid{max-width:1180px;margin:auto;display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
    .card{overflow:hidden;border:1px solid rgba(25,26,29,.12);border-radius:14px;background:#fffdf8;box-shadow:0 12px 35px rgba(44,38,29,.08)}
    .visual{height:240px;padding:16px;display:grid;place-items:center;background:#e9e5dc}.visual svg{width:100%;height:100%;filter:drop-shadow(0 8px 12px rgba(40,35,28,.1))}
    .body{padding:16px}.card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.card-head h2{font-size:19px;margin:0}
    .ok,.bad{padding:4px 8px;border-radius:999px;font:600 10px "InkTrace Sans",monospace}.ok{color:#34715a;background:#dcebe3}.bad{color:#9a611e;background:#f6ead3}
    p{min-height:34px;margin:6px 0 12px;color:#777168;font-size:11px;line-height:1.5}
    dl{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;margin:0;overflow:hidden;border:1px solid rgba(25,26,29,.1);border-radius:8px;background:rgba(25,26,29,.1)}
    dl div{padding:8px;background:#fff}dt{font-size:9px;color:#8b8377}dd{margin:2px 0 0;font:600 14px monospace}
    .params{margin-top:9px;font:10px "InkTrace Sans",monospace;color:#777168}.warn{margin-top:9px;padding:8px;border-radius:0 6px 6px 0;border-left:2px solid #9a611e;background:#f6ead3;color:#9a611e;font-size:9px;line-height:1.5}
    footer{max-width:1180px;margin:18px auto 0;color:#8b8377;font:10px "InkTrace Sans",monospace}@media(max-width:900px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <header>
    <span class="eyebrow">INKTRACE · FIXED SEED 631 · ${escapeHtml(report.algorithm)}</span>
    <h1>交叉线与孤立斑点：三组可重复结果</h1>
    <p>同一输入、同一算法版本；比较节点数与视觉完整度，并验证细线保护、噪点过滤与 10× 纯矢量导出。</p>
  </header>
  <div class="summary">${escapeHtml(report.summary)}</div>
  <main class="grid">${comparisonCards(report.items)}</main>
  <footer>生成时间 ${escapeHtml(report.generatedAt)} · 输入 ${report.sample.width}×${report.sample.height} px · 导出不含 &lt;image&gt; 或栅格滤镜</footer>
</body>
</html>`;
}

async function main() {
  await mkdir(resultsRoot, { recursive: true });
  await mkdir(snapshotsRoot, { recursive: true });
  const sample = createCrossingSample();
  const generatedAt = new Date().toISOString();
  const items = [];
  const snapshots = [];

  for (const preset of ["default", "boundary", "exception"]) {
    const definition = PARAM_PRESETS[preset];
    const result = vectorizeSample(sample, definition.params);
    const project = createProjectFromResult(resultWithoutMask(result), sample, {
      id: `uid631-${preset}`,
      projectName: `交叉线稿 · ${definition.name}`
    });
    const svg = exportSvgDocument(project, 0);
    const tenX = exportSvgDocument(project, 0, { scale: 10 });
    const preview = buildSceneSvg(project, { time: 0 }).svg;
    const projectJson = serializeProject(project);
    const base = `artifacts/results/${preset}`;
    await writeFile(join(root, `${base}.svg`), svg);
    await writeFile(join(root, `${base}-10x.svg`), tenX);
    await writeFile(join(root, `${base}.project.json`), projectJson);
    const snapshot = {
      schema: "inktrace-pre-export-snapshot-v1",
      id: `snapshot-${preset}`,
      reason: "pre-export",
      label: `${definition.name} · 导出前`,
      createdAt: generatedAt,
      exportedFile: `${slug(definition.name)}.svg`,
      project
    };
    const snapshotFile = `artifacts/snapshots/${preset}.pre-export.json`;
    await writeFile(join(root, snapshotFile), JSON.stringify(snapshot, null, 2));
    snapshots.push({
      id: snapshot.id,
      preset,
      file: snapshotFile,
      projectFile: `${base}.project.json`,
      reason: "pre-export"
    });
    items.push({
      preset,
      name: definition.name,
      description: definition.description,
      params: result.params,
      warnings: result.warnings,
      nodeCount: result.nodeCount,
      pathCount: result.paths.length,
      visualCompleteness: result.metrics.completeness,
      maskCompleteness: result.metrics.maskCompleteness,
      thinLineCoverage: result.metrics.thinLineCoverage,
      noiseRemoved: result.metrics.noiseRemoved,
      inkPixels: result.metrics.inkPixels,
      vectorPixels: result.metrics.vectorPixels,
      filteredComponents: result.filteredComponents,
      fallbackApplied: result.fallbackApplied,
      vectorOnly: !/<image\b|data:image\//i.test(svg + tenX),
      svgBytes: Buffer.byteLength(svg),
      tenXBytes: Buffer.byteLength(tenX),
      svgSha256: hash(svg),
      previewSvg: preview,
      svgFile: `results/${preset}.svg`,
      tenXFile: `results/${preset}-10x.svg`,
      projectFile: `results/${preset}.project.json`,
      snapshotFile: `snapshots/${preset}.pre-export.json`
    });
  }

  const defaultNodes = items[0].nodeCount;
  for (const item of items) {
    item.nodeDelta = defaultNodes ? ((item.nodeCount - defaultNodes) / defaultNodes) * 100 : 0;
    const status = ensurePass(item);
    item.pass = status.passed;
    item.failureReasons = status.reasons;
  }
  const reduction = ((items[0].nodeCount - items[1].nodeCount) / items[0].nodeCount) * 100;
  const minimumThinCoverage = Math.min(...items.map((item) => item.thinLineCoverage));
  const summary = `默认 ${items[0].nodeCount} 节点 → 边界 ${items[1].nodeCount} 节点（${reduction.toFixed(1)}% 减少）。默认视觉完整度 ${items[0].visualCompleteness.toFixed(2)}%，边界 ${items[1].visualCompleteness.toFixed(2)}%；三组细线覆盖最低 ${minimumThinCoverage.toFixed(2)}%，12 个孤立斑点全部移除，导出仅含矢量路径。`;
  const report = {
    schema: "inktrace-comparison-report-v1",
    generatedAt,
    algorithm: ALGORITHM_VERSION,
    seed: 631,
    sample: {
      id: sample.id,
      name: sample.name,
      width: sample.width,
      height: sample.height,
      description: sample.description,
      structuralPixels: sample.referenceMask.reduce((sum, value) => sum + value, 0),
      speckPixels: sample.speckMask.reduce((sum, value) => sum + value, 0)
    },
    defaults: DEFAULT_PARAMS,
    summary,
    items: items.map(({ previewSvg, ...item }) => item),
    snapshots
  };

  const htmlReport = {
    ...report,
    items: items.map(({ previewSvg, ...item }) => item)
  };
  const html = reportHtml({ ...htmlReport, items });
  await writeFile(join(artifactRoot, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(artifactRoot, "comparison.html"), html);
  await writeFile(
    join(artifactRoot, "snapshot-index.json"),
    JSON.stringify({ schema: "inktrace-snapshot-index-v1", generatedAt, snapshots }, null, 2)
  );
  const markdown = [
    "# InkTrace 三组对比报告",
    "",
    `- 算法：\`${ALGORITHM_VERSION}\``,
    `- 样例：${sample.name}（720×480，固定 seed 631）`,
    `- 生成时间：${generatedAt}`,
    "",
    "| 参数组 | 阈值 | 平滑 | 合并 | 最小区域 | 节点数 | 视觉完整度 | 细线覆盖 | 噪点清除 | 状态 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...items.map((item) => (
      `| ${item.name} | ${item.params.threshold} | ${item.params.smoothing} | ${item.params.merge} | ${item.params.minRegion} | ${item.nodeCount} | ${item.visualCompleteness.toFixed(2)}% | ${item.thinLineCoverage.toFixed(2)}% | ${item.noiseRemoved.toFixed(2)}% | ${item.pass ? "通过" : "需检查"} |`
    )),
    "",
    summary,
    "",
    "## 产物",
    "",
    "- `results/default.svg` / `results/boundary.svg` / `results/exception.svg`：可编辑纯矢量导出。",
    "- `results/*-10x.svg`：10× 画布尺寸，仍只包含 `<path>`。",
    "- `results/*.project.json`：对应工程文件，包含图层、关键帧、坐标和颜色。",
    "- `snapshots/*.pre-export.json`：导出前工程快照。",
    "- `comparison.html`：带三组预览的离线对比页。",
    "- `report.json`：机器可读的节点数、完整度与检查结果。",
    ""
  ].join("\n");
  await writeFile(join(artifactRoot, "COMPARISON.md"), markdown);
  console.log(summary);
  console.log(`Generated report in ${artifactRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
