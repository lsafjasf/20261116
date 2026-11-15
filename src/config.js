// Parameter presets: default / boundary / exception.
// All presets are plain data so tests are fully repeatable.
export const DEFAULT_PARAMS = Object.freeze({
  tileSize: 256,
  maxLod: 4,
  cacheBudgetBytes: 4 * 1024 * 1024,
  tileBytes: 64 * 1024,
  crossfadeMs: 200,
  requestTimeoutMs: 1000,
  maxRetries: 2,
  viewport: { width: 1024, height: 768 },
  worldSize: { width: 4096, height: 4096 },
  layers: ['terrain', 'road', 'decor'],
  layerColors: { terrain: '#3a5f3a', road: '#8a8a8a', decor: '#c2a14d' }
});

export const BOUNDARY_PARAMS = Object.freeze({
  ...DEFAULT_PARAMS,
  maxLod: 2,
  cacheBudgetBytes: 4 * 64 * 1024,
  viewport: { width: 512, height: 512 },
  worldSize: { width: 256, height: 256 },
  crossfadeMs: 0
});

export const EXCEPTION_PARAMS = Object.freeze({
  ...DEFAULT_PARAMS,
  cacheBudgetBytes: 2 * 64 * 1024,
  requestTimeoutMs: 50,
  maxRetries: 1,
  failTileIds: ['2/1/1', '1/0/0'],
  corruptThumbnailIds: ['0/0/0'],
  invalidateCacheAfterMs: 300
});

export function resolveParams(overrides = {}) {
  return { ...DEFAULT_PARAMS, ...overrides };
}
