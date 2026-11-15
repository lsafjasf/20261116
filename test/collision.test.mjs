import test from "node:test";
import assert from "node:assert/strict";
import {
  circle,
  rectangle,
  narrowPhase,
  contactDigest,
  boundsOf
} from "../src/geometry.js";
import {
  CollisionScene,
  compareDetection,
  detectBruteForce,
  detectSpatialGrid
} from "../src/collision-engines.js";
import {
  SCENARIOS,
  createScenarioObjects,
  stepMotion,
  SCENE_HEIGHT,
  SCENE_WIDTH
} from "../src/scenarios.js";

function assertParity(objects, grid, message) {
  const brute = detectBruteForce(objects);
  const indexed = detectSpatialGrid(objects, grid);
  const comparison = compareDetection(brute, indexed);
  assert.equal(comparison.equal, true, message);
  assert.equal(comparison.digestEqual, true, message);
  assert.ok(indexed.candidatePairs >= indexed.contacts.length, message);
  return { brute, indexed, comparison };
}

test("circle and rotated rectangle use exact local-space contact", () => {
  const bodyCircle = circle(110, 100, 12, { id: 1 });
  const bodyRect = rectangle(100, 100, 60, 20, Math.PI / 2, { id: 2 });
  const contact = narrowPhase(bodyCircle, bodyRect);
  assert.ok(contact);
  assert.equal(contact.a, 1);
  assert.equal(contact.b, 2);
  assert.ok(contact.depth > 0);

  const separated = narrowPhase(circle(130, 100, 9, { id: 3 }), bodyRect);
  assert.equal(separated, null);
});

test("rotated rectangle tangency and AABB boundaries remain inclusive", () => {
  const left = rectangle(100, 100, 40, 20, Math.PI / 4, { id: 1 });
  const right = rectangle(100 + Math.SQRT2 * 20, 100 + Math.SQRT2 * 20, 40, 20, Math.PI / 4, {
    id: 2
  });
  const contact = narrowPhase(left, right);
  assert.ok(contact);
  assert.ok(Math.abs(contact.depth) < 1e-8);
  assert.deepEqual(boundsOf(left), {
    minX: 100 - Math.SQRT2 * 15,
    minY: 100 - Math.SQRT2 * 15,
    maxX: 100 + Math.SQRT2 * 15,
    maxY: 100 + Math.SQRT2 * 15
  });
});

test("all fixed scenarios match brute force after deterministic motion", () => {
  for (const scenario of SCENARIOS) {
    const objects = createScenarioObjects(scenario.id);
    const scene = new CollisionScene(objects);
    for (let frame = 0; frame < 24; frame += 1) {
      stepMotion(objects, 1 / 60, SCENE_WIDTH, SCENE_HEIGHT);
      for (const object of objects) scene.update(object.id);
    }
    const result = assertParity(objects, scene.grid, `${scenario.id} parity`);
    assert.ok(result.indexed.candidatePairs < result.brute.candidatePairs);
    assert.equal(scenario.count >= 280, true);
  }
});

test("move, scale and delete keep the index synchronized", () => {
  const objects = createScenarioObjects("after");
  const scene = new CollisionScene(objects);
  const moving = objects.find((object) => object.shape === "rect" && object.boundaryCase == null);
  moving.x += 137;
  moving.y -= 61;
  moving.angle += 0.71;
  scene.update(moving.id);
  assertParity(objects, scene.grid, "move parity");

  const scaling = objects.find((object) => object.shape === "circle");
  scaling.radius *= 2.7;
  scene.update(scaling.id);
  assertParity(objects, scene.grid, "scale parity");

  const deletedId = objects[Math.floor(objects.length / 2)].id;
  assert.equal(scene.remove(deletedId), true);
  assert.equal(scene.byId.has(deletedId), false);
  assert.equal(scene.grid.entries.has(deletedId), false);
  assertParity(scene.objects, scene.grid, "delete parity");
});

test("cell sizes from tiny to oversized preserve the contact set", () => {
  const objects = createScenarioObjects("boundary");
  const brute = detectBruteForce(objects);
  for (const cellSize of [8, 32, 72, 144, 512]) {
    const scene = new CollisionScene(objects, cellSize);
    const indexed = detectSpatialGrid(objects, scene.grid);
    const comparison = compareDetection(brute, indexed);
    assert.equal(comparison.equal, true, `cell size ${cellSize}`);
    assert.equal(contactDigest(indexed.contacts), brute.digest);
  }
});

test("deterministic snapshots and candidates are stable between engine runs", () => {
  const first = createScenarioObjects("after");
  const second = createScenarioObjects("after");
  assert.deepEqual(first, second);
  const scene = new CollisionScene(first);
  const indexedA = detectSpatialGrid(first, scene.grid);
  const indexedB = detectSpatialGrid(second, new CollisionScene(second).grid);
  assert.equal(indexedA.digest, indexedB.digest);
  assert.equal(indexedA.candidatePairs, indexedB.candidatePairs);
});
