// Minimal DOM/canvas shim so the browser harness can execute under Node.
class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this._cls = new Set();
    this.width = 96;
    this.height = 96;
  }
  get classList() {
    const s = this._cls;
    return {
      add: (c) => s.add(c),
      toggle: (c, f) => (f ? s.add(c) : s.delete(c)),
      contains: (c) => s.has(c),
    };
  }
  set className(v) {
    this._cls = new Set(v.split(/\s+/).filter(Boolean));
  }
  append(...kids) {
    this.children.push(...kids);
  }
  getContext() {
    return {
      drawImage() {},
      putImageData() {},
      clearRect() {},
      fillRect() {},
      fillStyle: "",
      imageSmoothingEnabled: false,
    };
  }
}
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};
globalThis.document = {
  createElement: (t) => new El(t),
  getElementById: () => {
    throw new Error("no real element in shim");
  },
};
globalThis.performance = {
  now: () => Number(process.hrtime.bigint() / 1000n),
  getEntriesByType: () => [],
};
