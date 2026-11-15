export class SpatialIndex {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }

  _key(cx, cy) {
    return `${cx},${cy}`;
  }

  _forEachCell(rect, callback) {
    const size = this.cellSize;
    const x0 = Math.floor(rect.x / size);
    const y0 = Math.floor(rect.y / size);
    const x1 = Math.floor((rect.x + rect.w - 0.0001) / size);
    const y1 = Math.floor((rect.y + rect.h - 0.0001) / size);
    for (let cy = y0; cy <= y1; cy += 1) {
      for (let cx = x0; cx <= x1; cx += 1) {
        callback(this._key(cx, cy));
      }
    }
  }

  insert(item, bounds) {
    const keys = [];
    this._forEachCell(bounds, (key) => {
      let bucket = this.cells.get(key);
      if (!bucket) {
        bucket = new Set();
        this.cells.set(key, bucket);
      }
      bucket.add(item);
      keys.push(key);
    });
    item._spatialKeys = keys;
  }

  remove(item) {
    for (const key of item._spatialKeys || []) {
      const bucket = this.cells.get(key);
      if (!bucket) continue;
      bucket.delete(item);
      if (bucket.size === 0) this.cells.delete(key);
    }
    item._spatialKeys = [];
  }

  update(item, bounds) {
    this.remove(item);
    this.insert(item, bounds);
  }

  query(rect) {
    const found = new Map();
    this._forEachCell(rect, (key) => {
      const bucket = this.cells.get(key);
      if (!bucket) return;
      for (const item of bucket) found.set(item.id, item);
    });
    return [...found.values()];
  }

  clear() {
    this.cells.clear();
  }
}
