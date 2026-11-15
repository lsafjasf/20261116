import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  PHASE,
  createSimulation,
  hashState,
  makeReplayRecord,
  runReplay,
  setCommands,
} from "../src/sim.js";
import { runAutopilot } from "../src/autopilot.js";

const outDir = new URL("../artifacts/", import.meta.url);
await mkdir(outDir, { recursive: true });

function writeRecord(name, record) {
  return writeFile(new URL(name, outDir), `${JSON.stringify(record, null, 2)}\n`);
}

function summary(state, replayed, record) {
  return {
    seed: state.seed,
    phase: state.phase,
    tick: state.tick,
    elapsed: Number(state.elapsed.toFixed(3)),
    latchCount: state.latchCount,
    failure: state.failure,
    driftEvents: state.driftSerial,
    resources: state.resources,
    finalHash: hashState(state),
    replayHash: hashState(replayed),
    hashMatch: hashState(state) === hashState(replayed),
    recordedHash: record.finalHash,
    inputEvents: record.inputLog.length,
  };
}

const success = createSimulation("verify-success-01");
runAutopilot(success, 10810);
assert.equal(success.phase, PHASE.COMPLETE);
const successRecord = makeReplayRecord(success);
await writeRecord("replay-success.json", successRecord);
const savedSuccess = JSON.parse(await readFile(new URL("replay-success.json", outDir), "utf8"));
const successReplay = runReplay(savedSuccess.seed, savedSuccess.inputLog, savedSuccess.endTick);
assert.equal(hashState(successReplay), hashState(success));

const mistake = createSimulation("verify-mistake-01");
while (mistake.phase !== PHASE.FAILED) {
  setCommands(mistake, { yaw: 0, pitch: 0, throttle: 1 });
  const { step } = await import("../src/sim.js");
  step(mistake);
}
assert.equal(mistake.phase, PHASE.FAILED);
const mistakeRecord = makeReplayRecord(mistake);
await writeRecord("replay-mistake.json", mistakeRecord);
const mistakeReplay = runReplay(mistakeRecord.seed, mistakeRecord.inputLog, mistakeRecord.endTick);
assert.equal(hashState(mistakeReplay), hashState(mistake));

const limit = createSimulation("verify-limit-01");
setCommands(limit, { yaw: 999, pitch: -999, throttle: 999 });
const { step } = await import("../src/sim.js");
while (limit.phase !== PHASE.FAILED) {
  step(limit);
}
const limitRecord = makeReplayRecord(limit);
await writeRecord("replay-limit.json", limitRecord);
const limitReplay = runReplay(limitRecord.seed, limitRecord.inputLog, limitRecord.endTick);
assert.equal(hashState(limitReplay), hashState(limit));

const restartA = createSimulation("restart-proof");
runAutopilot(restartA, 500);
const restartB = createSimulation("restart-proof");
runAutopilot(restartB, 500);
assert.equal(hashState(restartA), hashState(restartB));
assert.equal(restartB.tick, restartA.tick);

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  success: summary(success, successReplay, successRecord),
  mistake: summary(mistake, mistakeReplay, mistakeRecord),
  limit: summary(limit, limitReplay, limitRecord),
  restart: {
    seed: restartB.seed,
    resetTick: createSimulation(restartB.seed).tick,
    resetResources: createSimulation(restartB.seed).resources,
    sequenceHashA: hashState(restartA),
    sequenceHashB: hashState(restartB),
    sequenceMatch: hashState(restartA) === hashState(restartB),
  },
};
await writeFile(new URL("verification.json", outDir), `${JSON.stringify(report, null, 2)}\n`);

console.log("成功路线", report.success);
console.log("操作失误", report.mistake);
console.log("参数极限", report.limit);
console.log("重新开始与同 seed 序列", report.restart);
console.log(`\n所有最终状态哈希一致。产物写入 ${outDir.pathname}`);
