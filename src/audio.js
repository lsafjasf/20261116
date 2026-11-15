const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export class BenchAudio {
  constructor() {
    this.context = null;
    this.master = null;
    this.leftDrone = null;
    this.rightDrone = null;
    this.muted = false;
    this.lastPulse = { left: 0, right: 0 };
  }

  async unlock() {
    if (this.context) {
      if (this.context.state === 'suspended') await this.context.resume();
      return;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    this.context = new AudioContextClass();
    this.master = this.context.createGain();
    this.master.gain.value = this.muted ? 0 : 0.44;
    const compressor = this.context.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.ratio.value = 5;
    this.master.connect(compressor).connect(this.context.destination);
    this.leftDrone = this.createDrone('triangle', 86, 'left');
    this.rightDrone = this.createDrone('sawtooth', 176, 'right');
    await this.context.resume();
  }

  createDrone(type, frequency, side) {
    const context = this.context;
    const oscillator = context.createOscillator();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    filter.type = 'lowpass';
    filter.frequency.value = side === 'left' ? 260 : 620;
    filter.Q.value = 0.8;
    gain.gain.value = 0.0001;
    panner.pan.value = side === 'left' ? -0.42 : 0.42;
    oscillator.connect(filter).connect(gain).connect(panner).connect(this.master);
    oscillator.start();
    return { oscillator, filter, gain, panner, side };
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.44, this.context.currentTime, 0.03);
    }
    return this.muted;
  }

  toggleMuted() {
    return this.setMuted(!this.muted);
  }

  update(state, timestamp) {
    if (!this.context || !this.leftDrone || !this.rightDrone) return;
    const now = this.context.currentTime;
    const leftActive = state.phase === 'active' && state.leftHeld;
    const rightActive = state.phase === 'active' && state.rightHeld;
    const leftLevel = leftActive ? 0.028 + (100 - state.offset) * 0.00012 : 0.0015;
    const rightLevel = rightActive ? 0.012 + state.pressure * 0.00022 : 0.0012;

    this.leftDrone.gain.gain.setTargetAtTime(leftLevel, now, 0.04);
    this.leftDrone.oscillator.frequency.setTargetAtTime(80 + (100 - state.offset) * 0.42, now, 0.08);
    this.leftDrone.filter.frequency.setTargetAtTime(200 + (100 - state.offset) * 2.2, now, 0.08);

    this.rightDrone.gain.gain.setTargetAtTime(rightLevel, now, 0.035);
    this.rightDrone.oscillator.frequency.setTargetAtTime(110 + state.pressure * 3.2, now, 0.06);
    this.rightDrone.filter.frequency.setTargetAtTime(420 + state.pressure * 7, now, 0.06);

    const leftTempo = leftActive ? 255 : 720;
    const rightTempo = rightActive
      ? clamp(430 - state.pressure * 3.7, 115, 410)
      : 760;
    if (leftActive && timestamp - this.lastPulse.left > leftTempo) {
      this.lastPulse.left = timestamp;
      this.tick('left', state.offset);
    }
    if (rightActive && timestamp - this.lastPulse.right > rightTempo) {
      this.lastPulse.right = timestamp;
      this.tick('right', state.pressure);
    }
  }

  tone(frequency, duration, level, options = {}) {
    if (!this.context || this.muted) return;
    const context = this.context;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const filter = context.createBiquadFilter();
    const panner = context.createStereoPanner();
    const now = context.currentTime;
    oscillator.type = options.type || 'sine';
    oscillator.frequency.setValueAtTime(frequency, now);
    if (options.endFrequency) {
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(30, options.endFrequency),
        now + duration
      );
    }
    filter.type = 'lowpass';
    filter.frequency.value = options.filter || 2200;
    panner.pan.value = options.pan ?? 0;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(filter).connect(gain).connect(panner).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  tick(side, value) {
    const left = side === 'left';
    this.tone(
      left ? 170 + value * 1.4 : 310 + value * 3.6,
      left ? 0.055 : 0.035,
      left ? 0.05 : 0.032,
      {
        type: left ? 'sine' : 'square',
        filter: left ? 720 : 2600,
        pan: left ? -0.42 : 0.42
      }
    );
  }

  action(side, type) {
    if (!this.context) return;
    const left = side === 'left';
    if (type === 'press') {
      this.tone(left ? 132 : 248, 0.1, 0.1, {
        type: left ? 'triangle' : 'sawtooth',
        endFrequency: left ? 88 : 330,
        pan: left ? -0.5 : 0.5,
        filter: 1500
      });
    } else {
      this.tone(left ? 96 : 184, 0.07, 0.052, {
        type: 'sine',
        endFrequency: 70,
        pan: left ? -0.5 : 0.5
      });
    }
  }

  result(kind) {
    if (!this.context) return;
    if (kind === 'success' || kind === 'complete') {
      [392, 523.25, 659.25, 783.99].forEach((frequency, index) => {
        window.setTimeout(() => {
          this.tone(frequency, 0.65, 0.075, {
            type: 'triangle',
            filter: 3200,
            pan: -0.2 + index * 0.13
          });
        }, index * 72);
      });
    } else if (kind === 'crush' || kind === 'failed') {
      this.noise(0.3, 0.16);
      this.tone(112, 0.42, 0.12, {
        type: 'sawtooth',
        endFrequency: 44,
        filter: 900
      });
    }
  }

  noise(duration, level) {
    if (!this.context || this.muted) return;
    const sampleCount = Math.ceil(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, sampleCount, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < sampleCount; index += 1) {
      data[index] = (Math.random() * 2 - 1) * (1 - index / sampleCount);
    }
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 460;
    filter.Q.value = 0.75;
    gain.gain.value = level;
    source.buffer = buffer;
    source.connect(filter).connect(gain).connect(this.master);
    source.start();
  }
}
