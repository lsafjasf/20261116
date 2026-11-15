// Web Audio：水流声随总出流变化，超限/失败时报警
export class FlowAudio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.master = null;
    this.filter = null;
    this.alarmOsc = null;
  }

  _ensure() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    // 白噪声源 -> 低通滤波 -> 增益
    const len = 2 * this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { // 褐噪声，更像水流
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 400;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    src.connect(this.filter).connect(this.master).connect(this.ctx.destination);
    src.start();
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) { this._ensure(); this.ctx.resume(); }
    else if (this.ctx) { this.master.gain.value = 0; this.stopAlarm(); }
  }

  // qOut: 当前总出流；qMax: 参考最大值
  update(qOut, qMax = 4500) {
    if (!this.enabled || !this.ctx) return;
    const r = Math.min(1, qOut / qMax);
    this.master.gain.setTargetAtTime(r * 0.5, this.ctx.currentTime, 0.2);
    this.filter.frequency.setTargetAtTime(300 + r * 1800, this.ctx.currentTime, 0.2);
  }

  alarm(on) {
    if (!this.enabled || !this.ctx) return;
    if (on && !this.alarmOsc) {
      this.alarmOsc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      g.gain.value = 0.06;
      this.alarmOsc.type = 'square';
      this.alarmOsc.frequency.value = 880;
      this.alarmOsc.connect(g).connect(this.ctx.destination);
      this.alarmOsc.start();
    } else if (!on) {
      this.stopAlarm();
    }
  }

  stopAlarm() {
    if (this.alarmOsc) { try { this.alarmOsc.stop(); } catch {} this.alarmOsc = null; }
  }
}
