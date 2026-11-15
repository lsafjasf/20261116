import test from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG,
  GameState,
  RhythmGame,
  clampCalibration
} from "../src/game-core.js";

function readyGame(seed = 0x20261116) {
  const game = new RhythmGame({ seed });
  game.ready();
  return game;
}

function start(game) {
  assert.equal(game.begin(), true);
  game.advance(CONFIG.countdownMs);
  assert.equal(game.state, GameState.PLAYING);
}

function playPerfect(game) {
  for (const note of game.notes) {
    game.advance(note.timeMs - game.songMs);
    if (game.focus !== note.lane) game.toggleFocus();
    game.pressLane(note.lane);
  }
  game.advance(CONFIG.durationMs - game.songMs);
}

test("success route completes 60 seconds and all notes", () => {
  const game = readyGame(0x5150);
  start(game);
  playPerfect(game);

  assert.equal(game.state, GameState.SUCCESS);
  assert.equal(game.songMs, CONFIG.durationMs);
  assert.equal(game.integrity, 100);
  assert.equal(game.hits.perfect, game.notes.length);
  assert.equal(game.misses, 0);
  assert.equal(game.combo, game.notes.length);
  assert.equal(game.multiplier, CONFIG.maxMultiplier);
  assert.ok(game.notes.some((note) => note.cross), "chart contains crossing notes");

  const record = game.exportRecord();
  assert.equal(record.finalState, GameState.SUCCESS);
  assert.match(record.finalHash, /^[0-9a-f]{16}$/);
  assert.equal(record.seed, 0x5150);
  assert.ok(record.inputs.length > game.notes.length / 2);
});

test("one missed note blurs the opposite track but still allows success", () => {
  const game = readyGame(0x5152);
  start(game);
  const skipped = game.notes[0];
  game.advance(skipped.timeMs + CONFIG.missWindowMs + 1);
  game.advance(0);

  assert.equal(game.misses, 1);
  assert.equal(game.integrity, 100 - CONFIG.missIntegrity);
  assert.equal(game.blurLane, 1 - skipped.lane);
  assert.equal(game.blurUntil, skipped.timeMs + CONFIG.missWindowMs + CONFIG.blurMs);
  assert.equal(game.combo, 0);
  assert.match(game.lastChange.message, /漏拍|模糊/);

  for (let index = 1; index < game.notes.length; index += 1) {
    const note = game.notes[index];
    game.advance(note.timeMs - game.songMs);
    if (game.focus !== note.lane) game.toggleFocus();
    game.pressLane(note.lane);
  }
  game.advance(CONFIG.durationMs - game.songMs);

  assert.equal(game.state, GameState.SUCCESS);
  assert.equal(game.misses, 1);
  assert.equal(game.integrity, 100);
  assert.equal(game.maxCombo, game.notes.length - 1);
});

test("pause freezes the clock and audio-facing state", () => {
  const game = readyGame(77);
  game.begin();
  game.advance(500);
  const countdownBefore = game.countdownElapsed;
  assert.equal(game.pause(), true);
  assert.equal(game.state, GameState.PAUSED);
  game.advance(5_000);
  assert.equal(game.songMs, 0);
  assert.equal(game.countdownElapsed, countdownBefore);
  assert.equal(game.resume(), true);
  assert.equal(game.state, GameState.COUNTDOWN);
  game.advance(CONFIG.countdownMs);
  assert.equal(game.state, GameState.PLAYING);
});

test("failure recovery resets timer, integrity, inputs and chart randomness", () => {
  const game = readyGame(0xbadc0de);
  const chartDigest = game.chartDigest;
  const randomBefore = game.peekRandomSequence(6);
  start(game);
  game.advance(10_000);
  assert.equal(game.state, GameState.FAILED);
  assert.equal(game.integrity, 0);
  assert.equal(game.misses, 9);

  assert.equal(game.recover(), true);
  assert.equal(game.state, GameState.READY);
  assert.equal(game.songMs, 0);
  assert.equal(game.integrity, 100);
  assert.equal(game.score, 0);
  assert.equal(game.combo, 0);
  assert.equal(game.multiplier, 1);
  assert.equal(game.misses, 0);
  assert.equal(game.inputLog.length, 0);
  assert.equal(game.chartDigest, chartDigest);
  assert.deepEqual(game.peekRandomSequence(6), randomBefore);
});

