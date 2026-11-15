/*
 * images.js — 程序生成测试图（不依赖外部资源，Node/浏览器通用）
 * 返回 { data: Uint8ClampedArray, width, height, name }
 */
(function (global) {
  'use strict';

  function makeImage(w, h, name, fill) {
    var data = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        var c = fill(x, y, w, h);
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
      }
    }
    return { data: data, width: w, height: h, name: name };
  }

  // 图 A：平滑渐变 + 圆形（普通场景：连续色调，考验色阶/色调映射）
  function genGradient(w, h) {
    return makeImage(w, h, 'gradient', function (x, y) {
      var nx = x / w, ny = y / h;
      var dx = nx - 0.62, dy = ny - 0.42;
      var d = Math.sqrt(dx * dx + dy * dy);
      var circle = Math.max(0, 1 - d * 3.2);
      return [
        Math.round(40 + 180 * nx + 60 * circle),
        Math.round(30 + 160 * ny + 80 * circle),
        Math.round(90 + 120 * (1 - nx) * ny + 40 * circle)
      ];
    });
  }

  // 图 B：棋盘格 + 锐利边缘（考验模糊与噪点的顺序敏感性）
  function genChecker(w, h) {
    return makeImage(w, h, 'checker', function (x, y) {
      var s = Math.max(4, Math.floor(w / 16));
      var on = ((Math.floor(x / s) + Math.floor(y / s)) % 2) === 0;
      var edge = x < w / 3 ? 255 : 0; // 一条硬垂直边
      var v = on ? 230 : 25;
      return [
        Math.min(255, v + (edge ? 20 : 0)),
        v,
        Math.min(255, (on ? 60 : 200) + (edge ? 30 : 0))
      ];
    });
  }

  // 图 C：径向高光 + 暗部（考验色调映射的曝光压缩）
  function genRadial(w, h) {
    return makeImage(w, h, 'radial', function (x, y) {
      var dx = x / w - 0.5, dy = y / h - 0.5;
      var d = Math.sqrt(dx * dx + dy * dy);
      var glow = Math.max(0, 1 - d * 1.8);
      return [
        Math.round(10 + 245 * glow * glow),
        Math.round(8 + 200 * glow),
        Math.round(20 + 160 * Math.sqrt(glow))
      ];
    });
  }

  // 边界场景：2x2 极小图
  function genTiny() {
    return makeImage(2, 2, 'tiny', function (x, y) {
      return x === 0 && y === 0 ? [255, 0, 0]
        : x === 1 && y === 0 ? [0, 255, 0]
        : x === 0 ? [0, 0, 255] : [255, 255, 255];
    });
  }

  var Generators = { gradient: genGradient, checker: genChecker, radial: genRadial, tiny: genTiny };

  global.TestImages = { generators: Generators, makeImage: makeImage };
})(typeof self !== 'undefined' ? self : globalThis);
