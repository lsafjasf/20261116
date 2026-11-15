// Shared deterministic test rig: fake clock, instant async, scripted
// pan/zoom rounds, and seam (gap/overlap) verification helpers.
import { Engine } from '../src/engine.js';
import { LayerStack, Timeline } from '../src/timeline.js';
import { tileWorldRect, lodForZoom } from '../src/tileGrid.js';

export function makeRig(params, keyframes) {
  const clock = { t: 1000 };
  const layers = new LayerStack(params.layers, params.layerColors);
  const timeline = new Timeline(keyframes);
  const engine = new Engine(params, layers, {
    now: () => clock.t,
    sleep: async () => {}
  });
  return { clock, layers, timeline, engine };
}

export async function runPanZoomRounds(rig, { rounds = 2, framesPerRound = 60, dtMs = 16, onFrame } = {}) {
  const { timeline, engine, clock } = rig;
  const duration = timeline.keyframes[timeline.keyframes.length - 1].t;
  for (let round = 0; round < rounds; round++) {
    timeline.time = 0;
    for (let f = 0; f < framesPerRound; f++) {
      clock.t += dtMs;
      const camera = timeline.advance(duration / framesPerRound);
      const ops = engine.update(camera, dtMs);
      if (onFrame) onFrame(camera, ops, round, f);
      await engine.settle();
    }
  }
}

export async function settleFades(engine, camera, frames = 40) {
  let ops;
  for (let i = 0; i < frames; i++) {
    ops = engine.update(camera, 16);
    await engine.settle();
  }
  return ops;
}

export function findSeamGaps(params, ops, layer, lod) {
  const tiles = ops.filter((o) => o.layer === layer && o.lod === lod);
  const byKey = new Map();
  for (const op of tiles) {
    const [, x, y] = op.tileId.split('/').map(Number);
    byKey.set(`${x},${y}`, tileWorldRect(params, op.tileId));
  }
  const gaps = [];
  for (const [key, rect] of byKey) {
    const [x, y] = key.split(',').map(Number);
    const right = byKey.get(`${x + 1},${y}`);
    if (right && Math.abs(rect.x + rect.width - right.x) > 1e-9) {
      gaps.push({ key, dir: 'x', expected: rect.x + rect.width, actual: right.x });
    }
    const below = byKey.get(`${x},${y + 1}`);
    if (below && Math.abs(rect.y + rect.height - below.y) > 1e-9) {
      gaps.push({ key, dir: 'y', expected: rect.y + rect.height, actual: below.y });
    }
  }
  return gaps;
}

export function targetLodOps(params, ops, camera) {
  const lod = lodForZoom(params, camera.zoom);
  return ops.filter((o) => o.lod === lod);
}
