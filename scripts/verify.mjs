import { mkdir, writeFile } from "node:fs/promises";
import { Game, MODES, STATE, replayRecord } from "../src/engine.js";

function started(seed) {
  const game = new Game(seed);
  game.start();
  return game;
}

function ranked(game) {
  return game.state.cargos.slice().sort((left, right) => left.rank - right.rank);
}

function complete(game) {
  const modes = ["standard", "saver", "standard", "escort"];
  modes.forEach((mode, index) => {
    const cargo = ranked(game).find((item) => !item.loaded);
    game.tick(12 + index * 3);
    game.propose(cargo.id, mode);
    game.respond("accept");
  });
}

const success = started("PORT-640");
const successRoles = [];
for (let index = 0; index < 4; index += 1) {
  const cargo = ranked(success).find((item) => !item.loaded);
  const mode = ["standard", "saver", "standard", "escort"][index];
  successRoles.push(success.state.activeRole);
  success.tick(12 + index * 3);
  success.propose(cargo.id, mode);
  success.respond("accept");
}
const successRecord = success.toRecord();
const successReplay = replayRecord(successRecord);

const mistake = started("MISTAKE-640");
const mistakeCargo = ranked(mistake).at(-1);
const mistakeInitial = {
  credit: mistake.state.credit,
  rngState: mistake.state.rngState,
  forecast: mistake.state.randomForecast,
};
mistake.tick(30);
mistake.propose(mistakeCargo.id, "standard");
mistake.respond("accept");
const mistakeResult = {
  wrongOrder: mistake.state.stats.wrongOrder,
  credit: mistake.state.credit,
  loaded: mistake.state.loaded.length,
  checkpointLoaded: mistake.checkpointInfo().loaded,
  hash: mistake.hash(),
};
const restore = mistake.restoreCheckpoint();
const restoreResult = {
  ok: restore.ok,
  loaded: mistake.state.loaded.length,
  credit: mistake.state.credit,
  tick: mistake.state.tick,
  rngReset: mistake.state.rngState === mistakeInitial.rngState,
  forecastReset: JSON.stringify(mistake.state.randomForecast) === JSON.stringify(mistakeInitial.forecast),
};
complete(mistake);
const mistakeRecord = mistake.toRecord();
const mistakeReplay = replayRecord(mistakeRecord);

const timeout = started("TIMEOUT-640");
timeout.propose(ranked(timeout)[0].id, "standard");
timeout.tick(MODES.standard.ticks);
const timeoutResult = {
  status: timeout.state.status,
  credit: timeout.state.credit,
  timeouts: timeout.state.stats.timeouts,
  lastChange: timeout.state.lastChange.kind,
};

const extreme = started("4294967295");
extreme.tick(Number.MAX_SAFE_INTEGER);
let proposalCount = 0;
while (extreme.state.status === STATE.REQUESTING && proposalCount < 12) {
  extreme.propose(ranked(extreme)[0].id, "saver");
  extreme.tick(Number.MAX_SAFE_INTEGER);
  proposalCount += 1;
}
const extremeRecord = extreme.toRecord();
const extremeReplay = replayRecord(extremeRecord);

const resetGame = started("RESET-640");
complete(resetGame);
resetGame.restart();
const fresh = started("RESET-640");
const resetResult = {
  tick: resetGame.state.tick,
  credit: resetGame.state.credit,
  negotiation: resetGame.state.negotiation,
  loaded: resetGame.state.loaded.length,
  forecastSame: JSON.stringify(resetGame.state.randomForecast) === JSON.stringify(fresh.state.randomForecast),
  randomSequenceSame: JSON.stringify(resetGame.randomPreview(16)) === JSON.stringify(fresh.randomPreview(16)),
  hashSame: resetGame.hash() === fresh.hash(),
};

const report = {
  version: 1,
  success: {
    seed: successRecord.seed,
    roles: successRoles,
    status: success.state.status,
    credit: success.state.credit,
    loaded: success.state.loaded,
    inputs: successRecord.inputs.length,
    finalTick: successRecord.finalTick,
    finalHash: successRecord.finalHash,
    replayHash: successReplay.finalHash,
    hashMatch: successReplay.matches,
  },
  mistake: {
    seed: "MISTAKE-640",
    result: mistakeResult,
    recovery: restoreResult,
    finalStatus: mistake.state.status,
    finalHash: mistakeRecord.finalHash,
    replayHash: mistakeReplay.finalHash,
    hashMatch: mistakeReplay.matches,
  },
  timeout: timeoutResult,
  extreme: {
    seed: extreme.state.seed,
    proposalCount,
    status: extreme.state.status,
    credit: extreme.state.credit,
    timeouts: extreme.state.stats.timeouts,
    finalTick: extremeRecord.finalTick,
    finalHash: extremeRecord.finalHash,
    replayHash: extremeReplay.finalHash,
    hashMatch: extremeReplay.matches,
  },
  reset: resetResult,
};

await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/verification-report.json", `${JSON.stringify(report, null, 2)}\n`);
await writeFile("artifacts/success-record.json", `${JSON.stringify(successRecord, null, 2)}\n`);
await writeFile("artifacts/mistake-recovery-record.json", `${JSON.stringify(mistakeRecord, null, 2)}\n`);
await writeFile("artifacts/extreme-record.json", `${JSON.stringify(extremeRecord, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
