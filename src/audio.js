// Web Audio soundscape. Fully guarded so importing in Node is harmless.
export class SubAudio {
  constructor() {
    this.ctx = null;
    this.enabled = typeof window !== 'undefined';
    this.master = null;
    this.engineGain = null;
    this.engineOsc = null;
    this.noiseNode = null;
    this.noiseGain = null;
    this.lastPhase = null;
    this.lastBlow = false;
  }

  ensure() {
    if (!this.enabled || this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);

    // engine: low oscillator whose frequency tracks thrust, plus filtered noise
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 48;
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0.0;
    this.engineOsc.connect(this.engineGain).connect(this.master);
    this.engineOsc.start();

    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseNode = this.ctx.createBufferSource();
    this.noiseNode.buffer = buffer;
    this.noiseNode.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.noiseNode.connect(filter).connect(this.noiseGain).connect(this.master);
    this.noiseNode.start();
  }

  resume() { this.ensure(); if (this.ctx?.state === 'suspended') this.ctx.resume(); }

  // Called every animation frame with the latest sim snapshot.
  update(s) {
    if (!this.enabled) return;
    this.ensure();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const thrust = Math.abs(s.vx) + (s.engineOn ? 0.15 : 0);
    const targetFreq = 46 + thrust * 55 + s.lightMode * 6;
    this.engineOsc.frequency.setTargetAtTime(targetFreq, t, 0.1);
    this.engineGain.gain.setTargetAtTime(s.engineOn && s.battery > 0 ? 0.05 + thrust * 0.05 : 0, t, 0.12);
    this.noiseGain.gain.setTargetAtTime(s.engineOn ? 0.02 + thrust * 0.03 : 0.005, t, 0.2);

    // emergency blow / valve hiss while active
    if (s.valveBlow && !this.lastBlow) this.hiss(0.16, 700);
    this.lastBlow = s.valveBlow;

    // phase-change stingers
    if (this.lastPhase !== s.phase) {
      if (s.phase === 'RUNAWAY' || s.phase === 'FAILED') this.alarm();
      else if (s.phase === 'SAMPLING') this.blip(880, 0.18, 'triangle');
      else if (s.phase === 'SURFACED') this.blip(660, 0.4, 'sine');
      this.lastPhase = s.phase;
    }
  }

  blip(freq, dur = 0.1, type = 'square', gain = 0.12) {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
    osc.connect(g).connect(this.master);
    osc.start();
    osc.stop(this.ctx.currentTime + dur);
  }

  hiss(gain = 0.1, freq = 600) {
    if (!this.ctx) return;
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.4, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(this.master);
    src.start();
  }

  alarm() {
    if (!this.ctx) return;
    for (let i = 0; i < 3; i++) {
      window.setTimeout(() => this.blip(i % 2 ? 620 : 440, 0.22, 'square', 0.14), i * 240);
    }
  }

  stop() {
    if (this.ctx) { this.ctx.close(); this.ctx = null; }
  }
}
