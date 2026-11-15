import {
  CollisionScene,
  compareDetection,
  detectBruteForce,
  detectSpatialGrid,
  objectBounds
} from "./collision-engines.js";
import {
  SCENARIOS,
  createScenarioObjects,
  sceneStats,
  stepMotion,
  SCENE_HEIGHT,
  SCENE_WIDTH
} from "./scenarios.js";

const now = () => globalThis.performance.now();

function heapUsage() {
  if (globalThis.performance?.memory) {
    return {
      bytes: globalThis.performance.memory.usedJSHeapSize,
      source: "performance.memory"
    };
  }
  if (globalThis.process?.memoryUsage) {
    const usage = globalThis.process.memoryUsage();
    return { bytes: usage.heapUsed, source: "process.heapUsed", rss: usage.rss };
  }
  return { bytes: null, source: "unavailable", rss: null };
}

function stateDigest(objects) {
  const text = JSON.stringify(
    objects.map((object) => ({
      id: object.id,
      shape: object.shape,
      x: object.x,
      y: object.y,
      radius: object.radius,
      width: object.width,
      height: object.height,
      angle: object.angle,
      hue: object.hue
    }))
  );
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function formatMemory(memory, baseline) {
  if (memory.bytes === null) return null;
  return {
    source: memory.source,
    startBytes: baseline.bytes,
    endBytes: memory.bytes,
    deltaBytes: baseline.bytes === null ? null : memory.bytes - baseline.bytes,
    rssBytes: memory.rss ?? null
  };
}

function runStrategy(scenarioId, strategy, options, progress) {
  const frames = options.frames;
  const warmupFrames = options.warmupFrames;
  const cellSize = options.cellSize;
  const deltaSeconds = 1 / 60;
  const objects = createScenarioObjects(scenarioId);
  const scene = new CollisionScene(objects, cellSize);
  const memoryStart = heapUsage();
  const frameTimes = [];
  const candidateCounts = [];
  const detectionTimes = [];
  const indexTimes = [];
  const errors = [];
  let finalDetection = null;

  for (let frame = 0; frame < warmupFrames + frames; frame += 1) {
    try {
      const frameStart = now();
      const motionStart = now();
      stepMotion(objects, deltaSeconds, SCENE_WIDTH, SCENE_HEIGHT);
      let indexTime = 0;
      if (strategy === "grid") {
        const indexStart = now();
        for (const object of objects) {
          object.bounds = objectBounds(object);
          scene.grid.update(object, object.bounds);
        }
        indexTime = now() - indexStart;
      }
      const motionTime = now() - motionStart - indexTime;
      const detectionStart = now();
      const detection =
        strategy === "brute"
          ? detectBruteForce(objects)
          : detectSpatialGrid(objects, scene.grid);
      const detectionTime = now() - detectionStart;
      const frameTime = now() - frameStart;

      if (frame >= warmupFrames) {
        frameTimes.push(frameTime);
        candidateCounts.push(detection.candidatePairs);
        detectionTimes.push(detectionTime);
        indexTimes.push(indexTime);
      }
      finalDetection = { ...detection, detectionTime, motionTime };
      if (progress && frame % 8 === 0) progress({ strategy, frame });
    } catch (error) {
      errors.push({ frame, message: errorText(error) });
      break;
    }
  }

  const memoryEnd = heapUsage();
  const average = frameTimes.length
    ? frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length
    : 0;
  const maxFrame = frameTimes.length ? Math.max(...frameTimes) : 0;
  const averageCandidates = candidateCounts.length
    ? candidateCounts.reduce((sum, value) => sum + value, 0) / candidateCounts.length
    : 0;
  const averageDetection = detectionTimes.length
    ? detectionTimes.reduce((sum, value) => sum + value, 0) / detectionTimes.length
    : 0;
  const averageIndex = indexTimes.length
    ? indexTimes.reduce((sum, value) => sum + value, 0) / indexTimes.length
    : 0;

  return {
    scenarioId,
    strategy,
    objects: sceneStats(objects),
    totalPairs: (objects.length * (objects.length - 1)) / 2,
    averageFrameMs: average,
    maxFrameMs: maxFrame,
    averageDetectionMs: averageDetection,
    averageCandidates,
    finalCandidates: finalDetection?.candidatePairs ?? 0,
    contacts: finalDetection?.contacts ?? [],
    contactCount: finalDetection?.contacts.length ?? 0,
    contactDigest: finalDetection?.digest ?? "",
    finalObjectDigest: stateDigest(objects),
    occupiedCells: finalDetection?.occupiedCells ?? 0,
    nodeCount: finalDetection?.nodeCount ?? 0,
    cellsVisited: finalDetection?.cellsVisited ?? 0,
    averageIndexMs: averageIndex,
    samples: {
      frameTimes: frameTimes.map((value) => Number(value.toFixed(3))),
      candidateCounts,
      indexTimes: indexTimes.map((value) => Number(value.toFixed(3)))
    },
    memory: formatMemory(memoryEnd, memoryStart),
    errors,
    completedFrames: frameTimes.length
  };
}

export function benchmarkScenario(scenarioId, options = {}) {
  const scenario = SCENARIOS.find((entry) => entry.id === scenarioId);
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
  const settings = {
    frames: options.frames ?? 36,
    warmupFrames: options.warmupFrames ?? 4,
    cellSize: options.cellSize ?? 72
  };

  const brute = runStrategy(scenarioId, "brute", settings, options.onProgress);
  const grid = runStrategy(scenarioId, "grid", settings, options.onProgress);
  const bruteShallow = {
    strategy: "brute",
    candidatePairs: brute.totalPairs,
    narrowPairs: brute.totalPairs,
    contacts: brute.contacts,
    digest: brute.contactDigest,
    occupiedCells: 0,
    nodeCount: 0,
    cellsVisited: 0
  };
  const gridShallow = {
    strategy: "grid",
    candidatePairs: grid.finalCandidates,
    narrowPairs: grid.finalCandidates,
    contacts: grid.contacts,
    digest: grid.contactDigest,
    occupiedCells: grid.occupiedCells,
    nodeCount: grid.nodeCount,
    cellsVisited: grid.cellsVisited,
    sharedCellTests: 0
  };
  const parity = compareDetection(bruteShallow, gridShallow);
  const semanticEqual =
    brute.finalObjectDigest === grid.finalObjectDigest &&
    brute.errors.length === 0 &&
    grid.errors.length === 0;
  const outputEqual = parity.equal && parity.digestEqual;
  const pairReduction =
    brute.totalPairs > 0 ? 1 - grid.finalCandidates / brute.totalPairs : 0;

  return {
    scenario: { ...scenario },
    settings,
    brute,
    grid,
    parity,
    semanticEqual,
    outputEqual,
    pairReduction,
    errors: [
      ...brute.errors.map((error) => ({ ...error, strategy: "brute" })),
      ...grid.errors.map((error) => ({ ...error, strategy: "grid" }))
    ]
  };
}

export async function benchmarkAllScenarios(options = {}) {
  const results = [];
  for (const scenario of SCENARIOS) {
    if (options.onScenarioStart) options.onScenarioStart(scenario);
    results.push(benchmarkScenario(scenario.id, options));
    if (options.onScenarioDone) options.onScenarioDone(results.at(-1));
    if (options.yieldFrame) await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return {
    generatedAt: new Date().toISOString(),
    settings: {
      frames: options.frames ?? 36,
      warmupFrames: options.warmupFrames ?? 4,
      cellSize: options.cellSize ?? 72
    },
    results,
    allOutputsEqual: results.every((result) => result.outputEqual),
    allSemanticsEqual: results.every((result) => result.semanticEqual),
    totalErrors: results.reduce((sum, result) => sum + result.errors.length, 0)
  };
}
