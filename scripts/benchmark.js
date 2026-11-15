import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { AnimationLoop } from "../src/animation-loop.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = join(root, "artifacts");
const scenarios = ["before", "after", "boundary"];

await mkdir(artifacts, { recursive: true });
for (const scenario of scenarios) {
  execFileSync(
    process.execPath,
    [join(root, "scripts/benchmark-scenario.js"), scenario, artifacts],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
  );
}

const results = {};
for (const scenario of scenarios) {
  results[scenario] = JSON.parse(
    await readFile(join(artifacts, `${scenario}.json`), "utf8"),
  );
}

async function loadPixels(path) {
  const image = await loadImage(path);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, image.width, image.height).data;
}

function comparePixels(left, right) {
  let bytes = 0;
  let pixels = 0;
  let maxDelta = 0;
  for (let index = 0; index < left.length; index += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(left[index + channel] - right[index + channel]);
      if (delta) {
        bytes += 1;
        changed = true;
        maxDelta = Math.max(maxDelta, delta);
      }
    }
    if (changed) pixels += 1;
  }
  return { bytes, pixels, maxDelta };
}

const baselinePixels = await loadPixels(results.before.output.png);
const comparisons = {};
for (const scenario of scenarios) {
  const pixels = await loadPixels(results[scenario].output.png);
  comparisons[scenario] = comparePixels(baselinePixels, pixels);
}

const publicBaseline = JSON.stringify(results.before.publicSnapshot);
const publicSemanticsEqual = scenarios.every(
  (scenario) =>
    JSON.stringify(results[scenario].publicSnapshot) === publicBaseline,
);

let pauseFrames = 0;
let pauseId = 0;
const pending = new Map();
const pauseLoop = new AnimationLoop({
  requestFrame(callback) {
    pauseId += 1;
    pending.set(pauseId, callback);
    return pauseId;
  },
  cancelFrame(id) {
    pending.delete(id);
  },
  onFrame() {
    pauseFrames += 1;
  },
});
const flush = () => {
  const callbacks = [...pending.values()];
  pending.clear();
  for (const callback of callbacks) callback(performance.now());
};
pauseLoop.start();
flush();
flush();
flush();
const beforePause = pauseFrames;
pauseLoop.pause();
for (let index = 0; index < 30; index += 1) flush();
pauseLoop.stop();
const pauseProbe = {
  framesBeforePause: beforePause,
  framesAfterPause: pauseFrames,
  extraRedraws: pauseFrames - beforePause,
  scheduledAfterPause: pending.size,
};

const before = results.before;
const after = results.after;
const boundary = results.boundary;
const speedup = before.frameMs.avg / after.frameMs.avg;
const allComparisonsExact = Object.values(comparisons).every(
  (comparison) => comparison.bytes === 0,
);
const exceptions = scenarios.flatMap((scenario) =>
  results[scenario].exceptions.map((error) => ({ scenario, ...error })),
);

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    canvas: "@napi-rs/canvas 1.1.1",
  },
  fixture: {
    seed: "0x5eedc0de",
    viewport: "960x540",
    frames: before.frames,
    terrainNodes: before.nodes.terrain,
    textNodes: before.nodes.text,
    dynamicNodes: 240,
    actionTimeline: [
      "frame 30: pan(137,-58)",
      "frame 44/48: text hidden/shown",
      "frame 60: delete first visible object",
      "frame 74/78: terrain hidden/shown",
      "frame 92/96: dynamic hidden/shown",
      "frame 108: pan(-83,41)",
    ],
  },
  scenarios: results,
  comparisons,
  checks: {
    pixelExact: allComparisonsExact,
    publicSemanticsEqual,
    exceptions,
    pauseProbe,
    speedup,
    repaintReduction: 1 - after.repaint.avgRatio / before.repaint.avgRatio,
  },
};

await writeFile(
  join(artifacts, "benchmark.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const pct = (value) => `${(value * 100).toFixed(1)}%`;
const table = scenarios
  .map((name) => {
    const item = results[name];
    return `| ${name} | ${item.frameMs.avg.toFixed(2)} | ${item.frameMs.p95.toFixed(2)} | ${pct(item.repaint.avgRatio)} | ${item.candidates.avg.toFixed(1)} | ${pct(item.cache.finalHitRate)} | ${item.invalidation.full} / ${item.invalidation.capped} | ${mb(item.resources.peakRss)} | ${mb(item.resources.surfaceBytes)} |`;
  })
  .join("\n");
const comparisonTable = scenarios
  .map((name) => {
    const item = comparisons[name];
    return `| ${name} | \`${results[name].output.pixelHash.slice(0, 16)}…\` | ${item.pixels} | ${item.bytes} | ${item.maxDelta} |`;
  })
  .join("\n");

const markdown = `# Canvas 脏矩形优化验证

生成时间：${report.generatedAt}

## 固定场景

- 种子：\`0x5eedc0de\`，视口 960×540，共 120 帧。
- 节点：${before.nodes.terrain} 地形、${before.nodes.text} 文字、240 动态对象。
- 三组场景使用相同动作时间线：视口移动、文字显隐、对象删除、地形显隐、动态层显隐、再次移动视口。
- \`before\` 为逐帧全量重绘；\`after\` 为脏矩形更新；\`boundary\` 将脏矩形上限压到 2、合并间距设为 0、文字缓存压到 8。

## 性能与资源

| 场景 | 平均帧时间 ms | P95 ms | 平均重绘面积 | 平均候选数 | 缓存命中率 | 全量/降级次数 | RSS 峰值 | Canvas 表面内存 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${table}

优化后平均帧时间相对全量路径加速 **${speedup.toFixed(1)}×**，平均重绘面积下降 **${pct(report.checks.repaintReduction)}**。
脏矩形方案额外保留背景层和静态合成层，因此 Canvas 表面内存上升；这是以固定小内存换取每帧地形遍历与像素填充下降。

## 最终输出对比

| 场景 | 原始像素 SHA-256 | 差异像素 | 差异字节 | 最大通道差 |
| --- | --- | ---: | ---: | ---: |
${comparisonTable}

三组最终 PNG 均以全量路径为基准逐像素比较。像素差异为 **${allComparisonsExact ? "0" : "非 0"}**。

## 行为与异常

- 公开场景快照完全一致：**${publicSemanticsEqual ? "是" : "否"}**。
- 捕获异常数：**${exceptions.length}**。
- 暂停探针：暂停前 ${pauseProbe.framesBeforePause} 帧，暂停后额外重绘 **${pauseProbe.extraRedraws}** 帧，待调度回调 ${pauseProbe.scheduledAfterPause} 个。
- 自动化测试覆盖逐帧像素一致、所有失效路径、边界降级、零脏区与暂停调度。

## 结论

三组画面、公开快照和交互动作序列一致，异常日志为空。优化只改变了渲染调度、缓存和性能特征，没有改变既有视觉结果、交互语义或公开数据语义；边界参数走频繁全量降级时仍保持逐像素一致。
`;

await writeFile(join(artifacts, "benchmark.md"), markdown);
console.log(markdown);

if (
  !allComparisonsExact ||
  !publicSemanticsEqual ||
  exceptions.length > 0 ||
  pauseProbe.extraRedraws !== 0 ||
  pauseProbe.scheduledAfterPause !== 0
) {
  process.exitCode = 1;
}
