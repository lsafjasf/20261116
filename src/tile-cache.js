/**
 * Tile cache with explicit lifecycle states and failure fallback.
 *
 * A tile is identified by zoom level and time window. Tiles resolve through
 * an injectable async provider (pyramid computation in production, failing
 * stub in tests). Every request records a state machine:
 *
 *   idle -> loading -> ready
 *                    \-> failed -> stale (fallback)
 *
 * On failure the renderer falls back to the coarser pyramid level rather than
 * showing stale content or a blank area, and the failure is surfaced through
 * the notice bus instead of being swallowed.
 */

export const TILE_STATE = Object.freeze({
  LOADING: "loading",
  READY: "ready",
  FAILED: "failed"
});

export class NoticeBus {
  constructor() {
    this.notices = [];
  }

  warn(code, message, detail = {}) {
    const notice = { kind: "warning", code, message, detail, at: Date.now() };
    this.notices.push(notice);
    return notice;
  }

  info(code, message, detail = {}) {
    const notice = { kind: "info", code, message, detail, at: Date.now() };
    this.notices.push(notice);
    return notice;
  }

  clear() {
    this.notices = [];
  }
}

export class TileCache {
  constructor(provider, { maxEntries = 256, notices = new NoticeBus() } = {}) {
    if (typeof provider !== "function") throw new Error("TileCache requires a provider function");
    this.provider = provider;
    this.maxEntries = maxEntries;
    this.notices = notices;
    this.entries = new Map();
    this.inFlight = new Map();
    this.metrics = { hits: 0, misses: 0, failures: 0, fallbacks: 0, evictions: 0 };
  }

  static key(levelIndex, tileIndex) {
    return `${levelIndex}:${tileIndex}`;
  }

  get(levelIndex, tileIndex) {
    return this.entries.get(TileCache.key(levelIndex, tileIndex)) || null;
  }

  hasReady(levelIndex, tileIndex) {
    const entry = this.get(levelIndex, tileIndex);
    return Boolean(entry && entry.state === TILE_STATE.READY);
  }

  invalidate(levelIndex, tileIndex) {
    const key = TileCache.key(levelIndex, tileIndex);
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.notices.warn("TILE_INVALIDATED", "Tile cache entry invalidated; re-fetching", { key });
    }
  }

  invalidateAll() {
    const count = this.entries.size;
    this.entries.clear();
    this.inFlight.clear();
    if (count > 0) {
      this.notices.warn("CACHE_CLEARED", "All waveform tiles invalidated", { count });
    }
  }

  /** Request a tile; resolves to a READY entry or records FAILED. */
  async request(levelIndex, tileIndex) {
    const key = TileCache.key(levelIndex, tileIndex);
    const existing = this.entries.get(key);
    if (existing && existing.state === TILE_STATE.READY) {
      this.metrics.hits += 1;
      return existing;
    }
    if (this.inFlight.has(key)) {
      this.metrics.misses += 1;
      return this.inFlight.get(key);
    }

    this.metrics.misses += 1;
    const entry = { key, levelIndex, tileIndex, state: TILE_STATE.LOADING, value: null, attempts: 0 };
    this.entries.set(key, entry);

    const promise = (async () => {
      entry.attempts += 1;
      try {
        const value = await this.provider(levelIndex, tileIndex);
        if (value === null || value === undefined) throw new Error("Provider returned empty tile");
        entry.state = TILE_STATE.READY;
        entry.value = value;
        this.enforceLimit();
        return entry;
      } catch (error) {
        entry.state = TILE_STATE.FAILED;
        entry.error = error.message;
        this.metrics.failures += 1;
        this.notices.warn("TILE_FETCH_FAILED", "Waveform tile request failed; using coarse fallback", {
          key,
          reason: error.message
        });
        return entry;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  enforceLimit() {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestKey);
      if (oldest && oldest.state === TILE_STATE.LOADING) break;
      this.entries.delete(oldestKey);
      this.metrics.evictions += 1;
    }
  }
}
