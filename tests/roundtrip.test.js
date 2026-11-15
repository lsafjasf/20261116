// Export / reload fidelity: snapshot is kept before export, exported frame
// matches the on-screen preview, and reload preserves layer order, keyframes,
// coordinates and colors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PARAMS } from '../src/config.js';
import { serializeProject, exportFrame, exportProject, loadProject } from '../src/project.js';
import { Engine } from '../src/engine.js';
import { LayerStack, Timeline } from '../src/timeline.js';
import { makeRig, settleFades } from './helpers.js';

const KEYFRAMES = [
  { t: 0, x: 512, y: 384, zoom: 1 },
  { t: 500, x: 2400, y: 1600, zoom: 4 },
  { t: 1000, x: 900, y: 2900, zoom: 8 }
];

test('roundtrip: snapshot is written before export', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mapproj-'));
  const rig = makeRig({ ...DEFAULT_PARAMS }, KEYFRAMES);
  const project = serializeProject({
    params: rig.engine.params,
    layers: rig.layers,
    timeline: rig.timeline
  });
  const snapshotDir = join(dir, 'snapshots');
  const { snapshotPath } = await exportProject(project, join(dir, 'project.json'), { snapshotDir });
  assert.ok(snapshotPath, 'snapshot path returned');
  const snapshots = await readdir(snapshotDir);
  assert.equal(snapshots.length, 1, 'exactly one pre-export snapshot kept');
  const snap = JSON.parse(await readFile(snapshotPath, 'utf8'));
  assert.deepEqual(snap, project, 'snapshot equals the pre-export project state');
});

test('roundtrip: reload preserves layers, keyframes, coords and colors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mapproj-'));
  const rig = makeRig({ ...DEFAULT_PARAMS }, KEYFRAMES);
  rig.timeline.advance(250);
  const project = serializeProject({
    params: rig.engine.params,
    layers: rig.layers,
    timeline: rig.timeline
  });
  const path = join(dir, 'project.json');
  await exportProject(project, path, { snapshotDir: join(dir, 'snapshots') });
  const restored = await loadProject(path);
  assert.deepEqual(restored.layerOrder, DEFAULT_PARAMS.layers, 'layer order preserved');
  assert.deepEqual(restored.layerColors, DEFAULT_PARAMS.layerColors, 'colors preserved');
  assert.deepEqual(restored.keyframes, KEYFRAMES, 'keyframes (t, x, y, zoom) preserved');
  assert.equal(restored.timelineTime, 250, 'timeline position preserved');
  assert.deepEqual(restored.params, rig.engine.params, 'params preserved');
});

test('roundtrip: exported frame matches the screen preview exactly', async () => {
  const rig = makeRig({ ...DEFAULT_PARAMS }, KEYFRAMES);
  const cam = { x: 1024, y: 1024, zoom: 2 };
  const preview = await settleFades(rig.engine, cam, 5);
  const exported = exportFrame(preview, cam);
  assert.deepEqual(exported.ops, preview, 'export is identical to the preview draw list');
  assert.deepEqual(exported.camera, cam, 'export carries the preview camera');
});

test('roundtrip: reloaded project renders the same frame deterministically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mapproj-'));
  const rig = makeRig({ ...DEFAULT_PARAMS }, KEYFRAMES);
  const cam = { x: 1024, y: 1024, zoom: 2 };
  const before = await settleFades(rig.engine, cam, 5);
  const project = serializeProject({
    params: rig.engine.params,
    layers: rig.layers,
    timeline: rig.timeline
  });
  const path = join(dir, 'project.json');
  await exportProject(project, path, { snapshotDir: join(dir, 'snapshots') });
  const restored = await loadProject(path);
  const layers = new LayerStack(restored.layerOrder, restored.layerColors);
  const timeline = new Timeline(restored.keyframes);
  const engine2 = new Engine(restored.params, layers, { sleep: async () => {} });
  const after = await settleFades(engine2, cam, 5);
  assert.deepEqual(after, before, 'reloaded project renders identical output');
});
