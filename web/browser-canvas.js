// 真实 Canvas 2D 适配层：补齐渲染器用到的 ellipse(x,y,rx,ry) 签名
export function createBrowserCanvas(width, height, background) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const raw = canvas.getContext('2d');
  const adapter = new CanvasAdapter(raw, width, height, background);
  return {
    width,
    height,
    canvas,
    getContext() {
      return adapter;
    },
  };
}

class CanvasAdapter {
  constructor(ctx, width, height, background) {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
    this.drawLog = [];
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
  }

  set fillStyle(value) {
    this.ctx.fillStyle = value;
  }

  get fillStyle() {
    return this.ctx.fillStyle;
  }

  set globalAlpha(value) {
    this.ctx.globalAlpha = value;
  }

  get globalAlpha() {
    return this.ctx.globalAlpha;
  }

  setTransform(...args) {
    this.ctx.setTransform(...args);
  }

 resetTransform() {
    this.ctx.resetTransform();
  }

  translate(x, y) {
    this.ctx.translate(x, y);
  }

  rotate(r) {
    this.ctx.rotate(r);
  }

  scale(x, y) {
    this.ctx.scale(x, y);
  }

  save() {
    this.ctx.save();
  }

  restore() {
    this.ctx.restore();
  }

  beginPath() {
    this.ctx.beginPath();
  }

  rect(x, y, w, h) {
    this.ctx.rect(x, y, w, h);
  }

  fillRect(x, y, w, h) {
    this.ctx.fillRect(x, y, w, h);
  }

  ellipse(cx, cy, rx, ry) {
    this.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  }

  clip() {
    this.ctx.clip();
  }

  fill(style) {
    if (style) this.ctx.fillStyle = style;
    this.ctx.fill();
    this.drawLog.push({ op: 'fill', color: this.ctx.fillStyle });
  }
}
