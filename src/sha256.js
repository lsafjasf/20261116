/* Incremental SHA-256. Works in browsers, workers and Node (no deps). */
(function (global) {
  "use strict";

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function Sha256() {
    this._h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    this._buf = new Uint8Array(64);
    this._bufLen = 0;
    this._total = 0;
    this._w = new Int32Array(64);
  }

  Sha256.prototype._block = function (block, offset) {
    var w = this._w;
    for (var i = 0; i < 16; i++) {
      var j = offset + i * 4;
      w[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
    }
    for (var t = 16; t < 64; t++) {
      var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    var a = this._h[0], b = this._h[1], c = this._h[2], d = this._h[3];
    var e = this._h[4], f = this._h[5], g = this._h[6], h = this._h[7];
    for (var r = 0; r < 64; r++) {
      var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + K[r] + w[r]) | 0;
      var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    this._h[0] = (this._h[0] + a) | 0;
    this._h[1] = (this._h[1] + b) | 0;
    this._h[2] = (this._h[2] + c) | 0;
    this._h[3] = (this._h[3] + d) | 0;
    this._h[4] = (this._h[4] + e) | 0;
    this._h[5] = (this._h[5] + f) | 0;
    this._h[6] = (this._h[6] + g) | 0;
    this._h[7] = (this._h[7] + h) | 0;
  };

  Sha256.prototype.update = function (data) {
    if (typeof data === "string") {
      data = new TextEncoder().encode(data);
    }
    this._total += data.length;
    var pos = 0;
    if (this._bufLen > 0) {
      while (this._bufLen < 64 && pos < data.length) {
        this._buf[this._bufLen++] = data[pos++];
      }
      if (this._bufLen === 64) {
        this._block(this._buf, 0);
        this._bufLen = 0;
      }
    }
    while (pos + 64 <= data.length) {
      this._block(data, pos);
      pos += 64;
    }
    while (pos < data.length) {
      this._buf[this._bufLen++] = data[pos++];
    }
    return this;
  };

  Sha256.prototype.digestHex = function () {
    var bitLenHi = Math.floor(this._total / 0x20000000);
    var bitLenLo = (this._total << 3) >>> 0;
    this._buf[this._bufLen++] = 0x80;
    if (this._bufLen > 56) {
      while (this._bufLen < 64) this._buf[this._bufLen++] = 0;
      this._block(this._buf, 0);
      this._bufLen = 0;
    }
    while (this._bufLen < 56) this._buf[this._bufLen++] = 0;
    this._buf[this._bufLen++] = (bitLenHi >>> 24) & 0xff;
    this._buf[this._bufLen++] = (bitLenHi >>> 16) & 0xff;
    this._buf[this._bufLen++] = (bitLenHi >>> 8) & 0xff;
    this._buf[this._bufLen++] = bitLenHi & 0xff;
    this._buf[this._bufLen++] = (bitLenLo >>> 24) & 0xff;
    this._buf[this._bufLen++] = (bitLenLo >>> 16) & 0xff;
    this._buf[this._bufLen++] = (bitLenLo >>> 8) & 0xff;
    this._buf[this._bufLen++] = bitLenLo & 0xff;
    this._block(this._buf, 0);
    var out = "";
    for (var i = 0; i < 8; i++) {
      var hex = (this._h[i] >>> 0).toString(16);
      out += "00000000".slice(hex.length) + hex;
    }
    return out;
  };

  function sha256Hex(data) {
    return new Sha256().update(data).digestHex();
  }

  var api = { Sha256: Sha256, sha256Hex: sha256Hex };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.KfSha256 = api;
})(typeof self !== "undefined" ? self : globalThis);
