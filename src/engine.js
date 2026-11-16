import { GLGuard } from "./gl-guard.js";
import { GeometryCache } from "./geometry-cache.js";
import { OrbitCamera, cullNodes, pickNode } from "./scene.js";
import { Metrics } from "./metrics.js";
import { BaselineRenderer } from "./renderer-baseline.js";
import { OptimizedRenderer } from "./renderer-optimized.js";

export const PHASE = {
  INIT: "INIT",
  RUNNING: "RUNNING",
  LOST: "LOST",
  RESTORING: "RESTORING",
};

export class Engine {
  constructor(canvas, scene, mode, callbacks = {}) {
    this.canvas = canvas;
    this.scene = scene;
    this.mode = mode;
    this.callbacks = callbacks;
    this.phase = PHASE.INIT;
    this.lossCount = 0;
    this.selectedId = null;
    this.metrics = new Metrics();
    this._rafId = 0;
    this._running = false;
    this._pageHidden = false;
    this._lastFrameAt = 0;

    this.camera = new OrbitCamera(canvas);
    this.cache = new GeometryCache();
    this.guard = null;
    this.gl = null;
    this.renderer = null;

    this._onLost = this._handleLost.bind(this);
    this._onRestored = this._handleRestored.bind(this);
    this._onVisibility = this._handleVisibility.bind(this);
    this._onResize = this._handleResize.bind(this);
  }

  start() {
    const gl = this.canvas.getContext("webgl2", {
      antialias: false,
      preserveDrawingBuffer: true,
      alpha: false,
    });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.guard = new GLGuard(gl);
    this.gl = this.guard.api;
    this.loseContextExt = gl.getExtension("WEBGL_lose_context");

    this.canvas.addEventListener("webglcontextlost", this._onLost, false);
    this.canvas.addEventListener("webglcontextrestored", this._onRestored, false);
    document.addEventListener("visibilitychange", this._onVisibility);
    window.addEventListener("resize", this._onResize);

    this._buildResources();
    this.phase = PHASE.RUNNING;
    this._emitState();
    this._running = true;
    this._lastFrameAt = performance.now();
    this._rafId = requestAnimationFrame(this._frame.bind(this));
  }

  // Rebuild every GL resource after (re)creation of a context. The scene graph
  // and camera state live outside GL and therefore survive intact.
  _buildResources() {
    const Renderer = this.mode === "optimized" ? OptimizedRenderer : BaselineRenderer;
    this.cache = new GeometryCache();
    this.renderer = new Renderer(this.gl, this.cache, this.scene);
    this.renderer.build();
    this._applySize();
  }

