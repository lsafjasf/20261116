// Shared deterministic harness for the pre-optimisation, post-optimisation
// and edge-parameter scenarios. Every mode replays the exact same moves, so
// any output difference indicates a semantic regression rather than noise.
import { createGame } from "../src/core/game.js";
import { Metrics, nowMs } from "../src/core/metrics.js";
import { stableStringify, checksumText } from "../src/core/checksum.js";

export const SCENARIOS = {
  pre: {
    label: "pre-optimisation",
    seed: 20261116,
    width: 24,
    height: 16,
    wallRatio: 0.18,
    gemCount: 8,
    cacheCapacity: 0,
    repeat: 2,
  },
  post: {
    label: "post-optimisation",
    seed: 20261116,
    width: 24,
    height: 16,
    wallRatio: 0.18,
    gemCount: 8,
    cacheCapacity: 256,
    repeat: 2,
  },
  edge: {
    label: "edge-parameters",
    seed: 20261116,
    width: 48,
    height: 32,
    wallRatio: 0.3,
    gemCount: 24,
    cacheCapacity: 1,
    repeat: 3,
  },
};

export function fixedMoves(config) {
  const moves = [];
  const step = config.repeat ?? 1;
  for (let r = 0; r < step; r++) {
    moves.push([config.width - 2, config.height - 2]);
    moves.push([1, config.height - 2]);
    moves.push([config.width - 2, 1]);
    moves.push([1, 1]);
    moves.push([Math.floor(config.width / 2), Math.floor(config.height / 2)]);
    if (config.wallRatio >= 0.3) {
      // Deliberately unreachable-looking probes inside the dense edge map;
      // the game must log a structured UNREACHABLE entry instead of crashing.
      moves.push([0, 0]);
    }
  }
  return moves;
}

export function runScenario(name, config) {
  const metrics = new Metrics({ windowSize: 120 });
  const errors = [];
  const game = createGame({
    seed: config.seed,
    width: config.width,
    height: config.height,
    wallRatio: config.wallRatio,
    gemCount: config.gemCount,
    cacheCapacity: config.cacheCapacity,
  });
  const moves = fixedMoves(config);
  const heapStart = process.memoryUsage().heapUsed;
  const startedAt = nowMs();
  let blockedMoves = 0;

  for (const target of moves) {
    const frameStart = nowMs();
    let result;
    try {
      result = game.moveToward(target[0], target[1]);
      if (!result.ok) {
        blockedMoves++;
        errors.push({
          code: "UNREACHABLE",
          target,
          message: result.reason,
        });
      }
    } catch (error) {
      errors.push({ code: error.name, target, message: error.message });
    }
    const frameMs = nowMs() - frameStart;
    metrics.recordFrame(frameMs, game.pathService);
  }

  const elapsedMs = nowMs() - startedAt;
  const heapEnd = process.memoryUsage().heapUsed;
  const snapshot = game.snapshot();
  return {
    name,
    label: config.label,
    config: {
      cacheCapacity: config.cacheCapacity,
      width: config.width,
      height: config.height,
      wallRatio: config.wallRatio,
      gemCount: config.gemCount,
      moves: moves.length,
    },
    outputHash: checksumText(stableStringify(snapshot)),
    progress: snapshot.progress,
    settings: snapshot.settings,
    replay: {
      count: snapshot.replaySummary.count,
      totalSteps: snapshot.replaySummary.totalSteps,
      totalGems: snapshot.replaySummary.totalGems,
    },
    metrics: {
      ...metrics.snapshot(),
      elapsedMs: round3(elapsedMs),
      nodesExpanded: game.pathService.nodesExpanded,
      queries: game.pathService.queries,
      candidatesPeak: game.pathService.candidatesPeak,
      cache: game.pathService.cache.stats,
    },
    resources: {
      heapDeltaBytes: heapEnd - heapStart,
      heapUsedBytes: heapEnd,
    },
    errors,
    blockedMoves,
    snapshot,
  };
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
