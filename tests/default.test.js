// Group 1: default parameters — two pan/zoom rounds, seams, cache stats, pause.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PARAMS } from '../src/config.js';
import { makeRig, runPanZoomRounds, settleFades, findSeamGaps } from './helpers.js';

const KEYFRAMES = [
  { t: 0, x: 512, y: 384, zoom: 1 },
  { t: 500, x: 2400, y: 1600, zoom: 4 },
  { t: 1000, x: 900, y: 2900, zoom: 8 },
  { t: 1500, x: 512, y: 384, zoom: 1 }
];

test('default: two pan/zoom rounds never show a blank frame', async () => {
  const rig = makeRig({ ...DEFAULT_PARAMS }, KEYFRAMES);
  let frames = 0;
  await runPanZoomRounds(rig, {
    rounds: 2,
    onFrame: (camera, ops) => {
      frames++;
      assert.ok(ops.length > 0, 'every frame draws something');
      for (const layer of DEFAULT_PARAMS.layers) {
        assert.ok(
          ops.some((o) => o.layer === layer),
          `layer ${layer} always has coverage`
        );
      }
    }
  });
  assert.equal(frames, 120);
});

test('default: hi-detail replaces low-detail with no placeholders left', async () => {
  const rig = makeRig({ ...DEFAULT_PARAMS }, KEYFRAMES);
  const sawLowDetailFirst = { value: false };
  await runPanZoomRounds(rig, {
    rounds: 1,
    onFrame: (camera, ops) => {
      if (ops.some((o) => o.placeholder || o.lod < 2)) sawLowDetailFirst.value = true;
    }
  });
  assert.ok(sawLowDetailFirst.value, 'low-detail content appears while hi-detail loads');
  const cam = { x: 900, y: 2900, zoom: 8 };
  await rig.engine.settle();
  const ops = await settleFades(rig.engine, cam);
  assert.equal(ops.filter((o) => o.placeholder).length, 0, 'no placeholders remain');
});

test('default: tile boundaries are seamless at every layer', async () => {
  const rig = makeRig({ ...DEFAULT_PARAMS }, KEYFRAMES);
  const cam = { x: 1024, y: 1024, zoom: 2 };
  rig.engine.update(cam, 16);
  await rig.engine.settle();
  const ops = await settleFades(rig.engine, cam);
  for (const layer of DEFAULT_PARAMS.layers) {
    const gaps = findSeamGaps(DEFAULT_PARAMS, ops, layer, 1);
    assert.deepEqual(gaps, [], `layer ${layer} has no seam gaps`);
  }
});

test('default: cache hits and memory usage are observable', async () => {
  const rig = makeRig({ ...DEFAULT_PARAMS }, KEYFRAMES);
  await runPanZoomRounds(rig, { rounds: 2 });
  const stats = rig.engine.getStats();
  assert.ok(stats.cache.hits > 0, 'second round reuses cached tiles');
  assert.ok(stats.cache.misses > 0, 'first loads register as misses');
  assert.ok(stats.cache.bytesUsed <= stats.cache.budgetBytes, 'memory stays within budget');
});

test('default: pause freezes camera, loads and stats', async () => {
  const rig = makeRig({ ...DEFAULT_PARAMS }, KEYFRAMES);
  rig.timeline.advance(100);
  rig.engine.update(rig.timeline.cameraAt(rig.timeline.time), 16);
  rig.timeline.pause();
  rig.engine.setPaused(true);
  const camBefore = rig.timeline.advance(500);
  const statsBefore = JSON.stringify(rig.engine.getStats().cache);
  const opsBefore = rig.engine.update(camBefore, 16);
  const opsAfter = rig.engine.update(camBefore, 16);
  assert.equal(rig.timeline.time, 100, 'paused timeline does not advance');
  assert.deepEqual(opsAfter, opsBefore, 'paused render is stable');
  assert.equal(JSON.stringify(rig.engine.getStats().cache), statsBefore, 'paused cache untouched');
  rig.timeline.resume();
  rig.engine.setPaused(false);
  rig.timeline.advance(50);
  assert.equal(rig.timeline.time, 150, 'resume continues from the paused time');
});
