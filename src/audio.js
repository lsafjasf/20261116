export class AudioEngine {
  constructor() {
    this.context = null;
    this.master = null;
    this.drone = null;
    this.droneGain = null;
    this.harmonic = null;
    this.harmonicGain = null;
    this.filter = null;
    this.noise = null;
    this.noiseGain = null;
    this.enabled = true;
    this.paused = false;
    this.lastCueTick = -1;
  }

  async ensure() {
    if (this.context) {
      if (this.context.state === "suspended") {
        await this.context.resume();
      }
      return;
    }
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      return;
    }
    this.context = new AudioContext();
    this.master = this.context.createGain();
    this.master.gain.value = this.enabled ? 0.24 : 0;
    this.master.connect(this.context.destination);

    this.filter = this.context.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 440;
    this.filter.Q.value = 2.5;
    this.filter.connect(this.master);

    this.drone = this.context.createOscillator();
    this.drone.type = "sawtooth";
    this.drone.frequency.value = 54;
    this.droneGain = this.context.createGain();
    this.droneGain.gain.value = 0.11;
    this.drone.connect(this.droneGain).connect(this.filter);
    this.drone.start();

    this.harmonic = this.context.createOscillator();
    this.harmonic.type = "sine";
    this.harmonic.frequency.value = 330;
    this.harmonicGain = this.context.createGain();
    this.harmonicGain.gain.value = 0.035;
    this.harmonic.connect(this.harmonicGain).connect(this.master);
    this.harmonic.start();

    this.noise = this.context.createBufferSource();
    const buffer = this.context.createBuffer(1, this.context.sampleRate * 2, this.context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < channel.length; index += 1) {
      channel[index] = Math.random() * 2 - 1;
    }
    this.noise.buffer = buffer;
    this.noise.loop = true;
    this.noiseGain = this.context.createGain();
    this.noiseGain.gain.value = 0.012;
    const noiseFilter = this.context.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 720;
    noiseFilter.Q.value = 0.7;
    this.noise.connect(noiseFilter).connect(this.noiseGain).connect(this.master);
    this.noise.start();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(enabled ? 0.24 : 0, this.context.currentTime, 0.04);
    }
  }

  setPaused(paused) {
    this.paused = paused;
    if (this.context && this.master) {
      const level = this.enabled && !paused ? 0.24 : 0;
      this.master.gain.setTargetAtTime(level, this.context.currentTime, 0.06);
    }
  }

  update(state) {
    if (!this.context || !this.drone || this.paused) {
      return;
    }
    const now = this.context.currentTime;
    const proximity = Math.max(0, Math.min(1, 1 - (state.d - 0.7) / 24));
    const closing = Math.max(-0.3, Math.min(1, -state.vd));
    const frequency = 46 + proximity * 58 + Math.max(0, closing) * 24;
    const harmonicFrequency = 220 + proximity * 360 + state.driftSerial * 3;
    this.drone.frequency.setTargetAtTime(frequency, now, 0.09);
    this.harmonic.frequency.setTargetAtTime(harmonicFrequency, now, 0.12);
    this.harmonicGain.gain.setTargetAtTime(0.018 + proximity * 0.035, now, 0.12);
    this.filter.frequency.setTargetAtTime(280 + proximity * 850, now, 0.1);
    this.droneGain.gain.setTargetAtTime(0.075 + proximity * 0.075, now, 0.1);
  }

  cue(tone = "info") {
    if (!this.context || !this.enabled || this.paused || !this.master) {
      return;
    }
    const settings = {
      start: [260, 0.1],
      lock: [540, 0.13],
      success: [720, 0.16],
      complete: [940, 0.28],
      warn: [170, 0.14],
      danger: [88, 0.3],
      drift: [310, 0.07],
    };
    const [frequency, duration] = settings[tone] || settings.info || [420, 0.08];
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = tone === "danger" ? "square" : "sine";
    oscillator.frequency.setValueAtTime(frequency, now);
    if (tone === "danger") {
      oscillator.frequency.exponentialRampToValueAtTime(42, now + duration);
    }
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.11, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  reset() {
    this.lastCueTick = -1;
    if (!this.context) {
      return;
    }
    const now = this.context.currentTime;
    this.drone.frequency.setTargetAtTime(54, now, 0.05);
    this.harmonic.frequency.setTargetAtTime(330, now, 0.05);
    this.filter.frequency.setTargetAtTime(440, now, 0.05);
  }

  distanceBand(state) {
    if (state.d < 2) return "LOCK";
    if (state.d < 8) return "NEAR";
    if (state.d < 16) return "MID";
    return "FAR";
  }
}
