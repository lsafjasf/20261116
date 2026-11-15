import * as C from './config.js';

// Web Audio soundscape: a continuous drone whose pitch and filter track the
// gate/channel pressure differential, plus alarm and collision blips.
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = false;
  }

  async start() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.12;
      this.master.connect(this.ctx.destination);

      this.osc = this.ctx.createOscillator();
      this.osc.type = 'sawtooth';
      this.filter = this.ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.osc.connect(this.filter).connect(this.master);
      this.osc.start();

      this.lfo = this.ctx.createOscillator();
      this.lfo.frequency.value = 4;
      this.lfoGain = this.ctx.createGain();
      this.lfo.connect(this.lfoGain).connect(this.osc.frequency);
      this.lfo.start();
    }
    await this.ctx.resume();
    this.enabled = true;
  }

  stop() {
    this.enabled = false;
    if (this.ctx) this.ctx.suspend();
  }

  // pressure in kPa; map onto an audible pitch and brightness range.
  update(pressure, heat) {
    if (!this.enabled || !this.ctx) return;
    const now = this.ctx.currentTime;
    const norm = Math.min(1, pressure / (C.PRESSURE_CRITICAL * 1.4));
    const freq = 70 + norm * 320;
    this.osc.frequency.setTargetAtTime(freq, now, 0.1);
    this.filter.frequency.setTargetAtTime(300 + norm * 2600, now, 0.1);
    this.lfoGain.gain.setTargetAtTime(norm * 18, now, 0.2);
    this.master.gain.setTargetAtTime(0.08 + norm * 0.12, now, 0.2);
    if (heat >= C.OVERHEAT_TEMP - 8) {
      this.osc.type = 'square';
    } else {
      this.osc.type = 'sawtooth';
    }
  }

  blip(freq = 880, duration = 0.12, type = 'triangle', volume = 0.5) {
    if (!this.enabled || !this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    osc.connect(gain).connect(this.master);
    osc.start();
    osc.stop(this.ctx.currentTime + duration);
  }

  collision() {
    this.blip(140, 0.35, 'sawtooth', 0.7);
  }

  alarm() {
    this.blip(660, 0.1, 'square', 0.4);
  }
}
