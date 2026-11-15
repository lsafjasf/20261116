/* Web Audio：运输负载驱动的环境音 + 满载/断供事件提示 */
(function (global) {
  const APP = global.App || (global.App = {});

  function LoadAudio() {
    this.ctx = null;
    this.muted = true;
    this.gain = null;
    this.osc = null;
    this.lastAlert = -99;
  }

  LoadAudio.prototype.ensure = function () {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.osc = this.ctx.createOscillator();
    this.osc.type = 'sine';
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.0001;
    this.osc.connect(this.gain).connect(this.ctx.destination);
    this.osc.start();
  };

  LoadAudio.prototype.toggle = function () {
    this.ensure();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.muted = !this.muted;
    this.gain.gain.setTargetAtTime(this.muted ? 0.0001 : 0.05,
      this.ctx.currentTime, 0.1);
    return !this.muted;
  };

  LoadAudio.prototype.update = function (tickState, tick) {
    if (!this.ctx || this.muted) return;
    const edges = tickState.edges;
    const avgUtil = edges.reduce((a, e) => a + e.util, 0) / Math.max(1, edges.length);
    const freq = 140 + avgUtil * 320;
    this.osc.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.15);
    const overload = edges.some((e) => e.overcap) || tickState.outages.length > 0;
    if (overload && tick - this.lastAlert >= 3) {
      this.beep(880, 0.12);
      this.lastAlert = tick;
    }
  };

  LoadAudio.prototype.beep = function (freq, dur) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.12, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + dur);
    osc.connect(g).connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + dur);
  };

  APP.LoadAudio = LoadAudio;
})(typeof window !== 'undefined' ? window : globalThis);
