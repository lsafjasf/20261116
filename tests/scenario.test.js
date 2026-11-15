import test from "node:test";
import assert from "node:assert/strict";
import { runThreeRoundScenario } from "../src/core/scenario.js";
import { validateAtlasPackage } from "../src/core/schema.js";

test("fixed 100-frame three-round scenario passes all stability and export checks", () => {
  const result = runThreeRoundScenario({ seed: 628, count: 100, includeAtlasPixels: true });
  assert.equal(result.baseline.frameCount, 100);
  assert.equal(result.rounds.length, 3);
  assert.equal(result.passed, true, JSON.stringify(result.checks));
  assert.deepEqual(result.checks, {
    noOverlap: true,
    stableUnaffectedCoordinates: true,
    noRunawayUtilization: true,
    losslessSlices: true,
    reloadFingerprintStable: true,
    preExportSnapshots: true,
  });
  for (const round of result.rounds) {
    assert.equal(round.unaffectedMovement.moved, 0);
    assert.equal(round.unaffectedMovement.maxDelta, 0);
    assert.equal(validateAtlasPackage(round.package).ok, true);
    assert.equal(round.export.rotatedFrames > 0, true);
    assert.equal(round.export.trimmedFrames, round.frameCount);
    assert.equal(round.export.restoreChecked, round.frameCount);
    assert.equal(round.export.restoreExact, true);
    assert.equal(round.export.snapshotMatches, true);
    assert.equal(round.atlasPixels.width, round.atlas.width);
    assert.equal(round.atlasPixels.height, round.atlas.height);
  }
  assert.ok(result.rounds[1].rearrangedRegion.w < result.rounds[1].atlas.width);
  assert.ok(result.rounds[2].utilization > result.rounds[1].utilization);
});

test("scenario is deterministic across repeated runs", () => {
  const first = runThreeRoundScenario({ seed: 628 });
  const second = runThreeRoundScenario({ seed: 628 });
  assert.deepEqual(
    first.rounds.map((round) => ({
      size: round.atlas,
      util: round.utilization,
      region: round.rearrangedRegion,
      hash: round.export.pixelHash,
      snapshot: round.export.snapshotMatches,
    })),
    second.rounds.map((round) => ({
      size: round.atlas,
      util: round.utilization,
      region: round.rearrangedRegion,
      hash: round.export.pixelHash,
      snapshot: round.export.snapshotMatches,
    })),
  );
});
