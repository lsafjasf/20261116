import assert from "node:assert/strict";
import test from "node:test";
import {
  MATERIAL_LIST,
  MAX_EXPOSURE,
  MAX_RANGE,
  SCAN_COST,
} from "../src/config.js";
import { createGame, replayRecord } from "../src/game.js";
import { echoIntensity, findPath, scanSonar, worldSignature } from "../src/world.js";

function moveToExit(game, exit, limit = 8000) {
  const path = findPath(game.world, game.world.start, exit);
  assert.ok(path, "exit must be reachable");
  let waypoint = 1;
  let ticks = 0;
  while (game.state.status === "RUNNING" && ticks < limit) {
    const target = path[Math.min(waypoint, path.length - 1)];
    const targetX = target.x + 0.5;
    const targetY = target.y + 0.5;
    const dx = targetX - game.state.position.x;
    const dy = targetY - game.state.position.y;
    if (Math.hypot(dx, dy) < 0.22 && waypoint < path.length - 1) waypoint += 1;
    game.tick({
      dx: Math.abs(dx) < 0.05 ? 0 : Math.sign(dx),
      dy: Math.abs(dy) < 0.05 ? 0 : Math.sign(dy),
    });
    ticks += 1;
    if (
      Math.hypot(
        exit.x + 0.5 - game.state.position.x,
        exit.y + 0.5 - game.state.position.y,
      ) < 1.7
    ) {
      return game.submitExit();
    }
  }
  return { ok: false, reason: game.state.failureReason || "route_timeout" };
}

test("same seed produces the same four-material cave and three reachable exits", () => {
  const first = createGame(20261116);
  const second = createGame(20261116);
  const other = createGame(20261117);
  assert.equal(first.getHash(), second.getHash());
  assert.equal(worldSignature(first.world), worldSignature(second.world));
  assert.notEqual(first.getHash(), other.getHash());

  const materialCounts = new Map(MATERIAL_LIST.map((material) => [material.id, 0]));
  let gateCount = 0;
  for (const tile of first.world.grid) {
    if (materialCounts.has(tile)) materialCounts.set(tile, materialCounts.get(tile) + 1);
    if (tile === 9) gateCount += 1;
  }
  for (const material of MATERIAL_LIST) {
    assert.ok(materialCounts.get(material.id) > 20, `${material.name} should be present`);
  }
  assert.equal(gateCount, 3);
  assert.equal(first.world.exits.length, 3);
  for (const exit of first.world.exits) {
    assert.ok(findPath(first.world, first.world.start, exit), `${exit.name} should be reachable`);
  }
  assert.equal(first.world.currents.length, 3);
  assert.equal(first.world.initialPatrols.length, 3);
});

test("echo returns only from objects and depends on distance and material", () => {
  const game = createGame(20261116);
  const hits = scanSonar(game.world, game.world.start, 144, MAX_RANGE);
  assert.ok(hits.length > 20);
  assert.ok(hits.every((hit) => hit.distance > 0 && hit.intensity > 0));
  assert.ok(hits.every((hit) => hit.distance <= MAX_RANGE + 0.3));

  const closeCrystal = echoIntensity(MATERIAL_LIST[3], 3);
  const farCrystal = echoIntensity(MATERIAL_LIST[3], 15);
  assert.ok(closeCrystal > farCrystal);
  assert.ok(closeCrystal <= 1);
  assert.ok(echoIntensity(MATERIAL_LIST[3], 5) > echoIntensity(MATERIAL_LIST[1], 5));
  assert.ok(echoIntensity(MATERIAL_LIST[1], 5) > echoIntensity(MATERIAL_LIST[2], 5));

  const shortHits = scanSonar(game.world, game.world.start, 144, 0.3);
  assert.ok(shortHits.length <= hits.length);
  assert.ok(shortHits.every((hit) => hit.distance <= 0.3));
});

test("success route pauses, emits sonar, exits correctly, and replays to the same hash", () => {
  const game = createGame(20261116);
  game.start();
  const scan = game.scan();
  assert.equal(scan.ok, true);
  assert.ok(scan.hits.length > 0);

  for (let index = 0; index < 5; index += 1) game.tick();
  const beforePause = game.state.tick;
  assert.equal(game.pause(), true);
  for (let index = 0; index < 20; index += 1) game.tick({ dx: 1, dy: 0 });
  assert.equal(game.state.tick, beforePause, "paused ticks must not advance");
  assert.equal(game.resume(), true);

  const correctExit = game.world.exits[game.world.correctExitIndex];
  const result = moveToExit(game, correctExit);
  assert.equal(result.ok, true);
  assert.equal(result.correct, true);
  assert.equal(game.state.status, "SUCCESS");
  assert.equal(game.state.revealMap, true);

  const record = JSON.parse(JSON.stringify(game.exportRecord()));
  assert.ok(record.events.length > 100);
  const replayed = replayRecord(record);
  assert.equal(replayed.state.status, "SUCCESS");
  assert.equal(replayed.getHash(), record.finalHash);
  assert.equal(replayed.state.revealMap, true);
});

