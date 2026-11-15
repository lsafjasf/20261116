import { mkdir, writeFile } from "node:fs/promises";
import {
  CONFIG,
  GameState,
  RhythmGame,
  clampCalibration
} from "../src/game-core.js";

const root = new URL("../artifacts/", import.meta.url);
const recordsDir = new URL("records/", root);

function start(game) {
  game.ready();
  game.begin();
  game.advance(CONFIG.countdownMs);
}

function perfectRoute(seed) {
  const game = new RhythmGame({ seed });
  start(game);
  for (const note of game.notes) {
    game.advance(note.timeMs - game.songMs);
    if (game.focus !== note.lane) game.toggleFocus();
    game.pressLane(note.lane);
  }
  game.advance(CONFIG.durationMs - game.songMs);
  return game;
}

function mistakeRoute(seed) {
  const game = new RhythmGame({ seed });
  start(game);
  const skipped = game.notes[0];
  game.advance(skipped.timeMs + CONFIG.missWindowMs + 1);
  const blurObserved = {
    lane: game.blurLane,
    expected: 1 - skipped.lane,
    integrity: game.integrity,
    atMs: game.songMs
  };
  for (let index = 1; index < game.notes.length; index += 1) {
    const note = game.notes[index];
    game.advance(note.timeMs - game.songMs);
    if (game.focus !== note.lane) game.toggleFocus();
    game.pressLane(note.lane);
  }
  game.advance(CONFIG.durationMs - game.songMs);
  return { game, blurObserved };
}

function replay(record) {
  const game = new RhythmGame({ seed: 1 });
  game.startReplay(record, { speed: 60 });
  game.finishReplay();
  return {
    state: game.state,
    hash: game.hashState(),
    match: game.replayHashMatches()
  };
}

await mkdir(recordsDir, { recursive: true });

const success = perfectRoute(0x5150);
const successRecord = success.exportRecord();
const successReplay = replay(successRecord);
await writeFile(
  new URL("success-seed-20816.json", recordsDir),
  JSON.stringify(successRecord, null, 2)
);

const mistake = mistakeRoute(0x5152);
const mistakeRecord = mistake.game.exportRecord();
const mistakeReplay = replay(mistakeRecord);
await writeFile(
  new URL("mistake-seed-20818.json", recordsDir),
  JSON.stringify(mistakeRecord, null, 2)
);

const limitGame = new RhythmGame({ seed: 0xffffffff });
limitGame.ready();
limitGame.startCalibration();
for (let index = 0; index < CONFIG.calibrationSamples; index += 1) {
  limitGame.addCalibrationSample(-10_000);
}
const minOffset = limitGame.calibrationOffset;
limitGame.startCalibration();
for (let index = 0; index < CONFIG.calibrationSamples; index += 1) {
  limitGame.addCalibrationSample(10_000);
}
const maxOffset = limitGame.calibrationOffset;
limitGame.cancelCalibration();
limitGame.begin();
limitGame.advance(CONFIG.countdownMs);
limitGame.advance(Number.MAX_SAFE_INTEGER);

const failure = new RhythmGame({ seed: 0xbadc0de });
start(failure);
failure.advance(10_000);
const failedSnapshot = failure.getSnapshot();
const chartDigest = failure.chartDigest;
const randomSequence = failure.peekRandomSequence(8);
failure.recover();
const recoveredSnapshot = failure.getSnapshot();

const report = {
  generatedAt: new Date().toISOString(),
  config: CONFIG,
  successRoute: {
    seed: success.seed,
    state: success.state,
    songMs: success.songMs,
    notes: success.notes.length,
    inputs: successRecord.inputs.length,
    hits: success.hits,
    maxCombo: success.maxCombo,
    multiplier: success.multiplier,
    finalHash: successRecord.finalHash,
    replay: successReplay
  },
  mistakeRoute: {
    seed: mistake.game.seed,
    state: mistake.game.state,
    blurObserved: mistake.blurObserved,
    misses: mistake.game.misses,
    finalIntegrity: mistake.game.integrity,
    inputs: mistakeRecord.inputs.length,
    finalHash: mistakeRecord.finalHash,
    replay: mistakeReplay
  },
  parameterLimit: {
    calibrationMin: minOffset,
    calibrationMax: maxOffset,
    calibrationClampChecks: {
      low: clampCalibration(-99_999),
      high: clampCalibration(99_999),
      nan: clampCalibration(Number.NaN)
    },
    stateAfterMaxDelta: limitGame.state,
    songMsAfterMaxDelta: limitGame.songMs
  },
  failureRecovery: {
    failedState: failedSnapshot.state,
    failedSongMs: failedSnapshot.songMs,
    failedIntegrity: failedSnapshot.integrity,
    failedMisses: failedSnapshot.misses,
    recoveredState: recoveredSnapshot.state,
    recoveredSongMs: recoveredSnapshot.songMs,
    recoveredIntegrity: recoveredSnapshot.integrity,
    recoveredInputs: recoveredSnapshot.inputCount,
    chartStable: chartDigest === failure.chartDigest,
    randomStable: JSON.stringify(randomSequence) === JSON.stringify(failure.peekRandomSequence(8))
  },
  assertions: {
    successReplayHashMatches: successReplay.match,
    mistakeReplayHashMatches: mistakeReplay.match,
    mistakeBlurTargetCorrect: mistake.blurObserved.lane === mistake.blurObserved.expected,
    calibrationClamped: minOffset === CONFIG.calibrationMinMs && maxOffset === CONFIG.calibrationMaxMs,
    failureRecovered: recoveredSnapshot.state === GameState.READY && recoveredSnapshot.songMs === 0
  }
};

await writeFile(new URL("rhythm-verification.json", root), JSON.stringify(report, null, 2));

const failedAssertions = Object.entries(report.assertions)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);
if (failedAssertions.length) {
  console.error(`Verification failed: ${failedAssertions.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    successHash: report.successRoute.finalHash,
    successReplayMatch: successReplay.match,
    mistakeHash: report.mistakeRoute.finalHash,
    mistakeReplayMatch: mistakeReplay.match,
    calibration: [minOffset, maxOffset],
    recovered: report.failureRecovery
  }, null, 2));
}
