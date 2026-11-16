// Web Audio engine. Tension drives a continuous drone; cracks, jerks and rope
// snaps trigger one-shot noise/oscillator events. In Node (no AudioContext) it
// degrades to an event log so the same game code runs headless.
export class AudioEngine {
  constructor(win = globalThis) {
    this.available = false;
    this.muted = false;
    this.log = [];
    this._tensionSamples = 0;
    const Ctx = win.AudioContext || win.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);

    this.droneOsc = this.ctx.createOscillator();
    this.droneOsc.type = 'sawtooth';
    this.droneOsc.frequency.value = 70;
    this.droneFilter = this.ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 300;
    this.droneGain = this.ctx.createGain();
    this.droneGain.gain.value = 0.0;
    this.droneOsc.connect(this.droneFilter).connect(this.droneGain).connect(this.master);
    this.droneOsc.start();
    this.available = true;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.5;
  }

  updateTension(tension, stress) {
    // Keep the headless log bounded: retain only a sampled tension trail.
    this._tensionSamples += 1;
    if (this._tensionSamples % 25 === 1) {
      this.log.push({ kind: 'tension', tension, stress });
    }
    if (!this.available || this.muted) return;
    const now = this.ctx.currentTime;
    this.droneGain.gain.setTargetAtTime(0.02 + tension * 0.12, now, 0.08);
    this.droneOsc.frequency.setTargetAtTime(60 + tension * 130, now, 0.08);
    this.droneFilter.frequency.setTargetAtTime(240 + stress * 1400, now, 0.1);
  }

  crack(stress = 0.5) {
    this.log.push({ kind: 'crack', stress });
    if (!this.available || this.muted) return;
    const now = this.ctx.currentTime;
    const noise = this.makeNoise(0.18 + stress * 0.25);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 1400 + stress * 2200;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    noise.connect(filter).connect(gain).connect(this.master);
    noise.start(now);
    noise.stop(now + 0.32);
  }

  jerk(side) {
    this.log.push({ kind: 'jerk', side });
    if (!this.available || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(side === 'left' ? 220 : 180, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.12);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  snap() {
    this.log.push({ kind: 'snap' });
    if (!this.available || this.muted) return;
    const now = this.ctx.currentTime;
    const noise = this.makeNoise(0.5);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    noise.connect(filter).connect(gain).connect(this.master);
    noise.start(now);
    noise.stop(now + 0.52);
  }

  win() {
    this.log.push({ kind: 'win' });
    if (!this.available || this.muted) return;
    const now = this.ctx.currentTime;
    [440, 554, 659].forEach((f, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.12 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.35);
      osc.connect(gain).connect(this.master);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.4);
    });
  }

  makeNoise(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    return src;
  }
}
