const DEFAULT_CAPACITY = 64;

export function makeFrameKey({
  sourceId = "project",
  revision = 1,
  timeMs,
  width,
  height,
  cropAspect = "16:9",
} = {}) {
  if (!Number.isFinite(timeMs) || timeMs < 0) {
    throw new RangeError("frame time must be a finite non-negative number");
  }
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError("frame resolution must contain positive integers");
  }
  return [
    sourceId,
    `r${revision}`,
    `t${Math.round(timeMs)}`,
    `${width}x${height}`,
    `crop:${cropAspect}`,
  ].join("|");
}

export class FrameCache {
  #capacity;
  #entries = new Map();
  #inflight = new Map();
  #generation = 0;
  #onStats;

  constructor({ capacity = DEFAULT_CAPACITY, onStats = () => {} } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("cache capacity must be an integer greater than zero");
    }
    this.#capacity = capacity;
    this.#onStats = onStats;
    this.stats = {
      lookups: 0,
      hits: 0,
      misses: 0,
      deduped: 0,
      evictions: 0,
      invalidations: 0,
      failures: 0,
      rejected: 0,
    };
  }

  get generation() {
    return this.#generation;
  }

  get size() {
    return this.#entries.size;
  }

  get inflightSize() {
    return this.#inflight.size;
  }

  get hitRate() {
    return this.stats.lookups === 0 ? 0 : this.stats.hits / this.stats.lookups;
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  peek(key) {
    return this.#entries.get(key)?.value;
  }

  set(key, value) {
    if (this.#entries.has(key)) this.#entries.delete(key);
    this.#entries.set(key, { value });
    while (this.#entries.size > this.#capacity) {
      const oldestKey = this.#entries.keys().next().value;
      this.#entries.delete(oldestKey);
      this.stats.evictions += 1;
    }
    this.#emit();
  }

  delete(key) {
    return this.#entries.delete(key);
  }

  clear(reason = "manual") {
    const cleared = this.#entries.size;
    for (const request of this.#inflight.values()) {
      request.controller.abort(reason);
    }
    this.#entries.clear();
    this.#inflight.clear();
    this.#generation += 1;
    this.stats.invalidations += 1;
    this.#emit();
    return cleared;
  }

  getOrLoad(key, loader, { validate = () => true } = {}) {
    this.stats.lookups += 1;
    const hit = this.get(key);
    if (hit !== undefined) {
      this.stats.hits += 1;
      this.#emit();
      return { status: "hit", value: hit, generation: this.#generation };
    }

    const existing = this.#inflight.get(key);
    if (existing) {
      this.stats.deduped += 1;
      this.#emit();
      return {
        status: "inflight",
        promise: existing.promise,
        generation: this.#generation,
      };
    }

    this.stats.misses += 1;
    const generation = this.#generation;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => loader(controller.signal))
      .then((value) => {
        validate(value);
        if (generation === this.#generation) this.set(key, value);
        return value;
      })
      .catch((error) => {
        this.stats.failures += 1;
        this.#emit();
        throw error;
      })
      .finally(() => {
        if (this.#inflight.get(key)?.promise === promise) {
          this.#inflight.delete(key);
          this.#emit();
        }
      });

    this.#inflight.set(key, { promise, controller, generation });
    this.#emit();
    return { status: "miss", promise, generation };
  }

  invalidateKey(key) {
    this.delete(key);
    const request = this.#inflight.get(key);
    if (request) {
      request.controller.abort("invalidated");
      request.promise.catch(() => {});
      this.#inflight.delete(key);
    }
  }

  metrics() {
    return {
      ...this.stats,
      size: this.size,
      capacity: this.#capacity,
      inflight: this.inflightSize,
      hitRate: this.hitRate,
      generation: this.#generation,
    };
  }

  #emit() {
    this.#onStats(this.metrics());
  }
}
