// Deterministic scene definitions. Both optimized and naive paths consume the
// exact same config objects, so rendered output semantics cannot diverge.

export const SCENE_LIBRARY = [
  { id: 'pad',     oscType: 'sine',     freq: 220,  delay: 0.25, gain: 0.22, voices: 2 },
  { id: 'pluck',   oscType: 'triangle', freq: 330,  delay: 0.12, gain: 0.18, voices: 3 },
  { id: 'arpeggio', oscType: 'square',  freq: 440,  delay: 0.30, gain: 0.12, voices: 4 },
  { id: 'bass',    oscType: 'sawtooth', freq: 110,  delay: 0.40, gain: 0.20, voices: 2 },
  { id: 'bell',    oscType: 'sine',     freq: 660,  delay: 0.18, gain: 0.16, voices: 3 },
];

// Tiny size-bounded LRU cache for resolved scene configurations.
export class SceneConfigCache {
  constructor(capacity) {
    this.capacity = Math.max(1, capacity);
    this._map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key, resolver) {
    if (this._map.has(key)) {
      const value = this._map.get(key);
      this._map.delete(key);
      this._map.set(key, value);
      this.hits += 1;
      return { value, hit: true };
    }
    const value = resolver();
    this.misses += 1;
    this._map.set(key, value);
    if (this._map.size > this.capacity) {
      const oldestKey = this._map.keys().next().value;
      this._map.delete(oldestKey);
    }
    return { value, hit: false };
  }

  get hitRate() {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }
}

// Boundary scenario: degenerate inputs that the engine must tolerate without
// leaks or uncaught exceptions.
export const BOUNDARY_LIBRARY = [
  { id: 'zero-voices', oscType: 'sine',     freq: 440, delay: 0.1, gain: 0.2, voices: 0 },
  { id: 'null-type',    oscType: undefined,  freq: 0,   delay: 0,   gain: 0,   voices: 1 },
  { id: 'heavy',        oscType: 'sawtooth', freq: 55,  delay: 0.5, gain: 0.05, voices: 12 },
];

export function resolveConfig(raw) {
  return {
    id: raw.id,
    oscType: raw.oscType ?? 'sine',
    freq: Number.isFinite(raw.freq) && raw.freq > 0 ? raw.freq : 440,
    delay: Number.isFinite(raw.delay) && raw.delay >= 0 ? raw.delay : 0.1,
    gain: Number.isFinite(raw.gain) && raw.gain >= 0 && raw.gain <= 1 ? raw.gain : 0.2,
    voices: Number.isInteger(raw.voices) && raw.voices >= 0 ? raw.voices : 1,
  };
}
