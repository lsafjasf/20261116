import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PeakPyramid,
  TimeScale,
  ZOOM_LEVELS,
  renderProject,
  TileCache,
  NoticeBus
} from "../src/index.js";
import { defaultProject, VIEW, resolvingCache } from "../test/fixtures.js";

const pyramidBytes = readFileSync(join(process.cwd(), "artifacts", "audio", "peak-pyramid.bin"));
const pyramid = PeakPyramid.deserialize(pyramidBytes);

function measure(label, buildCache, scrollSec = 30) {
  const cache = buildCache();
  const runs = [];
  for (const zoom of ZOOM_LEVELS) {
    const project = defaultProject({
      viewport: { zoomId: zoom.id, scrollSec },
      overlay: { playheadSec: scrollSec + 20, selection: { startSec: scrollSec + 5, endSec: scrollSec + 12 } }
    });
    const scale = new TimeScale(VIEW.width, zoom.pixelsPerSecond, scrollSec);
    const samples = [];
    let last;
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const started = performance.now();
      const result = renderProject(pyramid, project, { cache, scale });
      samples.push(performance.now() - started);
      last = result;
    }
    samples.sort((a, b) => a - b);
    runs.push({
      zoom: zoom.id,
      pixelsPerSecond: zoom.pixelsPerSecond,
      level: last.metrics.level,
      bucketsDrawn: last.metrics.buckets,
      fillCalls: last.metrics.fills,
      medianMs: Number(samples[15].toFixed(3)),
      p95Ms: Number(samples[28].toFixed(3)),
      frameHash: last.framebuffer.hash()
    });
  }
  return { scenario: label, runs, cacheMetrics: cache.metrics, notices: cache.notices.notices.map((n) => n.code) };
}

const healthy = measure("healthy-cache", () => resolvingCache());
const degraded = measure("failing-async-with-fallback", () => {
  const notices = new NoticeBus();
  const preferred = pyramid.chooseLevel(1 / ZOOM_LEVELS[1].pixelsPerSecond);
  return new TileCache(async (levelIndex) => {
    if (levelIndex === preferred) throw new Error("simulated request failure");
    return { ready: true };
  }, { notices });
});

const memory = process.memoryUsage();
const report = {
  audioDurationSec: pyramid.durationSec,
  totalSamples: pyramid.totalSamples,
  pyramidLevels: pyramid.levelCount,
  viewport: VIEW,
  scenarios: [healthy, degraded],
  memory: {
    heapUsedMb: Number((memory.heapUsed / 1024 / 1024).toFixed(2)),
    rssMb: Number((memory.rss / 1024 / 1024).toFixed(2))
  },
  budgets: { maxMedianMs: 16, maxBucketsPerFrame: VIEW.width, noFullSampleDraw: true }
};

const outputDir = join(process.cwd(), "artifacts");
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "perf-report.json"), JSON.stringify(report, null, 2));
for (const scenario of report.scenarios) {
  process.stdout.write(`\n${scenario.scenario}\n`);
  for (const run of scenario.runs) {
    process.stdout.write(
      `  ${run.zoom.padEnd(8)} L${run.level} buckets=${String(run.bucketsDrawn).padStart(4)} fills=${String(run.fillCalls).padStart(4)} median=${run.medianMs}ms p95=${run.p95Ms}ms\n`
    );
  }
}
process.stdout.write(`\nheap ${report.memory.heapUsedMb} MB, rss ${report.memory.rssMb} MB\n`);

const violations = [];
for (const scenario of report.scenarios) {
  for (const run of scenario.runs) {
    if (run.medianMs > report.budgets.maxMedianMs) violations.push(`${scenario.scenario}/${run.zoom} median ${run.medianMs}ms`);
    if (run.bucketsDrawn > report.budgets.maxBucketsPerFrame) violations.push(`${scenario.scenario}/${run.zoom} buckets ${run.bucketsDrawn}`);
  }
}
if (violations.length) {
  process.stdout.write(`\nPERF BUDGET VIOLATIONS:\n${violations.map((v) => `  - ${v}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("\nAll render performance budgets met.\n");
}
