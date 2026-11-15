// Web Audio synthesis engine. All one-shot nodes are registered so the UI can
// show live node counts and tests can prove that destroy() leaves nothing open.

import { LANES } from './config.js';

export class AudioEngine {
  constructor(params) {
    this.params = params;
    this.ctx = null;
    this.master = null;
    this.compressor = null;
    this.nodes = new Set();        // every live AudioNode we created
    this.createdTotal = 0;
    this.playedVoices = 0;
    this.schedulerTimer = null;
    this.noiseBuffer = null;
    this._lastScheduleTime = -Infinity;
    this.tickCount = 0;
  }

  async init() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.compressor = this.ctx.createDynamicsCompressor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.params.masterGain;
    this._register(this.compressor);
    this._register(this.master);
    this.master.connect(this.compressor);
    this.compressor.connect(this.ctx.destination);

    const len = this.ctx.sampleRate * 1;
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    return this.ctx;
  }

  get state() {
    return this.ctx ? this.ctx.state : 'closed';
  }

  get activeNodeCount() {
    return this.nodes.size;
  }

  get currentTime() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  _register(node) {
    this.nodes.add(node);
    this.createdTotal += 1;
    return node;
  }

  _release(chain) {
    for (const node of chain) {
      try { node.disconnect(); } catch { /* already disconnected */ }
      this.nodes.delete(node);
    }
  }

  _panner(panValue) {
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = panValue;
    return this._register(panner);
  }

  _noiseSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    return this._register(src);
  }

  // Voice chain helper: source(s) -> gain -> panner -> master, auto-cleaned.
  _wire(chain, sources, outGain, panner, when) {
    outGain.connect(panner);
    panner.connect(this.master);
    const releaseAt = when + 0.6;
    const cleanup = () => this._release(chain);
    // Sources always emit onended after stop(); use the latest-finishing one.
    sources.forEach((src) => {
      src.onended = cleanup;
    });
    // Safety net in case onended is dropped (context close races).
    const delayMs = Math.max(50, (releaseAt - this.ctx.currentTime) * 1000 + 100);
    setTimeout(cleanup, delayMs);
  }

  _envelope(gain, when, peak, attack, decay) {
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
  }

  // Scheduled drum voices, one per chart note.
  playDrum(kind, when, panValue, volume = 1) {
    if (!this.ctx) return;
    this.playedVoices += 1;
    const level = this.params.drumGain * volume;
    const panner = this._panner(panValue);

    if (kind === 'kick') return this._kick(when, level, panner);
    if (kind === 'snare') return this._snare(when, level, panner);
    if (kind === 'hihat') return this._hihat(when, level, panner, false);
    return this._clap(when, level, panner);
  }

  _kick(when, level, panner) {
    const osc = this._register(this.ctx.createOscillator());
    const gain = this._register(this.ctx.createGain());
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.exponentialRampToValueAtTime(45, when + 0.12);
    this._envelope(gain, when, level, 0.002, 0.22);
    osc.connect(gain);
    osc.start(when);
    osc.stop(when + 0.3);
    this._wire([osc, gain, panner], [osc], gain, panner, when);
  }

  _snare(when, level, panner) {
    const noise = this._noiseSource();
    const noiseGain = this._register(this.ctx.createGain());
    const osc = this._register(this.ctx.createOscillator());
    const oscGain = this._register(this.ctx.createGain());
    osc.type = 'triangle';
    osc.frequency.value = 190;
    this._envelope(noiseGain, when, level * 0.8, 0.001, 0.16);
    this._envelope(oscGain, when, level * 0.5, 0.001, 0.09);
    noise.connect(noiseGain);
    osc.connect(oscGain);
    noise.start(when); osc.start(when);
    noise.stop(when + 0.25); osc.stop(when + 0.15);
    this._wire([noise, noiseGain, osc, oscGain, panner], [noise, osc], noiseGain, panner, when);
    oscGain.connect(panner);
  }

  _hihat(when, level, panner, open) {
    const noise = this._noiseSource();
    const hp = this._register(this.ctx.createBiquadFilter());
    const gain = this._register(this.ctx.createGain());
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const decay = open ? 0.3 : 0.05;
    this._envelope(gain, when, level * 0.45, 0.001, decay);
    noise.connect(hp); hp.connect(gain);
    noise.start(when);
    noise.stop(when + decay + 0.05);
    this._wire([noise, hp, gain, panner], [noise], gain, panner, when);
  }

  _clap(when, level, panner) {
    const noise = this._noiseSource();
    const bp = this._register(this.ctx.createBiquadFilter());
    const gain = this._register(this.ctx.createGain());
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 1.2;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(level * 0.7, when + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
    noise.connect(bp); bp.connect(gain);
    noise.start(when);
    noise.stop(when + 0.25);
    this._wire([noise, bp, gain, panner], [noise], gain, panner, when);
  }

  // Interactive hit feedback: short blip, pitch reflects judgment tier.
  playHit(tier, laneId) {
    if (!this.ctx) return;
    const when = this.ctx.currentTime;
    const panner = this._panner(LANES[laneId].pan);
    const osc = this._register(this.ctx.createOscillator());
    const gain = this._register(this.ctx.createGain());
    const base = tier === 'perfect' ? 880 : tier === 'good' ? 660 : 220;
    osc.type = tier === 'miss' ? 'sawtooth' : 'square';
    osc.frequency.setValueAtTime(base, when);
    osc.frequency.exponentialRampToValueAtTime(base * 1.5, when + 0.08);
    this._envelope(gain, when, this.params.hitGain * 0.5, 0.002, 0.1);
    osc.connect(gain);
    osc.start(when);
    osc.stop(when + 0.15);
    this._wire([osc, gain, panner], [osc], gain, panner, when);
  }

  // Look-ahead scheduler: schedule every chart drum once, anchored to
  // ctx.currentTime so suspend()/resume() cannot drift audio vs notes.
  startScheduler(chart, startAt) {
    this.stopScheduler();
    const lookAhead = 0.25;
    let cursor = 0;
    const tick = () => {
      this.tickCount += 1;
      try {
        if (!this.ctx) return;
        const horizon = this.ctx.currentTime + lookAhead;
        // The cursor only advances once a note actually enters the scheduling
        // window, so an early tick with an empty horizon cannot consume notes.
        while (cursor < chart.notes.length) {
          const note = chart.notes[cursor];
          const at = startAt + note.time;
          if (at > horizon) break;
          const lane = LANES[note.lane];
          this.playDrum(lane.drum, at, lane.pan);
          cursor += 1;
        }
        this._lastScheduleTime = this.ctx.currentTime;
        if (cursor >= chart.notes.length) this.stopScheduler();
      } catch (err) {
        this.lastSchedulerError = err.stack || String(err);
        this.stopScheduler();
      }
    };
    tick();
    this.schedulerTimer = setInterval(tick, 50);
  }

  stopScheduler() {
    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  async suspend() {
    this.stopScheduler();
    if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend();
  }

  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  // Full teardown: ramps gain down first so no tail rings after close.
  async destroy() {
    this.stopScheduler();
    if (this.ctx) {
      const now = this.ctx.currentTime;
      try {
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setValueAtTime(this.master.gain.value, now);
        this.master.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
      } catch { /* context may already be gone */ }
      await new Promise((resolve) => setTimeout(resolve, 60));
      try { await this.ctx.close(); } catch { /* noop */ }
    }
    this.nodes.forEach((node) => {
      try { node.disconnect(); } catch { /* noop */ }
    });
    this.nodes.clear();
    this.ctx = null;
    this.master = null;
    this.compressor = null;
    this.noiseBuffer = null;
  }

  // Offline render of the full chart for WAV export; shares voice recipes.
  static async renderOffline(params, chart) {
    const sampleRate = 44100;
    const total = Math.ceil((chart.duration + 0.5) * sampleRate);
    const offline = new OfflineAudioContext(2, total, sampleRate);
    const master = offline.createGain();
    master.gain.value = params.masterGain;
    master.connect(offline.destination);
    const renderer = new OfflineVoice(offline, master, params);
    for (const note of chart.notes) {
      const lane = LANES[note.lane];
      renderer.drum(lane.drum, note.time, lane.pan);
    }
    const rendered = await offline.startRendering();
    return { buffer: rendered, wav: encodeWav(rendered) };
  }
}

// Minimal subset mirroring AudioEngine voices for deterministic offline export.
class OfflineVoice {
  constructor(ctx, master, params) {
    this.ctx = ctx;
    this.master = master;
    this.params = params;
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i += 1) d[i] = Math.random() * 2 - 1;
  }

  _pan(value) {
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = value;
    panner.connect(this.master);
    return panner;
  }

  drum(kind, when, panValue) {
    const level = this.params.drumGain;
    const out = this._pan(panValue);
    const gain = this.ctx.createGain();
    if (kind === 'hihat' || kind === 'clap') {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      const filt = this.ctx.createBiquadFilter();
      filt.type = kind === 'hihat' ? 'highpass' : 'bandpass';
      filt.frequency.value = kind === 'hihat' ? 7000 : 1400;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(level * 0.5, when + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + (kind === 'hihat' ? 0.06 : 0.18));
      src.connect(filt); filt.connect(gain); gain.connect(out);
      src.start(when); src.stop(when + 0.3);
      return;
    }
    const osc = this.ctx.createOscillator();
    osc.type = kind === 'kick' ? 'sine' : 'triangle';
    osc.frequency.value = kind === 'kick' ? 120 : 190;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(level, when + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + (kind === 'kick' ? 0.22 : 0.12));
    osc.connect(gain); gain.connect(out);
    osc.start(when); osc.stop(when + 0.3);
  }
}

export function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const rate = buffer.sampleRate;
  const frames = buffer.length;
  const dataSize = frames * channels * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  const chans = [];
  for (let c = 0; c < channels; c += 1) chans.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const sample = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}
