// Deterministic, seedable PRNG (mulberry32) so offline renders are reproducible.
export class Rng {
  constructor(seed = 1) {
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Probability gate, e.g. density 0.7 fires ~70% of the time.
  chance(p) {
    return this.next() < p;
  }
}
