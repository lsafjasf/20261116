import { identity, invert, applyPoint, multiply } from '../core/math.js';

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new TypeError(`颜色格式错误: ${hex}`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersect =
      pi.y > y !== pj.y > y &&
      x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function ellipsePolygon(cx, cy, rx, ry, segments = 48) {
  const pts = [];
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return pts;
}

export class VirtualContext {
  constructor(width, height, background = null) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
    if (background) this.fillBackground(background);
    this.transform = identity();
    this.globalAlpha = 1;
    this.path = [];
    this.clipStack = [];
    this.stateStack = [];
    this.drawLog = [];
    this._pendingFill = null;
  }

  set fillStyle(value) {
    this._pendingFill = value;
  }

  get fillStyle() {
    return this._pendingFill;
  }

  fillBackground(hex) {
    const { r, g, b } = hexToRgb(hex);
    for (let i = 0; i < this.width * this.height; i += 1) {
      this.pixels.set([r, g, b, 255], i * 4);
    }
  }

  setTransform(a, b, c, d, e, f) {
    this.transform = { a, b, c, d, e, f };
  }

  resetTransform() {
    this.transform = identity();
  }

  translate(x, y) {
    this.transform = multiply(this.transform, {
      a: 1, b: 0, c: 0, d: 1, e: x, f: y,
    });
  }

  rotate(rad) {
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    this.transform = multiply(this.transform, {
      a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0,
    });
  }

  scale(sx, sy) {
    this.transform = multiply(this.transform, {
      a: sx, b: 0, c: 0, d: sy, e: 0, f: 0,
    });
  }

  save() {
    this.stateStack.push({
      transform: { ...this.transform },
      globalAlpha: this.globalAlpha,
      fillStyle: this._pendingFill,
      clipStack: this.clipStack.length,
      path: this.path.map((p) => p.map((v) => ({ ...v }))),
    });
  }

  restore() {
    const state = this.stateStack.pop();
    if (!state) return;
    this.transform = state.transform;
    this.globalAlpha = state.globalAlpha;
    this._pendingFill = state.fillStyle;
    this.clipStack.length = state.clipStack;
    this.path = state.path;
  }

  beginPath() {
    this.path = [];
  }

 rect(x, y, w, h) {
    this.path.push([
      { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
    ]);
  }

  fillRect(x, y, w, h) {
    this.beginPath();
    this.rect(x, y, w, h);
    this.fill();
  }

  ellipse(cx, cy, rx, ry) {
    if (rx < 0 || ry < 0) throw new RangeError('椭圆半径不能为负');
    this.path.push(ellipsePolygon(cx, cy, rx, ry));
  }

  clip() {
    const poly = this.path[this.path.length - 1];
    if (!poly) throw new Error('clip 前必须先构建路径');
    this.clipStack.push({ polygon: poly, transform: { ...this.transform } });
  }

  insideClip(localX, localY) {
    if (this.clipStack.length === 0) return true;
    return this.clipStack.every(({ polygon, transform }) => {
      const world = applyPoint(this.transform, localX, localY);
      const local = applyPoint(invert(transform), world.x, world.y);
      return pointInPolygon(local.x, local.y, polygon);
    });
  }

  fill(style) {
    const color = style ?? this._pendingFill;
    if (!color) throw new Error('fill 缺少颜色');
    const { r, g, b } = hexToRgb(color);
    const alpha = Math.max(0, Math.min(1, this.globalAlpha));
    const polygons = this.path;
    if (polygons.length === 0) return;
    const inv = invert(this.transform);
    const corners = polygons.flat();
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const w0 = applyPoint(this.transform, Math.min(...xs), Math.min(...ys));
    const w1 = applyPoint(this.transform, Math.max(...xs), Math.max(...ys));
    const minX = Math.max(0, Math.floor(Math.min(w0.x, w1.x)));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(w0.x, w1.x)));
    const minY = Math.max(0, Math.floor(Math.min(w0.y, w1.y)));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(w0.y, w1.y)));
    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const local = applyPoint(inv, px + 0.5, py + 0.5);
        const hit = polygons.some((poly) => pointInPolygon(local.x, local.y, poly));
        if (!hit || !this.insideClip(local.x, local.y)) continue;
        this.blendPixel(px, py, r, g, b, alpha);
      }
    }
    this.drawLog.push({ op: 'fill', color, transform: { ...this.transform }, alpha });
    this.path = [];
  }

  blendPixel(x, y, r, g, b, alpha) {
    const i = (y * this.width + x) * 4;
    const dstA = this.pixels[i + 3] / 255;
    const srcA = alpha;
    const outA = srcA + dstA * (1 - srcA);
    if (outA === 0) return;
    const blend = (src, dst) => (src * srcA + dst * dstA * (1 - srcA)) / outA;
    this.pixels[i] = blend(r, this.pixels[i]);
    this.pixels[i + 1] = blend(g, this.pixels[i + 1]);
    this.pixels[i + 2] = blend(b, this.pixels[i + 2]);
    this.pixels[i + 3] = outA * 255;
  }

  getPixel(x, y) {
    const i = (y * this.width + x) * 4;
    return [
      this.pixels[i], this.pixels[i + 1], this.pixels[i + 2], this.pixels[i + 3],
    ];
  }

  // 统计与给定颜色近似的像素数量（容差用于抗锯齿/混合边界）
  countColor(hex, tolerance = 8) {
    const { r, g, b } = hexToRgb(hex);
    let count = 0;
    for (let i = 0; i < this.width * this.height; i += 1) {
      const o = i * 4;
      if (this.pixels[o + 3] === 0) continue;
      if (
        Math.abs(this.pixels[o] - r) <= tolerance &&
        Math.abs(this.pixels[o + 1] - g) <= tolerance &&
        Math.abs(this.pixels[o + 2] - b) <= tolerance
      ) {
        count += 1;
      }
    }
    return count;
  }
}

export function createVirtualCanvas(width, height, background) {
  return {
    width,
    height,
    getContext() {
      return new VirtualContext(width, height, background);
    },
  };
}
