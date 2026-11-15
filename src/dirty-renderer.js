import {
  alignRect,
  clampDirtySet,
  clipToViewport,
  mergeDirtyRects,
  totalRectArea,
} from "./dirty-rects.js";
import {
  drawBase,
  drawDynamics,
  drawObject,
  drawTerrain,
  drawTexts,
  resetContext,
  screenDynamicBounds,
  screenTextBounds,
} from "./drawing.js";
import { intersectRect } from "./geometry.js";
import { TextCommandCache } from "./text-cache.js";

export class DirtyRenderer {
  constructor(canvas, scene, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.scene = scene;
    this.width = scene.config.width;
    this.height = scene.config.height;
    this.createSurface = options.createSurface;
    if (!this.createSurface) throw new Error("DirtyRenderer requires createSurface");
    this.background = this.createSurface(this.width, this.height);
    this.backgroundCtx = this.background.getContext("2d");
    this.staticLayer = this.createSurface(this.width, this.height);
    this.staticCtx = this.staticLayer.getContext("2d");
    this.textCache = new TextCommandCache(options.textCacheCapacity || 512);
    this.mergeGap = options.mergeGap ?? 6;
    this.maxDirtyRects = options.maxDirtyRects ?? 64;
    this.staticReady = false;
    this.backgroundReady = false;
    this.prevCameraRevision = -1;
    this.prevLayers = null;
    this.prevObjects = new Map();
    this.stats = {
      renderCalls: 0,
      redrawCalls: 0,
      skippedCalls: 0,
      fullInvalidations: 0,
      cappedInvalidations: 0,
      lastFrameMs: 0,
      emaFrameMs: 0,
      repaintPixels: 0,
      repaintRatio: 0,
      dirtyRects: 0,
      candidateCount: 0,
      dynamicCandidates: 0,
      textCandidates: 0,
      drawnObjects: 0,
      lastReason: "initial",
    };
  }

  _visibleTexts(scene) {
    const viewport = {
      x: scene.camera.x,
      y: scene.camera.y,
      w: this.width,
      h: this.height,
    };
    return scene.textIndex.query(viewport).filter((text) => {
      const bounds = screenTextBounds(text, scene.camera);
      return intersectRect(bounds, { x: 0, y: 0, w: this.width, h: this.height });
    });
  }

  _prepareTextCache(scene) {
    const visible = this._visibleTexts(scene);
    for (const text of visible) this.textCache.prepare(text, this.staticCtx);
    return visible.length;
  }

  _rebuildBackground(scene) {
    resetContext(this.backgroundCtx, this.width, this.height);
    drawBase(this.backgroundCtx, scene);
    if (scene.layers.terrain) drawTerrain(this.backgroundCtx, scene);
    this.backgroundReady = true;
  }

  _rebuildStatic(scene) {
    resetContext(this.staticCtx, this.width, this.height);
    this.staticCtx.drawImage(this.background, 0, 0);
    if (scene.layers.text) drawTexts(this.staticCtx, scene, this.textCache);
    this.staticReady = true;
  }

  _fullRect() {
    return { x: 0, y: 0, w: this.width, h: this.height };
  }

  _textInvalidationRects(scene) {
    return this._visibleTexts(scene).map((text) =>
      screenTextBounds(text, scene.camera),
    );
  }

  _dynamicInvalidationRects(scene) {
    const rects = [];
    for (const object of scene.dynamics) {
      if (!object.alive) continue;
      const old = this.prevObjects.get(object.id);
      if (old) rects.push(old);
      if (scene.layers.dynamic) {
        rects.push(screenDynamicBounds(object, scene.camera));
      }
    }
    if (scene.layers.dynamic) {
      for (const [id, old] of this.prevObjects) {
        if (!scene.dynamics.some((object) => object.id === id && object.alive)) {
          rects.push(old);
        }
      }
    }
    return rects;
  }

  _motionInvalidationRects(scene) {
    if (!scene.layers.dynamic) return [];
    const rects = [];
    for (const object of scene.dynamics) {
      if (!object.alive) continue;
      const next = screenDynamicBounds(object, scene.camera);
      const old = this.prevObjects.get(object.id);
      if (!old) {
        rects.push(next);
        continue;
      }
      if (
        old.x !== next.x ||
        old.y !== next.y ||
        old.w !== next.w ||
        old.h !== next.h
      ) {
        rects.push(old, next);
      }
    }
    for (const [id, old] of this.prevObjects) {
      if (!scene.dynamics.some((object) => object.id === id && object.alive)) {
        rects.push(old);
      }
    }
    return rects;
  }

