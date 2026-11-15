import assert from "node:assert/strict";
import test from "node:test";

import {
  RestorationEngine,
  SOURCE_HASHES,
  hashString,
  stableStringify
} from "../src/engine.js";
import { SAMPLES, TOOLS, getSample } from "../src/samples.js";

function diagnoseAll(engine) {
  for (const damageId of engine.sample.damage) {
    const result = engine.diagnose(damageId);
    assert.equal(result.ok, true, `diagnose ${damageId}`);
  }
  assert.equal(engine.diagnosisComplete, true);
}

function valueFor(engine, tool) {
  return tool.id === "align" ? engine.sample.driftMs : tool.ideal;
}

function finishJob(engine, limit = 500) {
  let ticks = 0;
  while (engine.currentState === "repairing" && ticks < limit) {
    engine.tick();
    ticks += 1;
  }
  assert.ok(ticks < limit, "job should finish");
}

function repairSample(sampleId = "rain-shed", seed = 17042) {
  const engine = new RestorationEngine({ seed, selectedId: sampleId });
  diagnoseAll(engine);
  for (const toolId of engine.requiredTools) {
    const tool = TOOLS.find((item) => item.id === toolId);
    const result = engine.startRepair(toolId, valueFor(engine, tool));
    assert.equal(result.ok, true, `start ${toolId}`);
    finishJob(engine);
  }
  return engine;
}

test("success route archives a searchable, exported repair", () => {
  const sample = getSample("rain-shed");
  const sourceBefore = hashString(stableStringify(sample));
  const engine = repairSample();

  assert.equal(engine.currentState, "ready");
  assert.deepEqual(engine.missingTools, []);
  assert.equal(engine.verification.pass, true);
  assert.ok(engine.verification.metrics.audio >= 80);
  assert.ok(engine.verification.metrics.video >= 80);
  assert.ok(engine.verification.metrics.sync >= 80);

  const archived = engine.archive();
  assert.equal(archived.ok, true);
  assert.match(archived.stateHash, /^[0-9a-f]{16}$/);
  assert.equal(engine.currentState, "archived");
  assert.equal(archived.summary.fragments.length, 3);

  const allFragments = engine.search("");
  const titleResults = engine.search("雨棚");
  const syncResults = engine.search("同步");
  assert.equal(allFragments.length, 3);
  assert.equal(titleResults.length, 3);
  assert.deepEqual(
    syncResults.map((fragment) => fragment.fragmentId),
    ["RAIN-017-SYN"]
  );

  const bundle = engine.exportBundle();
  assert.equal(bundle.fragmentCount, 3);
  assert.equal(bundle.entries.length, 1);
  assert.equal(bundle.fragments.length, 3);
  assert.equal(
    hashString(stableStringify(sample)),
    sourceBefore,
    "original source must remain byte-identical"
  );
  assert.equal(SOURCE_HASHES[sample.id], sourceBefore);
});

test("misoperation enters failed state and recovers from a snapshot", () => {
  const engine = new RestorationEngine({ seed: 17042 });
  const sourceBefore = hashString(stableStringify(engine.sample));
  diagnoseAll(engine);

  const mistake = engine.startRepair("align", engine.sample.driftMs);
  assert.equal(mistake.ok, false);
  assert.equal(mistake.code, "ORDER_ERROR");
  assert.equal(engine.currentState, "failed");
  assert.match(engine.project.error.detail, /对齐/);
  assert.ok(engine.snapshots.length >= 1);

  const recovered = engine.recover();
  assert.equal(recovered.ok, true);
  assert.equal(engine.currentState, "inspect");
  assert.equal(engine.project.error, null);
  assert.equal(engine.project.repairs.align, undefined);
  assert.equal(hashString(stableStringify(engine.sample)), sourceBefore);
  assert.equal(engine.verification.checks.find((c) => c.id === "source").pass, true);
});

test("parameter beyond safe limit is rejected and recoverable", () => {
  const engine = new RestorationEngine({ seed: 17042 });
  diagnoseAll(engine);
  const result = engine.startRepair("denoise", 100);
  assert.equal(result.ok, false);
  assert.equal(result.code, "PARAM_LIMIT");
  assert.equal(engine.currentState, "failed");
  assert.match(result.error.detail, /20–95/);

  assert.equal(engine.recover().ok, true);
  assert.equal(engine.currentState, "inspect");
  const valid = engine.startRepair("denoise", 68);
  assert.equal(valid.ok, true);
  finishJob(engine);
  assert.equal(engine.project.repairs.denoise.score > 80, true);
});

test("undo restores the previous derived snapshot without touching source", () => {
  const engine = new RestorationEngine({ seed: 17042 });
  const sourceBefore = hashString(stableStringify(engine.sample));
  diagnoseAll(engine);
  engine.startRepair("denoise", 68);
  finishJob(engine);
  assert.equal(engine.project.repairs.denoise.score > 80, true);
  assert.equal(engine.resources.cpu < 260, true);

  const undone = engine.undo();
  assert.equal(undone.ok, true);
  assert.equal(engine.currentState, "inspect");
  assert.equal(engine.project.repairs.denoise, undefined);
  assert.equal(engine.resources.cpu, 260);
  assert.equal(engine.diagnosisComplete, true);
  assert.equal(hashString(stableStringify(engine.sample)), sourceBefore);
});

