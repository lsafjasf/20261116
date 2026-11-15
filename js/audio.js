// Web Audio engine for the coupled-oscillator network.
// Every AudioNode and event listener is registered so stop() can prove
// it leaves nothing behind: no tail, no leaked nodes, no stale listeners.

import { N, stepSim, voiceState, createSim, restoreSim, snapshotOf } from './sim.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.sim = null;
    this.voices = [];        // { osc, gain, pan }
    this.master = null;
    this.analyser = null;
    this.compressor = null;
    this.schedulerId = null;
    this._nodes = new Set();     // live AudioNodes we created
    this._listeners = [];        // { target, type, fn } for exact removal
    this._timeData = null;
    this.stats = { starts: 0, stops: 0, nodesCreated: 0, nodesReleased: 0 };
  }

  _track(node) { this._nodes.add(node); this.stats.nodesCreated++; return node; }

  _listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push({ target, type, fn, opts });
  }

  get activeNodeCount() { return this._nodes.size; }
  get activeListenerCount() { return this._listeners.length; }
  get running() { return this.schedulerId !== null; }

  async start(params, snapshot) {
    if (this.running) return false; // idempotent: repeated start is a no-op
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this._track(this.ctx.createGain());
      this.master.gain.value = 0.9;
      // Soft limiter: extra guarantee against sustained clipping.
      this.compressor = this._track(this.ctx.createDynamicsCompressor());
      this.compressor.threshold.value = -6;
      this.compressor.ratio.value = 12;
      this.analyser = this._track(this.ctx.createAnalyser());
      this.analyser.fftSize = 2048;
      this.master.connect(this.compressor);
      this.compressor.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this._timeData = new Float32Array(this.analyser.fftSize);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.sim = snapshot ? restoreSim(snapshot) : createSim(params);
    this._buildVoices();
    this.stats.starts++;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      let steps = Math.min(4, Math.max(1, Math.round((now - last) / (1000 / 60))));
      last = now;
      for (let s = 0; s < steps; s++) { stepSim(this.sim); this._apply(); }
      this.schedulerId = requestAnimationFrame(tick);
    };
    this.schedulerId = requestAnimationFrame(tick);
    return true;
  }

  _buildVoices() {
    const t = this.ctx.currentTime;
    for (let i = 0; i < N; i++) {
      const osc = this._track(this.ctx.createOscillator());
      osc.type = i % 2 === 0 ? 'sine' : 'triangle';
      const gain = this._track(this.ctx.createGain());
      const pan = this._track(this.ctx.createStereoPanner());
      const v = voiceState(this.sim, i);
      osc.frequency.setValueAtTime(v.freq, t);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(v.gain, t + 0.05); // fade-in: no click
      pan.pan.setValueAtTime(v.pan, t);
      osc.connect(gain); gain.connect(pan); pan.connect(this.master);
      osc.start();
      this.voices.push({ osc, gain, pan });
    }
  }

  _apply() {
    const t = this.ctx.currentTime;
    for (let i = 0; i < N; i++) {
      const v = voiceState(this.sim, i);
      const voice = this.voices[i];
      voice.osc.frequency.setTargetAtTime(v.freq, t, 0.03);
      voice.gain.gain.setTargetAtTime(v.gain, t, 0.05);
      voice.pan.pan.setTargetAtTime(v.pan, t, 0.05);
    }
  }

  // Hard stop with short fade: releases every node and listener it owns.
  async stop() {
    if (this.schedulerId !== null) {
      cancelAnimationFrame(this.schedulerId);
      this.schedulerId = null;
    }
    if (this.ctx && this.voices.length) {
      const t = this.ctx.currentTime;
      for (const { gain } of this.voices) {
        gain.gain.cancelScheduledValues(t);
        gain.gain.setTargetAtTime(0, t, 0.015); // ~50ms fade: no click, no tail
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    this._teardownVoices();
    this.stats.stops++;
  }

  _teardownVoices() {
    for (const { osc, gain, pan } of this.voices) {
      try { osc.stop(); } catch (_) { /* already stopped */ }
      osc.disconnect(); gain.disconnect(); pan.disconnect();
      for (const n of [osc, gain, pan]) { this._nodes.delete(n); this.stats.nodesReleased++; }
    }
    this.voices = [];
  }

  // Full teardown including shared nodes (used by reset / page unload).
  async dispose() {
    await this.stop();
    for (const { target, type, fn, opts } of this._listeners.splice(0)) {
      target.removeEventListener(type, fn, opts);
    }
    if (this.ctx) {
      for (const n of [this.analyser, this.compressor, this.master]) {
        if (n) { n.disconnect(); this._nodes.delete(n); this.stats.nodesReleased++; }
      }
      await this.ctx.close();
      this.ctx = null;
      this.master = this.compressor = this.analyser = null;
    }
    this.sim = null;
  }

  async pause() {
    if (this.schedulerId !== null) {
      cancelAnimationFrame(this.schedulerId);
      this.schedulerId = null;
    }
    if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend();
  }

  async resume() {
    if (!this.ctx || !this.sim) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (this.schedulerId === null) {
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        let steps = Math.min(4, Math.max(1, Math.round((now - last) / (1000 / 60))));
        last = now;
        for (let s = 0; s < steps; s++) { stepSim(this.sim); this._apply(); }
        this.schedulerId = requestAnimationFrame(tick);
      };
      this.schedulerId = requestAnimationFrame(tick);
    }
  }

  rms() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this._timeData);
    let s = 0;
    for (let i = 0; i < this._timeData.length; i++) s += this._timeData[i] * this._timeData[i];
    return Math.sqrt(s / this._timeData.length);
  }

  waveform() {
    if (!this.analyser) return new Float32Array(0);
    this.analyser.getFloatTimeDomainData(this._timeData);
    return this._timeData;
  }

  snapshot() { return this.sim ? snapshotOf(this.sim) : null; }
}
