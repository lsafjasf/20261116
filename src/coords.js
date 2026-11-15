// Coordinate core: CSS size vs backing store vs devicePixelRatio.
// Pure logic, shared by the browser app and the Node test harness.

// Backing store must be an integer number of device pixels.
export function computeBackingSize(cssWidth, cssHeight, dpr) {
  const safeDpr = dpr > 0 ? dpr : 1;
  return {
    width: Math.max(1, Math.round(cssWidth * safeDpr)),
    height: Math.max(1, Math.round(cssHeight * safeDpr)),
    dpr: safeDpr,
  };
}

// Single source of truth: client (viewport) coords -> canvas-local CSS px.
// `rect` must come from canvas.getBoundingClientRect() (float, transform-aware).
export function clientToCanvas(clientX, clientY, rect) {
  return { x: clientX - rect.left, y: clientY - rect.top };
}

// Canvas-local CSS px -> device px (for direct backing-store access).
export function canvasToDevice(x, y, dpr) {
  return { x: x * dpr, y: y * dpr };
}

// Caches getBoundingClientRect() between invalidations (resize/scroll/
// fullscreen/DPR change). Exposes hit-rate so the UI can prove the cache
// works and the tests can prove semantics did not change.
export class RectCache {
  constructor(readRect) {
    this.readRect = readRect;
    this.rect = null;
    this.hits = 0;
    this.misses = 0;
  }
  invalidate() {
    this.rect = null;
  }
  get() {
    if (this.rect === null) {
      this.rect = this.readRect();
      this.misses += 1;
    } else {
      this.hits += 1;
    }
    return this.rect;
  }
  get hitRate() {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }
}
