import { LayoutCache, LayoutService } from "./cache.js";
import { SCENARIOS, frameAt, workloadPublicDigest } from "./data.js";
import { digest } from "./hash.js";
import { layoutFingerprint, layoutString } from "./layout.js";
import { findOverlaps, lineRects, maxScroll } from "./geometry.js";

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

function heapUsed() {
  if (typeof process !== "undefined" && process.memoryUsage) {
    return process.memoryUsage().heapUsed;
  }
  if (typeof performance !== "undefined" && performance.memory) {
    return performance.memory.usedJSHeapSize;
  }
  return null;
}

function frameTimeStats(times) {
  if (!times.length) {
    return { avg: 0, p50: 0, p95: 0, max: 0, total: 0 };
  }
  const sorted = [...times].sort((a, b) => a - b);
  const total = times.reduce((sum, value) => sum + value, 0);
  return {
    avg: total / times.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    total
  };
}

function emptyLayout(cue) {
  return {
    text: cue.text,
    style: cue.style,
    width: cue.style.width,
    lineHeight: cue.style.fontSize * cue.style.lineHeight,
    height: cue.style.fontSize * cue.style.lineHeight,
    candidateCount: 0,
    lines: [
      {
        text: "",
        width: 0,
        x: 0,
        y: 0,
        height: cue.style.fontSize * cue.style.lineHeight
      }
    ]
  };
}

