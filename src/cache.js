export function layoutKey(text, style) {
  return JSON.stringify([
    text,
    style.fontFamily,
    style.fontWeight,
    style.fontSize,
    style.width,
    style.align,
    style.lineHeight
  ]);
}

export class LayoutCache {
  constructor(capacity = 192) {
    this.capacity = Math.max(1, capacity);
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  get(text, style) {
    const key = layoutKey(text, style);
    if (!this.entries.has(key)) {
      this.misses += 1;
      return null;
    }
    const value = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, value);
    this.hits += 1;
    return value;
  }

  set(text, style, layout) {
    const key = layoutKey(text, style);
    if (this.entries.has(key)) {
      this.entries.delete(key);
      this.entries.set(key, layout);
      return;
    }
    this.entries.set(key, layout);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
      this.evictions += 1;
    }
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }

  get lookups() {
    return this.hits + this.misses;
  }

  get hitRate() {
    return this.lookups ? this.hits / this.lookups : 0;
  }

  snapshot() {
    return {
      size: this.size,
      capacity: this.capacity,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      lookups: this.lookups,
      hitRate: this.hitRate
    };
  }
}

export class LayoutService {
  constructor({ engine, cache, cacheEnabled = true }) {
    this.engine = engine;
    this.cache = cache;
    this.cacheEnabled = cacheEnabled;
    this.errors = [];
  }

  resolve(text, style) {
    const start = performance.now();
    if (!this.cacheEnabled) {
      const layout = this.engine.layout(text, style);
      return {
        layout,
        cacheHit: false,
        candidates: layout.candidateCount,
        elapsed: performance.now() - start
      };
    }
    const cached = this.cache.get(text, style);
    if (cached) {
      return {
        layout: cached,
        cacheHit: true,
        candidates: 0,
        elapsed: performance.now() - start
      };
    }
    try {
      const layout = this.engine.layout(text, style);
      this.cache.set(text, style, layout);
      return {
        layout,
        cacheHit: false,
        candidates: layout.candidateCount,
        elapsed: performance.now() - start
      };
    } catch (error) {
      this.errors.push({ text, message: error.message, at: start });
      throw error;
    }
  }

  snapshot() {
    return {
      cacheEnabled: this.cacheEnabled,
      cache: this.cache.snapshot(),
      errors: this.errors.length
    };
  }
}
