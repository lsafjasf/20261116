import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MATERIAL_LIST, MAX_EXPOSURE } from "../src/config.js";
import { createGame, replayRecord } from "../src/game.js";
import { findPath } from "../src/world.js";

const SEED = 20261116;

function moveToExit(game, exit, limit = 8000) {
  const path = findPath(game.world, game.world.start, exit);
  assert.ok(path, `No path to ${exit.name}`);
  let waypoint = 1;
  let tick = 0;
  while (game.state.status === "RUNNING" && tick < limit) {
    const target = path[Math.min(waypoint, path.length - 1)];
    const dx = target.x + 0.5 - game.state.position.x;
    const dy = target.y + 0.5 - game.state.position.y;
    if (Math.hypot(dx, dy) < 0.22 && waypoint < path.length - 1) waypoint += 1;
    game.tick({
      dx: Math.abs(dx) < 0.05 ? 0 : Math.sign(dx),
      dy: Math.abs(dy) < 0.05 ? 0 : Math.sign(dy),
    });
    tick += 1;
    if (
      Math.hypot(
        exit.x + 0.5 - game.state.position.x,
        exit.y + 0.5 - game.state.position.y,
      ) < 1.7
    ) {
      return game.submitExit();
    }
  }
  throw new Error(`Route did not reach ${exit.name}: ${game.state.failureReason}`);
}

const successGame = createGame(SEED);
successGame.start();
const scan = successGame.scan();
assert.equal(scan.ok, true);
for (let tick = 0; tick < 5; tick += 1) successGame.tick();
successGame.pause();
const pausedTick = successGame.state.tick;
for (let tick = 0; tick < 25; tick += 1) successGame.tick({ dx: 1 });
assert.equal(successGame.state.tick, pausedTick);
successGame.resume();
const correctExit = successGame.world.exits[successGame.world.correctExitIndex];
const successResult = moveToExit(successGame, correctExit);
assert.equal(successResult.correct, true);
assert.equal(successGame.state.status, "SUCCESS");
assert.equal(successGame.state.revealMap, true);
const record = successGame.exportRecord();
const replayed = replayRecord(record);
assert.equal(replayed.getHash(), record.finalHash);
assert.equal(replayed.state.status, "SUCCESS");

const mistakeGame = createGame(SEED);
mistakeGame.start();
const wrongExit =
  mistakeGame.world.exits[
    (mistakeGame.world.correctExitIndex + 1) % mistakeGame.world.exits.length
  ];
const mistakeResult = moveToExit(mistakeGame, wrongExit);
assert.equal(mistakeResult.correct, false);
assert.equal(mistakeGame.state.status, "FAILED");
assert.equal(mistakeGame.state.failureReason, "wrong_exit");
const wrongExitFailure = {
  status: mistakeGame.state.status,
  failureReason: mistakeGame.state.failureReason,
  revealMap: mistakeGame.state.revealMap,
};
const recovery = mistakeGame.recover();
assert.equal(recovery.ok, true);
assert.equal(mistakeGame.state.status, "RUNNING");

const extremeGame = createGame(SEED);
extremeGame.start();
for (let scanIndex = 0; scanIndex < 8; scanIndex += 1) {
  extremeGame.scan();
  for (let tick = 0; tick < 35; tick += 1) extremeGame.tick();
}
assert.equal(extremeGame.state.status, "FAILED");
assert.equal(extremeGame.state.failureReason, "exposure");
assert.equal(extremeGame.state.exposure, MAX_EXPOSURE);

const resetGame = createGame(SEED);
resetGame.start();
resetGame.scan();
for (let tick = 0; tick < 100; tick += 1) resetGame.tick({ dx: 1, dy: 1 });
resetGame.restart();
const freshGame = createGame(SEED);
assert.equal(resetGame.getHash(), freshGame.getHash());
assert.equal(resetGame.state.tick, 0);
assert.equal(resetGame.state.battery, 100);
assert.equal(resetGame.getDiagnostics().audioSeq, 0);
assert.equal(resetGame.getDiagnostics().recordEvents, 0);

const materialCounts = Object.fromEntries(MATERIAL_LIST.map((material) => [material.key, 0]));
for (const tile of successGame.world.grid) {
  const material = MATERIAL_LIST.find((entry) => entry.id === tile);
  if (material) materialCounts[material.key] += 1;
}

const artifact = {
  version: 1,
  generatedAt: new Date().toISOString(),
  seed: SEED,
  scenario: "success-with-sonar-pause-and-route",
  checks: {
    fourMaterials: materialCounts,
    success: {
      status: successGame.state.status,
      finalTick: record.finalTick,
      finalHash: record.finalHash,
      revealMap: successGame.state.revealMap,
      sonarReturns: scan.hits.length,
    },
    wrongExitMistake: {
      status: wrongExitFailure.status,
      failureReason: wrongExitFailure.failureReason,
      revealMap: wrongExitFailure.revealMap,
      recovered: recovery.ok,
      resumedStatus: mistakeGame.state.status,
    },
    extreme: {
      status: extremeGame.state.status,
      failureReason: extremeGame.state.failureReason,
      exposure: extremeGame.state.exposure,
    },
    restartReset: {
      tick: resetGame.state.tick,
      battery: resetGame.state.battery,
      rngState: resetGame.getDiagnostics().rngState,
      audioSeq: resetGame.getDiagnostics().audioSeq,
      visualClock: resetGame.getDiagnostics().visualClock,
      hash: resetGame.getHash(),
      matchesFreshInitialState: resetGame.getHash() === freshGame.getHash(),
    },
    replay: {
      expectedHash: record.finalHash,
      actualHash: replayed.getHash(),
      equal: replayed.getHash() === record.finalHash,
      status: replayed.state.status,
    },
  },
  record,
};

const outputPath = resolve("artifacts/verification.json");
const replayPath = resolve(`artifacts/replay-seed-${SEED}.json`);
mkdirSync(resolve("artifacts"), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
writeFileSync(replayPath, `${JSON.stringify(record, null, 2)}\n`);

console.log("Abyss Listener verification");
console.log(`seed: ${SEED}`);
console.log(`four materials: ${JSON.stringify(materialCounts)}`);
console.log(`success: tick ${record.finalTick}, hash ${record.finalHash}`);
console.log(`wrong exit: ${wrongExitFailure.failureReason}, recovery=${recovery.ok}`);
console.log(`extreme: ${extremeGame.state.failureReason} at exposure ${extremeGame.state.exposure}`);
console.log(`restart reset: ${resetGame.getHash() === freshGame.getHash()}`);
console.log(`replay hash: ${replayed.getHash()} (equal=${replayed.getHash() === record.finalHash})`);
console.log(`artifact: ${outputPath}`);
console.log(`replay record: ${replayPath}`);
