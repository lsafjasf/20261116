import test from "node:test";
import assert from "node:assert/strict";
import { StableAtlasPacker } from "../src/core/packer.js";
import { createDemoFrames, createSpriteFrame } from "../src/core/sprite.js";

test("continuous growth does not make utilization deteriorate indefinitely", () => {
  const frames = createDemoFrames(100, { seed: 628 });
  const packer = new StableAtlasPacker();
  const baseline = packer.packAll(frames).metrics.utilization;
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  const utilities = [];
  let nextIndex = 300;
  for (let round = 1; round <= 18; round += 1) {
    const ids = [...byId.keys()];
    const upserts = [];
    for (let index = 0; index < 3; index += 1) {
      const id = `stress-${String(nextIndex).padStart(3, "0")}`;
      const frame = createSpriteFrame(id, nextIndex);
      nextIndex += 1;
      byId.set(id, frame);
      upserts.push(frame);
    }
    for (let index = 0; index < 2; index += 1) {
      const id = ids[(round * 7 + index * 11) % ids.length];
      if (upserts.some((frame) => frame.id === id)) continue;
      const numeric = Number(id.split("-").at(-1));
      const frame = createSpriteFrame(id, numeric, { variant: 1 });
      byId.set(id, frame);
      upserts.push(frame);
    }
    const deletes = ids
      .filter((id) => id.startsWith("spr-0") && !upserts.some((frame) => frame.id === id))
      .slice(0, 2);
    for (const id of deletes) byId.delete(id);
    const result = packer.applyChanges({ upserts, deletes });
    utilities.push(result.after.utilization);
    assert.equal(packer.assertNoOverlaps(), true);
  }
  assert.ok(Math.min(...utilities) >= baseline - 0.1, `min=${Math.min(...utilities)} baseline=${baseline}`);
  const tail = utilities.slice(-6);
  const drops = tail.slice(1).filter((value, index) => value < tail[index] - 0.01).length;
  assert.ok(drops <= 2, `tail=${tail.join(",")}`);
  assert.ok(utilities.at(-1) > 0.6);
});

test("utilization guard compacts and shrinks after sustained deletions", () => {
  const frames = createDemoFrames(100, { seed: 628 });
  const packer = new StableAtlasPacker();
  packer.packAll(frames);
  let activeIds = frames.map((frame) => frame.id);
  let nextIndex = 500;
  let compactCount = 0;
  for (let round = 1; round <= 8; round += 1) {
    const deletes = activeIds.splice(0, 12);
    const upserts = [];
    for (let index = 0; index < 2; index += 1) {
      const id = `delete-test-${nextIndex}`;
      const frame = createSpriteFrame(id, nextIndex);
      nextIndex += 1;
      activeIds.push(id);
      upserts.push(frame);
    }
    for (const id of activeIds.slice(0, 2)) {
      const numeric = Number(id.split("-").at(-1)) || nextIndex++;
      upserts.push(createSpriteFrame(id, numeric, { variant: 1 }));
    }
    const result = packer.applyChanges({ upserts, deletes });
    if (result.compacted) compactCount += 1;
    assert.equal(packer.assertNoOverlaps(), true);
    assert.ok(result.after.utilization > 0.34);
  }
  assert.ok(compactCount >= 1);
  assert.ok(packer.width < 512 || packer.height < 512);
});
