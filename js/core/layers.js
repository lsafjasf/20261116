// The four fabric layers. Every generator is a pure function of pixel
// coordinates + parameters and only uses periodic primitives, so rendering a
// single dirty block yields byte-identical results to a full-tile render.
import { Rng } from "./rng.js";
import { buildOctaves, buildAnisoOctaves, fbm, fbmAniso } from "./noise.js";
import { TILE_SIZE } from "./params.js";

const TAU = Math.PI * 2;
const noiseCache = new Map();

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Octave sets are deterministic functions of (seed, name, cells, count); cache
// them so per-block renders never rebuild grids, and full renders stay fast.
function octaves(seed, name, cells, count) {
  const key = `${seed}|${name}|${cells}|${count}`;
  let list = noiseCache.get(key);
  if (!list) {
    list = buildOctaves(`${seed}:${name}`, cells, count);
    noiseCache.set(key, list);
  }
  return list;
}

function anisoOctaves(seed, name, cellsX, cellsY, count) {
  const key = `${seed}|${name}|${cellsX}x${cellsY}|${count}`;
  let list = noiseCache.get(key);
  if (!list) {
    list = buildAnisoOctaves(`${seed}:${name}`, cellsX, cellsY, count);
    noiseCache.set(key, list);
  }
  return list;
}

const threadShadeCache = new Map();
function threadShade(seed, kind, index) {
  const key = `${seed}|${kind}|${index}`;
  let shade = threadShadeCache.get(key);
  if (shade === undefined) {
    const rng = new Rng(key);
    shade = 0.85 + rng.next() * 0.3;
    threadShadeCache.set(key, shade);
  }
  return shade;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

// Toroidal normalized coordinate: pixels on opposite edges produce the exact
// same float, which is required for byte-identical seam continuity.
function torusUV(x, y, n) {
  // Alias the last pixel of each axis onto the first's normalized coordinate.
  // Pixel n-1 is the torus neighbor of pixel 0, so both must feed noise the
  // exact same float; interior pixels keep their normal center coordinate.
  const wx = ((x % n) + n) % n;
  const wy = ((y % n) + n) % n;
  const u = wx === n - 1 ? 0 : wx / n;
  const v = wy === n - 1 ? 0 : wy / n;
  return [u, v];
}

// --- Layer 2: nap / fuzz (绒毛) --------------------------------------------
// Directional fibers. Coordinates are rotated, but rotation of a *periodic*
// unit square by an arbitrary angle keeps the field periodic because both
// input axes wrap with period 1; the domain warp is periodic as well.
export function renderFuzz(params, out, x0 = 0, y0 = 0, x1 = TILE_SIZE, y1 = TILE_SIZE) {
  const n = TILE_SIZE;
  const angleRad = (params.fiberDirection * Math.PI) / 180;
  const cloud = octaves(params.seed, "fuzzcloud", 6, 4);
  // Two axis-aligned anisotropic fields. Direction is produced by blending
  // their integer-cell counts with sin/cos weights instead of rotating the
  // sampling coordinates, which would break integer-lattice periodicity.
  const streakX = anisoOctaves(params.seed, "fuzzsx", 28, 3, 3);
  const streakY = anisoOctaves(params.seed, "fuzzsy", 3, 28, 3);
  const wtX = Math.abs(Math.cos(angleRad));
  const wtY = Math.abs(Math.sin(angleRad));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const [u, v] = torusUV(x, y, n);
      const along = fbm(cloud, u, v);
      const across = fbmAniso(streakX, u, v) * wtX + fbmAniso(streakY, u, v) * wtY;
      const hair = clamp01((across - 0.45) * 2.2);
      const mask = clamp01(hair * (0.35 + along * 0.85));
      const p = (y * n + x) * 4;
      // Fuzz lightens toward a desaturated warm highlight; alpha = coverage.
      out[p] = Math.round(mask * 255);
      out[p + 1] = Math.round(mask * 235);
      out[p + 2] = Math.round(mask * 210);
      out[p + 3] = Math.round(mask * 150);
    }
  }
  return out;
}

// --- Layer 3: wear / abrasion (磨损) ---------------------------------------
// Brush mask is a Uint8Array (0..255) maintained on a torus by FabricMaterial,
// so strokes crossing an edge appear identically on the opposite edge.
export function renderWear(params, brushMask, out, x0 = 0, y0 = 0, x1 = TILE_SIZE, y1 = TILE_SIZE) {
  const n = TILE_SIZE;
  const blotch = octaves(params.seed, "wear", 10, 4);
  // Fine vertical scratches: 2 cells across x, 18 along y.
  const scratch = anisoOctaves(params.seed, "scratch", 2, 18, 2);
  const threshold = 1 - params.wearLevel;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      // Edge pixels alias to the same normalized coordinate so the procedural
      // field is byte-identical across the seam; the brush term already comes
      // from a torus-symmetric mask.
      const [u, v] = torusUV(x, y, n);
      const field = fbm(blotch, u, v);
      const grain = fbmAniso(scratch, u, v);
      const auto = clamp01((field - threshold) / Math.max(0.08, 1 - threshold));
      const brushed = brushMask[y * n + x] / 255;
      const mask = clamp01(Math.max(auto * (0.55 + grain * 0.6), brushed));
      const fray = clamp01((grain - 0.5) * 1.6) * mask; // light edge fibers
      const p = (y * n + x) * 4;
      out[p] = Math.round((mask * 0.85 + fray * 0.4) * 255);
      out[p + 1] = Math.round((mask * 0.8 + fray * 0.35) * 255);
      out[p + 2] = Math.round((mask * 0.72 + fray * 0.3) * 255);
      out[p + 3] = Math.round(mask * 200);
    }
  }
  return out;
}

