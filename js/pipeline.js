/*
 * pipeline.js — 图像处理链核心：色阶 / 模糊 / 噪点 / 色调映射
 * 纯函数 + 分块异步调度器。浏览器与 Node 均可加载（挂到 globalThis.PipelineCore）。
 * 所有算子对“行带 [y0,y1)”写入 dst、读取完整 src，因此分块结果与整图单次计算逐像素一致。
 */
(function (global) {
  'use strict';

  // ---------- 确定性随机：仅依赖像素坐标与种子，与分块顺序无关 ----------
  function pixelHash(x, y, seed) {
    var h = (Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(seed, 0xcb1ab31f)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    return h >>> 0;
  }

  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  // ---------- 算子：色阶 ----------
  // params: { inBlack, inWhite, gamma, outBlack, outWhite }
  function makeLevelsLut(p) {
    var lut = new Uint8ClampedArray(256);
    var inB = Math.min(254, Math.max(0, p.inBlack));
    var inW = Math.max(inB + 1, Math.min(255, p.inWhite));
    var gamma = Math.max(0.05, p.gamma || 1);
    var outB = Math.max(0, Math.min(255, p.outBlack));
    var outW = Math.max(0, Math.min(255, p.outWhite));
    for (var i = 0; i < 256; i++) {
      var t = (i - inB) / (inW - inB);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      t = Math.pow(t, 1 / gamma);
      lut[i] = clamp255(Math.round(outB + t * (outW - outB)));
    }
    return lut;
  }

  function applyLevels(src, dst, w, y0, y1, params) {
    var lut = makeLevelsLut(params);
    for (var y = y0; y < y1; y++) {
      var row = y * w * 4;
      for (var x = 0; x < w; x++) {
        var i = row + x * 4;
        dst[i] = lut[src[i]];
        dst[i + 1] = lut[src[i + 1]];
        dst[i + 2] = lut[src[i + 2]];
        dst[i + 3] = 255;
      }
    }
  }

  // ---------- 算子：可分离盒式模糊（边缘钳制） ----------
  // tmp 为与图像等大的临时缓冲。调用方需保证 tmp 在 [y0,y1) 的垂直 halo 行有效，
  // 即水平 pass 覆盖 [y0-r, y1+r)（钳制到图像内），垂直 pass 只写 [y0,y1)。
  function applyBlur(src, tmp, dst, w, h, y0, y1, params) {
    var r = Math.max(0, Math.round(params.radius || 0));
    var hy0 = Math.max(0, y0 - r), hy1 = Math.min(h, y1 + r);
    var x, y, c, i, acc, k, kc;
    var count = 2 * r + 1; // 钳制采样：窗口样本数恒定
    // 水平 pass：对扩展行带 [hy0,hy1) 做横向盒模糊，写入 tmp
    for (y = hy0; y < hy1; y++) {
      var rowBase = y * w * 4;
      for (c = 0; c < 3; c++) {
        acc = 0;
        for (k = -r; k <= r; k++) {
          kc = k < 0 ? 0 : k >= w ? w - 1 : k;
          acc += src[rowBase + kc * 4 + c];
        }
        for (x = 0; x < w; x++) {
          tmp[rowBase + x * 4 + c] = acc / count;
          var xOut = x - r, xIn = x + r + 1;
          var co = xOut < 0 ? 0 : xOut >= w ? w - 1 : xOut;
          var ci = xIn < 0 ? 0 : xIn >= w ? w - 1 : xIn;
          acc += src[rowBase + ci * 4 + c] - src[rowBase + co * 4 + c];
        }
      }
    }
    // 垂直 pass：仅写 [y0,y1)
    for (y = y0; y < y1; y++) {
      for (x = 0; x < w; x++) {
        for (c = 0; c < 3; c++) {
          acc = 0; count = 0;
          for (k = -r; k <= r; k++) {
            var yy = y + k;
            yy = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
            acc += tmp[yy * w * 4 + x * 4 + c]; count++;
          }
          dst[y * w * 4 + x * 4 + c] = acc / count;
        }
        dst[y * w * 4 + x * 4 + 3] = 255;
      }
    }
  }
  // ---------- 算子：噪点（确定性，逐像素哈希，分块顺序无关） ----------
  // params: { amount (0..128), seed, mono }
  function applyNoise(src, dst, w, y0, y1, params) {
    var amount = Math.max(0, params.amount || 0);
    var seed = (params.seed || 1) | 0;
    var mono = !!params.mono;
    for (var y = y0; y < y1; y++) {
      for (var x = 0; x < w; x++) {
        var idx = y * w * 4 + x * 4;
        if (amount === 0) {
          dst[idx] = src[idx]; dst[idx + 1] = src[idx + 1]; dst[idx + 2] = src[idx + 2];
        } else if (mono) {
          var n = ((pixelHash(x, y, seed) & 0xffff) / 65535 - 0.5) * 2 * amount;
          dst[idx] = clamp255(src[idx] + n);
          dst[idx + 1] = clamp255(src[idx + 1] + n);
          dst[idx + 2] = clamp255(src[idx + 2] + n);
        } else {
          dst[idx] = clamp255(src[idx] + ((pixelHash(x, y, seed) & 0xffff) / 65535 - 0.5) * 2 * amount);
          dst[idx + 1] = clamp255(src[idx + 1] + ((pixelHash(x, y, seed + 1) & 0xffff) / 65535 - 0.5) * 2 * amount);
          dst[idx + 2] = clamp255(src[idx + 2] + ((pixelHash(x, y, seed + 2) & 0xffff) / 65535 - 0.5) * 2 * amount);
        }
        dst[idx + 3] = 255;
      }
    }
  }

  // ---------- 算子：色调映射 ----------
  // params: { exposure (0.05..4), operator: 'reinhard'|'exp'|'filmic' }
  function toneMapChannel(v, exposure, op) {
    var c = (v / 255) * exposure;
    var m;
    if (op === 'exp') m = 1 - Math.exp(-c);
    else if (op === 'filmic') m = (c * (1 + c * 0.6)) / (1 + c * 0.6 + c * c * 0.12) / 1.05;
    else m = c / (1 + c); // reinhard
    return clamp255(Math.round(m * 255));
  }

  function applyTonemap(src, dst, w, y0, y1, params) {
    var exposure = Math.max(0.05, params.exposure || 1);
    var op = params.operator || 'reinhard';
    var lut = new Uint8ClampedArray(256);
    for (var i = 0; i < 256; i++) lut[i] = toneMapChannel(i, exposure, op);
    for (var y = y0; y < y1; y++) {
      var row = y * w * 4;
      for (var x = 0; x < w; x++) {
        var j = row + x * 4;
        dst[j] = lut[src[j]];
        dst[j + 1] = lut[src[j + 1]];
        dst[j + 2] = lut[src[j + 2]];
        dst[j + 3] = 255;
      }
    }
  }

  // ---------- SHA-256 哈希（浏览器 crypto.subtle / Node globalThis.crypto 均可用） ----------
  async function hashPixels(u8) {
    var buf = await global.crypto.subtle.digest('SHA-256', u8);
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }
  // ---------- Runner：分块异步调度 + 节点级缓存 + 脏区域增量重算 ----------
  // nodes: [{ id, type:'levels'|'blur'|'noise'|'tonemap', enabled, params }]
  var OPS = { levels: applyLevels, blur: applyBlur, noise: applyNoise, tonemap: applyTonemap };

  function Runner(width, height, nodes, tileHeight) {
    this.w = width; this.h = height;
    this.tileH = tileHeight || 64;
    this.nodes = nodes;
    this.src = new Uint8ClampedArray(width * height * 4);
    // 每个节点一个输出缓存（全图大小），分配一次、复用，不因重算重建对象
    this.buffers = nodes.map(function () { return new Uint8ClampedArray(width * height * 4); });
    this.tmp = new Uint8ClampedArray(width * height * 4); // 模糊临时缓冲
    this.validCount = 0;        // 缓存有效的节点数（前 validCount 个节点输出有效）
    this.dirty = null;          // {x0,y0,x1,y1} 需要重算的区域，null 表示干净
    this.runToken = 0;          // 取消令牌
    // 统计计数器（测量面板用）
    this.stats = { tiles: 0, nodeRuns: 0, pixels: 0, longestBlockMs: 0, totalMs: 0, bufferAllocs: this.buffers.length + 2 };
  }

  Runner.prototype.setSource = function (u8) {
    this.src.set(u8);
    this.validCount = 0;
    this.dirty = { x0: 0, y0: 0, x1: this.w, y1: this.h };
  };

  // 下游模糊半径总和：脏区域需要外扩的量（用于局部编辑）
  Runner.prototype.blurHaloFrom = function (nodeIndex) {
    var halo = 0;
    for (var i = nodeIndex; i < this.nodes.length; i++) {
      var n = this.nodes[i];
      if (n.enabled && n.type === 'blur') halo += Math.max(0, Math.round(n.params.radius || 0));
    }
    return halo;
  };

  // 参数变化：仅从该节点起失效，并标记脏区域（默认全图；局部编辑传 rect）
  Runner.prototype.invalidateFrom = function (nodeIndex, rect) {
    if (nodeIndex < this.validCount) this.validCount = nodeIndex;
    var halo = this.blurHaloFrom(nodeIndex);
    var r = rect || { x0: 0, y0: 0, x1: this.w, y1: this.h };
    var d = {
      x0: Math.max(0, r.x0 - halo), y0: Math.max(0, r.y0 - halo),
      x1: Math.min(this.w, r.x1 + halo), y1: Math.min(this.h, r.y1 + halo)
    };
    if (!this.dirty) this.dirty = d;
    else this.dirty = {
      x0: Math.min(this.dirty.x0, d.x0), y0: Math.min(this.dirty.y0, d.y0),
      x1: Math.max(this.dirty.x1, d.x1), y1: Math.max(this.dirty.y1, d.y1)
    };
  };

  Runner.prototype.nodeInput = function (i) {
    return i === 0 ? this.src : this.buffers[i - 1];
  };

  // 对单个节点 i 的行带 [y0,y1) 计算
  Runner.prototype.processNodeBand = function (i, y0, y1) {
    var n = this.nodes[i];
    var input = this.nodeInput(i);
    var out = this.buffers[i];
    if (!n.enabled) { // 停用节点：直通拷贝
      for (var y = y0; y < y1; y++) {
        var s = y * this.w * 4, e = s + this.w * 4;
        for (var j = s; j < e; j++) out[j] = input[j];
      }
    } else if (n.type === 'blur') {
      applyBlur(input, this.tmp, out, this.w, this.h, y0, y1, n.params);
    } else {
      OPS[n.type](input, out, this.w, y0, y1, n.params);
    }
    this.stats.nodeRuns++;
    this.stats.pixels += (y1 - y0) * this.w;
  };

  // 异步分块处理脏区域（节点主序：每个失效节点处理完全部行带再进入下一节点，
  // 保证模糊读取的上游缓冲在 halo 行内已有效）。onBand 在末节点完成每带后回调。
  Runner.prototype.process = async function (onBand, yieldFn) {
    var token = ++this.runToken;
    var dirty = this.dirty;
    this.stats.tiles = 0; this.stats.nodeRuns = 0; this.stats.pixels = 0;
    this.stats.longestBlockMs = 0; this.stats.totalMs = 0;
    if (!dirty) return { cancelled: false, clean: true };
    var startIndex = this.validCount;
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var bands = [];
    for (var y = dirty.y0; y < dirty.y1; y += this.tileH) {
      bands.push([y, Math.min(dirty.y1, y + this.tileH)]);
    }
    this.stats.tiles = bands.length;
    var lastNode = this.nodes.length - 1;
    for (var i = startIndex; i <= lastNode; i++) {
      for (var b = 0; b < bands.length; b++) {
        var b0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        this.processNodeBand(i, bands[b][0], bands[b][1]);
        var b1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (b1 - b0 > this.stats.longestBlockMs) this.stats.longestBlockMs = b1 - b0;
        if (i === lastNode && onBand) {
          onBand(dirty.x0, bands[b][0], dirty.x1, bands[b][1], this.buffers[lastNode], this.w);
        }
        if (yieldFn) await yieldFn(); // 让出事件循环，保持交互流畅
        if (token !== this.runToken) return { cancelled: true };
      }
    }
    this.validCount = this.nodes.length;
    this.dirty = null;
    var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.totalMs = t1 - t0;
    return { cancelled: false, fromNode: startIndex };
  };

  Runner.prototype.finalBuffer = function () {
    return this.buffers[this.nodes.length - 1];
  };

  global.PipelineCore = global.PipelineCore || {};
  var PC = global.PipelineCore;
  PC.pixelHash = pixelHash;
  PC.applyLevels = applyLevels;
  PC.applyBlur = applyBlur;
  PC.applyNoise = applyNoise;
  PC.applyTonemap = applyTonemap;
  PC.clamp255 = clamp255;
  PC.hashPixels = hashPixels;
  PC.Runner = Runner;
  PC.OPS = OPS;
})(typeof self !== 'undefined' ? self : globalThis);
