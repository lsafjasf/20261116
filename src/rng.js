function mix32(value) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

export function normalizeSeed(input) {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input >>> 0;
  }
  const text = String(input ?? "");
  if (/^\d+$/.test(text.trim())) {
    return Number(text.trim()) >>> 0;
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return mix32(hash);
}

export class RNG {
  constructor(seed) {
    this.state = normalizeSeed(seed);
  }

  nextU32() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    return mix32(this.state);
  }

  next() {
    return this.nextU32() / 0x100000000;
  }

  between(min, max) {
    return min + (max - min) * this.next();
  }

  int(min, max) {
    return Math.floor(this.between(min, max + 1));
  }

  pick(items) {
    return items[this.int(0, items.length - 1)];
  }

  clone() {
    const copy = new RNG(0);
    copy.state = this.state;
    return copy;
  }
}

export function stableHash(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + index;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  h1 ^= text.length;
  h2 ^= text.length;
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

export function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
