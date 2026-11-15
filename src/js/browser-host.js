export class BrowserHost {
  constructor(AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext) {
    if (!AudioContextCtor) {
      throw new Error('Web Audio API is not available in this browser');
    }
    this.context = new AudioContextCtor();
    this.destination = this.context.destination;
    this._nodeCount = 0;
  }

  get currentTime() {
    return this.context.currentTime;
  }

  get sampleRate() {
    return this.context.sampleRate;
  }

  get state() {
    return this.context.state;
  }

  addEventListener(type, handler) {
    this.context.addEventListener(type, handler);
  }

  removeEventListener(type, handler) {
    this.context.removeEventListener(type, handler);
  }

  _track(node) {
    this._nodeCount += 1;
    return node;
  }

  createGain() {
    return this._track(this.context.createGain());
  }

  createStereoPanner() {
    return this._track(this.context.createStereoPanner());
  }

  createBufferSource() {
    return this._track(this.context.createBufferSource());
  }

  createDynamicsCompressor() {
    return this._track(this.context.createDynamicsCompressor());
  }

  requestFrame(callback) {
    let rafId = 0;
    let cancelled = false;
    const loop = () => {
      if (cancelled) return;
      callback(this.context.currentTime);
      rafId = globalThis.requestAnimationFrame(loop);
    };
    rafId = globalThis.requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      globalThis.cancelAnimationFrame(rafId);
    };
  }

  async resume() {
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  async close() {
    await this.context.close();
  }
}
