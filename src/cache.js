// LRU tile cache with a byte budget, optional TTL invalidation and
// observable statistics (hits / misses / evictions / bytes).
export class TileCache {
  constructor({ budgetBytes, ttlMs = null } = {}) {
    this.budgetBytes = budgetBytes;
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> { value, bytes, storedAt }
    this.stats = { hits: 0, misses: 0, evictions: 0, invalidations: 0, sets: 0 };
  }

  _expired(entry, now) {
    return this.ttlMs != null && now - entry.storedAt > this.ttlMs;
  }

  get(key, now = Date.now()) {
    const entry = this.map.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    if (this._expired(entry, now)) {
      this.map.delete(key);
      this.stats.misses++;
      this.stats.invalidations++;
      return undefined;
    }
    // refresh LRU order
    this.map.delete(key);
    this.map.set(key, entry);
    this.stats.hits++;
    return entry.value;
  }

  peek(key, now = Date.now()) {
    const entry = this.map.get(key);
    if (!entry || this._expired(entry, now)) return undefined;
    return entry.value;
  }

  set(key, value, bytes, now = Date.now()) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, bytes, storedAt: now });
    this.stats.sets++;
    this._evict();
  }

  invalidate(key) {
    if (this.map.delete(key)) this.stats.invalidations++;
  }

  _evict() {
    while (this.bytesUsed() > this.budgetBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
      this.stats.evictions++;
    }
  }

  bytesUsed() {
    let total = 0;
    for (const entry of this.map.values()) total += entry.bytes;
    return total;
  }

  snapshot() {
    return {
      entries: this.map.size,
      bytesUsed: this.bytesUsed(),
      budgetBytes: this.budgetBytes,
      ...this.stats
    };
  }
}
