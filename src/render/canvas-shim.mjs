import zlib from 'node:zlib';

// Minimal 2D-context shim over an RGBA framebuffer. It implements only the
// calls used by renderer.mjs, so the same renderer produces real PNG frames
// in Node without a browser.
export function createCanvas(width, height) {
  const frame = new Uint8ClampedArray(width * height * 4);
  const ctx = createContext(width, height, frame);
  return {
    width,
    height,
    getContext: () => ctx,
    toBuffer: () => encodePng(width, height, frame),
  };
}

function createContext(width, height, frame) {
  const stack = [];
  const ctx = {
    canvas: { width, height },
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    font: '12px sans-serif',
    _dash: [],
    setLineDash(d) { this._dash = d; },
    save() { stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, font: this.font }); },
    restore() { Object.assign(this, stack.pop() || {}); },
    translate() {},
    rotate() {},
    fillRect(x, y, w, h) {
      const c = parseColor(this.fillStyle);
      rect(frame, width, height, x, y, w, h, c);
    },
    strokeRect(x, y, w, h) {
      const c = parseColor(this.strokeStyle);
      rect(frame, width, height, x, y, w, Math.max(1, this.lineWidth), c);
      rect(frame, width, height, x, y + h - this.lineWidth, w, Math.max(1, this.lineWidth), c);
      rect(frame, width, height, x, y, Math.max(1, this.lineWidth), h, c);
      rect(frame, width, height, x + w - this.lineWidth, y, Math.max(1, this.lineWidth), h, c);
    },
    beginPath() { this._path = []; },
    moveTo(x, y) { this._path.push({ x, y }); this._cur = { x, y }; },
    lineTo(x, y) { this._path.push({ x, y }); this._cur = { x, y }; },
    arc(cx, cy, r, a0, a1) {
      const steps = Math.max(10, Math.ceil((a1 - a0) * r));
      for (let i = 0; i <= steps; i += 1) {
        const a = a0 + ((a1 - a0) * i) / steps;
        const p = { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
        if (i === 0) this.moveTo(p.x, p.y);
        else this.lineTo(p.x, p.y);
      }
    },
    fill() {
      const c = parseColor(this.fillStyle);
      fillPath(frame, width, height, this._path, c);
    },
    stroke() {
      const c = parseColor(this.strokeStyle);
      const pts = this._path || [];
      for (let i = 1; i < pts.length; i += 1) {
        line(frame, width, height, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, Math.max(1, this.lineWidth), c);
      }
    },
    fillText(text, x, y) {
      drawText(frame, width, height, String(text), x, y, parseColor(this.fillStyle));
    },
    createLinearGradient() {
      return {
        _color: [23, 62, 85, 255],
        addColorStop(_pos, color) { if (this._color === null) this._color = parseColor(color); },
      };
    },
  };
  // Gradients fall back to the first solid stop for simplicity.
  const origFill = Object.getOwnPropertyDescriptor(ctx, 'fillStyle');
  void origFill;
  return ctx;
}

function parseColor(style) {
  if (style && style._color) return style._color;
  if (typeof style !== 'string') return [0, 0, 0, 255];
  let m = style.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  m = style.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((s) => s.trim());
    const a = p[3] === undefined ? 255 : Math.round(Number(p[3]) * 255);
    return [Number(p[0]), Number(p[1]), Number(p[2]), a];
  }
  return [0, 0, 0, 255];
}

function blend(frame, W, H, x, y, c) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= W || py >= H) return;
  const i = (py * W + px) * 4;
  const alpha = c[3] / 255;
  frame[i] = frame[i] * (1 - alpha) + c[0] * alpha;
  frame[i + 1] = frame[i + 1] * (1 - alpha) + c[1] * alpha;
  frame[i + 2] = frame[i + 2] * (1 - alpha) + c[2] * alpha;
  frame[i + 3] = Math.max(frame[i + 3], c[3]);
}

function rect(frame, W, H, x, y, w, h, c) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(W, Math.round(x + w));
  const y1 = Math.min(H, Math.round(y + h));
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) blend(frame, W, H, xx, yy, c);
  }
}

function line(frame, W, H, x0, y0, x1, y1, width, c) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  const r = (width - 1) / 2;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    for (let ox = -r; ox <= r; ox += 1) {
      for (let oy = -r; oy <= r; oy += 1) blend(frame, W, H, x + ox, y + oy, c);
    }
  }
}

function fillPath(frame, W, H, pts, c) {
  if (!pts || pts.length < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  for (let y = Math.round(minY); y <= Math.round(maxY); y += 1) {
    const xs = [];
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.round(xs[i]); x <= Math.round(xs[i + 1]); x += 1) blend(frame, W, H, x, y, c);
    }
  }
}

// 5x7 bitmap font, just enough for HUD digits/labels.
const FONT = {
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','11110','00001','00001','10001','01110'],
  '6': ['00110','01000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00010','01100'],
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
  '.': ['00000','00000','00000','00000','00000','01100','01100'],
  ':': ['00000','01100','01100','00000','01100','01100','00000'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
  '%': ['11001','11010','00100','00100','01000','10110','10011'],
  '/': ['00001','00010','00100','01000','10000','00000','00000'],
  _: ['00000','00000','00000','00000','00000','00000','11111'],
};

function drawText(frame, W, H, text, x, y, c) {
  let cursor = Math.round(x);
  const baseY = Math.round(y) - 7;
  for (const ch of text) {
    const glyph = FONT[ch] || FONT._;
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (glyph[row][col] === '1') blend(frame, W, H, cursor + col, baseY + row, c);
      }
    }
    cursor += 6;
  }
}

function encodePng(width, height, frame) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(frame.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const deflated = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.concat([
      u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0]),
    ])),
    chunk('IDAT', deflated),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = u32(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0, 0);
  return b;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
