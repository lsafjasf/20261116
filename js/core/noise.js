// Periodic value noise on a toroidal grid: noise(x, y) === noise(x + period, y).
// Every layer is built from these primitives, which guarantees tile-edge
// continuity mathematically rather than by post-processing seams.
import { Rng } from "./rng.js";

function smooth(t) {
  return t * t * (3 - 2 * t);
}

export class PeriodicNoise {
  constructor(seed, periodCellsX, periodCellsY = periodCellsX) {
    const rng = new Rng(seed);
    this.periodCellsX = periodCellsX;
    this.periodCellsY = periodCellsY;
    this.grid = new Float32Array(periodCellsY * periodCellsX);
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = rng.next();
  }

  // x, y in cell units (can be negative or beyond the period).
  sample(x, y) {
    const px = this.periodCellsX;
    const py = this.periodCellsY;
    // Torus-normalize first so coordinate 0 and coordinate period execute the
    // identical floating-point path (required for byte-exact seam pixels).
    x = ((x % px) + px) % px;
    y = ((y % py) + py) % py;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = smooth(x - x0);
    const ty = smooth(y - y0);
    const x1 = (x0 + 1) % px;
    const y1 = (y0 + 1) % py;
    const v00 = this.grid[y0 * px + x0];
    const v10 = this.grid[y0 * px + x1];
    const v01 = this.grid[y1 * px + x0];
    const v11 = this.grid[y1 * px + x1];
    const a = v00 + (v10 - v00) * tx;
    const b = v01 + (v11 - v01) * tx;
    return a + (b - a) * ty;
  }

  // Normalized sampling with u, v in [0,1). Uses fractional arithmetic instead
  // of integer modulo, which is the dominant hot-path cost. Inputs outside
  // [0,1) are folded, so callers can pass seam-aliased coordinates directly.
  sampleUV(u, v) {
    const fx = u - Math.floor(u);
    const fy = v - Math.floor(v);
    const gx = fx * this.periodCellsX;
    const gy = fy * this.periodCellsY;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = smooth(gx - x0);
    const ty = smooth(gy - y0);
    const px = this.periodCellsX;
    const py = this.periodCellsY;
    const x1 = x0 + 1 >= px ? 0 : x0 + 1;
    const y1 = y0 + 1 >= py ? 0 : y0 + 1;
    const v00 = this.grid[y0 * px + x0];
    const v10 = this.grid[y0 * px + x1];
    const v01 = this.grid[y1 * px + x0];
    const v11 = this.grid[y1 * px + x1];
    const a = v00 + (v10 - v00) * tx;
    const b = v01 + (v11 - v01) * tx;
    return a + (b - a) * ty;
  }
}

// Fractal sum of periodic octaves. Each octave is its OWN periodic noise with
// an integer number of cells (baseCells * 2^k), and inputs stay in 0..1, so
// the sum is periodic by construction at every octave.
export function fbm(noiseList, u, v) {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  for (const noise of noiseList) {
    const val = noise.sampleUV(u, v);
    sum += val * amp;
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

// Build octaves whose periods stay integer-divisible so every octave wraps.
export function buildOctaves(seed, baseCells, octaves) {
  const list = [];
  for (let o = 0; o < octaves; o++) {
    const cells = baseCells * 2 ** o;
    list.push(new PeriodicNoise(`${seed}:oct${o}`, cells));
  }
  return list;
}

// Anisotropic octaves: grid has cellsX x cellsY cells at every level; both
// counts are integers => wraps on every edge and gives directional streaks.
export function buildAnisoOctaves(seed, cellsX, cellsY, levels) {
  const list = [];
  for (let o = 0; o < levels; o++) {
    const scale = 2 ** o;
    list.push(new PeriodicNoise(`${seed}:a${o}`, cellsX * scale, cellsY * scale));
  }
  return list;
}

export function fbmAniso(noiseList, u, v) {
  return fbm(noiseList, u, v);
}

// Domain warp along an angle using two periodic FBM fields; the warp itself
// is periodic, so warped directional streaks still tile seamlessly.
export function makeWarp(seed, cells = 8, octaves = 3) {
  const nx = buildOctaves(`${seed}:wx`, cells, octaves);
  const ny = buildOctaves(`${seed}:wy`, cells, octaves);
  return (u, v, amount = 0.06) => {
    const wx = (fbm(nx, u, v) - 0.5) * 2 * amount;
    const wy = (fbm(ny, u, v) - 0.5) * 2 * amount;
    return [wx, wy];
  };
}
