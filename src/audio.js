export class MechanicalAudio {
  constructor() {
    this.context = null;
    this.enabled = true;
    this.master = null;
    this.hum = null;
    this.humGain = null;
    this.nextBeatAt = 0;
    this.lastCueAt = 0;
  }

  async unlock() {
    if (this.context) {
      if (this.context.state === 'suspended') await this.context.resume();
      return;
    }
    const AudioContextClass =
      window.AudioContext ?? window.webkitAudioContext ?? null;
    if (!AudioContextClass) return;
    this.context = new AudioContextClass();
    this.master = this.context.createGain();
    this.master.gain.value = this.enabled ? 0.17 : 0;
    this.master.connect(this.context.destination);

    this.hum = this.context.createOscillator();
    this.hum.type = 'sawtooth';
    this.hum.frequency.value = 62;
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 170;
    this.humGain = this.context.createGain();
    this.humGain.gain.value = 0.035;
    this.hum.connect(filter).connect(this.humGain).connect(this.master);
    this.hum.start();
    this.nextBeatAt = this.context.currentTime + 0.15;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!this.master || !this.context) return;
    this.master.gain.setTargetAtTime(
      enabled ? 0.17 : 0,
      this.context.currentTime,
      0.03
    );
  }

  toggle() {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  pulse(frequency, duration, volume, type = 'triangle', detune = 0) {
    if (!this.context || !this.enabled) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.detune.value = detune;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  click(strength = 1, pitch = 0, warning = false) {
    this.pulse(warning ? 118 : 165 + pitch, 0.035, 0.12 * strength, 'square');
    this.pulse(warning ? 72 : 94 + pitch * 0.4, 0.07, 0.08 * strength, 'triangle');
  }

  cue(kind) {
    if (!this.context || !this.enabled) return;
    const now = this.context.currentTime;
    if (now - this.lastCueAt < 0.045) return;
    this.lastCueAt = now;
    if (kind === 'scan') {
      this.pulse(880, 0.055, 0.055, 'sine');
      window.setTimeout(() => this.pulse(1320, 0.04, 0.03, 'sine'), 35);
    } else if (kind === 'release' || kind === 'pack') {
      this.pulse(240, 0.07, 0.08, 'square');
    } else if (kind === 'route') {
      this.pulse(440, 0.04, 0.045, 'square');
    } else if (kind === 'collision' || kind === 'overflow') {
      this.pulse(86, 0.3, 0.15, 'sawtooth', -35);
      this.pulse(63, 0.42, 0.11, 'square');
    } else if (kind === 'success') {
      [440, 554, 659, 880].forEach((frequency, index) => {
        window.setTimeout(
          () => this.pulse(frequency, 0.2, 0.065, 'triangle'),
          index * 90
        );
      });
    } else if (kind === 'failure') {
      this.pulse(140, 0.4, 0.11, 'sawtooth');
      window.setTimeout(() => this.pulse(92, 0.7, 0.1, 'square'), 180);
    }
  }

  update(sim, speed = 1, active = true) {
    if (!this.context || !this.enabled) return;
    const now = this.context.currentTime;
    const load = sim.cacheLoad() / 12;
    const contamination = Math.min(
      1,
      (sim.contamination.A + sim.contamination.B) / 4
    );
    const pressure = sim.overflow.A || sim.overflow.B ? 1 : 0;
    const mechanicalRate = Math.max(0.26, 0.9 - load * 0.46) / Math.max(0.75, speed);
    if (active && now >= this.nextBeatAt) {
      this.click(0.55 + load * 0.45, load * 38 + contamination * 24, pressure > 0);
      this.nextBeatAt = now + mechanicalRate;
    }
    if (this.hum) {
      const targetFrequency = 58 + load * 24 + contamination * 35;
      this.hum.frequency.setTargetAtTime(targetFrequency, now, 0.08);
      this.humGain.gain.setTargetAtTime(
        active ? 0.028 + load * 0.045 : 0.012,
        now,
        0.06
      );
    }
  }
}