// --- Layer 4: creases (折痕) -----------------------------------------------
// Low-frequency periodic ridges: valley darkens, lip highlights; signed so the
// composite can both shade and slightly desaturate the fold.
export function renderCrease(params, out, x0 = 0, y0 = 0, x1 = TILE_SIZE, y1 = TILE_SIZE) {
  const n = TILE_SIZE;
  const broad = octaves(params.seed, "crease", 3, 3);
  const detail = octaves(params.seed, "creasedet", 9, 2);
  const strength = params.creaseStrength;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const [u, v] = torusUV(x, y, n);
      const h = (fbm(broad, u, v) - 0.5) * 2 + (fbm(detail, u, v) - 0.5) * 0.35;
      const valley = clamp01(-h * 2.2) * strength;
      const lip = clamp01(h * 1.8) * strength * 0.5;
      const shade = clamp01(1 - valley * 0.45 + lip * 0.18);
      const p = (y * n + x) * 4;
      out[p] = Math.round(clamp01(shade) * 255);
      out[p + 1] = Math.round(clamp01(shade) * 255);
      out[p + 2] = Math.round(clamp01(shade + valley * 0.12) * 255);
      out[p + 3] = 255;
    }
  }
  return out;
}

// --- Layer 1: warp + weft (经纬线) -----------------------------------------
export function renderWeave(params, out, x0 = 0, y0 = 0, x1 = TILE_SIZE, y1 = TILE_SIZE) {
  const n = TILE_SIZE;
  const d = params.threadDensity;
  const [br, bg, bb] = params.baseColor;
  const jitter = params.paletteJitter;
  const colorNoise = octaves(params.seed, "color", 4, 3);
  const shadeW = new Float64Array(d);
  const shadeH = new Float64Array(d);
  for (let i = 0; i < d; i++) {
    shadeW[i] = threadShade(params.seed, "w", i);
    shadeH[i] = threadShade(params.seed, "h", i);
  }
  // Ridge lookup over the wrapped thread fraction; replaces cos() per pixel.
  const ridgeLut = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    ridgeLut[i] = Math.cos(Math.PI * Math.min(i / 256, 1 - i / 256));
  }
  for (let y = y0; y < y1; y++) {
    // Pixel-center phase on a torus. Edge pixels are equidistant neighbors of
    // the same thread center, so every derived term matches on opposite edges.
    const py = ((((y + 0.5) * d) / n) % d + d) % d;
    const iy = Math.floor(py);
    const dy = py - iy;
    const distY = Math.min(dy, 1 - dy); // 0 at center, 0.5 at boundary
    const ridgeY = ridgeLut[(Math.round(distY * 255)) % 256];
    for (let x = x0; x < x1; x++) {
      const px = ((((x + 0.5) * d) / n) % d + d) % d;
      const ix = Math.floor(px);
      const dx = px - ix;
      const distX = Math.min(dx, 1 - dx);
      const ridgeX = ridgeLut[(Math.round(distX * 255)) % 256];
      // Per-axis torus-continuous shading. A checkerboard interlace would flip
      // parity on the wrapped edge (thread d -> 0), so weave relief is encoded
      // as independent warp/weft ridge heights instead.
      const bump = ridgeX * 0.12 - ridgeY * 0.06;
      const gap = Math.min(ridgeX, ridgeY) < 0.12 ? 0.72 : 1; // recessed crossings
      // Wrapped shade index: thread d-1 on the right edge is the torus
      // neighbor of thread 0 on the left, so both sample shade row 0/edge.
      const shadeIx = ix === d - 1 ? 0 : ix;
      const shadeIy = iy === d - 1 ? 0 : iy;
      const threadTone = (shadeW[shadeIx] + shadeH[shadeIy]) * 0.5;
      const tone = clamp01(0.92 + bump) * gap * threadTone;
      // Integer thread-cell coordinates: PeriodicNoise wraps by grid index,
      // giving bit-identical jitter for thread 0 on both wrapped edges.
      const colJ = 1 + (fbm(colorNoise, ix, iy) - 0.5) * 2 * jitter;
      const p = (y * n + x) * 4;
      out[p] = Math.round(clamp01((br * tone * colJ) / 255) * 255);
      out[p + 1] = Math.round(clamp01((bg * tone * colJ) / 255) * 255);
      out[p + 2] = Math.round(clamp01((bb * tone * colJ) / 255) * 255);
      out[p + 3] = 255;
    }
  }
  return out;
}
