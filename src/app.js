import { Store } from './store.js';
import { DEFAULT_STATE } from './presets.js';
import { FogEngine } from './gl/engine.js';

const SNAPSHOT_KEY = 'fog-valley.snapshot.v1';

export class FogApp {
  constructor(canvas, { autostart = true } = {}) {
    this.canvas = canvas;
    this.store = new Store(DEFAULT_STATE);
    this.engine = new FogEngine(canvas);
    this.frameCount = 0;
    this.gpuFrameMs = [];
    this.rafter = null;
    this.lastWall = performance.now();
    this.pendingRegions = new Set();
    this._pendingRebuild = false;

    this.store.subscribe((rec) => this._onChange(rec));
    this.engine.onContextLost(() => {
      this.contextLostAt = performance.now();
      if (this.rafter) cancelAnimationFrame(this.rafter);
      this.rafter = null;
    });

    const s = this.store.state;
    this._applyCanvasSize();
    this.engine.buildQuality(s.quality, s.width, s.height);
    this._applyRegions(new Set(['weather', 'wind', 'humidity', 'sun', 'camera', 'viewport']));
    this.engine.render();
    if (autostart) this.start();
  }

  _applyCanvasSize() {
    const s = this.store.state;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.round(s.width * dpr);
    this.canvas.height = Math.round(s.height * dpr);
    this.canvas.style.width = s.width + 'px';
    this.canvas.style.height = s.height + 'px';
  }

  _onChange(rec) {
    if (rec.fullRebuild) {
      this._pendingRebuild = true;
    }
    for (const r of rec.changedRegions) this.pendingRegions.add(r);
    if (rec.changedRegions.includes('viewport')) this._applyCanvasSize();
    // 暂停时仍然立即重绘一次（保证参数交互有反馈），但不推进 simTime。
    if (this.store.state.paused) this.renderOnce();
  }

  _applyRegions(regions) {
    return this.engine.applyState(this.store.state, [...regions]);
  }

  start() {
    if (this.rafter || this.engine.lost) return;
    this.lastWall = performance.now();
    const loop = (now) => {
      const dt = Math.min((now - this.lastWall) / 1000, 0.1);
      this.lastWall = now;
      const s = this.store.state;
      if (!s.paused) {
        // 时间本身就是一个区域更新，不触碰任何 GL 资源。
        this.store.set({ simTime: s.simTime + dt }, 'animation');
      }
      this.renderOnce();
      this.rafter = requestAnimationFrame(loop);
    };
    this.rafter = requestAnimationFrame(loop);
  }

  pause() { this.store.set({ paused: true }, 'ui'); }
  resume() { this.store.set({ paused: false }, 'ui'); }

  renderOnce() {
    if (this.engine.lost) return false;
    if (this._pendingRebuild) {
      const s = this.store.state;
      this.engine.buildQuality(s.quality, s.width, s.height);
      this.pendingRegions = new Set(
        ['weather', 'wind', 'humidity', 'sun', 'camera', 'viewport', 'time']);
      this._pendingRebuild = false;
    }
    if (this.pendingRegions.size > 0) {
      this._applyRegions(this.pendingRegions);
      this.pendingRegions.clear();
    }
    const t0 = performance.now();
    const ok = this.engine.render();
    if (ok) {
      this.gpuFrameMs.push(performance.now() - t0);
      if (this.gpuFrameMs.length > 120) this.gpuFrameMs.shift();
      this.frameCount += 1;
    }
    return ok;
  }

  set(patch, source = 'ui') {
    return this.store.set(patch, source);
  }

  saveSnapshot() {
    const snap = this.store.snapshot();
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
    return snap;
  }

  static loadSnapshot() {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  restoreSnapshot(snapshot) {
    const snap = snapshot || FogApp.loadSnapshot();
    if (!snap) return { noop: true };
    return this.store.restore(snap, 'restore');
  }

  exportPNG(filename = 'fog-valley-frame.png') {
    const a = document.createElement('a');
    a.download = filename;
    a.href = this.canvas.toDataURL('image/png');
    a.click();
    return a.href.length;
  }

  averageFrameMs() {
    if (!this.gpuFrameMs.length) return 0;
    return this.gpuFrameMs.reduce((a, b) => a + b, 0) / this.gpuFrameMs.length;
  }
}