  _applySize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.camera.resize(this.canvas.width, this.canvas.height);
    // Depth test makes inter-node occlusion independent of draw order, so the
    // baseline (per-node draws) and optimized (grouped batches) match exactly.
    this.gl.enable(this.gl.DEPTH_TEST);
    this.gl.depthFunc(this.gl.LEQUAL);
    this.gl.clearColor(0, 0, 0, 1);
  }

  _handleResize() {
    if (this.phase !== PHASE.RUNNING) return;
    this._applySize();
  }

  _handleLost(event) {
    event.preventDefault();
    this.lossCount++;
    this.phase = PHASE.LOST;
    this._running = false;
    cancelAnimationFrame(this._rafId);
    this.metrics.markPaused();
    // All handles are now invalid: detach them first, then mark the guard so
    // any late GL call is blocked instead of touching a dead context.
    if (this.renderer) this.renderer.dispose();
    this.renderer = null;
    this.guard.markLost();
    this.gl = null;
    this._emitState();
  }

  _handleRestored() {
    this.phase = PHASE.RESTORING;
    this._emitState();
    // The browser supplies a fresh context through the same canvas object.
    const freshGL = this.canvas.getContext("webgl2", {
      antialias: false,
      preserveDrawingBuffer: true,
      alpha: false,
    });
    if (!freshGL) {
      this._emitState(new Error("restore: WebGL2 unavailable on new context"));
      return;
    }
    this.guard = new GLGuard(freshGL);
    this.gl = this.guard.api;
    // Rebuild order: size/viewport -> shaders -> textures -> buffers -> camera.
    this._buildResources();
    this.phase = PHASE.RUNNING;
    if (!this._pageHidden) this._resumeLoop();
    this._emitState();
  }

  _handleVisibility() {
    this._pageHidden = document.hidden;
    if (document.hidden) {
      // Tab sleep: stop producing frames; resume when visible again.
      this._running = false;
      cancelAnimationFrame(this._rafId);
      this.metrics.markPaused();
    } else if (this.phase === PHASE.RUNNING) {
      this._resumeLoop();
    }
    this._emitState();
  }

  _resumeLoop() {
    if (this._running) return;
    this._running = true;
    this._lastFrameAt = performance.now();
    this._rafId = requestAnimationFrame(this._frame.bind(this));
  }

  _frame(now) {
    if (!this._running || this.phase !== PHASE.RUNNING) return;
    const duration = now - this._lastFrameAt;
    this._lastFrameAt = now;
    this.metrics.recordFrame(duration);

    const visibleNodes = cullNodes(this.scene.nodes, this.camera);
    this.renderer.render(visibleNodes, this.camera, this.selectedId);

    this.metrics.update({
      candidateCount: this.scene.nodes.length,
      visibleCount: visibleNodes.length,
      nodeCount: this.scene.nodes.length,
      drawCalls: this.renderer.drawCalls,
      cacheHitRate: this.cache.hitRate,
      gpuBytes: this.guard.gpuBytes,
      glErrors: this.guard.glErrors,
      blockedCalls: this.guard.blockedCalls,
    });
    this._emitState();
    this._rafId = requestAnimationFrame(this._frame.bind(this));
  }

  // Called by tests while the context is lost: must not reach the GL driver.
  attemptRenderWhileLost() {
    if (this.phase !== PHASE.LOST) return false;
    // The renderer was deliberately detached; exercise the guard directly so
    // the "no stale GL calls" guarantee is observable through blockedCalls.
    if (this.guard) {
      const deadGL = this.guard.api;
      const real = this.guard.realGL;
      deadGL.clearColor(0, 0, 0, 1);
      deadGL.clear(real.COLOR_BUFFER_BIT);
      deadGL.drawArrays(real.TRIANGLES, 0, 3);
      deadGL.getParameter(real.VERSION);
    }
    this._emitState();
    return true;
  }

  handlePick(px, py) {
    if (this.phase !== PHASE.RUNNING) return null;
    const ray = this.camera.pickRay(px, py);
    const hit = pickNode(ray, this.scene.nodes);
    this.selectedId = hit ? hit.id : null;
    this._emitState();
    return hit ? { id: hit.id, geoKey: hit.geoKey } : null;
  }

  getState() {
    return {
      phase: this.phase,
      mode: this.mode,
      lossCount: this.lossCount,
      running: this._running,
      pageHidden: this._pageHidden,
      selectedId: this.selectedId,
      camera: this.camera.getState(),
      metrics: {
        ...this.metrics.snapshot(),
        // While paused no frame refreshes metrics; surface live guard counters
        // so the HUD still shows blocked calls/GL errors during a loss.
        glErrors: this.guard ? this.guard.glErrors : this.metrics.glErrors,
        blockedCalls: this.guard ? this.guard.blockedCalls : this.metrics.blockedCalls,
      },
      guardAlive: this.guard ? this.guard.alive : false,
      rendererAttached: this.renderer !== null,
    };
  }

  _emitState(error = null) {
    if (this.callbacks.onState) this.callbacks.onState(this.getState(), error);
  }

  destroy() {
    this._running = false;
    cancelAnimationFrame(this._rafId);
    this.canvas.removeEventListener("webglcontextlost", this._onLost);
    this.canvas.removeEventListener("webglcontextrestored", this._onRestored);
    document.removeEventListener("visibilitychange", this._onVisibility);
    window.removeEventListener("resize", this._onResize);
    if (this.renderer) this.renderer.dispose();
  }
}
