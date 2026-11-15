// Camera timeline: keyframed pan/zoom with an explicit pause state.
// Keyframe: { t, x, y, zoom } — camera center in world coords plus zoom.
export class Timeline {
  constructor(keyframes = []) {
    this.keyframes = [...keyframes].sort((a, b) => a.t - b.t);
    this.time = 0;
    this.paused = false;
  }

  addKeyframe(kf) {
    this.keyframes.push(kf);
    this.keyframes.sort((a, b) => a.t - b.t);
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  // Advance time; frozen while paused so nothing loads or moves.
  advance(dtMs) {
    if (!this.paused) this.time += dtMs;
    return this.cameraAt(this.time);
  }

  cameraAt(t) {
    const kfs = this.keyframes;
    if (kfs.length === 0) return { x: 0, y: 0, zoom: 1 };
    if (t <= kfs[0].t) return pick(kfs[0]);
    if (t >= kfs[kfs.length - 1].t) return pick(kfs[kfs.length - 1]);
    for (let i = 0; i < kfs.length - 1; i++) {
      const a = kfs[i];
      const b = kfs[i + 1];
      if (t >= a.t && t <= b.t) {
        const f = (t - a.t) / (b.t - a.t);
        return {
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f,
          zoom: a.zoom + (b.zoom - a.zoom) * f
        };
      }
    }
    return pick(kfs[kfs.length - 1]);
  }
}

function pick(kf) {
  return { x: kf.x, y: kf.y, zoom: kf.zoom };
}

// Ordered layer stack; index 0 renders first (bottom).
export class LayerStack {
  constructor(layers, colors) {
    this.layers = [...layers];
    this.colors = { ...colors };
  }

  order() {
    return [...this.layers];
  }

  colorOf(layer) {
    return this.colors[layer];
  }
}
