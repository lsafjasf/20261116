/**
 * Minimal, deterministic CanvasRenderingContext2D-compatible surface backed by
 * an RGBA pixel buffer. In Node this gives exact pixel equality tests; in a
 * browser the real canvas context implements the same subset of calls, so the
 * renderer code is identical in both environments.
 */

const NAMED_COLORS = {
  transparent: [0, 0, 0, 0],
  "#0b1020": [11, 16, 32, 255],
  "#38bdf8": [56, 189, 248, 255],
  "#f472b6": [244, 114, 182, 255],
  "#facc15": [250, 204, 21, 255],
  "#f8fafc": [248, 250, 252, 255],
  "#94a3b8": [148, 163, 184, 255],
  "#1e293b": [30, 41, 59, 255]
};

export function parseColor(color) {
  if (Array.isArray(color)) return color;
  if (NAMED_COLORS[color]) return NAMED_COLORS[color];
  const hex = color.replace("#", "");
  if (hex.length === 6) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
      255
    ];
  }
  if (hex.length === 8) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
      parseInt(hex.slice(6, 8), 16)
    ];
  }
  throw new Error(`Unsupported color: ${color}`);
}

export class Framebuffer {
  constructor(width, height, background = "#0b1020") {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error("Framebuffer dimensions must be positive integers");
    }
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
    this.clear(background);
  }

  clear(color) {
    const [r, g, b, a] = parseColor(color);
    for (let offset = 0; offset < this.pixels.length; offset += 4) {
      this.pixels[offset] = r;
      this.pixels[offset + 1] = g;
      this.pixels[offset + 2] = b;
      this.pixels[offset + 3] = a;
    }
  }

  setPixel(x, y, color) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const [r, g, b, a] = parseColor(color);
    const offset = (y * this.width + x) * 4;
    if (a === 255) {
      this.pixels[offset] = r;
      this.pixels[offset + 1] = g;
      this.pixels[offset + 2] = b;
      this.pixels[offset + 3] = 255;
      return;
    }
    const inv = (255 - a) / 255;
    this.pixels[offset] = r * (a / 255) + this.pixels[offset] * inv;
    this.pixels[offset + 1] = g * (a / 255) + this.pixels[offset + 1] * inv;
    this.pixels[offset + 2] = b * (a / 255) + this.pixels[offset + 2] * inv;
    this.pixels[offset + 3] = Math.max(this.pixels[offset + 3], a);
  }

  fillRect(x, y, rectWidth, rectHeight, color) {
    const x0 = Math.max(0, Math.ceil(x));
    const y0 = Math.max(0, Math.ceil(y));
    const x1 = Math.min(this.width, Math.floor(x + rectWidth));
    const y1 = Math.min(this.height, Math.floor(y + rectHeight));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        this.setPixel(px, py, color);
      }
    }
  }

  /** Exact-content hash (FNV-1a over RGBA) for reload/export equality. */
  hash() {
    let hash = 2166136261 >>> 0;
    for (let offset = 0; offset < this.pixels.length; offset += 1) {
      hash ^= this.pixels[offset];
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  differenceCount(other) {
    if (other.width !== this.width || other.height !== this.height) return -1;
    let differences = 0;
    for (let offset = 0; offset < this.pixels.length; offset += 4) {
      if (
        this.pixels[offset] !== other.pixels[offset] ||
        this.pixels[offset + 1] !== other.pixels[offset + 1] ||
        this.pixels[offset + 2] !== other.pixels[offset + 2] ||
        this.pixels[offset + 3] !== other.pixels[offset + 3]
      ) {
        differences += 1;
      }
    }
    return differences;
  }

  clone() {
    const copy = new Framebuffer(this.width, this.height, "transparent");
    copy.pixels.set(this.pixels);
    return copy;
  }
}

/** Context adapter exposing the CanvasRenderingContext2D subset the renderer uses. */
export class Canvas2DAdapter {
  constructor(framebuffer) {
    this.framebuffer = framebuffer;
    this.fillStyle = "#000000";
    this.strokeStyle = "#000000";
    this.lineWidth = 1;
    this.drawStats = { fills: 0, strokes: 0, lines: 0 };
  }

  fillRect(x, y, width, height) {
    this.framebuffer.fillRect(x, y, width, height, this.fillStyle);
    this.drawStats.fills += 1;
  }

  beginPath() {}

  moveTo() {}

  lineTo() {}

  stroke() {
    this.drawStats.strokes += 1;
  }

  /** Pixel-exact alternative used instead of stroked paths. */
  drawLine(x0, y0, x1, y1, color = this.strokeStyle) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let step = 0; step <= steps; step += 1) {
      const x = Math.round(x0 + ((x1 - x0) * step) / steps);
      const y = Math.round(y0 + ((y1 - y0) * step) / steps);
      this.framebuffer.setPixel(x, y, color);
    }
    this.drawStats.lines += 1;
  }
}
