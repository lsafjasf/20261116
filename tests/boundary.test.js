// Group 2: boundary parameters — exact-fit viewport, minimal cache, lod clamp.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOUNDARY_PARAMS } from '../src/config.js';
import { visibleTiles, lodForZoom } from '../src/tileGrid.js';
import { makeRig, settleFades } from './helpers.js';

test('boundary: edge-aligned viewport selects exactly 2x2 tiles', () => {
  const ids = visibleTiles(BOUNDARY_PARAMS, 1, { x: 0, y: 0, width: 512, height: 512 });
  assert.deepEqual(ids.sort(), ['1/0/0', '1/0/1', '1/1/0', '1/1/1']);
});

test('boundary: world is exactly one tile at lod 0', () => {
  const ids = visibleTiles(BOUNDARY_PARAMS, 0, { x: 0, y: 0, width: 512, height: 512 });
  assert.deepEqual(ids, ['0/0/0']);
});

test('boundary: zoom beyond range clamps to lod limits', () => {
  assert.equal(lodForZoom(BOUNDARY_PARAMS, 1000), BOUNDARY_PARAMS.maxLod);
  assert.equal(lodForZoom(BOUNDARY_PARAMS, 0.0001), 0);
});

test('boundary: minimal cache evicts LRU and stays within budget', async () => {
  const rig = makeRig({ ...BOUNDARY_PARAMS }, [{ t: 0, x: 128, y: 128, zoom: 2 }]);
  const cam = { x: 128, y: 128, zoom: 2 };
  await settleFades(rig.engine, cam, 5);
  const stats = rig.engine.getStats().cache;
  assert.ok(stats.evictions > 0, 'memory fallback evicts least-recently-used tiles');
  assert.ok(stats.bytesUsed <= stats.budgetBytes, 'never exceeds the byte budget');
  assert.ok(stats.bytesUsed > 0, 'cache still holds the most recent tiles');
});

test('boundary: evicted tiles reload instead of going blank', async () => {
  const rig = makeRig({ ...BOUNDARY_PARAMS }, [{ t: 0, x: 128, y: 128, zoom: 2 }]);
  const cam = { x: 128, y: 128, zoom: 2 };
  const ops = await settleFades(rig.engine, cam, 5);
  for (const layer of BOUNDARY_PARAMS.layers) {
    const layerOps = ops.filter((o) => o.layer === layer && o.alpha === 1);
    assert.equal(layerOps.length, 4, `${layer}: full 2x2 coverage despite eviction`);
    assert.ok(layerOps.every((o) => !o.placeholder), `${layer}: real tiles only`);
  }
});

test('boundary: zero crossfade swaps tiles instantly', async () => {
  const rig = makeRig({ ...BOUNDARY_PARAMS }, [{ t: 0, x: 128, y: 128, zoom: 2 }]);
  assert.equal(BOUNDARY_PARAMS.crossfadeMs, 0);
  const cam = { x: 128, y: 128, zoom: 2 };
  const ops = await settleFades(rig.engine, cam, 3);
  assert.ok(ops.every((o) => o.alpha === 1), 'no partial-alpha tiles with crossfadeMs=0');
});