export function runWorkload(workload, { engine, cacheEnabled, frames = workload.frames } = {}) {
  const cache = new LayoutCache();
  const service = new LayoutService({ engine, cache, cacheEnabled });
  const frameTimes = [];
  const outputs = [];
  const visualFrames = [];
  const interactionFrames = [];
  const errors = [];
  const overlaps = [];
  let candidatesTotal = 0;
  let lineNodes = 0;
  let peakHeap = heapUsed();
  const startHeap = peakHeap;
  const start = performance.now();

  for (let index = 0; index < frames; index += 1) {
    const frame = frameAt(workload, index);
    const frameStart = performance.now();
    try {
      const resolved = service.resolve(frame.text, frame.style);
      const layout = resolved.layout;
      candidatesTotal += resolved.candidates;
      lineNodes += layout.lines.length;
      const scrollPx =
        maxScroll(layout, frame.zoom, workload.viewportHeight) * frame.scrollNorm;
      const rects = lineRects(layout, frame.zoom, scrollPx);
      const frameOverlaps = findOverlaps(rects);
      if (frameOverlaps.length) {
        overlaps.push({ frame: index, ...frameOverlaps[0] });
      }
      outputs.push(layoutString(layout));
      visualFrames.push({
        cueId: frame.cueId,
        scroll: round(frame.scrollNorm, 5),
        zoom: round(frame.zoom, 5),
        layout: layoutFingerprint(layout)
      });
      interactionFrames.push({
        cueId: frame.cueId,
        speaker: frame.speaker,
        text: frame.text,
        style: layout.style,
        scroll: round(frame.scrollNorm, 5),
        zoom: round(frame.zoom, 5)
      });
      if (index % 20 === 0) {
        peakHeap = Math.max(peakHeap || 0, heapUsed() || 0);
      }
    } catch (error) {
      errors.push({
        frame: index,
        cueId: frame.cueId,
        message: error instanceof Error ? error.message : String(error)
      });
      const layout = emptyLayout(frame);
      outputs.push("");
      visualFrames.push({
        cueId: frame.cueId,
        scroll: round(frame.scrollNorm, 5),
        zoom: round(frame.zoom, 5),
        layout: layoutFingerprint(layout)
      });
      interactionFrames.push({
        cueId: frame.cueId,
        speaker: frame.speaker,
        text: frame.text,
        style: layout.style,
        scroll: round(frame.scrollNorm, 5),
        zoom: round(frame.zoom, 5)
      });
    }
    frameTimes.push(performance.now() - frameStart);
  }

  const totalMs = performance.now() - start;
  const endHeap = heapUsed();
  peakHeap = Math.max(peakHeap || 0, endHeap || 0);
  const stats = frameTimeStats(frameTimes);
  const snapshot = cache.snapshot();
  const finalFrame = frames > 0 ? frameAt(workload, frames - 1) : frameAt(workload, 0);
  const finalOutput = outputs[outputs.length - 1] || "";
  const finalLines = finalOutput ? finalOutput.split("\n") : [];

  return {
    id: workload.id,
    mode: cacheEnabled ? "cached" : "baseline",
    frames,
    frameTimes,
    stats,
    totalMs,
    candidatesTotal,
    candidatesPerFrame: frames ? candidatesTotal / frames : 0,
    cache: snapshot,
    cacheEntries: cache.size,
    hitRate: cacheEnabled ? snapshot.hitRate : 0,
    outputs,
    visualFrames,
    interactionFrames,
    outputDigest: digest(outputs),
    visualDigest: digest(visualFrames),
    interactionDigest: digest(interactionFrames),
    publicDigest: workloadPublicDigest(workload),
    finalOutput,
    finalLines,
    finalFrame,
    errors,
    overlaps,
    lineNodes,
    nodesPerFrame: frames ? lineNodes / frames : 0,
    heap: {
      start: startHeap,
      end: endHeap,
      peak: peakHeap,
      delta: startHeap === null || endHeap === null ? null : endHeap - startHeap
    }
  };
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function compareRuns(left, right) {
  const outputEqual = sameArray(left.outputs, right.outputs);
  const visualEqual = left.visualDigest === right.visualDigest;
  const interactionEqual = left.interactionDigest === right.interactionDigest;
  const publicEqual = left.publicDigest === right.publicDigest;
  const finalEqual = left.finalOutput === right.finalOutput;
  const errorFree = left.errors.length === 0 && right.errors.length === 0;
  const overlapFree = left.overlaps.length === 0 && right.overlaps.length === 0;
  const layoutGeometryEqual = left.visualFrames.every(
    (frame, index) => frame.layout === right.visualFrames[index]?.layout
  );
  return {
    outputEqual,
    visualEqual,
    interactionEqual,
    publicEqual,
    finalEqual,
    layoutGeometryEqual,
    errorFree,
    overlapFree,
    semanticEqual:
      outputEqual &&
      visualEqual &&
      interactionEqual &&
      publicEqual &&
      finalEqual &&
      layoutGeometryEqual,
    speedup: right.stats.avg > 0 ? left.stats.avg / right.stats.avg : 0
  };
}

function summarizeRun(run) {
  return {
    scenarioId: run.scenarioId,
    label: run.label,
    mode: run.mode,
    frames: run.frames,
    frameAvgMs: round(run.stats.avg, 3),
    frameP50Ms: round(run.stats.p50, 3),
    frameP95Ms: round(run.stats.p95, 3),
    frameMaxMs: round(run.stats.max, 3),
    totalMs: round(run.totalMs, 2),
    candidatesTotal: run.candidatesTotal,
    candidatesPerFrame: round(run.candidatesPerFrame, 1),
    hitRate: round(run.hitRate, 4),
    cacheHits: run.cache.hits,
    cacheMisses: run.cache.misses,
    cacheEntries: run.cacheEntries,
    evictions: run.cache.evictions,
    outputDigest: run.outputDigest,
    visualDigest: run.visualDigest,
    publicDigest: run.publicDigest,
    finalOutput: run.finalOutput,
    finalLines: run.finalLines,
    errors: run.errors,
    overlaps: run.overlaps,
    lineNodes: run.lineNodes,
    nodesPerFrame: round(run.nodesPerFrame, 1),
    heapDelta: run.heap.delta,
    heapPeak: run.heap.peak,
    heapEnd: run.heap.end
  };
}

export function runFixedScenarios({ engine, onStep } = {}) {
  const runs = [];
  const byId = {};
  for (const scenario of SCENARIOS) {
    onStep?.({ id: scenario.id, label: scenario.label });
    const run = runWorkload(scenario.workload, {
      engine,
      cacheEnabled: scenario.cacheEnabled
    });
    run.scenarioId = scenario.id;
    run.label = scenario.label;
    runs.push(run);
    byId[scenario.id] = run;
  }
  onStep?.({ id: "edge-baseline", label: "边界对照" });
  const edgeBaseline = runWorkload(SCENARIOS[2].workload, {
    engine,
    cacheEnabled: false
  });
  edgeBaseline.scenarioId = "edge-baseline";
  edgeBaseline.label = "边界参数 · 无缓存对照";

  const beforeAfter = compareRuns(byId.before, byId.after);
  const edge = compareRuns(edgeBaseline, byId.edge);
  const semanticEqual = beforeAfter.semanticEqual && edge.semanticEqual;
  const errorFree = beforeAfter.errorFree && edge.errorFree;
  const overlapFree = beforeAfter.overlapFree && edge.overlapFree;
  return {
    generatedAt: new Date().toISOString(),
    scenarios: runs.map(summarizeRun),
    edgeBaseline: summarizeRun(edgeBaseline),
    comparisons: { beforeAfter, edge },
    verdict: {
      semanticEqual,
      errorFree,
      overlapFree,
      onlyPerformanceChanged: semanticEqual && errorFree && overlapFree
    }
  };
}
