import { buildGeometry } from "./geometry.js";

// CPU-side geometry cache keyed by shape + tessellation.
// Both render paths ask the same questions; only GPU resource strategy differs.
export class GeometryCache {
  constructor() {
    this._store = new Map();
    this.requests = 0;
    this.hits = 0;
  }

  get(key, tessellation) {
    this.requests++;
    const cacheKey = `${key}:${tessellation}`;
    const hit = this._store.get(cacheKey);
    if (hit) {
      this.hits++;
      return hit;
    }
    const geometry = buildGeometry(key, tessellation);
    const entry = { key: cacheKey, geometry };
    this._store.set(cacheKey, entry);
    return entry;
  }

  get hitRate() {
    return this.requests === 0 ? 0 : this.hits / this.requests;
  }

  get size() {
    return this._store.size;
  }
}
