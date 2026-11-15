const SPECTRUM_BINS = 48;

export class DualTrackAudio {
  constructor() {
    this.context = null;
    this.master = null;
    this.lanes = [];
    this.activeVoices = new Set();
    this.calibrationOscillators = [];
    this.calibration = null;
    this.voiceSerial = 0;
    this.focusedLane = 0;
    this.paused = false;
  }

  async init() {
    if (this.context) {
      if (this.context.state === "suspended" && !this.paused) await this.context.resume();
      return this.context;
    }
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio API unavailable");
    const context = new AudioContextClass();
    const compressor = context.createDynamicsCompressor();
    const master = context.createGain();
    compressor.threshold.value = -20;
    compressor.knee.value = 18;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.25;
    master.gain.value = 0.72;
    master.connect(compressor).connect(context.destination);
    this.context = context;
    this.master = master;
    this.lanes = [this._createLane(0), this._createLane(1)];
    this.setFocus(0, true);
    if (context.state === "suspended") await context.resume();
    return context;
  }

  _createLane(lane) {
    const context = this.context;
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.76;
    const focusGain = context.createGain();
    focusGain.gain.value = lane === 0 ? 1 : 0.38;
    const muffle = context.createBiquadFilter();
    muffle.type = "lowpass";
    muffle.frequency.value = 18_000;
    muffle.Q.value = 0.4;
    const panner = context.createStereoPanner();
    panner.pan.value = lane === 0 ? -0.86 : 0.86;
    const droneGain = context.createGain();
    droneGain.gain.value = 0.012;
    const drone = context.createOscillator();
    drone.type = lane === 0 ? "sine" : "triangle";
    drone.frequency.value = lane === 0 ? 110 : 440;
    const dronePan = context.createStereoPanner();
    dronePan.pan.value = lane === 0 ? -0.72 : 0.72;
    const bytes = new Uint8Array(analyser.frequencyBinCount);
    drone.connect(droneGain).connect(dronePan).connect(analyser);
    analyser.connect(focusGain).connect(muffle).connect(this.master);
    drone.start();
    return { analyser, focusGain, muffle, panner, drone, droneGain, bytes, lane };
  }

  setFocus(lane, immediate = false) {
    this.focusedLane = lane === 1 ? 1 : 0;
    if (!this.context) return;
    const now = this.context.currentTime;
    this.lanes.forEach((bus, index) => {
      const target = index === this.focusedLane ? 1 : 0.38;
      bus.focusGain.gain.cancelScheduledValues(now);
      if (immediate) bus.focusGain.gain.setValueAtTime(target, now);
      else bus.focusGain.gain.setTargetAtTime(target, now, 0.045);
    });
  }

  setBlur(lane, active) {
    if (!this.context || !this.lanes[lane]) return;
    const filter = this.lanes[lane].muffle;
    const now = this.context.currentTime;
    filter.frequency.cancelScheduledValues(now);
    filter.frequency.setTargetAtTime(active ? 480 : 18_000, now, active ? 0.025 : 0.14);
    filter.Q.setTargetAtTime(active ? 4.5 : 0.4, now, 0.04);
  }

