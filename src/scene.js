// Scene graph + hit testing + metrics. Pure logic, no DOM.

export function makeNodes(count, width, height) {
  const nodes = [];
  for (let i = 0; i < count; i += 1) {
    const w = 8 + (i % 7) * 3;
    const h = 8 + (i % 5) * 4;
    nodes.push({
      id: i,
      x: (i * 37.13) % Math.max(1, width - w),
      y: (i * 53.77) % Math.max(1, height - h),
      w,
      h,
    });
  }
  return nodes;
}

function nodeContains(node, x, y) {
  return x >= node.x && x <= node.x + node.w && y >= node.y && y <= node.y + node.h;
}

// "Before" implementation: scans every node on every query.
export class NaiveHitTester {
  constructor(nodes) {
    this.nodes = nodes;
    this.lastCandidates = 0;
  }
  hitTest(x, y) {
    this.lastCandidates = 0;
    for (let i = this.nodes.length - 1; i >= 0; i -= 1) {
      this.lastCandidates += 1;
      if (nodeContains(this.nodes[i], x, y)) return this.nodes[i];
    }
    return null;
  }
}

// "After" implementation: uniform grid, same semantics (topmost = highest id).
export class GridHitTester {
  constructor(nodes, width, height, cellSize = 32) {
    this.nodes = nodes;
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(width / cellSize));
    this.rows = Math.max(1, Math.ceil(height / cellSize));
    this.cells = new Map();
    this.lastCandidates = 0;
    nodes.forEach((node, index) => {
      const c0 = Math.max(0, Math.floor(node.x / cellSize));
      const c1 = Math.min(this.cols - 1, Math.floor((node.x + node.w) / cellSize));
      const r0 = Math.max(0, Math.floor(node.y / cellSize));
      const r1 = Math.min(this.rows - 1, Math.floor((node.y + node.h) / cellSize));
      for (let r = r0; r <= r1; r += 1) {
        for (let c = c0; c <= c1; c += 1) {
          const key = r * this.cols + c;
          if (!this.cells.has(key)) this.cells.set(key, []);
          this.cells.get(key).push(index);
        }
      }
    });
  }
  hitTest(x, y) {
    this.lastCandidates = 0;
    const c = Math.floor(x / this.cellSize);
    const r = Math.floor(y / this.cellSize);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return null;
    const bucket = this.cells.get(r * this.cols + c);
    if (!bucket) return null;
    for (let i = bucket.length - 1; i >= 0; i -= 1) {
      this.lastCandidates += 1;
      const node = this.nodes[bucket[i]];
      if (nodeContains(node, x, y)) return node;
    }
    return null;
  }
}

// Observable metrics: frame time (EMA), candidate count, cache hit rate,
// node count. Snapshot is what the HUD shows and what tests compare.
export class Metrics {
  constructor() {
    this.frameMs = 0;
    this.frames = 0;
    this.candidates = 0;
    this.cacheHitRate = 0;
    this.nodeCount = 0;
  }
  recordFrame(ms) {
    this.frames += 1;
    this.frameMs = this.frames === 1 ? ms : this.frameMs * 0.9 + ms * 0.1;
  }
  snapshot() {
    return {
      frameMs: Number(this.frameMs.toFixed(3)),
      candidates: this.candidates,
      cacheHitRate: Number(this.cacheHitRate.toFixed(3)),
      nodeCount: this.nodeCount,
    };
  }
}
