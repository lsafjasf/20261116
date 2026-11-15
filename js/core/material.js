// FabricMaterial owns the four layer buffers, the toroidal brush mask, the
// 16x16 dirty-block grid and the composite RGBA tile. Re-rendering dirty
// blocks uses the exact same per-pixel functions as a full render, which is
// what makes incremental output byte-identical to a from-scratch render.
import { TILE_SIZE, BLOCK_SIZE, validateParams } from "./params.js";
import { renderWeave, renderFuzz, renderWear, renderCrease } from "./layers.js";

export const LAYERS = Object.freeze({
  WEAVE: "weave",
  FUZZ: "fuzz",
  WEAR: "wear",
  CREASE: "crease",
});

const PARAM_TO_LAYERS = {
  threadDensity: [LAYERS.WEAVE],
  baseColor: [LAYERS.WEAVE],
  paletteJitter: [LAYERS.WEAVE],
  fiberDirection: [LAYERS.FUZZ],
  wearLevel: [LAYERS.WEAR],
  creaseStrength: [LAYERS.CREASE],
  seed: [LAYERS.WEAVE, LAYERS.FUZZ, LAYERS.WEAR, LAYERS.CREASE],
};

export class FabricMaterial {
  constructor(params) {
    this.size = TILE_SIZE;
    this.blockSize = BLOCK_SIZE;
    this.blocksPerSide = TILE_SIZE / BLOCK_SIZE;
    this.params = validateParams(params);
    const px = TILE_SIZE * TILE_SIZE * 4;
    this.buffers = {
      [LAYERS.WEAVE]: new Uint8ClampedArray(px),
      [LAYERS.FUZZ]: new Uint8ClampedArray(px),
      [LAYERS.WEAR]: new Uint8ClampedArray(px),
      [LAYERS.CREASE]: new Uint8ClampedArray(px),
    };
    this.composite = new Uint8ClampedArray(px);
    this.brushMask = new Uint8Array(TILE_SIZE * TILE_SIZE);
    this.dirty = new Set();
    this.metrics = {
      fullRenders: 0,
      incrementalRenders: 0,
      blocksRecomputed: 0,
      brushStrokes: 0,
      layerCalls: 0,
    };
    this._markAllDirty();
    this._renderLayers(new Set(Object.values(LAYERS)), [...this.dirty]);
    this.recompose();
  }

  _markAllDirty() {
    this.dirty.clear();
    for (let b = 0; b < this.blocksPerSide ** 2; b++) this.dirty.add(b);
  }

