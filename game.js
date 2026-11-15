// 浏览器端:Canvas 渲染 + Web Audio + 交互控制
(function () {
  'use strict';
  const S = window.DeiceSim;
  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const $ = function (id) { return document.getElementById(id); };

  const SCENARIOS = {
    normal: { seed: 7, events: [] },
    pump: { seed: 11, events: [{ tick: 300, type: 'pump_failure' }] },
    gust: { seed: 3, events: [{ tick: 200, type: 'wind_gust', speed: 14, duration: 60 }] },
  };

  let sim = null;
  let running = true;
  let speed = 1;
  let selectedPlane = 0;
  let replayMode = false;
  let replayActions = [];
  let replayCursor = 0;
  let replayStopTick = Infinity;
  let lastFailure = null; // {seed, events, actionLog, failTick}
  let particles = [];
  let snowflakes = [];
  let renderedLogCount = 0;

  for (let i = 0; i < 120; i++) {
    snowflakes.push({ x: Math.random() * 900, y: Math.random() * 560, r: 1 + Math.random() * 2 });
  }

  function currentScenario() {
    return SCENARIOS[$('scenario').value] || SCENARIOS.normal;
  }

  function restart() {
    const sc = currentScenario();
    sim = S.createSim(sc.seed, sc.events);
    running = true;
    replayMode = false;
    replayActions = [];
    replayCursor = 0;
    replayStopTick = Infinity;
    particles = [];
    applyNow = [];
    renderedLogCount = 0;
    $('log').innerHTML = '';
    $('btnReplay').disabled = true;
    $('status').textContent = '运行中';
  }

  // ---------- Web Audio:风声随风速、引擎声随车速 ----------
  let audio = null;
  function initAudio() {
    if (audio) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctxA = new AC();
    const noiseBuf = ctxA.createBuffer(1, ctxA.sampleRate * 2, ctxA.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const windSrc = ctxA.createBufferSource();
    windSrc.buffer = noiseBuf; windSrc.loop = true;
    const windFilter = ctxA.createBiquadFilter();
    windFilter.type = 'bandpass'; windFilter.frequency.value = 400; windFilter.Q.value = 0.6;
    const windGain = ctxA.createGain(); windGain.gain.value = 0;
    windSrc.connect(windFilter).connect(windGain).connect(ctxA.destination);
    windSrc.start();
    const engine = ctxA.createOscillator();
    engine.type = 'sawtooth'; engine.frequency.value = 60;
    const engineGain = ctxA.createGain(); engineGain.gain.value = 0;
    engine.connect(engineGain).connect(ctxA.destination);
    engine.start();
    const spraySrc = ctxA.createBufferSource();
    spraySrc.buffer = noiseBuf; spraySrc.loop = true;
    const sprayFilter = ctxA.createBiquadFilter();
    sprayFilter.type = 'highpass'; sprayFilter.frequency.value = 2000;
    const sprayGain = ctxA.createGain(); sprayGain.gain.value = 0;
    spraySrc.connect(sprayFilter).connect(sprayGain).connect(ctxA.destination);
    spraySrc.start();
    audio = { ctx: ctxA, windGain: windGain, windFilter: windFilter, engine: engine, engineGain: engineGain, sprayGain: sprayGain };
  }

  function updateAudio() {
    if (!audio) return;
    const t = audio.ctx.currentTime;
    const w = Math.min(1, sim.wind.speed / 15);
    audio.windGain.gain.setTargetAtTime(w * 0.25, t, 0.2);
    audio.windFilter.frequency.setTargetAtTime(300 + sim.wind.speed * 60, t, 0.2);
    const moving = sim.truck.state === 'moving' ? 1 : 0;
    audio.engineGain.gain.setTargetAtTime(moving * 0.08, t, 0.1);
    audio.engine.frequency.setTargetAtTime(50 + moving * S.TRUCK_SPEED * 12, t, 0.1);
    audio.sprayGain.gain.setTargetAtTime(sim.truck.state === 'spraying' ? 0.06 : 0, t, 0.05);
  }

  // ---------- 渲染 ----------
  function draw() {
    ctx.clearRect(0, 0, 900, 560);
    // 机坪地面与滑行道
    ctx.fillStyle = '#33414f'; ctx.fillRect(0, 0, 900, 560);
    ctx.fillStyle = '#3d4f60'; ctx.fillRect(0, 380, 900, 120);
    ctx.strokeStyle = '#c9b458'; ctx.setLineDash([14, 12]);
    ctx.beginPath(); ctx.moveTo(0, 440); ctx.lineTo(900, 440); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#28323d'; ctx.fillRect(40, 460, 80, 40);
    ctx.fillStyle = '#9fc5ff'; ctx.font = '12px sans-serif'; ctx.fillText('车库', 62, 484);
    // 飞机
    sim.planes.forEach(function (p) {
      if (p.departed) {
        ctx.fillStyle = '#567'; ctx.fillText('已起飞', p.x - 20, p.y - 40);
        return;
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.fillStyle = '#c8d4e0';
      ctx.beginPath(); ctx.ellipse(0, 0, 60, 14, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(-12, -46, 10, 46); // 尾翼
      ctx.fillRect(-8, -8, 70, 8);    // 机翼
      if (p.ice > 0.01) { // 冰层覆盖
        ctx.fillStyle = 'rgba(120,190,255,' + (0.25 + p.ice * 0.55) + ')';
        ctx.beginPath(); ctx.ellipse(0, 0, 60, 14, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillRect(-8, -8, 70, 8);
      }
      ctx.restore();
      if (p.id === selectedPlane) {
        ctx.strokeStyle = '#ffd75e'; ctx.lineWidth = 2;
        ctx.strokeRect(p.x - 75, p.y - 55, 150, 90);
        ctx.lineWidth = 1;
      }
      ctx.fillStyle = '#dde6f0'; ctx.font = '12px sans-serif';
      ctx.fillText('机' + p.id + ' 冰' + (p.ice * 100).toFixed(0) + '%', p.x - 40, p.y + 40);
      ctx.fillText('窗口 ' + p.windowOpen + '-' + p.windowClose + 's', p.x - 48, p.y + 56);
      if (p.deiced && p.holdover > 0) {
        ctx.fillStyle = '#7fe08a';
        ctx.fillText('防冰 ' + p.holdover.toFixed(0) + 's', p.x - 34, p.y + 72);
      }
    });
    // 喷洒车
    const tr = sim.truck;
    ctx.save();
    ctx.translate(tr.x, tr.y);
    ctx.fillStyle = tr.pumpOk ? '#e0a040' : '#c0392b';
    ctx.fillRect(-14, -8, 28, 16);
    ctx.fillStyle = '#222'; ctx.fillRect(-10, 6, 6, 4); ctx.fillRect(4, 6, 6, 4);
    ctx.restore();
    ctx.fillStyle = '#dde6f0'; ctx.font = '11px sans-serif';
    ctx.fillText(tr.state, tr.x - 16, tr.y - 14);
    // 喷雾粒子(被风吹偏)
    if (tr.state === 'spraying' && Math.random() < 0.9) {
      const p = sim.planes[tr.targetPlane];
      if (p) {
        const windRad = sim.wind.dirDeg * Math.PI / 180;
        for (let i = 0; i < 4; i++) {
          particles.push({
            x: tr.x, y: tr.y - 6,
            vx: (p.x - tr.x) * 0.04 + (Math.random() - 0.5) * 1.5,
            vy: (p.y - tr.y) * 0.04 - 1 + (Math.random() - 0.5),
            wx: Math.cos(windRad) * sim.wind.speed * 0.35,
            wy: Math.sin(windRad) * sim.wind.speed * 0.35,
            life: 40,
          });
        }
      }
    }
    particles = particles.filter(function (pt) {
      pt.x += pt.vx + pt.wx; pt.y += pt.vy + pt.wy; pt.life--;
      if (pt.life <= 0) return false;
      ctx.fillStyle = 'rgba(140,220,255,' + (pt.life / 60) + ')';
      ctx.fillRect(pt.x, pt.y, 3, 3);
      return true;
    });
    // 雪花随风飘落
    const windRad2 = sim.wind.dirDeg * Math.PI / 180;
    snowflakes.forEach(function (f) {
      f.y += (0.6 + sim.snow * 1.6) * f.r * 0.6;
      f.x += Math.cos(windRad2) * sim.wind.speed * 0.15;
      if (f.y > 560) { f.y = -4; f.x = Math.random() * 900; }
      if (f.x > 900) f.x = 0; if (f.x < 0) f.x = 900;
      ctx.fillStyle = 'rgba(255,255,255,' + (0.25 + sim.snow * 0.5) + ')';
      ctx.fillRect(f.x, f.y, f.r, f.r);
    });
    // 风向箭头
    ctx.save();
    ctx.translate(840, 50);
    ctx.rotate(windRad2);
    ctx.strokeStyle = '#9fc5ff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-20, 0); ctx.lineTo(20, 0);
    ctx.lineTo(12, -6); ctx.moveTo(20, 0); ctx.lineTo(12, 6); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#9fc5ff'; ctx.font = '11px sans-serif';
    ctx.fillText(sim.wind.speed.toFixed(1) + 'm/s', 812, 84);
  }

  // ---------- HUD 与日志 ----------
  const LOG_CLASS = {
    EQUIPMENT_FAILURE: 'err', FAIL: 'err', PARAM_OUT_OF_LIMIT: 'warn',
    WIND_GUST: 'warn', REICING: 'warn', ACTION_REJECTED: 'warn',
    EQUIPMENT_RECOVERED: 'ok', DEICED: 'ok', TAKEOFF: 'ok', SUCCESS: 'ok',
  };

  function renderLog() {
    const box = $('log');
    for (; renderedLogCount < sim.log.length; renderedLogCount++) {
      const e = sim.log[renderedLogCount];
      const div = document.createElement('div');
      div.className = LOG_CLASS[e.type] || '';
      div.textContent = 't=' + e.time.toFixed(1) + ' [' + e.type + '] ' + e.msg;
      box.appendChild(div);
    }
    box.scrollTop = box.scrollHeight;
  }

  function updateHud() {
    $('clock').textContent = sim.time.toFixed(1);
    $('tick').textContent = sim.tick;
    $('tankTxt').textContent = sim.tank.toFixed(1) + 'L / ' + S.TANK_CAPACITY + 'L';
    $('tankBar').style.width = (sim.tank / S.TANK_CAPACITY * 100) + '%';
    $('polTxt').textContent = sim.pollution.toFixed(1) + ' / ' + S.POLLUTION_LIMIT;
    $('polBar').style.width = Math.min(100, sim.pollution / S.POLLUTION_LIMIT * 100) + '%';
    $('windTxt').textContent = sim.wind.speed.toFixed(1) + 'm/s @' + sim.wind.dirDeg.toFixed(0) + '°';
    $('snowTxt').textContent = (sim.snow * 100).toFixed(0) + '%';
    if (sim.outcome === 'success') $('status').textContent = '✔ 任务成功:全部飞机在窗口内起飞';
    else if (sim.outcome === 'fail') $('status').textContent = '✘ 任务失败:' + sim.failReason;
    else $('status').textContent = (running ? '运行中' : '已暂停') + (replayMode ? '(回放)' : '');
    $('btnRepair').disabled = sim.truck.state !== 'broken';
  }

  function onOutcome() {
    if (!sim.outcome) return;
    running = false;
    if (sim.outcome === 'fail' && !replayMode) {
      const sc = currentScenario();
      lastFailure = { seed: sc.seed, events: sc.events, actionLog: sim.actionLog.slice(), failTick: sim.failTick };
      $('btnReplay').disabled = false;
    }
  }

  // ---------- 主循环:固定步长仿真时钟 ----------
  let acc = 0;
  let lastTs = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    if (!lastTs) lastTs = ts;
    const elapsed = Math.min(0.25, (ts - lastTs) / 1000);
    lastTs = ts;
    if (running && !sim.outcome) {
      acc += elapsed * speed;
      while (acc >= S.DT && !sim.outcome) {
        acc -= S.DT;
        stepOnce();
        if (replayMode && sim.tick >= replayStopTick) { running = false; break; }
      }
      onOutcome();
    }
    draw();
    updateHud();
    renderLog();
    updateAudio();
  }

  function stepOnce() {
    if (replayMode) {
      const acts = [];
      while (replayCursor < replayActions.length && replayActions[replayCursor].tick === sim.tick) {
        acts.push(replayActions[replayCursor]); replayCursor++;
      }
      S.step(sim, acts);
    } else {
      S.step(sim, []);
    }
  }

  // ---------- 交互 ----------
  function playerAction(a) {
    if (replayMode || sim.outcome) return;
    applyNow.push(a);
  }
  let applyNow = [];
  const origStepOnce = stepOnce;
  stepOnce = function () {
    if (!replayMode && applyNow.length) {
      const acts = applyNow; applyNow = [];
      S.step(sim, acts);
    } else {
      origStepOnce();
    }
  };

  cv.addEventListener('click', function (ev) {
    const r = cv.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    sim.planes.forEach(function (p) {
      if (Math.abs(x - p.x) < 80 && Math.abs(y - p.y) < 60) selectedPlane = p.id;
    });
  });
  $('btnGoto').onclick = function () { initAudio(); playerAction({ type: 'goto', plane: selectedPlane }); };
  $('btnSpray').onclick = function () { initAudio(); playerAction({ type: 'spray', amount: Number($('amt').value) }); };
  $('btnTakeoff').onclick = function () { initAudio(); playerAction({ type: 'takeoff', plane: selectedPlane }); };
  $('btnRepair').onclick = function () { initAudio(); playerAction({ type: 'repair' }); };
  $('amt').oninput = function () { $('amtTxt').textContent = $('amt').value; };
  $('btnPause').onclick = function () { running = false; };
  $('btnResume').onclick = function () { if (!sim.outcome) running = true; };
  $('btnStep').onclick = function () {
    running = false;
    if (!sim.outcome) { stepOnce(); onOutcome(); }
  };
  $('btnRestart').onclick = function () { restart(); };
  document.querySelectorAll('.spd').forEach(function (b) {
    b.onclick = function () { speed = Number(b.dataset.s); };
  });
  $('btnReplay').onclick = function () {
    if (!lastFailure) return;
    sim = S.createSim(lastFailure.seed, lastFailure.events);
    replayMode = true;
    replayActions = lastFailure.actionLog;
    replayCursor = 0;
    replayStopTick = lastFailure.failTick;
    renderedLogCount = 0;
    $('log').innerHTML = '';
    running = true;
    $('status').textContent = '回放至失败时刻 t=' + (lastFailure.failTick * S.DT).toFixed(1) + 's';
  };

  restart();
  requestAnimationFrame(frame);
})();
