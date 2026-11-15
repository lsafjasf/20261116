/* 64-bit FNV-1a over canonical JSON: synchronous, deterministic, no deps. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AudioDiag = Object.assign(root.AudioDiag || {}, api);
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK64 = (1n << 64n) - 1n;

  function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }

  function fnv1a64(str) {
    let h = FNV_OFFSET;
    for (let i = 0; i < str.length; i++) {
      h ^= BigInt(str.charCodeAt(i));
      h = (h * FNV_PRIME) & MASK64;
    }
    return h.toString(16).padStart(16, '0');
  }

  function hashObject(obj) {
    return fnv1a64(canonical(obj));
  }

  return { canonical, fnv1a64, hashObject };
});
