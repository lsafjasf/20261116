import test from "node:test";
import assert from "node:assert/strict";
import { StableAtlasPacker } from "../src/core/packer.js";
import { roundChanges } from "../src/core/scenario.js";
import { createDemoFrames } from "../src/core/sprite.js";

function unaffectedMovement(before, after, affected) {
  const moved = [];
  for (const [id, old] of before) {
    if (affected.has(id) || !after.has(id)) continue;
    const current = after.get(id);
    if (old.x !== current.x || old.y !== current.y || old.rotated !== current.rotated) moved.push(id);
  }
  return moved;
}

test("100-frame three-round incremental packing keeps unaffected coordinates stable", () => {
  const frames = createDemoFrames(100, { seed: 628 });
  const packer = new StableAtlasPacker();
  const baseline = packer.packAll(frames);
  assert.equal(baseline.metrics.frameCount, 100);
  assert.equal(packer.width, 512);
  assert.equal(packer.height, 512);
  assert.ok(baseline.metrics.utilization > 0.6);
  assert.equal(packer.assertNoOverlaps(), true);

  const utilities = [baseline.metrics.utilization];
  for (let round = 0; round < 3; round += 1) {
    const changes = roundChanges(round, 628);
    const before = new Map(packer.placements);
    const affected = new Set([
      ...changes.upserts.map((frame) => frame.id),
      ...changes.deletes,
    ]);
    const result = packer.applyChanges(changes);
    assert.equal(result.compacted, false);
    assert.equal(packer.assertNoOverlaps(), true);
    assert.deepEqual(unaffectedMovement(before, packer.placements, affected), []);
    assert.equal(result.unchanged > 90, true);
    utilities.push(result.after.utilization);
  }
  assert.ok(Math.min(...utilities) > baseline.metrics.utilization - 0.05);
  assert.ok(utilities[3] > utilities[1]);
});

test("only the changed footprint is resized when a modified frame still fits its slot", () => {
  const solid = (id, width, height) => ({
    id,
    width,
    height,
    pixels: new Uint8ClampedArray(width * height * 4).fill(255),
    colors: ["#ffffff"],
    version: 0,
  });
  const frames = Array.from({ length: 20 }, (_, index) => solid(`solid-${index}`, 20, 20));
  const packer = new StableAtlasPacker({ width: 256, height: 256 });
  packer.packAll(frames);
  const target = frames[4];
  const before = new Map(packer.placements);
  const modified = solid(target.id, 19, 19);
  const result = packer.applyChanges({ upserts: [modified] });
  assert.equal(result.inserted.length, 0);
  assert.equal(result.deleted.length, 0);
  assert.equal(result.moved.length, 0);
  assert.equal(packer.assertNoOverlaps(), true);
  for (const [id, old] of before) {
    if (id === target.id) continue;
    assert.equal(packer.placements.get(id).x, old.x);
    assert.equal(packer.placements.get(id).y, old.y);
  }
});
