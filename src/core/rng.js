// mulberry32：确定性伪随机数发生器，状态仅为一个 32 位整数，便于序列化与回放。
export function mulberry32(seed) {
  let state = seed >>> 0;
  return {
    next() {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    get state() {
      return state >>> 0;
    },
    set state(value) {
      state = value >>> 0;
    },
  };
}

export function hash32(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
