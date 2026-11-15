import { MATERIALS } from "./config.js";

const MATERIAL_TONES = {
  basalt: { type: "sine", frequency: 196, overtone: 1 },
  granite: { type: "triangle", frequency: 294, overtone: 1.5 },
  shale: { type: "sine", frequency: 147, overtone: 0.75 },
  crystal: { type: "sine", frequency: 587, overtone: 2.01 },
  gate: { type: "triangle", frequency: 440, overtone: 1.5 },
  patrol: { type: "sawtooth", frequency: 92, overtone: 1.02 },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.flowGain = null;
    this.flowSource = null;
    this.active = new Set();
    this.muted = false;
    this.paused = false;
    this.eventsPlayed = 0;
    this.resetCount = 0;
    this.noiseSeed = 0x1a2b3c4d;
  }

  async init() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    this.ctx = new AudioContextClass();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0.0001 : 0.72;
    this.master.connect(this.ctx.destination);
    this.startAmbient();
  }

  startAmbient() {
    if (!this.ctx || this.flowSource) return;
    const duration = 2.5;
    const buffer = this.ctx.createBuffer(
      2,
      Math.floor(this.ctx.sampleRate * duration),
      this.ctx.sampleRate,
    );
    let seed = 0x1a2b3c4d;
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < data.length; index += 1) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        data[index] = ((seed >>> 0) / 0xffffffff) * 2 - 1;
      }
    }
    this.flowSource = this.ctx.createBufferSource();
    this.flowSource.buffer = buffer;
    this.flowSource.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 240;
    filter.Q.value = 0.8;
    this.flowGain = this.ctx.createGain();
    this.flowGain.gain.value = 0;
    this.flowSource.connect(filter);
    filter.connect(this.flowGain);
    this.flowGain.connect(this.master);
    this.flowSource.start();
  }

  stopVoices() {
    for (const source of this.active) {
      try {
        source.stop();
      } catch {
        // A source that already stopped is safe to ignore.
      }
    }
    this.active.clear();
  }

  reset() {
    this.stopVoices();
    this.resetCount += 1;
    this.eventsPlayed = 0;
    this.noiseSeed = 0x1a2b3c4d;
    this.paused = false;
    if (this.flowSource) {
      try {
        this.flowSource.stop();
      } catch {
        // Ignore an already stopped ambient source.
      }
    }
    this.flowSource = null;
    this.flowGain = null;
    if (!this.ctx) return;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(this.muted ? 0.0001 : 0.72, this.ctx.currentTime, 0.015);
    this.startAmbient();
  }

  setMuted(muted) {
    this.muted = muted;
    if (!this.ctx) return;
    const level = muted ? 0.0001 : 0.72;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(level, this.ctx.currentTime, 0.025);
  }

  setPaused(paused) {
    this.paused = paused;
    if (!this.ctx) return;
    if (paused) {
      this.stopVoices();
      if (this.flowGain) {
        this.flowGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
      }
    } else if (!this.muted) {
      this.master.gain.setTargetAtTime(0.72, this.ctx.currentTime, 0.04);
    }
  }

  setAmbient(flowStrength, exposure, status) {
    if (!this.ctx || !this.flowGain) return;
    const paused = status !== "RUNNING";
    const target = paused ? 0 : 0.008 + clamp(flowStrength, 0, 1) * 0.045;
    this.flowGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.12);
    if (exposure > 20 && this.master) {
      const audible = this.muted ? 0.0001 : 0.72;
      this.master.gain.setTargetAtTime(audible, this.ctx.currentTime, 0.1);
    }
  }

  makePan(pan) {
    if (!this.ctx.createStereoPanner) return null;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1);
    return panner;
  }

  tone({
    frequency,
    endFrequency = frequency,
    duration = 0.2,
    gain = 0.08,
    type = "sine",
    delay = 0,
    pan = 0,
    filterFrequency = 0,
  }) {
    if (!this.ctx || !this.master) return;
    const start = this.ctx.currentTime + Math.max(0, delay);
    const oscillator = this.ctx.createOscillator();
    const envelope = this.ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(Math.max(20, frequency), start);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(20, endFrequency),
      start + duration,
    );
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), start + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    let output = envelope;
    const panner = this.makePan(pan);
    if (panner) {
      envelope.connect(panner);
      output = panner;
    }
    if (filterFrequency > 0) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = filterFrequency;
      oscillator.connect(filter);
      filter.connect(envelope);
    } else {
      oscillator.connect(envelope);
    }
    output.connect(this.master);
    this.active.add(oscillator);
    oscillator.onended = () => this.active.delete(oscillator);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.03);
  }

  noiseBurst({ duration = 0.1, gain = 0.06, delay = 0, pan = 0, lowpass = 520 }) {
    if (!this.ctx || !this.master) return;
    const length = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = this.noiseSeed >>> 0;
    for (let index = 0; index < length; index += 1) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[index] = (((seed >>> 0) / 0xffffffff) * 2 - 1) * (1 - index / length);
    }
    this.noiseSeed = seed >>> 0;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = lowpass;
    const envelope = this.ctx.createGain();
    envelope.gain.value = gain;
    let output = envelope;
    const panner = this.makePan(pan);
    if (panner) {
      envelope.connect(panner);
      output = panner;
    }
    source.connect(filter);
    filter.connect(envelope);
    output.connect(this.master);
    const start = this.ctx.currentTime + delay;
    this.active.add(source);
    source.onended = () => this.active.delete(source);
    source.start(start);
  }

  playScan(event) {
    this.tone({
      frequency: 840,
      endFrequency: 260,
      duration: 0.48,
      gain: 0.1,
      type: "sine",
      pan: 0,
    });
    this.tone({
      frequency: 420,
      endFrequency: 620,
      duration: 0.16,
      gain: 0.025,
      type: "triangle",
      delay: 0.04,
    });
    const echoes = Array.isArray(event.echoes) ? event.echoes.slice(0, 20) : [];
    for (const echo of echoes) {
      const tone = MATERIAL_TONES[echo.materialKey] ?? MATERIAL_TONES.basalt;
      const delay = 0.06 + Math.min(1.35, echo.distance * 0.052);
      const gain = clamp(echo.intensity, 0.01, 0.9) * 0.075;
      const pan = Math.sin(echo.angle || 0) * 0.8;
      this.tone({
        frequency: tone.frequency,
        endFrequency: tone.frequency * 0.985,
        duration: 0.16 + Math.min(0.2, echo.distance * 0.006),
        gain,
        type: tone.type,
        delay,
        pan,
      });
      if (tone.overtone !== 1 && gain > 0.035) {
        this.tone({
          frequency: tone.frequency * tone.overtone,
          endFrequency: tone.frequency * tone.overtone * 0.99,
          duration: 0.12,
          gain: gain * 0.36,
          type: "sine",
          delay: delay + 0.015,
          pan: pan * 0.85,
        });
      }
    }
  }

  playEvent(event) {
    if (!this.ctx || !event) return;
    this.eventsPlayed += 1;
    if (this.paused) return;
    switch (event.type) {
      case "start":
        this.tone({
          frequency: 70,
          endFrequency: 150,
          duration: 0.75,
          gain: 0.045,
          type: "sine",
        });
        break;
      case "scan":
        this.playScan(event);
        break;
      case "patrolPing":
        this.tone({
          frequency: 66 + (event.patrolId ?? 0) * 5,
          endFrequency: 58,
          duration: 0.34,
          gain: clamp(0.09 / (1 + (event.distance ?? 0) * 0.15), 0.006, 0.08),
          type: "sawtooth",
          pan: event.pan ?? 0,
          filterFrequency: 180,
        });
        break;
      case "bump":
        this.noiseBurst({ duration: 0.16, gain: 0.08, lowpass: 320 });
        break;
      case "denied":
        this.tone({
          frequency: 150,
          endFrequency: 120,
          duration: 0.09,
          gain: 0.035,
          type: "square",
        });
        break;
      case "pause":
        this.tone({
          frequency: 240,
          endFrequency: 120,
          duration: 0.18,
          gain: 0.035,
          type: "sine",
        });
        break;
      case "resume":
        this.tone({
          frequency: 120,
          endFrequency: 260,
          duration: 0.2,
          gain: 0.035,
          type: "sine",
        });
        break;
      case "recover":
        [110, 165, 220].forEach((frequency, index) => {
          this.tone({
            frequency,
            endFrequency: frequency * 1.1,
            duration: 0.24,
            gain: 0.05,
            type: "triangle",
            delay: index * 0.11,
          });
        });
        break;
      case "fail":
        [170, 112, 68].forEach((frequency, index) => {
          this.tone({
            frequency,
            endFrequency: frequency * 0.62,
            duration: 0.44,
            gain: 0.075,
            type: "sawtooth",
            delay: index * 0.18,
            filterFrequency: 420,
          });
        });
        break;
      case "success":
        [330, 495, 660, 990].forEach((frequency, index) => {
          this.tone({
            frequency,
            endFrequency: frequency * 1.005,
            duration: 0.54,
            gain: 0.05,
            type: "sine",
            delay: index * 0.13,
          });
        });
        break;
      default:
        break;
    }
  }

  debugState() {
    return {
      available: Boolean(this.ctx),
      contextState: this.ctx?.state ?? "unavailable",
      muted: this.muted,
      paused: this.paused,
      activeSources: this.active.size,
      eventsPlayed: this.eventsPlayed,
      resetCount: this.resetCount,
      materialProfiles: Object.keys(MATERIALS).length,
    };
  }
}
