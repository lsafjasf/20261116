/* UI controller: fixed 100 ms logical ticks, DOM HUD, Canvas instruments. */
(function () {
  'use strict';
  const AD = window.AudioDiag;
  const Engine = AD.Engine;
  const host = new AD.AudioHost();
  const seedParam = new URLSearchParams(location.search).get('seed');
  const engine = new Engine({ seed: seedParam == null ? undefined : Number(seedParam) >>> 0, host });
  const renderer = new AD.Renderer(document.getElementById('scope'));
  const $ = (id) => document.getElementById(id);

  let selected = 0;
  let savedRecord = null;

  const hud = {
    fsm: $('hud-fsm'), timer: $('hud-timer'), target: $('hud-target'),
    resources: $('hud-resources'), transition: $('hud-transition'), seed: $('hud-seed')
  };

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function renderHud() {
    const fsmText = {
      menu: '待启动', running: '运行中', paused: '已暂停',
      recovery: '失败恢复', closed_fail: '结案失败', closed_win: '结案成功'
    }[engine.fsm];
    hud.fsm.textContent = fsmText;
    hud.timer.textContent = fmtTime(engine.elapsedMs);
    hud.seed.textContent = 'seed=' + engine.seed;
    const target = engine.devices[selected];
    hud.target.textContent = target.name + '（方位 ' +
      target.pos.x + ',' + target.pos.y + '，' + (target.solved ? '已结案' : '待诊断') + '）';
    const attemptsLeft = 4 - engine.mistakes;
    hud.resources.textContent =
      '剩余误判 ' + attemptsLeft + '/4 · 增益 ' + engine.gain.toFixed(2) +
      (engine.clipped ? ' [削波]' : '') + ' · 噪声底 ' + engine.metrics.noiseFloorDb.toFixed(1) +
      'dB · HPF ' + engine.filters.hpf + 'Hz · LPF ' + engine.filters.lpf + 'Hz' +
      (engine.recoveryLeft ? ' · 恢复 ' + (engine.recoveryLeft / 10).toFixed(1) + 's' : '');
    const lt = engine.lastTransition;
    hud.transition.textContent = lt.from + ' → ' + lt.to + '（' + lt.reason + ' @tick' + lt.tick + '）';
    document.body.dataset.fsm = engine.fsm;
  }

  function frame() {
    renderer.draw(engine);
    renderHud();
  }

  setInterval(() => { engine.tick(); frame(); }, Engine.TICK_MS);
  requestAnimationFrame(function loop() { frame(); requestAnimationFrame(loop); });

  $('btn-start').addEventListener('click', () => {
    host.ensure();
    host.buildVoices(engine);
    host.onMove(engine.listener.x, engine.listener.y);
    engine.start();
    frame();
  });

  $('btn-pause').addEventListener('click', () => {
    if (engine.fsm === 'paused') engine.resume(); else engine.pause();
    frame();
  });

  $('btn-restart').addEventListener('click', () => {
    savedRecord = engine.exportRecord();
    engine.restart();
    host.buildVoices(engine);
    host.onMove(0, 0);
    engine.start();
    selected = 0;
    frame();
  });

  $('btn-replay').addEventListener('click', () => {
    const record = savedRecord || engine.exportRecord();
    const replayed = Engine.replay(record, null);
    $('replay-out').textContent =
      '回放完成: ' + replayed.fsm + ' · 哈希 ' + replayed.stateHash() +
      ' · 当前哈希 ' + engine.stateHash();
  });

  const STEP = 0.5;
  window.addEventListener('keydown', (ev) => {
    if (engine.fsm !== 'running' && engine.fsm !== 'recovery') return;
    const map = {
      ArrowUp: [0, STEP], KeyW: [0, STEP], ArrowDown: [0, -STEP], KeyS: [0, -STEP],
      ArrowLeft: [-STEP, 0], KeyA: [-STEP, 0], ArrowRight: [STEP, 0], KeyD: [STEP, 0]
    };
    if (map[ev.code]) {
      ev.preventDefault();
      const [dx, dy] = map[ev.code];
      engine.moveListener(engine.listener.x + dx, engine.listener.y + dy);
    }
    if (ev.code >= 'Digit1' && ev.code <= 'Digit4') selected = Number(ev.code.slice(-1)) - 1;
    frame();
  });

  $('hpf').addEventListener('input', (e) => { engine.setFilter('hpf', Number(e.target.value)); frame(); });
  $('lpf').addEventListener('input', (e) => { engine.setFilter('lpf', Number(e.target.value)); frame(); });
  $('gain').addEventListener('input', (e) => { engine.setGain(Number(e.target.value)); frame(); });

  document.querySelectorAll('.target-btn').forEach((btn) => {
    btn.addEventListener('click', () => { selected = Number(btn.dataset.id); frame(); });
  });
  document.querySelectorAll('.state-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const result = engine.submitDiagnosis(selected, btn.dataset.state);
      $('submit-out').textContent = JSON.stringify(result);
      frame();
    });
  });

  frame();
})();
