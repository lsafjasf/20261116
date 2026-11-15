// Fully synthesized audio: motor hum follows the control load, the shutter is
// a short noise burst through a band-pass, and rejected shots get a low buzz.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.motor = null;
    this.motorGain = null;
    this.unlocked = false;
  }

  unlock() {
    if (this.unlocked) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.motor = this.ctx.createOscillator();
    this.motor.type = 'sawtooth';
    this.motor.frequency.value = 48;
    this.motorGain = this.ctx.createGain();
    this.motorGain.gain.value = 0;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    this.motor.connect(filter).connect(this.motorGain).connect(this.ctx.destination);
    this.motor.start();
    this.unlocked = true;
  }

  // load in 0..1 from combined player input; higher load = faster motor.
  updateMotor(load) {
    if (!this.unlocked) return;
    const now = this.ctx.currentTime;
    this.motor.frequency.setTargetAtTime(46 + load * 120, now, 0.05);
    this.motorGain.gain.setTargetAtTime(load > 0.02 ? 0.05 + load * 0.05 : 0, now, 0.06);
  }

  shutter(accepted) {
    if (!this.unlocked) return;
    const now = this.ctx.currentTime;

    // Mechanical two-stage click: mirror slap then curtain.
    for (const [offset, freq, peak] of [[0, 1800, 0.18], [0.055, 900, 0.14]]) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, now + offset);
      gain.gain.setValueAtTime(peak, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.05);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.07);
    }

    // Noise burst for the curtain travel.
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.08, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2600;
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = 0.12;
    noise.connect(band).connect(noiseGain).connect(this.ctx.destination);
    noise.start(now + 0.02);

    if (!accepted) this.buzz(now + 0.12);
  }

  buzz(when) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.setValueAtTime(110, when + 0.12);
    gain.gain.setValueAtTime(0.12, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.3);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(when);
    osc.stop(when + 0.32);
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
}
