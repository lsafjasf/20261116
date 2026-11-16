// Rolling performance metrics. Frame timing uses an EWMA over the last
// 60 frames; all counters are exposed as plain serializable snapshots.

export class Metrics {
  constructor() {
    this._frameSamples = [];
    this._maxSamples = 60;
    this.frameMs = 0;
    this.candidateCount = 0;
    this.visibleCount = 0;
    this.nodeCount = 0;
    this.drawCalls = 0;
    this.cacheHitRate = 0;
    this.gpuBytes = 0;
    this.glErrors = 0;
    this.blockedCalls = 0;
  }

  recordFrame(durationMs) {
    this._frameSamples.push(durationMs);
    if (this._frameSamples.length > this._maxSamples) this._frameSamples.shift();
    let sum = 0;
    for (const value of this._frameSamples) sum += value;
    this.frameMs = sum / this._frameSamples.length;
  }

  // While the frame loop is paused (context lost / tab sleep) frame time is
  // undefined rather than a stale carry-over from the last running frame.
  markPaused() {
    this._frameSamples.length = 0;
    this.frameMs = 0;
  }

  update(renderInfo) {
    this.candidateCount = renderInfo.candidateCount;
    this.visibleCount = renderInfo.visibleCount;
    this.nodeCount = renderInfo.nodeCount;
    this.drawCalls = renderInfo.drawCalls;
    this.cacheHitRate = renderInfo.cacheHitRate;
    this.gpuBytes = renderInfo.gpuBytes;
    this.glErrors = renderInfo.glErrors;
    this.blockedCalls = renderInfo.blockedCalls;
  }

  get fps() {
    return this.frameMs > 0 ? 1000 / this.frameMs : 0;
  }

  snapshot() {
    return {
      frameMs: this.frameMs,
      fps: this.fps,
      candidateCount: this.candidateCount,
      visibleCount: this.visibleCount,
      nodeCount: this.nodeCount,
      cacheHitRate: this.cacheHitRate,
      drawCalls: this.drawCalls,
      gpuBytes: this.gpuBytes,
      glErrors: this.glErrors,
      blockedCalls: this.blockedCalls,
    };
  }
}
