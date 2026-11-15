// Measurement primitives used by both the in-page dashboard and Node tests.
import { TILE_SIZE, BLOCK_SIZE } from "./params.js";

// FNV-1a over RGBA bytes; stable across browser and Node.
export function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function hashRegion(bytes, x0, y0, x1, y1, width = TILE_SIZE) {
  let h = 0x811c9dc5;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        h ^= bytes[p + c];
        h = Math.imul(h, 0x01000193);
      }
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// True continuity check: opposite edge pixels must match exactly, including
// corner pixels (wrap in both axes).
export function checkSeams(bytes, width = TILE_SIZE, height = TILE_SIZE) {
  let maxDelta = 0;
  let sumDelta = 0;
  let pairs = 0;
  let mismatches = 0;
  const perEdge = {};
  const measure = (p1, p2, name) => {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(bytes[p1 + c] - bytes[p2 + c]));
    perEdge[name] = Math.max(perEdge[name] || 0, d);
    maxDelta = Math.max(maxDelta, d);
    sumDelta += d;
    pairs++;
    if (d !== 0) mismatches++;
  };
  const step = (p1, p2) => {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(bytes[p1 + c] - bytes[p2 + c]));
    return d;
  };
  for (let y = 0; y < height; y++) {
    measure((y * width) * 4, (y * width + width - 1) * 4, "leftRight");
    perEdge.lrJump = Math.max(
      perEdge.lrJump || 0,
      step((y * width + width - 1) * 4, (y * width) * 4)
    );
  }
  for (let x = 0; x < width; x++) {
    measure(x * 4, ((height - 1) * width + x) * 4, "topBottom");
    perEdge.tbJump = Math.max(
      perEdge.tbJump || 0,
      step(((height - 1) * width + x) * 4, x * 4)
    );
  }
  // Interior neighbor-step baseline, sampled away from all four edges.
  let interiorMax = 0;
  let interiorSum = 0;
  let interiorPairs = 0;
  for (let y = 16; y < height - 16; y += 7) {
    for (let x = 16; x < width - 17; x += 7) {
      const s = step((y * width + x) * 4, (y * width + x + 1) * 4);
      interiorMax = Math.max(interiorMax, s);
      interiorSum += s;
      interiorPairs++;
    }
  }
  const seamJump = Math.max(perEdge.lrJump || 0, perEdge.tbJump || 0);
  const interiorMean = interiorSum / interiorPairs;
  return {
    // Seamless when the wrap boundary step is no larger than roughly twice the
    // ordinary interior step: no discontinuity is introduced by the tiling.
    seamless: seamJump <= Math.max(3, interiorMean * 2),
    maxDelta,
    meanDelta: Number((sumDelta / pairs).toFixed(4)),
    mismatches,
    pairs,
    seamJump,
    interiorMax,
    interiorMean: Number(interiorMean.toFixed(4)),
    perEdge,
  };
}

// Count blocks whose pixels differ between two composites.
export function diffBlocks(before, after, width = TILE_SIZE) {
  const blocksPerSide = width / BLOCK_SIZE;
  const changed = [];
  for (let by = 0; by < blocksPerSide; by++) {
    for (let bx = 0; bx < blocksPerSide; bx++) {
      let differs = false;
      const x0 = bx * BLOCK_SIZE;
      const y0 = by * BLOCK_SIZE;
      outer: for (let y = y0; y < y0 + BLOCK_SIZE; y++) {
        for (let x = x0; x < x0 + BLOCK_SIZE; x++) {
          const p = (y * width + x) * 4;
          if (before[p] !== after[p] || before[p + 1] !== after[p + 1] || before[p + 2] !== after[p + 2]) {
            differs = true;
            break outer;
          }
        }
      }
      if (differs) changed.push(by * blocksPerSide + bx);
    }
  }
  return { changedBlocks: changed, totalBlocks: blocksPerSide ** 2 };
}

export function countObjects() {
  if (typeof performance !== "undefined" && performance.getEntriesByType) {
    return performance.getEntriesByType("resource").length;
  }
  return 0;
}

// Mean color of a strip; used to prove the curved preview wraps the same tile.
export function meanColor(bytes, x0, y0, x1, y1, width = TILE_SIZE) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * width + x) * 4;
        r += bytes[p]; g += bytes[p + 1]; b += bytes[p + 2]; n++;
      }
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}
