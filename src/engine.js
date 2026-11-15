// Environment-agnostic 8-key synth engine. Works with any W3C Web Audio
// implementation (browser AudioContext, OfflineAudioContext, node-web-audio-api,
// or the test mock). No DOM access lives here.

export const KEY_COUNT = 8;
export const KEY_NOTES = [60, 62, 64, 65, 67, 69, 71, 72]; // C4 D4 E4 F4 G4 A4 B4 C5
export const WAVEFORMS = ['sine', 'square', 'sawtooth', 'triangle'];

export function defaultKeyParams() {
  return {
    waveform: 'sawtooth',
    attack: 0.01,
    decay: 0.12,
    sustain: 0.7,
    release: 0.25,
    filterType: 'lowpass',
    filterFreq: 3500,
    filterQ: 1,
    glide: 0,        // portamento seconds
    pan: 0,          // -1..1
    gain: 0.8,       // 0..1
    pitchOffset: 0,  // semitones
  };
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

class Voice {
  constructor(engine, keyIndex, params, when) {
    this.engine = engine;
    this.keyIndex = keyIndex;
    this.params = params;
    this.disposed = false;
    this.endTime = Infinity;

    const ctx = engine.ctx;
    this.osc = ctx.createOscillator();
    this.filter = ctx.createBiquadFilter();
    this.envGain = ctx.createGain();
    this.panner = ctx.createStereoPanner();

    this.osc.type = params.waveform;
    this.filter.type = params.filterType;
    this.filter.frequency.setValueAtTime(params.filterFreq, when);
    this.filter.Q.setValueAtTime(params.filterQ, when);
    this.panner.pan.setValueAtTime(params.pan, when);

    const target = engine.keyFrequency(keyIndex, params);
    const prev = engine.lastFreq[keyIndex];
    if (params.glide > 0 && prev != null && prev !== target) {
      // Portamento: start from previous frequency, ramp to target.
      this.osc.frequency.setValueAtTime(prev, when);
      this.osc.frequency.linearRampToValueAtTime(target, when + params.glide);
      this.glided = true;
    } else {
      this.osc.frequency.setValueAtTime(target, when);
      this.glided = false;
    }
    engine.lastFreq[keyIndex] = target;

    // ADSR on the voice gain.
    const g = this.envGain.gain;
    const peak = params.gain;
    g.setValueAtTime(0, when);
    g.linearRampToValueAtTime(peak, when + Math.max(0.001, params.attack));
    g.linearRampToValueAtTime(
      peak * params.sustain,
      when + Math.max(0.001, params.attack) + Math.max(0.001, params.decay)
    );

    this.osc.connect(this.filter);
    this.filter.connect(this.envGain);
    this.envGain.connect(this.panner);
    this.panner.connect(engine.master);
    engine._trackNodes(this.osc, this.filter, this.envGain, this.panner);

    this.osc.start(when);
    this.startedAt = when;
  }

  // Begin release phase; voice becomes collectable at endTime.
  release(when, releaseOverride) {
    if (this.disposed) return;
    const p = this.params;
    const rel = releaseOverride != null ? releaseOverride : Math.max(0.005, p.release);
    const g = this.envGain.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(g.value, when);
    g.linearRampToValueAtTime(0, when + rel);
    this.osc.stop(when + rel + 0.02);
    this.endTime = when + rel + 0.05;
  }

  // Hard silence for pause / interrupt: no audible tail allowed.
  kill(when, fade = 0.005) {
    this.release(when, fade);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const n of [this.osc, this.filter, this.envGain, this.panner]) {
      try { n.disconnect(); } catch (_) { /* already disconnected */ }
    }
    this.engine._untrackNodes(this.osc, this.filter, this.envGain, this.panner);
  }
}

export class SynthEngine {
  // ctxFactory: () => AudioContext-like. Required unless a context is injected.
  constructor({ ctxFactory = null, context = null, autoCollectMs = 50 } = {}) {
    this._ctxFactory = ctxFactory;
    this.ctx = context || null;
    this.autoCollectMs = autoCollectMs;
    this.keys = Array.from({ length: KEY_COUNT }, defaultKeyParams);
    this.voices = new Map(); // keyIndex -> Voice
    this.retiring = new Set(); // killed voices awaiting disposal (retriggered)
    this.lastFreq = new Array(KEY_COUNT).fill(null);
    this.activeNodeCount = 0;
    this.managedListeners = [];
    this.started = false;
    this._collectTimer = null;
    if (this.ctx) this._wireContext();
  }