  triggerNote(note, judgment = "perfect") {
    if (!this.context || this.paused) return;
    if (this.activeVoices.size >= 28) {
      this._retireVoice(this.activeVoices.values().next().value);
    }
    const context = this.context;
    const now = context.currentTime;
    const lane = note.lane === 1 ? 1 : 0;
    const bus = this.lanes[lane];
    const oscillator = context.createOscillator();
    const harmonic = context.createOscillator();
    const voiceGain = context.createGain();
    const harmonicGain = context.createGain();
    const panner = context.createStereoPanner();
    const analyser = context.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.55;
    const quality = judgment === "perfect" ? 1 : judgment === "good" ? 0.72 : 0.48;
    oscillator.type = lane === 0 ? "sine" : "triangle";
    oscillator.frequency.value = note.freq || (lane === 0 ? 110 : 440);
    harmonic.type = lane === 0 ? "triangle" : "sine";
    harmonic.frequency.value = oscillator.frequency.value * (lane === 0 ? 2 : 1.5);
    harmonicGain.gain.value = lane === 0 ? 0.16 : 0.09;
    voiceGain.gain.setValueAtTime(0.0001, now);
    voiceGain.gain.exponentialRampToValueAtTime(0.18 * quality, now + 0.012);
    voiceGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.48);
    panner.pan.setValueAtTime(note.pan ?? (lane === 0 ? -0.86 : 0.86), now);
    oscillator.connect(voiceGain);
    harmonic.connect(harmonicGain).connect(voiceGain);
    voiceGain.connect(panner).connect(analyser).connect(bus.analyser);
    oscillator.start(now);
    harmonic.start(now);
    oscillator.stop(now + 0.52);
    harmonic.stop(now + 0.52);
    this.voiceSerial += 1;
    const voice = {
      id: this.voiceSerial,
      lane,
      oscillator,
      harmonic,
      panner,
      analyser,
      startedAt: now
    };
    this.activeVoices.add(voice);
    oscillator.addEventListener("ended", () => this._retireVoice(voice), { once: true });
  }

  _retireVoice(voice) {
    if (!this.activeVoices.delete(voice)) return;
    try {
      voice.oscillator.disconnect();
      voice.harmonic.disconnect();
      voice.panner.disconnect();
      voice.analyser.disconnect();
    } catch {
      // A previously disconnected voice is already fully released.
    }
  }

  spectrum(lane) {
    if (!this.context || !this.lanes[lane]) return null;
    const bus = this.lanes[lane];
    bus.analyser.getByteFrequencyData(bus.bytes);
    const result = new Array(SPECTRUM_BINS).fill(0);
    for (let index = 0; index < SPECTRUM_BINS; index += 1) {
      const sourceIndex = Math.min(bus.bytes.length - 1, Math.floor((index / SPECTRUM_BINS) * 48));
      result[index] = bus.bytes[sourceIndex] / 255;
    }
    for (const voice of this.activeVoices) {
      if (voice.lane !== lane) continue;
      voice.analyser.getByteFrequencyData(bus.bytes);
      for (let index = 0; index < SPECTRUM_BINS; index += 1) {
        const sourceIndex = Math.min(bus.bytes.length - 1, Math.floor((index / SPECTRUM_BINS) * 32));
        result[index] = Math.max(result[index], bus.bytes[sourceIndex] / 255 * 0.85);
      }
    }
    return result;
  }

  async startCalibration() {
    await this.init();
    this.stopCalibration();
    const context = this.context;
    const anchor = context.currentTime + 0.12;
    const interval = 0.6;
    const count = 24;
    const anchorPerformance = performance.now() + 120;
    this.calibration = {
      active: true,
      anchor,
      anchorPerformance,
      intervalMs: interval * 1000,
      count
    };
    for (let index = 0; index < count; index += 1) {
      const start = anchor + index * interval;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "square";
      oscillator.frequency.value = index % 4 === 0 ? 1_320 : 880;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.045);
      oscillator.connect(gain).connect(this.master);
      oscillator.start(start);
      oscillator.stop(start + 0.05);
      this.calibrationOscillators.push(oscillator);
    }
    return this.calibration;
  }

  tapCalibration() {
    if (!this.calibration?.active) return null;
    const elapsed = performance.now() - this.calibration.anchorPerformance;
    const nearestIndex = Math.max(0, Math.round(elapsed / this.calibration.intervalMs));
    if (nearestIndex >= this.calibration.count) return null;
    const nearest = nearestIndex * this.calibration.intervalMs;
    return elapsed - nearest;
  }

  stopCalibration() {
    if (this.context && this.calibrationOscillators.length) {
      const now = this.context.currentTime;
      for (const oscillator of this.calibrationOscillators) {
        try {
          oscillator.stop(now);
          oscillator.disconnect();
        } catch {
          // Already ended.
        }
      }
    }
    this.calibrationOscillators = [];
    if (this.calibration) this.calibration.active = false;
  }

  async pause() {
    this.paused = true;
    if (!this.context) return;
    this.master.gain.cancelScheduledValues(this.context.currentTime);
    this.master.gain.setTargetAtTime(0.0001, this.context.currentTime, 0.025);
    try {
      await this.context.suspend();
    } catch {
      // Context may already be suspended.
    }
  }

  async resume() {
    this.paused = false;
    if (!this.context) return;
    if (this.context.state === "suspended") await this.context.resume();
    this.master.gain.cancelScheduledValues(this.context.currentTime);
    this.master.gain.setTargetAtTime(0.72, this.context.currentTime, 0.03);
  }

  reset() {
    this.stopCalibration();
    for (const voice of [...this.activeVoices]) this._retireVoice(voice);
    this.activeVoices.clear();
    this.voiceSerial = 0;
    if (this.context && !this.paused) {
      this.master.gain.cancelScheduledValues(this.context.currentTime);
      this.master.gain.setValueAtTime(0.72, this.context.currentTime);
    }
    for (const bus of this.lanes) {
      bus.bytes.fill(0);
      bus.muffle.frequency.cancelScheduledValues(this.context?.currentTime || 0);
      if (this.context) bus.muffle.frequency.setValueAtTime(18_000, this.context.currentTime);
    }
    this.setFocus(0, true);
  }

  resources() {
    return {
      status: this.context
        ? (this.paused ? "paused" : this.context.state)
        : "offline",
      laneCount: this.lanes.length,
      analyserCount: this.lanes.length,
      spectrumBins: this.lanes.length * SPECTRUM_BINS,
      activeVoices: this.activeVoices.size,
      calibrationClicks: this.calibrationOscillators.length,
      sampleRate: this.context?.sampleRate || 0
    };
  }
}
