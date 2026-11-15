import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame, generateMap } from "../src/core/game.js";
import { stableStringify } from "../src/core/checksum.js";
import { runScenario, SCENARIOS } from "../scripts/scenario_lib.js";

test("cache on and off return byte-identical paths", () => {
  const map = generateMap({
    seed: 5,
    width: 20,
    height: 14,
    wallRatio: 0.2,
    gemCount: 5,
  });
  const noCache = createGame({ map, cacheCapacity: 0 });
  const cached = createGame({
    map: structuredClone(map),
    cacheCapacity: 128,
  });
  const targets = [
    [18, 12],
    [1, 12],
    [18, 1],
    [10, 7],
    [18, 12],
    [10, 7],
    [18, 12],
    [10, 7],
  ];
  for (const target of targets) {
    const a = noCache.moveToward(target[0], target[1]);
    const b = cached.moveToward(target[0], target[1]);
    assert.deepEqual(a.path, b.path);
    assert.equal(a.ok, b.ok);
  }
  // Ping-pong between two points reuses identical (start, goal) cache keys.
  for (let i = 0; i < 4; i++) {
    const targetA = noCache.moveToward(10, 7);
    const targetB = cached.moveToward(10, 7);
    assert.deepEqual(targetA.path, targetB.path);
    const backA = noCache.moveToward(18, 12);
    const backB = cached.moveToward(18, 12);
    assert.deepEqual(backA.path, backB.path);
  }
  assert.ok(cached.pathService.cache.hits > 0);
  assert.equal(
    cached.pathService.nodesExpanded < noCache.pathService.nodesExpanded,
    true,
  );
});

test("fixed pre and post scenarios keep identical public snapshots", () => {
  const pre = runScenario("pre", SCENARIOS.pre);
  const post = runScenario("post", SCENARIOS.post);
  assert.equal(pre.outputHash, post.outputHash);
  assert.equal(
    stableStringify(pre.snapshot),
    stableStringify(post.snapshot),
  );
  assert.deepEqual(pre.errors, post.errors);
  assert.ok(post.metrics.nodesExpanded < pre.metrics.nodesExpanded);
  assert.ok(post.metrics.cache.hitRate > 0);
});

test("edge scenario logs unreachable targets without throwing", () => {
  const edge = runScenario("edge", SCENARIOS.edge);
  assert.ok(edge.errors.length > 0);
  assert.ok(edge.errors.every((entry) => entry.code === "UNREACHABLE"));
  assert.ok(edge.progress.moves > 0);
});
