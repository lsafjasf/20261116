/* Deterministic PRNG utilities (mulberry32) shared by engine and tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AudioDiag = Object.assign(root.AudioDiag || {}, api);
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(rng, arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function mixSeed32(n) {
    let x = (n >>> 0) ^ 0x9e3779b9;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
    return (x ^ (x >>> 16)) >>> 0;
  }

  /* Integer hash -> [-1, 1], used for deterministic rough-noise envelopes. */
  function noise2(a, b) {
    let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return ((h >>> 0) / 4294967296) * 2 - 1;
  }

  return { mulberry32, shuffle, mixSeed32, noise2 };
});
