/*
 * Web Audio host: real-time mechanical synthesis with HRTF binaural imaging.
 * The engine stays the source of truth; this layer only produces sound and
 * mirrors engine parameter changes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  root.AudioDiag = root.AudioDiag || {};
  root.AudioDiag.AudioHost = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const STATE_TONE = { normal: 220, loose: 174, friction: 1320, overload: 92 };

  function AudioHost() {
    this.ctx = null;
    this.voices = [];
    this.gainNode = null;
    this.hpfNode = null;
    this.lpfNode = null;
    this.waveShaper = null;
    this.started = false;
  }

  AudioHost.prototype.ensure = function () {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    this.ctx = ctx;

    this.hpfNode = ctx.createBiquadFilter();
    this.hpfNode.type = 'highpass';
    this.hpfNode.frequency.value = 20;
    this.lpfNode = ctx.createBiquadFilter();
    this.lpfNode.type = 'lowpass';
    this.lpfNode.frequency.value = 8000;
    this.waveShaper = ctx.createWaveShaper();
    this.waveShaper.curve = makeSoftClipCurve(ctx);
    this.waveShaper.oversample = '2x';
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = 0.9;
    this.hpfNode.connect(this.lpfNode);
    this.lpfNode.connect(this.waveShaper);
    this.waveShaper.connect(this.gainNode);
    this.gainNode.connect(ctx.destination);
    this.noiseBuffer = makeNoiseBuffer(ctx);
    return ctx;
  };

  AudioHost.prototype.buildVoices = function (engine) {
    const ctx = this.ensure();
    this.teardownVoices();
    engine.devices.forEach((device) => {
      const voice = createVoice(ctx, device, this.noiseBuffer, this.hpfNode);
      this.voices.push(voice);
    });
    this.started = true;
  };

  AudioHost.prototype.teardownVoices = function () {
    this.voices.forEach((v) => {
      try { v.panner.disconnect(); } catch (e) {}
      v.nodes.forEach((n) => { try { n.stop && n.stop(); } catch (e) {} try { n.disconnect(); } catch (e2) {} });
    });
    this.voices = [];
    this.started = false;
  };

  AudioHost.prototype.onMove = function (x, y) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.voices.forEach((v) => {
      v.panner.positionX.setValueAtTime(x, t);
      v.panner.positionY.setValueAtTime(y, t);
    });
  };

  AudioHost.prototype.onFilter = function (filters) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.hpfNode.frequency.setTargetAtTime(Math.max(20, filters.hpf || 20), t, 0.03);
    this.lpfNode.frequency.setTargetAtTime(filters.lpf, t, 0.03);
  };

  AudioHost.prototype.onGain = function (gain, clipped) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.gainNode.gain.setTargetAtTime(Math.min(1, 0.9 * gain), t, 0.02);
    const drive = clipped ? Math.min(20, (gain - 3) * 6) : 0;
    this.waveShaper.curve = makeSoftClipCurve(this.ctx, drive);
  };

  AudioHost.prototype.onState = function (fsm) {
    if (!this.ctx) return;
    if (fsm === 'paused') this.ctx.suspend();
    else if (fsm === 'running' || fsm === 'recovery') this.ctx.resume();
    else if (fsm === 'menu') this.teardownVoices();
  };

  AudioHost.prototype.onRestart = function () {
    if (!this.ctx) return;
    this.teardownVoices();
    this.gainNode.gain.value = 0.9;
    this.hpfNode.frequency.value = 20;
    this.lpfNode.frequency.value = 8000;
  };

  AudioHost.prototype.suspend = function () { if (this.ctx) this.ctx.suspend(); };
  AudioHost.prototype.resume = function () { if (this.ctx) this.ctx.resume(); };

  function makeNoiseBuffer(ctx) {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 1234;
    for (let i = 0; i < len; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      data[i] = (seed >>> 0) / 4294967296 * 2 - 1;
    }
    return buf;
  }

  function makeSoftClipCurve(ctx, drive) {
    const k = 1 + (drive || 0);
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    return curve;
  }

  function createVoice(ctx, device, noiseBuffer, bus) {
    const nodes = [];
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 18;
    panner.rolloffFactor = 1.2;
    panner.positionX.value = device.pos.x;
    panner.positionY.value = device.pos.y;
    panner.positionZ.value = 0;
    panner.connect(bus);
    const out = panner;
    const tone = STATE_TONE[device.state];

    if (device.state === 'friction') {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer; src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = tone; bp.Q.value = 1.4;
      const g = ctx.createGain(); g.gain.value = 0.22 * device.ampScale;
      src.connect(bp); bp.connect(g); g.connect(out);
      src.start(); nodes.push(src, bp, g);
    } else {
      const osc = ctx.createOscillator();
      osc.type = device.state === 'overload' ? 'sawtooth' : 'triangle';
      osc.frequency.value = tone;
      const g = ctx.createGain();
      g.gain.value = (device.state === 'overload' ? 0.16 : 0.12) * device.ampScale;
      osc.connect(g); g.connect(out); osc.start();
      nodes.push(osc, g);

      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = Math.max(0.4, device.rhythm);
      if (device.state === 'loose') {
        lfo.type = 'square';
        lfoGain.gain.value = g.gain.value * 0.95;
      } else if (device.state === 'overload') {
        lfo.type = 'sine';
        lfoGain.gain.value = g.gain.value * 0.7;
      } else {
        lfo.type = 'sine';
        lfoGain.gain.value = g.gain.value * 0.25;
      }
      lfo.connect(lfoGain); lfoGain.connect(g.gain);
      lfo.start(); nodes.push(lfo, lfoGain);
    }
    return { panner, nodes, deviceId: device.id };
  }

  return AudioHost;
});