test("parameter extremes clamp calibration, time and multiplier", () => {
  assert.equal(clampCalibration(-9_999), CONFIG.calibrationMinMs);
  assert.equal(clampCalibration(9_999), CONFIG.calibrationMaxMs);
  assert.equal(clampCalibration(Number.NaN), 0);

  const low = readyGame(0xffffffff);
  low.startCalibration();
  for (let index = 0; index < CONFIG.calibrationSamples; index += 1) {
    low.addCalibrationSample(-9_999);
  }
  assert.equal(low.state, GameState.READY);
  assert.equal(low.calibrationOffset, CONFIG.calibrationMinMs);

  const high = readyGame(0);
  high.startCalibration();
  for (let index = 0; index < CONFIG.calibrationSamples; index += 1) {
    high.addCalibrationSample(9_999);
  }
  assert.equal(high.calibrationOffset, CONFIG.calibrationMaxMs);

  const game = readyGame(0xffffffff);
  start(game);
  game.advance(-1_000);
  assert.equal(game.songMs, 0);
  game.advance(Number.MAX_SAFE_INTEGER);
  assert.ok(game.songMs <= CONFIG.durationMs);
  assert.equal(game.state, GameState.FAILED);

  const perfect = readyGame(9);
  start(perfect);
  playPerfect(perfect);
  assert.equal(perfect.multiplier, CONFIG.maxMultiplier);
  assert.ok(perfect.multiplier <= CONFIG.maxMultiplier);
});

test("restart resets every run-scoped field and rebuilds identical chart", () => {
  const game = readyGame(0x12345678);
  const initialChart = game.notes.map((note) => ({ ...note }));
  const initialDigest = game.chartDigest;
  const initialRandom = game.peekRandomSequence(8);
  start(game);
  const first = game.notes[0];
  game.advance(first.timeMs - game.songMs);
  if (game.focus !== first.lane) game.toggleFocus();
  game.pressLane(first.lane);
  assert.ok(game.score > 0);

  game.restart(0x12345678);
  assert.equal(game.state, GameState.READY);
  assert.equal(game.songMs, 0);
  assert.equal(game.countdownElapsed, 0);
  assert.equal(game.score, 0);
  assert.equal(game.combo, 0);
  assert.equal(game.integrity, 100);
  assert.equal(game.focus, 0);
  assert.equal(game.focusToggles, 0);
  assert.equal(game.inputLog.length, 0);
  assert.equal(game.results.every((result) => result === null), true);
  assert.equal(game.chartDigest, initialDigest);
  assert.deepEqual(game.notes, initialChart);
  assert.deepEqual(game.peekRandomSequence(8), initialRandom);
});

test("saved seed and inputs reproduce identical final state hash", () => {
  const original = readyGame(0xc0ffee);
  start(original);
  playPerfect(original);
  const record = original.exportRecord();

  const replay = new RhythmGame();
  replay.startReplay(record, { speed: 60 });
  replay.finishReplay();
  assert.equal(replay.state, GameState.SUCCESS);
  assert.equal(replay.hashState(), record.finalHash);
  assert.equal(replay.replayHashMatches(), true);
  assert.deepEqual(replay.inputLog, record.inputs);
});

test("failed run record also replays to the same final hash", () => {
  const original = readyGame(0x600d);
  start(original);
  original.advance(8_000);
  assert.equal(original.state, GameState.FAILED);
  const record = original.exportRecord();

  const replay = new RhythmGame({ seed: 1 });
  replay.startReplay(record, { speed: 20 });
  replay.finishReplay();
  assert.equal(replay.state, GameState.FAILED);
  assert.equal(replay.hashState(), record.finalHash);
});

test("illegal phase actions are rejected without mutating the run", () => {
  const game = readyGame(31);
  assert.equal(game.pause(), false);
  assert.equal(game.resume(), false);
  assert.equal(game.pressLane(0), false);
  assert.equal(game.toggleFocus(), false);
  assert.equal(game.state, GameState.READY);
  assert.equal(game.songMs, 0);
  assert.equal(game.inputLog.length, 0);
});