test("pause freezes timer, media, progress and random state", () => {
  const engine = new RestorationEngine({ seed: 17042 });
  diagnoseAll(engine);
  engine.playMedia();
  engine.advanceTo(11);
  assert.equal(engine.startRepair("denoise", 68).ok, true);
  engine.advanceTo(27);
  assert.equal(engine.pauseSession().ok, true);
  const frozen = {
    tickCount: engine.tickCount,
    sessionSeconds: engine.sessionSeconds,
    playhead: engine.project.mediaPlayhead,
    rngState: engine.rngState,
    progress: engine.project.activeJob.progress
  };
  for (let index = 0; index < 63; index += 1) engine.tick();
  assert.deepEqual(
    {
      tickCount: engine.tickCount,
      sessionSeconds: engine.sessionSeconds,
      playhead: engine.project.mediaPlayhead,
      rngState: engine.rngState,
      progress: engine.project.activeJob.progress
    },
    frozen
  );
  assert.equal(engine.resumeSession().ok, true);
  finishJob(engine);
  assert.ok(engine.sessionSeconds > frozen.sessionSeconds);
});

test("full reset restores timer, media, resources and RNG sequence", () => {
  const seed = 17042;
  const engine = new RestorationEngine({ seed });
  const freshHash = engine.getStateHash();
  const firstRandom = engine.random();
  engine.reset();
  assert.equal(engine.random(), firstRandom, "RNG sequence starts at the same point");

  diagnoseAll(engine);
  engine.playMedia();
  engine.advanceTo(70);
  engine.startRepair("denoise", 68);
  engine.advanceTo(130);
  assert.notEqual(engine.sessionSeconds, 0);
  assert.notEqual(engine.project.mediaPlayhead, 0);
  assert.notEqual(engine.resources.cpu, 260);

  engine.reset();
  assert.equal(engine.tickCount, 0);
  assert.equal(engine.sessionSeconds, 0);
  assert.equal(engine.project.mediaPlayhead, 0);
  assert.equal(engine.project.playing, false);
  assert.equal(engine.currentState, "inspect");
  assert.equal(engine.rngState, seed);
  assert.deepEqual(engine.resources, { cpu: 260, memory: 512, integrity: 100 });
  assert.equal(engine.project.diagnostics.length, 0);
  assert.equal(Object.keys(engine.project.repairs).length, 0);
  assert.equal(engine.snapshots.length, 0);
  assert.equal(engine.archives.length, 0);
  assert.equal(engine.getStateHash(), freshHash);
});

test("saved seed and input log replay to the identical final state hash", () => {
  const sample = getSample("rain-shed");
  const engine = new RestorationEngine({ seed: 17042 });
  diagnoseAll(engine);

  for (const toolId of engine.requiredTools) {
    const tool = TOOLS.find((item) => item.id === toolId);
    engine.advanceTo(engine.tickCount + 4);
    assert.equal(engine.startRepair(toolId, valueFor(engine, tool)).ok, true);
    if (toolId === "interpolate") {
      engine.advanceTo(engine.tickCount + 18);
      assert.equal(engine.pauseSession().ok, true);
      engine.advanceTo(engine.tickCount + 12);
      assert.equal(engine.resumeSession().ok, true);
    }
    finishJob(engine);
  }
  const archived = engine.archive();
  assert.equal(archived.ok, true);
  const record = JSON.parse(JSON.stringify(engine.getRunRecord()));
  const expected = archived.stateHash;

  const replay = RestorationEngine.replay(record);
  assert.equal(replay.getStateHash(), expected);
  assert.equal(replay.finalStateHash, expected);
  assert.equal(replay.sessionSeconds, engine.sessionSeconds);
  assert.equal(replay.project.mediaPlayhead, engine.project.mediaPlayhead);
  assert.deepEqual(replay.resources, engine.resources);
  assert.equal(replay.rngState, engine.rngState);
  assert.equal(replay.search("雨棚").length, 3);
  assert.equal(sample.id, replay.selectedId);
});

test("all three damaged samples can complete their repair chains", () => {
  for (const sample of SAMPLES) {
    const engine = repairSample(sample.id, sample.seed);
    assert.equal(engine.currentState, "ready", sample.id);
    assert.equal(engine.verification.pass, true, sample.id);
    const result = engine.archive();
    assert.equal(result.ok, true, sample.id);
    const domains = new Set(
      engine.requiredTools
        .map((id) => TOOLS.find((tool) => tool.id === id))
        .map((tool) => tool.domain)
    );
    assert.equal(result.summary.fragments.length, domains.size);
    assert.ok(result.summary.fragments.every((fragment) => fragment.searchText));
  }
});
