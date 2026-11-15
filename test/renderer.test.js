import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { AnimationLoop } from "../src/animation-loop.js";
import { DirtyRenderer } from "../src/dirty-renderer.js";
import { FullRenderer } from "../src/full-renderer.js";
import {
  advanceScene,
  createScene,
  deleteVisibleObject,
  panCamera,
  publicSnapshot,
  setLayerVisible,
} from "../src/scene.js";

const WIDTH = 960;
const HEIGHT = 540;

function canvases() {
  return {
    baseline: createCanvas(WIDTH, HEIGHT),
    optimized: createCanvas(WIDTH, HEIGHT),
  };
}

function pixelDiff(a, b) {
  const left = a.getContext("2d").getImageData(0, 0, WIDTH, HEIGHT).data;
  const right = b.getContext("2d").getImageData(0, 0, WIDTH, HEIGHT).data;
  let bytes = 0;
  let pixels = 0;
  let maxDelta = 0;
  for (let index = 0; index < left.length; index += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(left[index + channel] - right[index + channel]);
      if (delta) {
        bytes += 1;
        changed = true;
        maxDelta = Math.max(maxDelta, delta);
      }
    }
    if (changed) pixels += 1;
  }
  return { bytes, pixels, maxDelta };
}

function applyStep(scenes, frame) {
  for (const scene of scenes) {
    advanceScene(scene);
    if (frame === 4) panCamera(scene, 43, -27);
    if (frame === 9) setLayerVisible(scene, "text", false);
    if (frame === 10) setLayerVisible(scene, "text", true);
    if (frame === 15) deleteVisibleObject(scene);
    if (frame === 19) setLayerVisible(scene, "terrain", false);
    if (frame === 22) setLayerVisible(scene, "terrain", true);
    if (frame === 26) setLayerVisible(scene, "dynamic", false);
    if (frame === 29) setLayerVisible(scene, "dynamic", true);
    if (frame === 32) panCamera(scene, -91, 38);
  }
}

test("dirty renderer stays pixel-identical across all invalidation paths", () => {
  const scenes = [createScene(), createScene()];
  const surfaces = canvases();
  const full = new FullRenderer(surfaces.baseline);
  const dirty = new DirtyRenderer(surfaces.optimized, scenes[1], {
    createSurface: createCanvas,
    mergeGap: 6,
    maxDirtyRects: 64,
  });

  for (let frame = 0; frame <= 36; frame += 1) {
    if (frame > 0) applyStep(scenes, frame);
    const baselineMetrics = full.render(scenes[0]);
    const dirtyMetrics = dirty.render(scenes[1]);
    assert.ok(baselineMetrics.renderCalls > 0);
    assert.ok(dirtyMetrics.renderCalls > 0);
    assert.deepEqual(pixelDiff(surfaces.baseline, surfaces.optimized), {
      bytes: 0,
      pixels: 0,
      maxDelta: 0,
    });
  }

  assert.deepEqual(publicSnapshot(scenes[0]), publicSnapshot(scenes[1]));
  assert.ok(dirty.metrics.fullInvalidations >= 3);
  assert.ok(dirty.metrics.cacheHitRate > 0.8);
});

test("boundary parameters degrade to full redraw without visual drift", () => {
  const scenes = [createScene(), createScene()];
  const surfaces = canvases();
  const full = new FullRenderer(surfaces.baseline);
  const dirty = new DirtyRenderer(surfaces.optimized, scenes[1], {
    createSurface: createCanvas,
    mergeGap: 0,
    maxDirtyRects: 2,
    textCacheCapacity: 8,
  });

  for (let frame = 0; frame <= 18; frame += 1) {
    if (frame > 0) applyStep(scenes, frame);
    full.render(scenes[0]);
    dirty.render(scenes[1]);
    assert.deepEqual(pixelDiff(surfaces.baseline, surfaces.optimized), {
      bytes: 0,
      pixels: 0,
      maxDelta: 0,
    });
  }

  assert.ok(dirty.metrics.cappedInvalidations > 0);
  assert.ok(dirty.metrics.cacheHitRate < 0.9);
  assert.deepEqual(publicSnapshot(scenes[0]), publicSnapshot(scenes[1]));
});

test("unchanged scene produces zero dirty area", () => {
  const scene = createScene();
  const surface = createCanvas(WIDTH, HEIGHT);
  const dirty = new DirtyRenderer(surface, scene, { createSurface: createCanvas });
  dirty.render(scene);
  const before = dirty.metrics;
  const after = dirty.render(scene);
  assert.equal(after.dirtyRects, 0);
  assert.equal(after.repaintPixels, 0);
  assert.equal(after.redrawCalls, before.redrawCalls);
  assert.equal(after.skippedCalls, before.skippedCalls + 1);
});

test("paused animation loop schedules no additional redraws", () => {
  let nextId = 0;
  const pending = new Map();
  let frames = 0;
  const loop = new AnimationLoop({
    requestFrame(callback) {
      nextId += 1;
      pending.set(nextId, callback);
      return nextId;
    },
    cancelFrame(id) {
      pending.delete(id);
    },
    onFrame() {
      frames += 1;
    },
  });
  const flush = () => {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback(performance.now());
  };

  loop.start();
  flush();
  flush();
  flush();
  assert.equal(frames, 3);
  loop.pause();
  assert.equal(pending.size, 0);
  for (let index = 0; index < 20; index += 1) flush();
  assert.equal(frames, 3);

  loop.start();
  flush();
  assert.equal(frames, 4);
  loop.stop();
  assert.equal(pending.size, 0);
});
