import { LIMITS } from "./simulation.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class AudioEngine {
  constructor() {
    this.context = null;
    this.master = null;
    this.windGain = null;
    this.windFilter = null;
    this.sanderGain = null;
    this.sanderOsc = null;
    this.sanderOscHigh = null;
    this.enabled = false;
    this.started = false;
    this.lastFaultId = null;
  }

  get available() {
    return typeof window !== "undefined" && Boolean(window.AudioContext || window.webkitAudioContext);
  }

  async start() {
    if (!this.available) return false;
    if (!this.context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContext();
      this._buildGraph();
    }
    try {
      await this.context.resume();
    } catch {
      return false;
    }
    this.started = true;
    this.setEnabled(true);
    return true;
  }

  _buildGraph() {
    const ctx = this.context;
    this.master = ctx.createGain();
    this.master.gain.value = 0.42;
    this.master.connect(ctx.destination);

    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    let smooth = 0;
    for (let i = 0; i < data.length; i += 1) {
      smooth = smooth * 0.82 + (Math.random() * 2 - 1) * 0.18;
      data[i] = smooth;
    }

    const windSource = ctx.createBufferSource();
    windSource.buffer = noiseBuffer;
    windSource.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "bandpass";
    this.windFilter.frequency.value = 420;
    this.windFilter.Q.value = 0.48;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSource.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    windSource.start();

    this.sanderOsc = ctx.createOscillator();
    this.sanderOsc.type = "sawtooth";
    this.sanderOsc.frequency.value = 86;
    const sanderFilter = ctx.createBiquadFilter();
    sanderFilter.type = "bandpass";
    sanderFilter.frequency.value = 340;
    sanderFilter.Q.value = 2.9;
    this.sanderGain = ctx.createGain();
    this.sanderGain.gain.value = 0;
    this.sanderOsc.connect(sanderFilter);
    sanderFilter.connect(this.sanderGain);
    this.sanderGain.connect(this.master);
    this.sanderOsc.start();

    this.sanderOscHigh = ctx.createOscillator();
    this.sanderOscHigh.type = "square";
    this.sanderOscHigh.frequency.value = 244;
    const highGain = ctx.createGain();
    highGain.gain.value = 0.08;
    this.sanderOscHigh.connect(highGain);
    highGain.connect(this.sanderGain);
    this.sanderOscHigh.start();
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.master || !this.context) return this.enabled;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(this.enabled ? 0.42 : 0, now, 0.08);
    return this.enabled;
  }

  update(view) {
    if (!this.started || !view) return;
    const ctx = this.context;
    const now = ctx.currentTime;
    const windNormalized = clamp((view.env.wind - 3) / 17, 0, 1);
    const gust = clamp(view.env.gust / 8, 0, 1);

    this.windGain.gain.setTargetAtTime(0.022 + windNormalized * 0.115 + gust * 0.05, now, 0.15);
    this.windFilter.frequency.setTargetAtTime(260 + windNormalized * 760 + gust * 260, now, 0.2);
    this.windFilter.Q.setTargetAtTime(0.4 + windNormalized * 0.65, now, 0.25);

    const sanderActive = view.equipment.sander.active;
    const contact = clamp(1 - Math.max(0, view.platform.sway - LIMITS.contact) / 0.9, 0.15, 1);
    const motor = sanderActive ? 0.028 + contact * 0.048 : 0;
    this.sanderGain.gain.setTargetAtTime(motor, now, 0.04);
    this.sanderOsc.frequency.setTargetAtTime(80 + contact * 34 + view.env.wind * 0.9, now, 0.06);
    this.sanderOscHigh.frequency.setTargetAtTime(235 + contact * 55 + Math.sin(view.t * 16) * 4, now, 0.06);

    const faultId = view.currentFaultId;
    if (faultId && faultId !== this.lastFaultId) {
      this.lastFaultId = faultId;
      this.alarm(view.fault?.kind);
    } else if (!faultId) {
      this.lastFaultId = null;
    }
  }

  alarm(kind) {
    if (!this.context || !this.enabled) return;
    const ctx = this.context;
    const now = ctx.currentTime;
    const count = kind === "INSTABILITY" ? 3 : 2;
    for (let i = 0; i < count; i += 1) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "square";
      oscillator.frequency.value = i % 2 ? 740 : 560;
      gain.gain.setValueAtTime(0.0001, now + i * 0.17);
      gain.gain.linearRampToValueAtTime(0.055, now + i * 0.17 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.17 + 0.13);
      oscillator.connect(gain);
      gain.connect(this.master);
      oscillator.start(now + i * 0.17);
      oscillator.stop(now + i * 0.17 + 0.15);
    }
  }

  chime() {
    if (!this.context || !this.enabled) return;
    const ctx = this.context;
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + index * 0.1);
      gain.gain.linearRampToValueAtTime(0.035, now + index * 0.1 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.1 + 0.55);
      oscillator.connect(gain);
      gain.connect(this.master);
      oscillator.start(now + index * 0.1);
      oscillator.stop(now + index * 0.1 + 0.6);
    });
  }
}
