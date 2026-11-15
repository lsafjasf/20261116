/* Web Audio：载荷越高频率越紧，过载与失稳触发离散告警。无外部资源。 */
(function () {
  'use strict';
  var ctx = null, osc = null, gain = null, muted = false;
  var lastEventCount = 0;

  function ensure() {
    if (ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    osc = ctx.createOscillator();
    gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 90;
    gain.gain.value = 0.0001;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
  }

  function beep(freq, dur, vol, type) {
    if (!ctx || muted) return;
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + dur);
  }

  window.BridgeAudio = {
    unlock: function () { ensure(); if (ctx && ctx.state === 'suspended') ctx.resume(); },
    setMuted: function (m) {
      muted = m;
      if (gain) gain.gain.value = m ? 0.0001 : gain.gain.value;
    },
    update: function (sim) {
      ensure();
      if (!ctx || !osc) return;
      if (ctx.state === 'suspended') ctx.resume();
      var peak = Math.max.apply(null, sim.ratio);
      var freq = 80 + peak * 340;
      osc.frequency.setTargetAtTime(freq, ctx.currentTime, 0.08);
      var vol = muted ? 0.0001 : 0.015 + Math.min(peak, 1.4) * 0.05;
      gain.gain.setTargetAtTime(vol, ctx.currentTime, 0.1);
      while (lastEventCount < sim.events.length) {
        var ev = sim.events[lastEventCount++];
        if (ev.type === 'overload') beep(660, 0.12, 0.08, 'sawtooth');
        if (ev.type === 'nodefail') beep(160, 0.5, 0.14, 'square');
        if (ev.type === 'fault') beep(440, 0.25, 0.1, 'triangle');
        if (ev.type === 'end' && sim.status === 'success') beep(880, 0.3, 0.1, 'sine');
      }
    },
    reset: function () { lastEventCount = 0; }
  };
})();
