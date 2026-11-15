const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function makeNoiseBuffer(context) {
  const length = context.sampleRate * 2;
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 9157;
  for (let index = 0; index < length; index += 1) {
    seed = (seed * 16807) % 2147483647;
    data[index] = (seed / 2147483647) * 2 - 1;
  }
  return buffer;
}

export class TidalAudio {
  constructor() {
    this.context = null;
    this.master = null;
    this.waterGain = null;
    this.waterFilter = null;
    this.turbineGain = null;
    this.turbineOscillators = [];
    this.muted = false;
    this.enabled = false;
    this.lastAlarmKey = "";
  }

  async enable() {
    if (this.enabled) {
      await this.context?.resume();
      return true;
    }
    const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextClass) return false;
    this.context = new AudioContextClass();
    this.master = this.context.createGain();
    this.master.gain.value = this.muted ? 0 : 0.3;
    this.master.connect(this.context.destination);

    const noise = this.context.createBufferSource();
    noise.buffer = makeNoiseBuffer(this.context);
    noise.loop = true;
    this.waterFilter = this.context.createBiquadFilter();
    this.waterFilter.type = "lowpass";
    this.waterFilter.frequency.value = 420;
    this.waterFilter.Q.value = 0.7;
    this.waterGain = this.context.createGain();
    this.waterGain.gain.value = 0.001;
    noise.connect(this.waterFilter).connect(this.waterGain).connect(this.master);
    noise.start();

    const turbineFilter = this.context.createBiquadFilter();
    turbineFilter.type = "lowpass";
    turbineFilter.frequency.value = 280;
    this.turbineGain = this.context.createGain();
    this.turbineGain.gain.value = 0.001;
    turbineFilter.connect(this.turbineGain).connect(this.master);
    for (const [type, frequency] of [["sawtooth", 44], ["sine", 88]]) {
      const oscillator = this.context.createOscillator();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      oscillator.connect(turbineFilter);
      oscillator.start();
      this.turbineOscillators.push(oscillator);
    }
    this.enabled = true;
    await this.context.resume();
    return true;
  }

  setMuted(muted) {
    this.muted = muted;
    if (!this.master || !this.context) return;
    this.master.gain.setTargetAtTime(
      muted ? 0 : 0.3,
      this.context.currentTime,
      0.08,
    );
  }

  update(state) {
    if (!this.enabled || !this.context) return;
    const now = this.context.currentTime;
    const flow = Math.abs(state.flow.total);
    const power = Math.max(0, state.powerMW);
    const gate = state.gate.opening;
    const waterLevel = clamp(0.012 + flow / 920 * 0.11 + gate * 0.035, 0, 0.18);
    this.waterGain.gain.setTargetAtTime(waterLevel, now, 0.18);
    this.waterFilter.frequency.setTargetAtTime(240 + flow * 1.45, now, 0.25);
    const turbineLevel = clamp(power / 10 * 0.07, 0.001, 0.075);
    this.turbineGain.gain.setTargetAtTime(turbineLevel, now, 0.2);
    const base = 32 + power / 10 * 48;
    this.turbineOscillators[0].frequency.setTargetAtTime(base, now, 0.22);
    this.turbineOscillators[1].frequency.setTargetAtTime(base * 1.98, now, 0.22);
  }

  alarm(kind = "fault") {
    if (!this.enabled || !this.context || this.muted) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = kind === "success" ? "sine" : "triangle";
    oscillator.frequency.value = kind === "success" ? 660 : 240;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.72);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.76);
    if (kind === "fault") {
      const second = this.context.createOscillator();
      const secondGain = this.context.createGain();
      second.type = "square";
      second.frequency.setValueAtTime(190, now + 0.18);
      second.frequency.setValueAtTime(160, now + 0.42);
      secondGain.gain.setValueAtTime(0.0001, now);
      secondGain.gain.exponentialRampToValueAtTime(0.045, now + 0.24);
      secondGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
      second.connect(secondGain).connect(this.master);
      second.start(now);
      second.stop(now + 0.72);
    }
  }

  alarmOnce(key, kind = "fault") {
    if (!key || key === this.lastAlarmKey) return;
    this.lastAlarmKey = key;
    this.alarm(kind);
  }
}
