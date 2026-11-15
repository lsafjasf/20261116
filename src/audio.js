export class HarborAudio {
  constructor() {
    this.context = null;
    this.master = null;
    this.enabled = true;
    this.lastCountdown = null;
    this.active = new Set();
  }

  ensure() {
    if (!this.enabled) return false;
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) return false;
    if (!this.context) {
      this.context = new AudioContextClass();
      this.master = this.context.createGain();
      this.master.gain.value = 0.18;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === "suspended") this.context.resume().catch(() => {});
    return true;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.reset();
    return this.enabled;
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }

  reset() {
    this.lastCountdown = null;
    for (const node of this.active) {
      try {
        node.stop();
      } catch {
        // A finished oscillator cannot be stopped again.
      }
    }
    this.active.clear();
  }

  tone(frequency, duration, options = {}) {
    if (!this.ensure()) return;
    const start = this.context.currentTime + (options.delay ?? 0);
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = options.type ?? "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    if (options.slide) {
      oscillator.frequency.exponentialRampToValueAtTime(options.slide, start + duration);
    }
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(options.gain ?? 0.3, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.03);
    this.active.add(oscillator);
    oscillator.addEventListener("ended", () => {
      this.active.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    });
  }

  play(name) {
    if (!this.ensure()) return;
    if (name === "select") {
      this.tone(390, 0.06, { type: "triangle", gain: 0.09 });
    } else if (name === "request") {
      this.tone(420, 0.09, { type: "sine", gain: 0.16 });
      this.tone(620, 0.12, { type: "sine", gain: 0.1, delay: 0.07 });
    } else if (name === "accept") {
      this.tone(330, 0.12, { type: "sine", gain: 0.18 });
      this.tone(495, 0.2, { type: "sine", gain: 0.16, delay: 0.08 });
      this.tone(660, 0.28, { type: "sine", gain: 0.12, delay: 0.16 });
    } else if (name === "delay") {
      this.tone(230, 0.16, { type: "square", gain: 0.1, slide: 160 });
    } else if (name === "timeout") {
      this.tone(180, 0.45, { type: "sawtooth", gain: 0.13, slide: 90 });
      this.tone(120, 0.5, { type: "square", gain: 0.06, delay: 0.18 });
    } else if (name === "win") {
      [392, 494, 587, 784].forEach((frequency, index) => {
        this.tone(frequency, 0.35, { gain: 0.15, delay: index * 0.11 });
      });
    } else if (name === "lose") {
      [270, 220, 170, 110].forEach((frequency, index) => {
        this.tone(frequency, 0.3, { type: "triangle", gain: 0.12, delay: index * 0.12 });
      });
    }
  }

  countdown(seconds) {
    const rounded = Math.max(0, Math.ceil(seconds));
    if (rounded > 5 || rounded <= 0 || rounded === this.lastCountdown) return;
    this.lastCountdown = rounded;
    this.tone(480 + rounded * 45, 0.075, { type: "sine", gain: 0.11 });
  }
}
