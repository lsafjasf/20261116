// Minimal browser globals so src/app.js can run headlessly without a browser.
export class ShimElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.value = tag === 'input' ? 0 : '';
    this.style = {};
    this.textContent = '';
    this.innerHTML = '';
    this.width = 1040;
    this.height = 460;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  dispatch(event) {
    event.target = this;
    for (const fn of this.listeners[event.type] || []) fn(event);
  }
  dispatchEvent(event) {
    this.dispatch(event);
    return true;
  }
  click() {
    this.dispatch({ type: 'click' });
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  getContext() {
    return new Proxy(
      {},
      {
        get: (t, prop) => {
          if (prop === 'measureText') return () => ({ width: 10 });
          if (prop === 'createLinearGradient')
            return () => ({ addColorStop() {} });
          return typeof prop === 'string' ? () => {} : undefined;
        },
        set: () => true
      }
    );
  }
}

export function installDom() {
  globalThis.Event = class Event {
    constructor(type) {
      this.type = type;
    }
  };
  const registry = {};
  const ids = [
    'scenario', 'btn-start', 'btn-auto', 'btn-save', 'btn-load', 'btn-audio',
    'stage', 'p1-gate', 'p1-gate-val', 'p2-pump', 'p2-pump-val',
    'p1-status', 'p2-status', 'rp-play', 'rp-step', 'rp-restart',
    'rp-speed', 'rp-scrub', 'btn-csv', 'btn-svg', 'replay-status',
    'conflict-list', 'chart'
  ];
  for (const id of ids) registry[id] = new ShimElement(id);
  registry['scenario'].value = 'success';
  registry['rp-speed'].value = '1';
  registry['rp-scrub'].max = 7200;
  const documentListeners = {};
  globalThis.document = {
    getElementById: (id) => registry[id],
    createElement: (tag) => new ShimElement(tag),
    addEventListener: (type, fn) => {
      (documentListeners[type] ??= []).push(fn);
    },
    dispatchKey(key) {
      for (const fn of documentListeners.keydown || []) fn({ key });
    }
  };
  const rafQueue = [];
  globalThis.requestAnimationFrame = (fn) => {
    rafQueue.push(fn);
    return rafQueue.length;
  };
  globalThis.flushFrames = (count = 1) => {
    for (let i = 0; i < count; i++) {
      const fns = rafQueue.splice(0, rafQueue.length);
      timeMs += 260;
      const now = timeMs;
      for (const fn of fns) fn(now);
    }
  };
  class AudioContextShim {
    constructor() {
      this.currentTime = 0;
      this.destination = {};
    }
    createGain() {
      return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} }, connect() {} };
    }
    createOscillator() {
      return {
        type: '',
        frequency: { value: 0, setTargetAtTime() {} },
        connect() { return this; },
        start() {},
        stop() {}
      };
    }
    createBiquadFilter() {
      return { type: '', frequency: { setTargetAtTime() {} }, connect() { return this; } };
    }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
  }
  globalThis.window = globalThis;
  globalThis.AudioContext = AudioContextShim;
  globalThis.Blob = class {};
  globalThis.URL = { createObjectURL: () => 'blob:shim', revokeObjectURL() {} };
  let timeMs = 0;
  globalThis.performance = { now: () => timeMs };
  globalThis.advanceTime = (ms) => {
    timeMs += ms;
  };
  return registry;
}
