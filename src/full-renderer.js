import {
  drawBase,
  drawDynamics,
  drawTerrain,
  drawTexts,
  resetContext,
} from "./drawing.js";
import { TextCommandCache } from "./text-cache.js";

export class FullRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.textCache =
      options.textCache || new TextCommandCache(options.textCacheCapacity ?? 512);
    this.renderCalls = 0;
    this.lastFrameMs = 0;
  }

  render(scene) {
    const start = performance.now();
    resetContext(this.ctx, scene.config.width, scene.config.height);
    drawBase(this.ctx, scene);
    drawTerrain(this.ctx, scene);
    drawTexts(this.ctx, scene, this.textCache);
    drawDynamics(this.ctx, scene);
    this.renderCalls += 1;
    this.lastFrameMs = performance.now() - start;
    const alive = scene.dynamics.filter((object) => object.alive).length;
    return {
      mode: "full",
      frameMs: this.lastFrameMs,
      lastFrameMs: this.lastFrameMs,
      emaFrameMs: this.lastFrameMs,
      repaintPixels: scene.config.width * scene.config.height,
      repaintRatio: 1,
      dirtyRects: 1,
      candidateCount: scene.dynamics.length + scene.texts.length,
      dynamicCandidates: scene.dynamics.length,
      textCandidates: scene.texts.length,
      drawnObjects: alive,
      cacheHitRate: this.textCache.hitRate,
      nodes: {
        terrain: scene.terrain.length,
        text: scene.texts.length,
        dynamic: alive,
      },
      renderCalls: this.renderCalls,
      redrawCalls: this.renderCalls,
      fullInvalidations: this.renderCalls,
      cappedInvalidations: 0,
      lastReason: "full-redraw",
      cacheHits: this.textCache.hits,
      cacheMisses: this.textCache.misses,
      cacheEvictions: this.textCache.evictions,
      cacheEntries: this.textCache.entries.size,
      cacheCapacity: this.textCache.capacity,
      surfaceBytes: scene.config.width * scene.config.height * 4,
    };
  }
}
