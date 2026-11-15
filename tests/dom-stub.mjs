// Minimal DOM / Canvas / AudioContext stub sufficient to drive src/app.js in Node.
class Ctx2d {
  constructor() { this.calls = 0; }
  createLinearGradient() { return { addColorStop() {} }; }
  save() {} restore() {} translate() {} rotate() {} beginPath() {}
  moveTo() {} lineTo() {} arcTo() {} arc() {} closePath() {} fill() {}
  stroke() {} fillRect() {} strokeRect() {} fillText() {}
  connect() { return this; }
  setValueAtTime() {} exponentialRampToValueAtTime() {} setTargetAtTime() {}
  createGain() { return new Ctx2d(); }
  createOscillator() { return new Osc(); }
  createBufferSource() { return new Src(); }
  createBiquadFilter() { return new Ctx2d(); }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  set font(v) {} set fillStyle(v) {} set strokeStyle(v) {} set lineWidth(v) {}
}
class Osc extends Ctx2d {
  start() {} stop() {}
  get frequency() { return this._f || (this._f = new Param()); }
  connect() { return this; }
}
class Src extends Ctx2d {
  start() {} stop() {}
  set buffer(v) {}
  connect() { return this; }
}
class Param { setValueAtTime() {} setTargetAtTime() {} exponentialRampToValueAtTime() {} value = 0; }
class AudioCtx {
  currentTime = 0; state = 'running'; sampleRate = 8000;
  destination = {};
  createGain() { const g = new Ctx2d(); g.gain = new Param(); return g; }
  createOscillator() { const o = new Osc(); o.frequency.value = 0; o.type = ''; return o; }
  createBufferSource() { return new Src(); }
  createBiquadFilter() { const f = new Ctx2d(); f.frequency = new Param(); f.type = ''; return f; }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  resume() {} close() {}
}

class El {
  constructor(id) {
    this.id = id; this._text = ''; this._html = ''; this.value = id === 'seed' ? '2026' : '';
    this.width = 960; this.height = 600; this.classList = new Set();
    this.listeners = {}; this.dataset = {};
  }
  getContext() { return new Ctx2d(); }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  dispatch(ev) { for (const fn of this.listeners[ev] || []) fn({ code: ev, repeat: false, preventDefault() {} }); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  toggle(name) { const has = this.classList.has(name); has ? this.classList.delete(name) : this.classList.add(name); return !has; }
}

export function installDom() {
  const ids = ['scene','seed','timer','tick','phase','objective','hash','changes','warnings',
    'modeLabel','replayResult','pauseBtn','restartBtn'];
  const acts = ['thrust-fwd','thrust-rev','light','engine','sample','flood','vent','neutral',
    'blow','pause','recover','restart','replay','mode-safe','mode-mistake','mode-extreme','mode-manual'];
  const byId = new Map();
  for (const id of ids) byId.set(id, new El(id));
  const actionEls = acts.map((act) => { const e = new El(act); e.dataset.act = act; return e; });
  globalThis.window = {
    AudioContext: AudioCtx, webkitAudioContext: AudioCtx,
    _pressed: new Set(),
    addEventListener(ev, fn) { (this._l ||= {})[ev] ||= []; this._l[ev].push(fn); },
    dispatchKey(code) { this._pressed.add(code); for (const fn of this._l?.keydown || []) fn({ code, repeat: false, preventDefault() {} }); },
    releaseKey(code) { this._pressed.delete(code); for (const fn of this._l?.keyup || []) fn({ code, repeat: false, preventDefault() {} }); },
    setTimeout: (fn) => 0,
  };
  globalThis.document = {
    getElementById: (id) => byId.get(id),
    querySelectorAll: (sel) => sel === '[data-act]' ? actionEls : [],
  };
  let rafCb = null;
  globalThis.requestAnimationFrame = (cb) => { rafCb = cb; };
  globalThis.performance = { now: () => clock.now };
  globalThis.setTimeout = (fn) => 0;
  const clock = { now: 0 };
  return {
    byId: (id) => byId.get(id),
    act: (name) => actionEls.find((e) => e.dataset.act === name),
    pump(frames, tickMs = 100) {
      for (let i = 0; i < frames; i++) {
        clock.now += tickMs;
        const cb = rafCb; rafCb = null;
        cb?.(clock.now);
      }
    },
    press(code) { window.dispatchKey(code); },
    release(code) { window.releaseKey(code); },
  };
}
