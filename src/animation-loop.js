export class AnimationLoop {
  constructor({ requestFrame, cancelFrame, onFrame, onError }) {
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.onFrame = onFrame;
    this.onError = onError;
    this.frameId = null;
    this.paused = true;
    this.running = false;
  }

  _tick = (timestamp) => {
    this.frameId = null;
    if (this.paused || !this.running) return;
    try {
      this.onFrame(timestamp);
    } catch (error) {
      this.onError?.(error);
      this.pause();
      return;
    }
    if (!this.paused && this.running) {
      this.frameId = this.requestFrame(this._tick);
    }
  };

  start() {
    if (this.running && !this.paused) return;
    this.running = true;
    this.paused = false;
    if (this.frameId === null) this.frameId = this.requestFrame(this._tick);
  }

  pause() {
    this.paused = true;
    if (this.frameId !== null) {
      this.cancelFrame(this.frameId);
      this.frameId = null;
    }
  }

  stop() {
    this.pause();
    this.running = false;
  }
}
