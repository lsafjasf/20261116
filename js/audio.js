// Web Audio: 电机轰鸣随负载与运行状态变化
(function (root) {
  'use strict';
  var ctx = null, osc = null, sub = null, gain = null, noiseGain = null, started = false;

  function ensure() {
    if (started) return;
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    osc = ctx.createOscillator();      // 电机基频
    osc.type = 'sawtooth';
    sub = ctx.createOscillator();      // 低频轰鸣
    sub.type = 'sine';
    gain = ctx.createGain();
    gain.gain.value = 0;
    // 简单噪声源模拟机械摩擦
    var len = ctx.sampleRate * 1;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    var noise = ctx.createBufferSource();
    noise.buffer = buf; noise.loop = true;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 400;
    noiseGain = ctx.createGain(); noiseGain.gain.value = 0;
    noise.connect(lp); lp.connect(noiseGain); noiseGain.connect(ctx.destination);
    osc.connect(gain); sub.connect(gain); gain.connect(ctx.destination);
    osc.start(); sub.start(); noise.start();
    started = true;
  }

  // 每帧根据仿真状态更新: 负载越重音调越低、音量越大
  function update(sim) {
    if (!started) return;
    if (ctx.state === 'suspended') ctx.resume();
    var loadRatio = Math.min(1.2,
      (sim.cage.load.reduce(function (s, a) { return s + a.weight; }, 0)) /
      sim.cfg.capacity);
    var moving = sim.cage.moving && !sim.brakeFailed;
    var t = ctx.currentTime;
    var base = moving ? 90 - 30 * loadRatio : 45;   // 重载 -> 低沉
    osc.frequency.setTargetAtTime(base, t, 0.08);
    sub.frequency.setTargetAtTime(base / 2, t, 0.08);
    var vol = moving ? 0.05 + 0.06 * loadRatio : (sim.brakeFailed ? 0.0 : 0.012);
    gain.gain.setTargetAtTime(vol, t, 0.1);
    noiseGain.gain.setTargetAtTime(
      sim.brakeFailed ? 0.05 : (moving ? 0.02 + 0.03 * loadRatio : 0), t, 0.1);
  }

  function alarm() { // 故障提示音
    if (!started) return;
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = 660;
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.4);
  }

  root.MineAudio = { ensure: ensure, update: update, alarm: alarm };
})(typeof self !== 'undefined' ? self : this);
