import { clone, formatHash, hashString } from "./config.js";
import { cloneCanvas, renderAtlas, renderSlots } from "./atlas.js";
import { analyzeCanvas, compareCanvases, hashRegionOutsideSlots } from "./measure.js";
import { generateEntries } from "./shapes.js";

const SCENARIO_SETUP = {
  normal: { seed: 17, width: 640, height: 640, cell: 128, padding: 8, count: 12 },
  boundary: { seed: 29, width: 640, height: 640, cell: 128, padding: 3, count: 12 },
  failure: { seed: 41, width: 640, height: 640, cell: 128, padding: 8, count: 12 },
};

function buildScene(kind) {
  const setup = SCENARIO_SETUP[kind];
  const entries = generateEntries(setup.count, setup.seed);
  if (kind === "boundary") {
    const stressed = entries.find((entry) => entry.slot === 7);
    stressed.scale = 1.25;
    stressed.shadowBlur = 20;
    stressed.shadowDx = 10;
    stressed.shadowDy = 10;
  }
  return {
    config: { width: setup.width, height: setup.height, cell: setup.cell, padding: setup.padding },
    entries,
    sourceSlot: 7,
    destinationSlot: 8,
  };
}

function moveToDestination(entries, sourceSlot, destinationSlot) {
  const moving = entries.find((entry) => entry.slot === sourceSlot);
  const occupying = entries.find((entry) => entry.slot === destinationSlot);
  moving.slot = destinationSlot;
  if (occupying) occupying.slot = sourceSlot;
  return { moving, occupying };
}

export function runScenario(kind) {
  const started = performance.now();
  const setup = buildScene(kind);
  const initialScene = clone(setup.entries);
  const initialCanvas = renderAtlas(initialScene, setup.config);
  const initialHash = hashRegionOutsideSlots(initialCanvas, []);
  const beforeShot = initialCanvas.toDataURL("image/png");
  const beforeShotHash = hashString(beforeShot);

  const movedScene = clone(initialScene);
  const moved = moveToDestination(movedScene, setup.sourceSlot, setup.destinationSlot);
  const expectedDirty = [setup.sourceSlot, setup.destinationSlot];
  const injectedDirty = kind === "failure" ? [setup.sourceSlot] : expectedDirty;
  const incrementalCanvas = cloneCanvas(initialCanvas);
  renderSlots(incrementalCanvas, movedScene, setup.config, injectedDirty);
  const incrementalHash = hashRegionOutsideSlots(incrementalCanvas, []);
  const beforeRecomputeShot = incrementalCanvas.toDataURL("image/png");

  const recomputeStarted = performance.now();
  const fullCanvas = renderAtlas(movedScene, setup.config);
  const recomputeMs = performance.now() - recomputeStarted;
  const fullHash = hashRegionOutsideSlots(fullCanvas, []);
  const afterRecomputeShot = fullCanvas.toDataURL("image/png");
  const afterShotHash = hashString(afterRecomputeShot);

  const comparison = compareCanvases(incrementalCanvas, fullCanvas);
  const metrics = analyzeCanvas(fullCanvas, movedScene, setup.config);
  const dirtyRects = expectedDirty.map((index) => {
    const cols = Math.floor(setup.config.width / setup.config.cell);
    const col = index % cols;
    const row = Math.floor(index / cols);
    return {
      x: col * setup.config.cell,
      y: row * setup.config.cell,
      w: setup.config.cell,
      h: setup.config.cell,
    };
  });
  const stableBefore = hashRegionOutsideSlots(incrementalCanvas, dirtyRects);
  const stableAfter = hashRegionOutsideSlots(fullCanvas, dirtyRects);

  const expectedMatch = kind !== "failure";
  const hashMatches = comparison.equal;
  const objectCountStable = initialScene.length === movedScene.length;
  const isolationPass = metrics.guardViolations === 0;
  const stablePass = stableBefore === stableAfter;
  const expectedBehavior = expectedMatch
    ? hashMatches && objectCountStable && isolationPass && stablePass
    : !hashMatches && objectCountStable && isolationPass;

  return {
    kind,
    title: kind === "normal" ? "普通移动" : kind === "boundary" ? "边界高压" : "失败注入",
    status: expectedBehavior ? "pass" : "fail",
    expectedMatch,
    detected: !hashMatches,
    hashBeforeRecompute: incrementalHash,
    hashAfterRecompute: fullHash,
    initialHash,
    screenshotHashBefore: incrementalHash,
    screenshotHashAfter: fullHash,
    pngByteHashBefore: beforeShotHash,
    pngByteHashAfter: afterShotHash,
    screenshotDataHashBefore: incrementalHash,
    screenshotDataHashAfter: fullHash,
    objectCountBefore: initialScene.length,
    objectCountAfter: movedScene.length,
    occupiedSlots: metrics.occupiedSlots,
    capacity: metrics.capacity,
    dirtySlots: injectedDirty.length,
    expectedDirtySlots: expectedDirty.length,
    dirtyTexels: injectedDirty.length * setup.config.cell * setup.config.cell,
    totalTexels: setup.config.width * setup.config.height,
    diffPixels: comparison.diffPixels,
    diffRatio: comparison.diffRatio,
    stableHashBefore: stableBefore,
    stableHashAfter: stableAfter,
    isolationViolations: metrics.guardViolations,
    guardAlphaMax: metrics.guardAlphaMax,
    recomputeMs,
    elapsedMs: performance.now() - started,
    beforeShot,
    afterShot: beforeRecomputeShot,
    fullShot: afterRecomputeShot,
    diffShot: comparison.diffCanvas.toDataURL("image/png"),
    summary: expectedMatch
      ? `增量/全量 ${formatHash(comparison.hashA)} ↔ ${formatHash(comparison.hashB)}`
      : `漏绘被捕获：差异 ${comparison.diffPixels} px`,
    movedIds: [moved.moving?.id, moved.occupying?.id].filter(Boolean),
  };
}
