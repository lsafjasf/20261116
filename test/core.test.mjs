import test from "node:test";
import assert from "node:assert/strict";
import { hashBytes, hashString, mulberry32 } from "../src/config.js";
import { layoutFor, moveEntry } from "../src/atlas.js";
import { generateEntries } from "../src/shapes.js";
import { buildIndex, configFromIndex, restoreEntries } from "../src/serialize.js";

const config = { width: 1024, height: 768, cell: 128, padding: 8 };
const view = { sampler: "nearest", zoom: 8, guard: 1 };

function fakeMetrics(scene, cfg) {
  return {
    hash: "deadbeef",
    fillPixels: 1234,
    fillRatio: 1234 / (cfg.width * cfg.height),
    occupiedSlots: scene.length,
    capacity: layoutFor(cfg).capacity,
    slotRatio: scene.length / layoutFor(cfg).capacity,
    guardViolations: 0,
    alphaBounds: Object.fromEntries(scene.map((entry) => [entry.id, { x: 1, y: 2, w: 10, h: 12 }])),
  };
}

test("fixed grid produces exact slot geometry without overlap", () => {
  const layout = layoutFor(config);
  assert.equal(layout.cols, 8);
  assert.equal(layout.rows, 6);
  assert.equal(layout.capacity, 48);
  const points = new Set();
  for (const slot of layout.slots) {
    points.add(`${slot.x},${slot.y}`);
    assert.equal(slot.contentRect.x, slot.x + config.padding);
    assert.equal(slot.contentRect.w, config.cell - config.padding * 2);
  }
  assert.equal(points.size, 48);
});

test("shape generation is deterministic and slot-separated", () => {
  const first = generateEntries(12, 991);
  const second = generateEntries(12, 991);
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((entry) => entry.id)).size, 12);
  assert.equal(new Set(first.map((entry) => entry.slot)).size, 12);
});

test("moving into an occupied slot reports both dirty tiles", () => {
  const entries = generateEntries(6, 17);
  const movingId = entries[1].id;
  const result = moveEntry(entries, movingId, 4);
  assert.deepEqual(result.dirtySlots, [1, 4]);
  assert.equal(entries.find((entry) => entry.id === movingId).slot, 4);
  assert.equal(entries.find((entry) => entry.id === result.swappedId).slot, 1);
});

test("index round-trip restores every object field", () => {
  const scene = generateEntries(14, 20261116);
  const metrics = fakeMetrics(scene, config);
  const index = buildIndex(scene, config, metrics, view, { renderer: "test" });
  const restored = restoreEntries(index);
  assert.equal(index.format, "shadow-atlas/v1");
  assert.deepEqual(configFromIndex(index), config);
  assert.equal(restored.length, 14);
  assert.deepEqual(
    restored.map((entry) => [entry.id, entry.slot, entry.kind, entry.hue]),
    scene.map((entry) => [entry.id, entry.slot, entry.kind, entry.hue]),
  );
  assert.equal(index.shapes[0].uv.u0, index.shapes[0].rect.x / config.width);
  assert.equal(index.algorithm.guardPx, 1);
  assert.equal(index.sampling.sampleRect, "contentRect");
});

test("hash helpers are stable across invocations", () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 255, 128]);
  assert.equal(hashBytes(bytes), hashBytes(new Uint8Array(bytes)));
  assert.equal(hashString("shadow-atlas"), hashString("shadow-atlas"));
  assert.notEqual(hashString("shadow-atlas"), hashString("shadow-atlas "));
  const randA = mulberry32(42);
  const randB = mulberry32(42);
  assert.deepEqual([randA(), randA(), randA()], [randB(), randB(), randB()]);
});
