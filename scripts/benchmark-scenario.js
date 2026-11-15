import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { DirtyRenderer } from "../src/dirty-renderer.js";
import { FullRenderer } from "../src/full-renderer.js";
import {
  advanceScene,
  createScene,
  deleteVisibleObject,
  panCamera,
  publicSnapshot,
  setLayerVisible,
} from "../src/scene.js";

const scenario = process.argv[2];
const outputDir = process.argv[3];
const FRAMES = 120;
const WIDTH = 960;
const HEIGHT = 540;

if (!["before", "after", "boundary"].includes(scenario)) {
  throw new Error(`Unknown scenario: ${scenario}`);
}

function applyAction(scene, frame) {
  if (frame === 30) panCamera(scene, 137, -58);
  if (frame === 44) setLayerVisible(scene, "text", false);
  if (frame === 48) setLayerVisible(scene, "text", true);
  if (frame === 60) deleteVisibleObject(scene);
  if (frame === 74) setLayerVisible(scene, "terrain", false);
  if (frame === 78) setLayerVisible(scene, "terrain", true);
  if (frame === 92) setLayerVisible(scene, "dynamic", false);
  if (frame === 96) setLayerVisible(scene, "dynamic", true);
  if (frame === 108) panCamera(scene, -83, 41);
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function average(values) {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

const baseMemory = memorySnapshot();
let peakMemory = baseMemory;
const scene = createScene();
const canvas = createCanvas(WIDTH, HEIGHT);
const renderer =
  scenario === "before"
    ? new FullRenderer(canvas, { textCacheCapacity: 1 })
    : new DirtyRenderer(canvas, scene, {
        createSurface: createCanvas,
        mergeGap: scenario === "boundary" ? 0 : 6,
        maxDirtyRects: scenario === "boundary" ? 2 : 64,
        textCacheCapacity: scenario === "boundary" ? 8 : 512,
      });

const frameTimes = [];
const repaintRatios = [];
const candidateCounts = [];
const dirtyRectCounts = [];
const cacheHitRates = [];
const exceptions = [];
let lastMetrics = null;

for (let frame = 1; frame <= FRAMES; frame += 1) {
  try {
    applyAction(scene, frame);
    advanceScene(scene);
    lastMetrics = renderer.render(scene);
    frameTimes.push(lastMetrics.lastFrameMs);
    repaintRatios.push(lastMetrics.repaintRatio);
    candidateCounts.push(lastMetrics.candidateCount);
    dirtyRectCounts.push(lastMetrics.dirtyRects);
    cacheHitRates.push(lastMetrics.cacheHitRate);
    if (frame % 10 === 0) {
      const memory = memorySnapshot();
      if (memory.rss > peakMemory.rss) peakMemory = memory;
    }
  } catch (error) {
    exceptions.push({
      frame,
      message: error instanceof Error ? error.message : String(error),
    });
    break;
  }
}

const pixels = canvas.getContext("2d").getImageData(0, 0, WIDTH, HEIGHT).data;
const imageHash = createHash("sha256").update(pixels).digest("hex");
const png = await canvas.encode("png");
await mkdir(outputDir, { recursive: true });
const pngPath = join(outputDir, `${scenario}.png`);
await writeFile(pngPath, png);
const endMemory = memorySnapshot();

const result = {
  scenario,
  mode:
    scenario === "before"
      ? "full-redraw"
      : scenario === "after"
        ? "dirty-rect"
        : "dirty-rect-boundary",
  parameters:
    scenario === "boundary"
      ? { maxDirtyRects: 2, mergeGap: 0, textCacheCapacity: 8 }
      : scenario === "after"
        ? { maxDirtyRects: 64, mergeGap: 6, textCacheCapacity: 512 }
        : { fullRedraw: true },
  frames: frameTimes.length,
  frameMs: {
    avg: average(frameTimes),
    p50: percentile(frameTimes, 0.5),
    p95: percentile(frameTimes, 0.95),
    min: frameTimes.length ? Math.min(...frameTimes) : null,
    max: frameTimes.length ? Math.max(...frameTimes) : null,
  },
  repaint: {
    avgRatio: average(repaintRatios),
    avgPixels: average(repaintRatios) * WIDTH * HEIGHT,
    avgDirtyRects: average(dirtyRectCounts),
  },
  candidates: {
    avg: average(candidateCounts),
  },
  cache: {
    avgHitRate: average(cacheHitRates),
    finalHitRate: lastMetrics?.cacheHitRate ?? 0,
    hits: lastMetrics?.cacheHits ?? 0,
    misses: lastMetrics?.cacheMisses ?? 0,
    evictions: lastMetrics?.cacheEvictions ?? 0,
    entries: lastMetrics?.cacheEntries ?? 0,
    capacity: lastMetrics?.cacheCapacity ?? 0,
  },
  invalidation: {
    renderCalls: lastMetrics?.renderCalls ?? 0,
    redrawCalls: lastMetrics?.redrawCalls ?? 0,
    full: lastMetrics?.fullInvalidations ?? 0,
    capped: lastMetrics?.cappedInvalidations ?? 0,
  },
  nodes: {
    terrain: scene.terrain.length,
    text: scene.texts.length,
    dynamic: scene.dynamics.filter((object) => object.alive).length,
  },
  resources: {
    surfaceBytes: lastMetrics?.surfaceBytes ?? 0,
    cacheEntries: lastMetrics?.cacheEntries ?? 0,
    baseRss: baseMemory.rss,
    endRss: endMemory.rss,
    peakRss: peakMemory.rss,
    rssDelta: peakMemory.rss - baseMemory.rss,
    heapUsed: endMemory.heapUsed,
    external: endMemory.external,
    arrayBuffers: endMemory.arrayBuffers,
  },
  exceptions,
  publicSnapshot: publicSnapshot(scene),
  output: {
    png: pngPath,
    pixelHash: imageHash,
    width: WIDTH,
    height: HEIGHT,
  },
};

await writeFile(
  join(outputDir, `${scenario}.json`),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result));
