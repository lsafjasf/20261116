/*
 * Web Audio 程序化音效：
 * - 推进器：低频振荡器，音高随推力变化
 * - 张力：滤波噪声，音量/亮度随脐带张力上升
 * - 告警：中止/越限时的间断鸣响
 */
(function (root) {
  'use strict';

  class SimAudio {
    constructor() {
      this.ctx = null;
      this.muted = false;
    }

    ensure() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return;
      }
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(ctx.destination);

      this.thrOsc = ctx.createOscillator();
      this.thrOsc.type = 'sawtooth';
      this.thrGain = ctx.createGain();
      this.thrGain.gain.value = 0;
      this.thrOsc.connect(this.thrGain).connect(this.master);
      this.thrOsc.start();

      const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.noise = ctx.createBufferSource();
      this.noise.buffer = buffer;
      this.noise.loop = true;
      this.noiseFilter = ctx.createBiquadFilter();
      this.noiseFilter.type = 'bandpass';
      this.noiseFilter.frequency.value = 400;
      this.noiseGain = ctx.createGain();
      this.noiseGain.gain.value = 0;
      this.noise.connect(this.noiseFilter).connect(this.noiseGain).connect(this.master);
      this.noise.start();
    }

    update(state) {
      if (!this.ctx || this.muted) return;
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const thrustLevel = Math.abs(state.ship.thrust) / state.cfg.SHIP_THRUST_MAX;
      this.thrOsc.frequency.setTargetAtTime(45 + thrustLevel * 110, t, 0.1);
      this.thrGain.gain.setTargetAtTime(state.sounding ? 0.05 + thrustLevel * 0.08 : 0, t, 0.1);

      const tensionRatio = state.umbilical.tension / state.cfg.TENSION_BREAK;
      this.noiseFilter.frequency.setTargetAtTime(300 + tensionRatio * 1800, t, 0.1);
      this.noiseGain.gain.setTargetAtTime(
        state.sounding && !state.umbilical.broken ? 0.02 + tensionRatio * 0.16 : 0, t, 0.1);
    }

    alarm(kind) {
      if (!this.ctx || this.muted) return;
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = kind === 'abort' ? 320 : 520;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      osc.connect(g).connect(this.master);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    }

    setSounding(on) {
      this.sounding = on;
      if (!on && this.ctx) {
        this.thrGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
        this.noiseGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      }
    }
  }

  root.SimAudio = SimAudio;
})(window);