  _markRegionDirty(x0, y0, x1, y1) {
    const bs = this.blockSize;
    const bx0 = Math.max(0, Math.floor(x0 / bs));
    const by0 = Math.max(0, Math.floor(y0 / bs));
    const bx1 = Math.min(this.blocksPerSide - 1, Math.floor((x1 - 1) / bs));
    const by1 = Math.min(this.blocksPerSide - 1, Math.floor((y1 - 1) / bs));
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) this.dirty.add(by * this.blocksPerSide + bx);
    }
  }

  // Apply only changed parameters; untouched layers keep their buffers.
  updateParams(nextParams) {
    const next = validateParams(nextParams);
    const affectedLayers = new Set();
    for (const key of Object.keys(PARAM_TO_LAYERS)) {
      if (JSON.stringify(this.params[key]) !== JSON.stringify(next[key])) {
        for (const layer of PARAM_TO_LAYERS[key]) affectedLayers.add(layer);
      }
    }
    this.params = next;
    if (affectedLayers.size) {
      this._markAllDirty();
      this._renderLayers(affectedLayers, [...this.dirty]);
      this.recompose();
    }
    return [...affectedLayers];
  }

  // Toroidal brush: stamp onto all 9 wrapped copies. Each pixel's falloff is
  // computed once from its shortest distance to any toroidal copy of the
  // center, so seam-opposite pixels get byte-identical values by construction.
  brushAt(x, y, radius, value = 255) {
    const n = this.size;
    const r = Math.round(radius);
    const r2 = r * r;
    const centers = [];
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) centers.push([x + ox * n, y + oy * n]);
    }
    const boxes = new Set();
    for (const [cx, cy] of centers) {
      const bx0 = Math.max(0, cx - r);
      const by0 = Math.max(0, cy - r);
      const bx1 = Math.min(n - 1, cx + r);
      const by1 = Math.min(n - 1, cy + r);
      if (bx0 > bx1 || by0 > by1) continue;
      for (let py = by0; py <= by1; py++) {
        for (let px = bx0; px <= bx1; px++) {
          // Periodic per-axis offset: fold the pixel onto the center's local
          // neighborhood (-n/2..n/2) before measuring Euclidean distance.
          // Seam-opposite pixels then fold to the same offset and match.
          const dx = ((px - cx + n * 1.5) % n) - n / 2;
          const dy = ((py - cy + n * 1.5) % n) - n / 2;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const falloff = Math.round(value * (1 - Math.sqrt(d2) / r));
          const idx = py * n + px;
          this.brushMask[idx] = Math.max(this.brushMask[idx], falloff);
        }
      }
      boxes.add(`${bx0},${by0},${bx1 + 1},${by1 + 1}`);
    }
    for (const box of boxes) {
      const [bx0, by0, bx1, by1] = box.split(",").map(Number);
      this._markRegionDirty(bx0, by0, bx1, by1);
    }
    this.metrics.brushStrokes++;
    this._renderLayers(new Set([LAYERS.WEAR]), [...this.dirty]);
    this.recompose();
  }

  clearBrush() {
    this.brushMask.fill(0);
    this._markAllDirty();
    this._renderLayers(new Set([LAYERS.WEAR]), [...this.dirty]);
    this.recompose();
  }

  _renderLayers(layerSet, blockList) {
    const n = this.size;
    const bs = this.blockSize;
    const count = blockList.length;
    const full = count === this.blocksPerSide ** 2;
    if (full) this.metrics.fullRenders++;
    else this.metrics.incrementalRenders++;
    this.metrics.blocksRecomputed += count;
    for (const blockId of blockList) {
      const bx = blockId % this.blocksPerSide;
      const by = Math.floor(blockId / this.blocksPerSide);
      const x0 = bx * bs;
      const y0 = by * bs;
      const x1 = Math.min(n, x0 + bs);
      const y1 = Math.min(n, y0 + bs);
      if (layerSet.has(LAYERS.WEAVE)) {
        renderWeave(this.params, this.buffers[LAYERS.WEAVE], x0, y0, x1, y1);
        this.metrics.layerCalls++;
      }
      if (layerSet.has(LAYERS.FUZZ)) {
        renderFuzz(this.params, this.buffers[LAYERS.FUZZ], x0, y0, x1, y1);
        this.metrics.layerCalls++;
      }
      if (layerSet.has(LAYERS.WEAR)) {
        renderWear(this.params, this.brushMask, this.buffers[LAYERS.WEAR], x0, y0, x1, y1);
        this.metrics.layerCalls++;
      }
      if (layerSet.has(LAYERS.CREASE)) {
        renderCrease(this.params, this.buffers[LAYERS.CREASE], x0, y0, x1, y1);
        this.metrics.layerCalls++;
      }
    }
  }

  // "Over" alpha blending for fuzz/wear, multiplicative shade for crease.
  recompose() {
    const blockList = [...this.dirty];
    const n = this.size;
    const bs = this.blockSize;
    const weave = this.buffers[LAYERS.WEAVE];
    const fuzz = this.buffers[LAYERS.FUZZ];
    const wear = this.buffers[LAYERS.WEAR];
    const crease = this.buffers[LAYERS.CREASE];
    for (const blockId of blockList) {
      const bx = blockId % this.blocksPerSide;
      const by = Math.floor(blockId / this.blocksPerSide);
      const x0 = bx * bs;
      const y0 = by * bs;
      const x1 = Math.min(n, x0 + bs);
      const y1 = Math.min(n, y0 + bs);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * n + x) * 4;
          let r = weave[p];
          let g = weave[p + 1];
          let b = weave[p + 2];
          // fuzz blend
          let fa = fuzz[p + 3] / 255;
          r = r * (1 - fa) + fuzz[p] * fa;
          g = g * (1 - fa) + fuzz[p + 1] * fa;
          b = b * (1 - fa) + fuzz[p + 2] * fa;
          // wear blend
          fa = wear[p + 3] / 255;
          r = r * (1 - fa) + wear[p] * fa;
          g = g * (1 - fa) + wear[p + 1] * fa;
          b = b * (1 - fa) + wear[p + 2] * fa;
          // crease multiply
          r = (r * crease[p]) / 255;
          g = (g * crease[p + 1]) / 255;
          b = (b * crease[p + 2]) / 255;
          this.composite[p] = r;
          this.composite[p + 1] = g;
          this.composite[p + 2] = b;
          this.composite[p + 3] = 255;
        }
      }
    }
    this.dirty.clear();
    return this.composite;
  }
}