  _wireContext() {
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  // Idempotent: repeated start() must not duplicate listeners or timers.
  start() {
    if (this.started) return this;
    if (!this.ctx) {
      if (!this._ctxFactory) throw new Error('SynthEngine: no context or ctxFactory');
      this.ctx = this._ctxFactory();
      this._wireContext();
    }
    this.started = true;
    if (this._collectTimer == null) {
      this._collectTimer = setInterval(() => this.collectVoices(), this.autoCollectMs);
      if (this._collectTimer.unref) this._collectTimer.unref();
    }
    return this;
  }

  keyFrequency(keyIndex, params = this.keys[keyIndex]) {
    return midiToFreq(KEY_NOTES[keyIndex] + (params.pitchOffset || 0));
  }

  noteOn(keyIndex, when, paramsOverride) {
    this._assertRunning();
    const t = when != null ? when : this.ctx.currentTime;
    // Retrigger: silence the previous voice on this key instantly (no overlap tail).
    const prev = this.voices.get(keyIndex);
    if (prev && !prev.disposed) {
      prev.kill(t, 0.003);
      this.retiring.add(prev); // keep collectable even though map entry is replaced
    }
    const params = paramsOverride || { ...this.keys[keyIndex] };
    const voice = new Voice(this, keyIndex, params, t);
    this.voices.set(keyIndex, voice);
    return voice;
  }

  noteOff(keyIndex, when) {
    const t = when != null ? when : this.ctx.currentTime;
    const voice = this.voices.get(keyIndex);
    if (voice && !voice.disposed) voice.release(t);
  }

  // Silence everything with a micro-fade (anti-click). No release tails remain.
  stopAll(fade = 0.005) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const voice of this.voices.values()) {
      if (!voice.disposed) voice.kill(t, fade);
    }
  }

  // Input interruption (device loss, page hide, context suspend): silence now.
  handleInterrupt() {
    this.stopAll(0.003);
    if (this.ctx && this.ctx.state === 'running' && this.ctx.suspend) {
      return this.ctx.suspend();
    }
    return Promise.resolve();
  }

  // Dispose voices whose release has fully elapsed.
  collectVoices() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const [key, voice] of [...this.voices]) {
      if (!voice.disposed && voice.endTime <= now) {
        voice.dispose();
        if (this.voices.get(key) === voice) this.voices.delete(key);
      }
    }
    for (const voice of [...this.retiring]) {
      if (voice.disposed) this.retiring.delete(voice);
      else if (voice.endTime <= now) {
        voice.dispose();
        this.retiring.delete(voice);
      }
    }
  }

  setKeyParams(keyIndex, patch) {
    Object.assign(this.keys[keyIndex], patch);
  }

  applyPreset(presetKeys) {
    presetKeys.forEach((p, i) => { this.keys[i] = { ...defaultKeyParams(), ...p }; });
  }

  addManagedListener(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    this.managedListeners.push({ target, type, fn, options });
  }

  _removeManagedListeners() {
    for (const { target, type, fn, options } of this.managedListeners) {
      target.removeEventListener(type, fn, options);
    }
    this.managedListeners = [];
  }

  // Full teardown: silence, disconnect, remove listeners/timers, close context.
  async destroy() {
    this.stopAll(0.002);
    for (const voice of this.voices.values()) voice.dispose();
    this.voices.clear();
    for (const voice of this.retiring) voice.dispose();
    this.retiring.clear();
    this._removeManagedListeners();
    if (this._collectTimer != null) {
      clearInterval(this._collectTimer);
      this._collectTimer = null;
    }
    if (this.ctx) {
      try { this.master.disconnect(); } catch (_) {}
      try { this.analyser.disconnect(); } catch (_) {}
      if (this.ctx.state !== 'closed' && this.ctx.close) await this.ctx.close();
    }
    this.started = false;
    this.lastFreq.fill(null);
  }

  getStatus() {
    return {
      started: this.started,
      contextState: this.ctx ? this.ctx.state : 'none',
      activeNodes: this.activeNodeCount,
      activeVoices: [...this.voices.values()].filter((v) => !v.disposed).length,
      managedListeners: this.managedListeners.length,
      collectorRunning: this._collectTimer != null,
    };
  }

  _trackNodes(...nodes) { this.activeNodeCount += nodes.length; }
  _untrackNodes(...nodes) { this.activeNodeCount -= nodes.length; }

  _assertRunning() {
    if (!this.ctx) throw new Error('SynthEngine: call start() first');
  }
}
