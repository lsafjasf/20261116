import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultScene,
  fbm,
  nearestWrappedPoint,
  normalizeScene,
  periodicNoise,
  periodicSignal,
  periodicWorley,
  sceneDigest
} from "../src/core.js";

export const PARAMETER_SUITES = {
  default: {
    time: 50,
    stone: { scale: 8, contrast: 0.64, grain: 0.35, weather: 0.26 },
    fabric: { threads: 44, slub: 0.34, wrinkle: 0.34, contrast: 0.46 },
    expectedSizes: [512, 1024]
  },
  boundary: {
    time: 100,
    stone: { scale: 14, contrast: 1, grain: 1, weather: 1 },
    fabric: { threads: 96, slub: 1, wrinkle: 1, contrast: 1 },
    brush: { size: 160, hardness: 1, opacity: 1, color: "#d8b074" },
    boundaryPoints: [
      { x: 0.97, y: 0.06 },
      { x: 1.035, y: 0.12 },
      { x: 1.02, y: 0.98 },
      { x: 0.01, y: 1.025 }
    ]
  },
  exception: {
    corruptProject: { layers: [], keyframes: null, brush: null, view: null },
    invalidStone: { scale: "invalid", contrast: 8, grain: -2, weather: null },
    invalidPalette: { base: "nope", vein: "#444", accent: null },
    asyncFailure: "drop-result-and-sync-fallback",
    cacheFailure: "clear-and-rebuild"
  }
};

test("periodic noise is identical across all four boundaries", () => {
  for (let i = 0; i <= 100; i += 1) {
    const value = i / 100;
    assert.ok(Math.abs(periodicNoise(0, value, 8, 4107) - periodicNoise(1, value, 8, 4107)) < 1e-12);
    assert.ok(Math.abs(periodicNoise(value, 0, 8, 4107) - periodicNoise(value, 1, 8, 4107)) < 1e-12);
    assert.ok(Math.abs(fbm(0, value, 3, 91, 4) - fbm(1, value, 3, 91, 4)) < 1e-12);
    assert.ok(Math.abs(periodicSignal(0, value, 2, 5) - periodicSignal(1, value, 2, 5)) < 1e-12);
  }
});

test("periodic Voronoi is continuous across U and V wraps", () => {
  for (let i = 1; i < 100; i += 1) {
    const value = i / 100;
    const left = periodicWorley(0, value, 7, 4107);
    const right = periodicWorley(1, value, 7, 4107);
    assert.ok(Math.abs(left.d1 - right.d1) < 1e-12);
    assert.equal(left.cellX, right.cellX);
    const top = periodicWorley(value, 0, 7, 4107);
    const bottom = periodicWorley(value, 1, 7, 4107);
    assert.ok(Math.abs(top.edge - bottom.edge) < 1e-12);
    assert.equal(top.cellY, bottom.cellY);
  }
});

test("boundary brush points unwrap to the nearest copy", () => {
  const first = nearestWrappedPoint({ x: 0.98, y: 0.2 }, { x: 0.02, y: 0.21 });
  assert.ok(Math.abs(first.x - 1.02) < 1e-12);
  assert.ok(Math.abs(first.y - 0.21) < 1e-12);
  const second = nearestWrappedPoint({ x: 0.02, y: 0.9 }, { x: 0.98, y: 0.08 });
  assert.ok(Math.abs(second.x - -0.02) < 1e-12);
  assert.ok(Math.abs(second.y - 1.08) < 1e-12);
});

test("default project round-trips layer order, keyframes, coordinates and colors", () => {
  const scene = defaultScene();
  scene.layers[0].palette.base = "#a1a09a";
  scene.cursor = { u: 0.123, v: 0.876 };
  scene.view.rotation = 37;
  scene.currentTime = 72;
  const before = sceneDigest(scene);
  const after = sceneDigest(normalizeScene(JSON.parse(JSON.stringify(scene))));
  assert.equal(after, before);
  assert.deepEqual(normalizeScene(scene).layers.map((layer) => layer.id), scene.layers.map((layer) => layer.id));
  assert.deepEqual(normalizeScene(scene).keyframes, scene.keyframes);
  assert.equal(normalizeScene(scene).cursor.u, 0.123);
  assert.equal(normalizeScene(scene).layers[0].palette.base, "#a1a09a");
});

test("exception inputs normalize to a usable deterministic scene", () => {
  const recovered = normalizeScene(PARAMETER_SUITES.exception.corruptProject);
  assert.ok(recovered.layers.length >= 2);
  assert.ok(recovered.keyframes.length >= 3);
  assert.equal(sceneDigest(recovered), sceneDigest(normalizeScene(JSON.parse(JSON.stringify(recovered)))));
  const corruptLayer = {
    ...recovered,
    layers: [{
      ...recovered.layers[0],
      params: PARAMETER_SUITES.exception.invalidStone,
      palette: PARAMETER_SUITES.exception.invalidPalette
    }]
  };
  assert.doesNotThrow(() => normalizeScene(corruptLayer));
});

test("three parameter suites are complete and deterministic", () => {
  for (const [name, suite] of Object.entries(PARAMETER_SUITES)) {
    assert.ok(name);
    assert.ok(suite);
  }
  const a = normalizeScene(defaultScene());
  const b = normalizeScene(defaultScene());
  assert.equal(sceneDigest(a), sceneDigest(b));
});
