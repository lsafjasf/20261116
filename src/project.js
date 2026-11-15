// Project persistence: snapshot before export, deterministic export, and
// lossless reload (layer order, keyframes, coordinates, colors preserved).
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PROJECT_VERSION = 1;

export function serializeProject({ params, layers, timeline }) {
  return {
    version: PROJECT_VERSION,
    params: { ...params },
    layers: layers.order(),
    layerColors: { ...layers.colors },
    keyframes: timeline.keyframes.map((kf) => ({ ...kf })),
    timelineTime: timeline.time,
    paused: timeline.paused
  };
}

export function deserializeProject(data) {
  if (data.version !== PROJECT_VERSION) {
    throw new Error(`unsupported project version ${data.version}`);
  }
  return {
    params: { ...data.params },
    layerOrder: [...data.layers],
    layerColors: { ...data.layerColors },
    keyframes: data.keyframes.map((kf) => ({ ...kf })),
    timelineTime: data.timelineTime,
    paused: data.paused
  };
}

export function exportFrame(drawList, camera) {
  return {
    camera: { x: camera.x, y: camera.y, zoom: camera.zoom },
    ops: drawList.map((op) => ({ ...op, screen: { ...op.screen } }))
  };
}

export async function snapshotBeforeExport(project, dir, label = 'snapshot') {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${label}-${Date.now()}.json`);
  await writeFile(path, JSON.stringify(project, null, 2));
  return path;
}

export async function exportProject(project, path, { snapshotDir } = {}) {
  let snapshotPath = null;
  if (snapshotDir) {
    snapshotPath = await snapshotBeforeExport(project, snapshotDir, 'pre-export');
  }
  await writeFile(path, JSON.stringify(project, null, 2));
  return { path, snapshotPath };
}

export async function loadProject(path) {
  return deserializeProject(JSON.parse(await readFile(path, 'utf8')));
}
