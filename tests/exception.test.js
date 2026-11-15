// Group 3: exception parameters — failed requests, corrupt thumbnails,
// cache TTL invalidation, tiny budget, paused loader. Always falls back
// with an explicit notice; never stale, never blank.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXCEPTION_PARAMS } from '../src/config.js';
import { makeRig, settleFades } from './helpers.js';
import { validateThumbnail } from '../src/loader.js';

const KF = [{ t: 0, x: 512, y: 384, zoom: 1 }];

test('exception: failed async request falls back with a notice, never blank', async () => {
  const rig = makeRig({ ...EXCEPTION_PARAMS }, KF);
  const cam = { x: 96, y: 96, zoom: 4 }; // viewport covers failing tile 2/1/1
  const ops = await settleFades(rig.engine, cam, 5);
  const failed = ops.filter((o) => o.tileId === '2/1/1');
  assert.ok(failed.length > 0, 'failed tile region is still covered');
  for (const op of failed) {
    assert.ok(op.placeholder || op.lod < 2, 'fallback is parent tile or placeholder');
  }
  const notices = rig.engine.notices.filter((n) => n.type === 'load-failed');
  assert.ok(notices.length > 0, 'a load-failed notice was raised');
  assert.ok(notices.some((n) => n.tileId === '2/1/1'), 'notice names the failed tile');
});

test('exception: corrupt thumbnail is regenerated with a notice', async () => {
  const rig = makeRig({ ...EXCEPTION_PARAMS }, KF);
  const cam = { x: 512, y: 384, zoom: 1 };
  await settleFades(rig.engine, cam, 3);
  const notices = rig.engine.notices.filter((n) => n.type === 'thumbnail');
  assert.ok(notices.length > 0, 'thumbnail notice raised');
  const shown = rig.engine.displayed.get('terrain').get('0/0/0');
  assert.ok(shown && validateThumbnail(shown.tile), 'displayed tile has a valid thumbnail');
});

test('exception: expired cache entries are invalidated and refetched', async () => {
  const rig = makeRig({ ...EXCEPTION_PARAMS }, KF);
  const cam = { x: 512, y: 384, zoom: 1 };
  await settleFades(rig.engine, cam, 3);
  const missesBefore = rig.engine.cache.stats.misses;
  rig.clock.t += EXCEPTION_PARAMS.invalidateCacheAfterMs + 1000;
  await settleFades(rig.engine, cam, 3);
  const stats = rig.engine.cache.stats;
  assert.ok(stats.invalidations > 0, 'stale entries invalidated');
  assert.ok(stats.misses > missesBefore, 'expired entries count as misses');
  const ops = rig.engine.render(cam);
  assert.ok(ops.every((o) => !o.placeholder || o.alpha > 0), 'no stale or blank output');
});

test('exception: tiny budget keeps memory under limit under pressure', async () => {
  const rig = makeRig({ ...EXCEPTION_PARAMS }, KF);
  const cam = { x: 512, y: 384, zoom: 1 };
  await settleFades(rig.engine, cam, 5);
  const stats = rig.engine.getStats().cache;
  assert.ok(stats.evictions > 0, 'evictions happen under pressure');
  assert.ok(stats.bytesUsed <= stats.budgetBytes, 'budget never exceeded');
});

test('exception: paused loader triggers fallback instead of throwing', async () => {
  const rig = makeRig({ ...EXCEPTION_PARAMS }, KF);
  rig.engine.setPaused(false);
  rig.engine.loader.paused = true;
  const cam = { x: 512, y: 384, zoom: 1 };
  const ops = await settleFades(rig.engine, cam, 3);
  assert.ok(ops.length > 0, 'frame still renders');
  assert.ok(
    rig.engine.notices.some((n) => n.type === 'load-failed' && /paused/.test(n.message)),
    'paused-loader failure is surfaced as a notice'
  );
});
