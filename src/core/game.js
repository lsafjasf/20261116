import { createRng, hashSeed } from "./rng.js";
import { PathService } from "./pathfinder.js";

export const REPLAY_LIMIT = 20;

export function generateMap({
  seed,
  width = 24,
  height = 16,
  wallRatio = 0.18,
  gemCount = 8,
}) {
  const rng = createRng(hashSeed(String(seed)));
  const cells = new Array(width * height).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        cells[y * width + x] = 1;
      } else if (rng() < wallRatio) {
        cells[y * width + x] = 1;
      }
    }
  }
  const start = [1, 1];
  cells[start[1] * width + start[0]] = 0;
  const gems = [];
  let guard = 0;
  while (gems.length < gemCount && guard < width * height * 10) {
    guard++;
    const x = 1 + Math.floor(rng() * (width - 2));
    const y = 1 + Math.floor(rng() * (height - 2));
    const index = y * width + x;
    const occupied =
      cells[index] === 1 ||
      gems.some((gem) => gem[0] === x && gem[1] === y) ||
      (x === start[0] && y === start[1]);
    if (!occupied) {
      gems.push([x, y]);
    }
  }
  return {
    id: "map-" + String(seed),
    seed,
    width,
    height,
    wallRatio,
    cells,
    start,
    gems,
  };
}

export function createGame(options = {}) {
  const seed = options.seed ?? 42;
  const map = options.map ??
    generateMap({
      seed,
      width: options.width ?? 24,
      height: options.height ?? 16,
      wallRatio: options.wallRatio ?? 0.18,
      gemCount: options.gemCount ?? 8,
    });
  const settings = {
    volume: 0.7,
    difficulty: "normal",
    particles: true,
    ...(options.settings ?? {}),
  };
  const pathService = new PathService({
    cacheCapacity: options.cacheCapacity ?? 0,
  });
  const state = {
    player: { x: map.start[0], y: map.start[1] },
    score: 0,
    moves: 0,
    tick: 0,
    collected: [],
    settings,
  };
  const replay = [];

  function record(action) {
    replay.push(action);
    if (replay.length > REPLAY_LIMIT) {
      replay.shift();
    }
  }

  const game = {
    map,
    state,
    pathService,

    moveToward(targetX, targetY) {
      const path = pathService.findPath(
        map,
        [state.player.x, state.player.y],
        [targetX, targetY],
      );
      state.tick++;
      if (path.length === 0) {
        record({
          tick: state.tick,
          action: "blocked",
          target: [targetX, targetY],
          steps: 0,
          gemsCollected: 0,
        });
        return { ok: false, reason: "unreachable", path };
      }
      let gemsCollected = 0;
      for (let i = 1; i < path.length; i++) {
        const [x, y] = path[i];
        state.player.x = x;
        state.player.y = y;
        state.moves++;
        const gemIndex = map.gems.findIndex(
          (gem) => gem[0] === x && gem[1] === y,
        );
        if (gemIndex >= 0 && !state.collected.some((g) => g[0] === x && g[1] === y)) {
          state.collected.push([x, y]);
          state.score += 100;
          gemsCollected++;
        }
      }
      record({
        tick: state.tick,
        action: "move",
        target: [targetX, targetY],
        steps: path.length - 1,
        gemsCollected,
      });
      return { ok: true, path, gemsCollected };
    },

    updateSettings(patch) {
      Object.assign(state.settings, patch);
      record({
        tick: ++state.tick,
        action: "settings",
        patch,
        steps: 0,
        gemsCollected: 0,
      });
    },

    replaySummary() {
      const recent = replay.slice(-REPLAY_LIMIT);
      return {
        capacity: REPLAY_LIMIT,
        count: recent.length,
        totalSteps: recent.reduce((sum, item) => sum + item.steps, 0),
        totalGems: recent.reduce(
          (sum, item) => sum + item.gemsCollected,
          0,
        ),
        lastAction: recent.length ? recent[recent.length - 1].action : null,
        recent,
      };
    },

    // Everything that must survive a browser reload / app restart.
    snapshot() {
      return {
        map,
        progress: {
          player: state.player,
          score: state.score,
          moves: state.moves,
          tick: state.tick,
          collected: state.collected,
        },
        settings: { ...state.settings },
        replaySummary: game.replaySummary(),
      };
    },

    restore(snapshot) {
      const restored = createGame({
        map: snapshot.map,
        settings: snapshot.settings,
        cacheCapacity: pathService.cache.capacity,
      });
      restored.state.player = { ...snapshot.progress.player };
      restored.state.score = snapshot.progress.score;
      restored.state.moves = snapshot.progress.moves;
      restored.state.tick = snapshot.progress.tick;
      restored.state.collected = snapshot.progress.collected.map((g) => [
        g[0],
        g[1],
      ]);
      for (const action of snapshot.replaySummary.recent) {
        restored.replayPushExternal(action);
      }
      return restored;
    },

    replayPushExternal(action) {
      replay.push({ ...action });
      if (replay.length > REPLAY_LIMIT) {
        replay.shift();
      }
    },
  };

  return game;
}