  _invalidate(scene, forceFull) {
    const cameraMoved = this.prevCameraRevision !== scene.cameraRevision;
    const layersChanged =
      this.prevLayers &&
      (this.prevLayers.terrain !== scene.layers.terrain ||
        this.prevLayers.text !== scene.layers.text ||
        this.prevLayers.dynamic !== scene.layers.dynamic);
    if (!this.staticReady || !this.prevLayers) {
      return { full: true, reason: "initial" };
    }
    if (forceFull) return { full: true, reason: "forced" };
    if (cameraMoved) return { full: true, reason: "viewport" };
    if (this.prevLayers.terrain !== scene.layers.terrain) {
      return { full: true, reason: "terrain-layer" };
    }

    const rects = [];
    let reason = "objects";
    if (layersChanged && this.prevLayers.text !== scene.layers.text) {
      this.staticReady = false;
      rects.push(...this._textInvalidationRects(scene));
      reason = "text-layer";
    }
    if (layersChanged && this.prevLayers.dynamic !== scene.layers.dynamic) {
      rects.push(...this._dynamicInvalidationRects(scene));
      reason = "dynamic-layer";
    }
    if (scene.layers.dynamic) rects.push(...this._motionInvalidationRects(scene));
    return { full: false, rects, reason };
  }

  _recordFrame(scene) {
    this.prevCameraRevision = scene.cameraRevision;
    this.prevLayers = { ...scene.layers };
    this.prevObjects.clear();
    for (const object of scene.dynamics) {
      if (object.alive) {
        this.prevObjects.set(object.id, screenDynamicBounds(object, scene.camera));
      }
    }
  }

  render(scene, options = {}) {
    const start = performance.now();
    const forceFull = Boolean(options.forceFull);
    if (!this.backgroundReady) this._rebuildBackground(scene);
    const invalidation = this._invalidate(scene, forceFull);
    const textCandidates = this._prepareTextCache(scene);

    let rects;
    if (invalidation.full) {
      rects = [this._fullRect()];
      this._rebuildBackground(scene);
      this._rebuildStatic(scene);
      this.stats.fullInvalidations += 1;
    } else {
      if (!this.staticReady) this._rebuildStatic(scene);
      rects = invalidation.rects
        .map((rect) => alignRect(rect))
        .map((rect) => clipToViewport(rect, this.width, this.height))
        .filter(Boolean);
      rects = mergeDirtyRects(rects, this.mergeGap);
      const beforeCap = rects.length;
      rects = clampDirtySet(rects, this.maxDirtyRects, this.width, this.height);
      if (rects.length === 1 && beforeCap > this.maxDirtyRects) {
        this.stats.cappedInvalidations += 1;
      }
    }

    const dynamicIds = new Set();
    let drawnObjects = 0;
    for (const rect of rects) {
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.rect(rect.x, rect.y, rect.w, rect.h);
      this.ctx.clip();
      this.ctx.drawImage(
        this.staticLayer,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
      );
      if (scene.layers.dynamic) {
        const worldRect = {
          x: rect.x + scene.camera.x,
          y: rect.y + scene.camera.y,
          w: rect.w,
          h: rect.h,
        };
        const candidates = scene.dynamicIndex
          .query(worldRect)
          .filter((object) =>
            intersectRect(screenDynamicBounds(object, scene.camera), rect),
          )
          .sort((a, b) => a.order - b.order);
        for (const object of candidates) {
          dynamicIds.add(object.id);
          drawObject(this.ctx, object, scene.camera);
          drawnObjects += 1;
        }
      }
      this.ctx.restore();
    }

    const repaintPixels = totalRectArea(rects);
    const elapsed = performance.now() - start;
    this.stats.renderCalls += 1;
    if (rects.length === 0) this.stats.skippedCalls += 1;
    else this.stats.redrawCalls += 1;
    this.stats.lastFrameMs = elapsed;
    this.stats.emaFrameMs =
      this.stats.emaFrameMs === 0
        ? elapsed
        : this.stats.emaFrameMs * 0.82 + elapsed * 0.18;
    this.stats.repaintPixels = repaintPixels;
    this.stats.repaintRatio = repaintPixels / (this.width * this.height);
    this.stats.dirtyRects = rects.length;
    this.stats.dynamicCandidates = dynamicIds.size;
    this.stats.textCandidates = textCandidates;
    this.stats.candidateCount = dynamicIds.size + textCandidates;
    this.stats.drawnObjects = drawnObjects;
    this.stats.lastReason = invalidation.reason;
    this._recordFrame(scene);
    return this.metrics;
  }

  renderFullReference(scene) {
    if (!this.backgroundReady) this._rebuildBackground(scene);
    if (!this.staticReady) this._rebuildStatic(scene);
    resetContext(this.ctx, this.width, this.height);
    this.ctx.drawImage(this.staticLayer, 0, 0);
    drawDynamics(this.ctx, scene);
  }

  get metrics() {
    const alive = this.prevObjects.size;
    return {
      ...this.stats,
      frameMs: this.stats.lastFrameMs,
      cacheHitRate: this.textCache.hitRate,
      cacheHits: this.textCache.hits,
      cacheMisses: this.textCache.misses,
      cacheEvictions: this.textCache.evictions,
      cacheEntries: this.textCache.entries.size,
      cacheCapacity: this.textCache.capacity,
      surfaceBytes: this.width * this.height * 4 * 3,
      nodes: {
        terrain: this.scene?.terrain?.length ?? 0,
        text: this.scene?.texts?.length ?? 0,
        dynamic: alive,
      },
    };
  }
}
