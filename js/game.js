/*
 * Game controller: fixed-timestep loop over the deterministic simulation,
 * two-player keyboard input, HUD updates, pause / replay / recovery and
 * audio-video synchronisation.
 */
(function () {
  'use strict';

  const { Simulation, WORLD, CENTER, HARBOR, DT } = window.LighthouseSim;
  const { Renderer } = window.LighthouseRenderer;
  const { AudioEngine } = window.LighthouseAudio;

  const els = {};
  let sim;
  let renderer;
  let audio;
  let rafId = null;
  let lastWall = 0;
  let accumulator = 0;
  const held = { rot: 0, power: 0 };
  let replayMode = false;
  let replayQueue = [];

  function $(id) {
    return document.getElementById(id);
  }

  function init() {
    ['canvas', 'hudGoal', 'hudResources', 'hudChange', 'hudHash',
      'btnStart', 'btnPause', 'btnReplay', 'btnRecover', 'btnRestart',
      'btnAudio', 'seedInput', 'replayBox', 'btnLoadReplay'].forEach((id) => {
      els[id] = $(id);
    });
    els.canvas.width = WORLD.w;
    els.canvas.height = WORLD.h;
    renderer = new Renderer(els.canvas, { w: WORLD.w, h: WORLD.h, center: CENTER, harbor: HARBOR });
    audio = new AudioEngine();

    sim = new Simulation(Number(els.seedInput.value) || 42);
    bindInput();
    bindButtons();
    renderFrame();
    updateHud();
    rafId = requestAnimationFrame(loop);
  }

  function bindInput() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      switch (e.code) {
        case 'KeyA': held.rot = -1; break;
        case 'KeyD': held.rot = 1; break;
        case 'KeyW': held.power = 1; break;
        case 'KeyS': held.power = -1; break;
        case 'KeyL':
          if (sim.mode === 'running') sim.applyInput({ lamp: !sim.lampOn });
          break;
        case 'Space':
          e.preventDefault();
          togglePause();
          break;
        case 'KeyR':
          restart();
          break;
        default:
          break;
      }
    });
    window.addEventListener('keyup', (e) => {
      switch (e.code) {
        case 'KeyA': if (held.rot === -1) held.rot = 0; break;
        case 'KeyD': if (held.rot === 1) held.rot = 0; break;
        case 'KeyW': if (held.power === 1) held.power = 0; break;
        case 'KeyS': if (held.power === -1) held.power = 0; break;
        default:
          break;
      }
    });
  }

  function bindButtons() {
    els.btnStart.addEventListener('click', () => {
      audio.ensureContext();
      audio.setEnabled(true);
      if (sim.mode === 'ready') sim.start();
    });
    els.btnPause.addEventListener('click', togglePause);
    els.btnRestart.addEventListener('click', restart);
    els.btnRecover.addEventListener('click', () => {
      if (sim.mode === 'failed' || sim.mode === 'success') {
        replayMode = false;
        sim.recover();
        audio.reset();
      }
    });
    els.btnReplay.addEventListener('click', replayCurrent);
    els.btnLoadReplay.addEventListener('click', loadReplay);
    els.btnAudio.addEventListener('click', () => {
      const ctx = audio.ensureContext();
      if (!ctx) return;
      audio.setEnabled(els.btnAudio.dataset.on !== '1');
      els.btnAudio.dataset.on = els.btnAudio.dataset.on === '1' ? '0' : '1';
      els.btnAudio.textContent =
        els.btnAudio.dataset.on === '1' ? '音频：开' : '音频：关';
    });
    els.seedInput.addEventListener('change', restart);
  }

  function togglePause() {
    if (sim.mode === 'running' || sim.mode === 'overheat') sim.pause();
    else if (sim.mode === 'paused') sim.resume();
  }

  function restart() {
    const seed = Number(els.seedInput.value) || 42;
    replayMode = false;
    replayQueue = [];
    sim.restart(seed);
    audio.reset();
    accumulator = 0;
  }

  function replayCurrent() {
    const record = sim.toRecord();
    els.replayBox.value = JSON.stringify(record);
    runReplay(record);
  }

  function loadReplay() {
    try {
      const record = JSON.parse(els.replayBox.value);
      if (!record || !Array.isArray(record.inputs)) {
        throw new Error('bad record');
      }
      runReplay(record);
    } catch (err) {
      els.hudChange.textContent = '回放记录无效：' + err.message;
    }
  }

  function runReplay(record) {
    sim.restart(record.seed);
    els.seedInput.value = record.seed;
    audio.reset();
    replayQueue = record.inputs.slice().sort((a, b) => a.step - b.step);
    replayMode = true;
    sim.start();
  }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    if (!lastWall) lastWall = now;
    let frameTime = (now - lastWall) / 1000;
    lastWall = now;
    if (frameTime > 0.1) frameTime = 0.1;
    accumulator += frameTime;

    let guard = 0;
    const active = sim.mode === 'running' || sim.mode === 'overheat';
    while (active && accumulator >= DT && guard < 5) {
      stepSimulation();
      accumulator -= DT;
      guard++;
    }
    if (!active) accumulator = 0;
    renderFrame();
    updateHud();
  }

  function stepSimulation() {
    if (sim.mode === 'ready' || sim.mode === 'paused' ||
        sim.mode === 'success' || sim.mode === 'failed') {
      return;
    }
    if (replayMode) {
      while (replayQueue.length && replayQueue[0].step === sim.stepCount) {
        sim.applyInput(replayQueue.shift());
      }
      const prevStep = sim.stepCount;
      sim.step();
      if ((sim.mode === 'success' || sim.mode === 'failed') &&
          replayQueue.length === 0) {
        replayMode = false;
      }
      if (sim.stepCount === prevStep) replayMode = false;
    } else {
      sim.applyInput({ rot: held.rot, power: held.power });
      sim.step();
    }
  }

  function renderFrame() {
    const snap = sim.snapshot();
    snap._events = sim.events;
    renderer.draw(snap);
    audio.update(snap, held.rot);
  }

  function updateHud() {
    const snap = sim.snapshot();
    const docked = snap.ships.filter((s) => s.state === 'docked').length;
    const target = snap.ships[snap.targetShip];
    const targetText = target && target.state === 'sailing'
      ? '护航 船' + (snap.targetShip + 1)
      : docked === 3 ? '全部进港' : '选择目标';
    els.hudGoal.textContent =
      '目标：三船进港 (' + docked + '/3) · 当前' + targetText +
      ' · 状态 ' + snap.mode + (replayMode ? '（回放中）' : '');
    els.hudResources.textContent =
      '电源 ' + (snap.power * 100).toFixed(0) + '% · 热量 ' +
      snap.heat.toFixed(0) + '/100 · 危险 ' + snap.hazard.toFixed(0) +
      '/100 · 灯 ' + (snap.lampOn ? '亮' : '灭') +
      ' · 时间 ' + snap.time.toFixed(1) + 's';
    const ev = sim.lastEvent;
    els.hudChange.textContent = ev
      ? '最近变化：' + ev.type + ' @ ' + ev.time.toFixed(1) + 's ' +
        JSON.stringify(ev.detail)
      : '最近变化：无';
    els.hudHash.textContent = '状态哈希 ' + sim.stateHash() +
      ' · 帧 ' + snap.step;
  }

  window.addEventListener('DOMContentLoaded', init);
})();
