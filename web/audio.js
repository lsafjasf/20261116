export function createAudio() {
  let ctx = null;
  let hum = null;
  let muted = false;

  function ensure() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function startHum() {
    const audio = ensure();
    if (hum) return;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = 70;
    gain.gain.value = 0.025;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    hum = { osc, gain };
  }

  function updateHum(speed, running) {
    if (!hum || !ctx) return;
    const freq = 60 + (speed - 1) * 55;
    hum.osc.frequency.setTargetAtTime(freq, ctx.currentTime, 0.1);
    hum.gain.gain.setTargetAtTime(running && !muted ? 0.025 : 0, ctx.currentTime, 0.1);
  }

  function stopHum() {
    if (!hum || !ctx) return;
    try {
      hum.osc.stop();
    } catch {
      // 已停止的振荡器无需处理
    }
    hum = null;
  }

  function blip(freq, duration = 0.08, type = 'square', volume = 0.06) {
    if (muted) return;
    const audio = ensure();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + duration);
  }

  return {
    unlock: ensure,
    startHum,
    updateHum,
    stopHum,
    pick(speed) {
      blip(300 + (speed - 1) * 160, 0.07, 'square', 0.05);
    },
    stop() {
      blip(140, 0.25, 'sawtooth', 0.09);
    },
    repair() {
      blip(520, 0.09, 'triangle', 0.07);
      setTimeout(() => blip(720, 0.1, 'triangle', 0.07), 110);
    },
    success() {
      [523, 659, 784].forEach((f, i) => setTimeout(() => blip(f, 0.16, 'triangle', 0.08), i * 140));
    },
    toggleMute() {
      muted = !muted;
      if (hum && ctx) hum.gain.gain.setTargetAtTime(muted ? 0 : 0.025, ctx.currentTime, 0.05);
      return muted;
    },
    get muted() {
      return muted;
    },
  };
}
