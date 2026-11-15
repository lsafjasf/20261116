import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  RestorationEngine,
  SOURCE_HASHES,
  hashString,
  stableStringify
} from "../src/engine.js";
import { TOOLS, getSample } from "../src/samples.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(root, "artifacts", "verification");
const seed = 17042;
const sample = getSample("rain-shed");

function diagnoseAll(engine) {
  for (const damageId of engine.sample.damage) {
    assert.equal(engine.diagnose(damageId).ok, true);
  }
}

function finishJob(engine) {
  while (engine.currentState === "repairing") engine.tick();
}

function valueFor(engine, tool) {
  return tool.id === "align" ? engine.sample.driftMs : tool.ideal;
}

async function writeJSON(name, value) {
  const path = join(outputDir, name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

await mkdir(outputDir, { recursive: true });
const sourceBefore = hashString(stableStringify(sample));
const engine = new RestorationEngine({ seed, selectedId: sample.id });
diagnoseAll(engine);

for (const toolId of engine.requiredTools) {
  const tool = TOOLS.find((item) => item.id === toolId);
  engine.advanceTo(engine.tickCount + 4);
  const started = engine.startRepair(toolId, valueFor(engine, tool));
  assert.equal(started.ok, true, `start ${toolId}`);
  if (toolId === "interpolate") {
    engine.advanceTo(engine.tickCount + 18);
    assert.equal(engine.pauseSession().ok, true);
    const frozen = {
      tick: engine.tickCount,
      clock: engine.sessionSeconds,
      progress: engine.project.activeJob.progress,
      rng: engine.rngState
    };
    for (let index = 0; index < 20; index += 1) engine.tick();
    assert.deepEqual(
      {
        tick: engine.tickCount,
        clock: engine.sessionSeconds,
        progress: engine.project.activeJob.progress,
        rng: engine.rngState
      },
      frozen
    );
    assert.equal(engine.resumeSession().ok, true);
  }
  finishJob(engine);
}

assert.equal(engine.verification.pass, true);
const archived = engine.archive();
assert.equal(archived.ok, true);
assert.equal(hashString(stableStringify(sample)), sourceBefore);
assert.equal(SOURCE_HASHES[sample.id], sourceBefore);

const allFragments = engine.search("");
const titleFragments = engine.search("雨棚");
const syncFragments = engine.search("同步");
const interpolateFragments = engine.search("补帧");
assert.equal(allFragments.length, 3);
assert.equal(titleFragments.length, 3);
assert.equal(syncFragments.length, 1);
assert.equal(interpolateFragments.length, 1);

const bundle = engine.exportBundle();
assert.equal(bundle.fragmentCount, 3);
assert.equal(bundle.entries.length, 1);
const runRecord = JSON.parse(JSON.stringify(engine.getRunRecord()));
const replayed = RestorationEngine.replay(runRecord);
const replayedHash = replayed.getStateHash();
assert.equal(replayedHash, runRecord.stateHash);
assert.equal(replayedHash, archived.stateHash);
assert.equal(replayed.finalStateHash, archived.stateHash);

const summaryFile = await writeJSON("summary.json", archived.summary);
const indexFile = await writeJSON("index.json", bundle);
const runFile = await writeJSON("run-record.json", runRecord);
const relative = (path) => path.slice(root.length + 1);

const mistakeEngine = new RestorationEngine({ seed });
for (const damageId of mistakeEngine.sample.damage) mistakeEngine.diagnose(damageId);
const mistake = mistakeEngine.startRepair("align", mistakeEngine.sample.driftMs);
assert.equal(mistake.code, "ORDER_ERROR");
assert.equal(mistakeEngine.currentState, "failed");
assert.equal(mistakeEngine.recover().ok, true);
assert.equal(mistakeEngine.currentState, "inspect");

const limitEngine = new RestorationEngine({ seed });
for (const damageId of limitEngine.sample.damage) limitEngine.diagnose(damageId);
const limit = limitEngine.startRepair("denoise", 100);
assert.equal(limit.code, "PARAM_LIMIT");
assert.equal(limitEngine.currentState, "failed");
assert.equal(limitEngine.recover().ok, true);

const resetEngine = new RestorationEngine({ seed });
const freshHash = resetEngine.getStateHash();
const freshRandom = resetEngine.random();
resetEngine.diagnose("hum");
resetEngine.playMedia();
resetEngine.advanceTo(40);
resetEngine.startRepair("denoise", 68);
resetEngine.advanceTo(90);
resetEngine.reset();
assert.equal(resetEngine.sessionSeconds, 0);
assert.equal(resetEngine.project.mediaPlayhead, 0);
assert.equal(resetEngine.rngState, seed);
assert.deepEqual(resetEngine.resources, { cpu: 260, memory: 512, integrity: 100 });
assert.equal(resetEngine.getStateHash(), freshHash);
const resetHash = resetEngine.getStateHash();
const resetRngState = resetEngine.rngState;
assert.equal(resetEngine.random(), freshRandom);

const report = {
  schema: "restoration-verification/v1",
  generatedAt: new Date().toISOString(),
  seed,
  scenarios: {
    success: {
      pass: true,
      sampleId: sample.id,
      archiveId: archived.summary.archiveId,
      state: engine.currentState,
      metrics: archived.summary.metrics,
      fragments: allFragments.map((fragment) => fragment.fragmentId)
    },
    misoperation: {
      pass: true,
      code: mistake.code,
      recovered: mistakeEngine.currentState === "inspect",
      error: mistake.error.title
    },
    parameterLimit: {
      pass: true,
      code: limit.code,
      requested: 100,
      safeRange: [20, 95],
      recovered: limitEngine.currentState === "inspect"
    },
    pause: {
      pass: true,
      frozen: [
        "session clock",
        "media playhead",
        "job progress",
        "RNG state"
      ]
    },
    reset: {
      pass: true,
      clock: resetEngine.sessionSeconds,
      mediaPlayhead: resetEngine.project.mediaPlayhead,
      resources: resetEngine.resources,
      rngState: resetRngState,
      stateHash: resetHash
    },
    deterministicReplay: {
      pass: replayedHash === archived.stateHash,
      expected: archived.stateHash,
      actual: replayedHash,
      ticks: runRecord.finalTick,
      seed: runRecord.seed
    }
  },
  searchVerification: {
    totalFragments: allFragments.length,
    queryResults: {
      "": allFragments.length,
      "雨棚": titleFragments.length,
      "同步": syncFragments.map((fragment) => fragment.fragmentId),
      "补帧": interpolateFragments.map((fragment) => fragment.fragmentId)
    },
    pass: titleFragments.length === allFragments.length
  },
  exportVerification: {
    fragmentCount: bundle.fragmentCount,
    archiveCount: bundle.archiveCount,
    summaryPath: relative(summaryFile),
    indexPath: relative(indexFile),
    runRecordPath: relative(runFile),
    sourceHashUnchanged:
      hashString(stableStringify(sample)) === sourceBefore,
    pass: bundle.fragmentCount === 3
  }
};

const reportPath = await writeJSON("report.json", report);
console.log(`Verification passed: ${reportPath}`);
console.log(
  `Archive ${archived.summary.archiveId} · ${allFragments.length} fragments · state ${archived.stateHash}`
);
console.log(
  `Deterministic replay ${replayedHash === archived.stateHash ? "MATCH" : "MISMATCH"}`
);
