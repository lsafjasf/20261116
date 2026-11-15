export class SoundBoard {
  constructor() {
    this.ctx = null;
  }

  ensure() {
    if (!this.ctx && window.AudioContext) {
      this.ctx = new window.AudioContext();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  tone(frequency, duration = 0.08, type = 'sine', gainValue = 0.05) {
    this.ensure();
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(gainValue, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + duration);
  }

  confirm() { this.tone(660, 0.09, 'triangle'); }
  verify() { this.tone(880, 0.12, 'sine'); }
  reject() { this.tone(180, 0.18, 'sawtooth', 0.04); }
  route() { this.tone(520, 0.1, 'triangle'); setTimeout(() => this.tone(780, 0.1), 90); }
  undo() { this.tone(320, 0.07, 'square', 0.035); }
}
