function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class TensionAudio {
  constructor() {
    this.context = null;
    this.enabled = false;
    this.master = null;
    this.left = null;
    this.right = null;
    this.windGain = null;
    this.leftFilter = null;
    this.rightFilter = null;
  }

  async enable() {
    if (!this.context) this.createGraph();
    await this.context.resume();
    this.enabled = true;
    this.master.gain.setTargetAtTime(0.62, this.context.currentTime, 0.08);
    return true;
  }

  async disable() {
    if (!this.context) return false;
    this.enabled = false;
    this.master.gain.setTargetAtTime(0, this.context.currentTime, 0.05);
    return false;
  }

  createGraph() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContextClass();
    this.master = this.context.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.context.destination);

    this.left = this.createVoice("sawtooth", -0.72, 82);
    this.right = this.createVoice("triangle", 0.72, 138);

    const noise = this.context.createBuffer(
      1,
      this.context.sampleRate * 2,
      this.context.sampleRate,
    );
    const data = noise.getChannelData(0);
    let last = 0;
    for (let index = 0; index < data.length; index += 1) {
      const white = Math.random() * 2 - 1;
      last = last * 0.94 + white * 0.06;
      data[index] = last;
    }
    const wind = this.context.createBufferSource();
    wind.buffer = noise;
    wind.loop = true;
    const windFilter = this.context.createBiquadFilter();
    windFilter.type = "bandpass";
    windFilter.frequency.value = 620;
    windFilter.Q.value = 0.4;
    this.windGain = this.context.createGain();
    this.windGain.gain.value = 0.012;
    wind.connect(windFilter).connect(this.windGain).connect(this.master);
    wind.start();
  }

  createVoice(type, pan, frequency) {
    const oscillator = this.context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.value = frequency;

    const sub = this.context.createOscillator();
    sub.type = "sine";
    sub.frequency.value = frequency / 2;

    const filter = this.context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 500;
    filter.Q.value = 1.1;

    const gain = this.context.createGain();
    gain.gain.value = 0.015;

    const subGain = this.context.createGain();
    subGain.gain.value = 0.008;

    const panner = this.context.createStereoPanner
      ? this.context.createStereoPanner()
      : null;
    oscillator.connect(filter).connect(gain);
    sub.connect(subGain).connect(filter);
    if (panner) {
      panner.pan.value = pan;
      gain.connect(panner).connect(this.master);
    } else {
      gain.connect(this.master);
    }

    oscillator.start();
    sub.start();
    return { oscillator, sub, filter, gain, subGain };
  }

  update(view) {
    if (!this.context || !this.enabled) return;
    const now = this.context.currentTime;
    const leftTension = clamp(Number(view.leftTension) || 0, 0, 100);
    const rightTension = clamp(Number(view.rightTension) || 0, 0, 100);
    const leftAlive = view.leftWinch !== "severed";
    const rightAlive = view.rightWinch !== "severed";
    const wind = clamp(Number(view.wind?.pressure) || 0, 0, 1);
    const speedLeft = Math.max(0, Number(view.leftSpeed) || 0);
    const speedRight = Math.max(0, Number(view.rightSpeed) || 0);

    this.left.oscillator.frequency.setTargetAtTime(
      70 + leftTension * 1.05 + Math.min(speedLeft, 260) * 0.09,
      now,
      0.14,
    );
    this.left.sub.frequency.setTargetAtTime(
      35 + leftTension * 0.52,
      now,
      0.18,
    );
    this.right.oscillator.frequency.setTargetAtTime(
      132 + rightTension * 1.42 + Math.min(speedRight, 260) * 0.13,
      now,
      0.11,
    );
    this.right.sub.frequency.setTargetAtTime(
      66 + rightTension * 0.7,
      now,
      0.16,
    );
    this.left.filter.frequency.setTargetAtTime(
      300 + leftTension * 9 + speedLeft * 1.1,
      now,
      0.16,
    );
    this.right.filter.frequency.setTargetAtTime(
      420 + rightTension * 10 + speedRight * 1.4,
      now,
      0.12,
    );
    this.left.gain.gain.setTargetAtTime(
      leftAlive ? 0.012 + leftTension * 0.00022 : 0,
      now,
      0.08,
    );
    this.right.gain.gain.setTargetAtTime(
      rightAlive ? 0.009 + rightTension * 0.00025 : 0,
      now,
      0.08,
    );
    this.left.subGain.gain.setTargetAtTime(
      leftAlive ? 0.004 + leftTension * 0.0001 : 0,
      now,
      0.1,
    );
    this.right.subGain.gain.setTargetAtTime(
      rightAlive ? 0.003 + rightTension * 0.00012 : 0,
      now,
      0.1,
    );
    this.windGain.gain.setTargetAtTime(0.005 + wind * 0.025, now, 0.3);
  }

  impact(strength = 1) {
    if (!this.context || !this.enabled) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = "sawtooth";
    oscillator.frequency.setValueAtTime(46, now);
    oscillator.frequency.exponentialRampToValueAtTime(24, now + 0.24);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(
      clamp(0.07 * strength, 0.02, 0.14),
      now + 0.008,
    );
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.32);
  }
}
