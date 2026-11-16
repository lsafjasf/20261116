/**
 * Deterministic, seedable pseudo-random number generation.
 * mulberry32 is tiny, fast and fully deterministic across JS engines
 * for a given 32-bit seed, which keeps every test run repeatable.
 */

/** Hash a string seed into an unsigned 32-bit integer. */
export function hashSeed(input) {
  const text = String(input);
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Create a mulberry32 generator returning floats in [0, 1). */
export function createRng(seed) {
  let state = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic sine-based oscillator sample in [-1, 1]. */
export function sineSample(timeSeconds, frequencyHertz, phase = 0) {
  return Math.sin(2 * Math.PI * frequencyHertz * timeSeconds + phase);
}