test("wrong exit is a recorded operation mistake and recovery resumes the run", () => {
  const game = createGame(20261116);
  game.start();
  const wrongId = (game.world.correctExitIndex + 1) % game.world.exits.length;
  const wrongExit = game.world.exits[wrongId];
  const result = moveToExit(game, wrongExit);
  assert.equal(result.ok, true);
  assert.equal(result.correct, false);
  assert.equal(game.state.status, "FAILED");
  assert.equal(game.state.failureReason, "wrong_exit");
  assert.equal(game.state.revealMap, true);

  const batteryBeforeRecovery = game.state.battery;
  const recovery = game.recover();
  assert.equal(recovery.ok, true);
  assert.equal(game.state.status, "RUNNING");
  assert.equal(game.state.recoveries, 0);
  assert.equal(game.state.revealMap, false);
  assert.ok(game.state.battery < batteryBeforeRecovery);
  assert.equal(game.recover().ok, false, "only one recovery is available");
  game.tick({ dx: 1, dy: 0 });
  const record = game.exportRecord();
  const replayed = replayRecord(record);
  assert.equal(replayed.getHash(), record.finalHash);
});

test("extreme parameters fail safely at exposure, battery, range, and input bounds", () => {
  for (const seed of [0, 0xffffffff]) {
    const game = createGame(seed);
    assert.equal(game.world.exits.length, 3);
    for (const exit of game.world.exits) {
      assert.ok(findPath(game.world, game.world.start, exit));
    }
  }

  const exposureGame = createGame(20261116);
  exposureGame.start();
  for (let scanIndex = 0; scanIndex < 8; scanIndex += 1) {
    exposureGame.scan();
    for (let tick = 0; tick < 35; tick += 1) exposureGame.tick();
  }
  assert.equal(exposureGame.state.status, "FAILED");
  assert.equal(exposureGame.state.failureReason, "exposure");
  assert.equal(exposureGame.state.exposure, MAX_EXPOSURE);
  assert.equal(exposureGame.state.revealMap, false);

  const batteryGame = createGame(20261116);
  batteryGame.start();
  batteryGame.state.battery = SCAN_COST - 1;
  const denied = batteryGame.scan();
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "battery");
  batteryGame.state.battery = 0;
  batteryGame.tick();
  assert.equal(batteryGame.state.status, "FAILED");
  assert.equal(batteryGame.state.failureReason, "battery");

  const inputGame = createGame(20261116);
  inputGame.start();
  const start = { ...inputGame.state.position };
  inputGame.tick({ dx: 99999, dy: -99999 });
  assert.ok(Number.isFinite(inputGame.state.position.x));
  assert.ok(Number.isFinite(inputGame.state.position.y));
  assert.ok(Math.hypot(inputGame.state.position.x - start.x, inputGame.state.position.y - start.y) < 0.3);
  assert.ok(inputGame.state.hull > 0);
});

test("restart resets timer, resources, audio/visual counters, RNG, and the initial hash", () => {
  const game = createGame(424242);
  const fresh = createGame(424242);
  game.start();
  game.scan();
  for (let tick = 0; tick < 90; tick += 1) game.tick({ dx: 1, dy: 0 });
  const dirty = game.getDiagnostics();
  assert.ok(dirty.tick > 0);
  assert.ok(dirty.audioSeq > 0);
  assert.ok(dirty.visualClock > 0);
  assert.ok(dirty.recordEvents > 0);

  game.restart();
  const reset = game.getDiagnostics();
  const baseline = fresh.getDiagnostics();
  assert.equal(reset.status, "READY");
  assert.equal(reset.tick, 0);
  assert.equal(reset.elapsedMs, 0);
  assert.equal(reset.battery, 100);
  assert.equal(reset.exposure, 0);
  assert.equal(reset.hull, 100);
  assert.equal(reset.recoveries, 1);
  assert.equal(reset.audioSeq, 0);
  assert.equal(reset.audioQueueLength, 0);
  assert.equal(reset.visualClock, 0);
  assert.equal(reset.pulseCount, 0);
  assert.equal(reset.patrolPingCount, 0);
  assert.equal(reset.recordEvents, 0);
  assert.equal(reset.rngState, baseline.rngState);
  assert.equal(reset.hash, baseline.hash);
  assert.equal(game.state.pulses.length, 0);
  assert.equal(game.state.echoes.length, 0);
  assert.equal(game.state.trail.length, 1);
});
