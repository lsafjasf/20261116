export class FlightAudio {
  constructor() {
    this.context = null;
    this.master = null;
    this.engineOscillator = null;
    this.engineGain = null;
    this.engineFilter = null;
    this.pumpOscillator = null;
    this.pumpGain = null;
    this.pumpFilter = null;
    this.enabled = false;
    this.lastWarningAt = 0;
  }

  async enable() {
    if (this.enabled) return true;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return false;
    this.context = this.context || new AudioContext();
    if (this.context.state === "suspended") await this.context.resume();

    if (!this.master) {
      this.master = this.context.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.context.destination);

      this.engineFilter = this.context.createBiquadFilter();
      this.engineFilter.type = "lowpass";
      this.engineFilter.frequency.value = 680;
      this.engineFilter.Q.value = 1.4;
      this.engineGain = this.context.createGain();
      this.engineGain.gain.value = 0;
      this.engineOscillator = this.context.createOscillator();
      this.engineOscillator.type = "sawtooth";
      this.engineOscillator.frequency.value = 54;
      this.engineOscillator.connect(this.engineFilter);
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.master);
      this.engineOscillator.start();

      this.pumpFilter = this.context.createBiquadFilter();
      this.pumpFilter.type = "bandpass";
      this.pumpFilter.frequency.value = 220;
      this.pumpFilter.Q.value = 3.5;
      this.pumpGain = this.context.createGain();
      this.pumpGain.gain.value = 0;
      this.pumpOscillator = this.context.createOscillator();
      this.pumpOscillator.type = "triangle";
      this.pumpOscillator.frequency.value = 96;
      this.pumpOscillator.connect(this.pumpFilter);
      this.pumpFilter.connect(this.pumpGain);
      this.pumpGain.connect(this.master);
      this.pumpOscillator.start();
    }

    this.enabled = true;
    return true;
  }

  disable() {
    this.enabled = false;
    if (this.context) this.context.suspend();
  }

  async toggle() {
    if (this.enabled) {
      this.disable();
      return false;
    }
    return this.enable();
  }

  update(frame) {
    if (!this.enabled || !this.context || !frame) return;
    const now = this.context.currentTime;
    const rpm = frame.left?.rpm || 0;
    const pressure = frame.right?.pressure || 0;
    const failed = frame.stage === "FAILED";
    const safe = frame.shared?.alerts?.some((alert) => alert.level === "danger") ? 0.07 : 0;
    const engineLevel = failed ? 0 : Math.min(0.17, 0.012 + (rpm / 3400) * 0.135);
    const pumpLevel = failed ? 0 : Math.min(0.1, pressure * 0.00115);
    const engineHz = 42 + (rpm / 3400) * 168;
    const pumpHz = 82 + pressure * 3.5;

    this.engineOscillator.frequency.setTargetAtTime(engineHz + safe, now, 0.08);
    this.engineGain.gain.setTargetAtTime(engineLevel, now, 0.09);
    this.engineFilter.frequency.setTargetAtTime(420 + rpm * 0.14, now, 0.12);
    this.pumpOscillator.frequency.setTargetAtTime(pumpHz, now, 0.1);
    this.pumpGain.gain.setTargetAtTime(pumpLevel, now, 0.11);
    this.pumpFilter.frequency.setTargetAtTime(170 + pressure * 2.8, now, 0.12);
  }

  alert() {
    if (!this.enabled || !this.context) return;
    const now = this.context.currentTime;
    if (now - this.lastWarningAt < 0.4) return;
    this.lastWarningAt = now;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(720, now);
    oscillator.frequency.exponentialRampToValueAtTime(410, now + 0.11);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.075, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.17);
  }

  collision() {
    if (!this.enabled || !this.context) return;
    const now = this.context.currentTime;
    const buffer = this.context.createBuffer(1, this.context.sampleRate * 0.32, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) {
      const envelope = Math.exp(-index / (this.context.sampleRate * 0.055));
      data[index] = (Math.random() * 2 - 1) * envelope;
    }
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    filter.type = "lowpass";
    filter.frequency.value = 240;
    gain.gain.value = 0.38;
    source.buffer = buffer;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(now);
  }
}
