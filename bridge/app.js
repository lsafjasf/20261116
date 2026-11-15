/* 应用层：requestAnimationFrame 驱动固定步长内核，自身不做任何物理计算。 */
(function () {
  'use strict';
  var E = window.BridgeEngine, SC = window.BridgeScenarios;
  var canvas = document.getElementById('scene');
  var ctx = canvas.getContext('2d');
  var sim, paused = false, replaying = false;
  var rate = 1, acc = 0, lastTs = 0, drawnEvents = 0;
  var replayBase = null, replayTarget = 0, replayTimer = null;

  function $(id) { return document.getElementById(id); }

  function load(name) {
    clearInterval(replayTimer);
    replaying = false;
    sim = SC.build(name || $('scenario').value);
    paused = false;
    acc = 0;
    drawnEvents = 0;
    window.BridgeAudio.reset();
    $('btnPause').disabled = false;
    $('btnResume').disabled = true;
    $('btnStep').disabled = false;
    $('log').innerHTML = '';
    render();
  }

  function appendEvents() {
    var box = $('log');
    while (drawnEvents < sim.events.length) {
      var ev = sim.events[drawnEvents++];
      var div = document.createElement('div');
      div.className = 'e';
      div.innerHTML = '<span class="t">[' + ev.t.toFixed(1) + 's]</span>' +
        '<span class="tag ' + ev.type + '">' + ev.type + '</span> ' +
        escapeHtml(ev.msg);
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  function render() {
    window.BridgeRenderer.draw(ctx, sim, canvas.width, canvas.height);
    appendEvents();
    $('clock').textContent = sim.t.toFixed(1);
    $('step').textContent = sim.stepIndex;
    var pill = $('statusPill');
    pill.textContent = sim.status === 'success' ? '运输成功' :
      sim.status === 'failed' ? '失稳失败' : (paused ? '已暂停' : '运行中');
    pill.className = 'status-pill status-' + sim.status;
    var river = sim.supports.find(function (s) { return s.river; });
    $('stWater').textContent = sim.water.toFixed(1) + ' m';
    $('stHealth').textContent = river ? river.health.toFixed(2) : '—';
    $('stMargin').textContent = sim.lastMargin.toFixed(3);
    $('stPeak').textContent = Math.max.apply(null, sim.peakRatio).toFixed(3);
    $('stResidual').textContent = sim.finished ? sim.residual.toFixed(3) : '—';
    $('stFailed').textContent = sim.failed.length ? sim.failed.join(',') : '无';
    var activeFaults = Object.keys(sim.faults).filter(function (k) {
      var f = sim.faults[k];
      return f.repairedAt == null && (f.until == null || sim.t < f.until);
    });
    $('stFault').textContent = activeFaults.length ? activeFaults.join(' ') : '无';
    $('stRf').textContent = E.REINFORCE_LIMIT - sim.reinforced.length;
    $('rfLeft').textContent = '剩余 ' + (E.REINFORCE_LIMIT - sim.reinforced.length) + ' 处';
  }

  function tick(ts) {
    if (!lastTs) lastTs = ts;
    var dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;
    if (!paused && !replaying) {
      acc += dt * rate;
      var guard = 8;
      while (acc >= E.STEP && guard-- > 0) {
        E.step(sim);
        acc -= E.STEP;
      }
      window.BridgeAudio.update(sim);
    }
    render();
    requestAnimationFrame(tick);
  }

  function startReplay() {
    if (sim.status !== 'failed' || !sim.snapshots.length) {
      alert('当前剧本没有失败快照，无法回放');
      return;
    }
    paused = true;
    replaying = true;
    replayBase = sim.snapshots[Math.max(0, sim.snapshots.length - 8)];
    replayTarget = sim.failTime;
    sim = E.restore(SC.build($('scenario').value),
      JSON.parse(JSON.stringify(replayBase)), true);
    drawnEvents = 0;
    $('log').innerHTML = '';
    var replay = sim;
    replayTimer = setInterval(function () {
      if (replay.t >= replayTarget) {
        clearInterval(replayTimer);
        replaying = false;
        paused = true;
        return;
      }
      E.step(replay);
      render();
    }, 180);
  }

  function bind() {
    $('btnLoad').onclick = function () { load(); };
    $('btnPause').onclick = function () {
      paused = true; this.disabled = true; $('btnResume').disabled = false;
    };
    $('btnResume').onclick = function () {
      paused = false; this.disabled = true; $('btnPause').disabled = false;
      replaying = false;
    };
    $('btnStep').onclick = function () {
      paused = true;
      $('btnPause').disabled = true;
      $('btnResume').disabled = false;
      E.step(sim);
      window.BridgeAudio.update(sim);
      render();
    };
    $('btnReplay').onclick = startReplay;
    $('btnReset').onclick = function () { load(); };
    $('rate').oninput = function () {
      rate = parseFloat(this.value);
      $('rateVal').textContent = rate.toFixed(2) + '×';
    };
    $('mute').onchange = function () {
      window.BridgeAudio.setMuted(this.checked);
    };
    document.addEventListener('click', function () {
      window.BridgeAudio.unlock();
    }, { once: true });

    $('btnReinforce').onclick = function () {
      var node = parseInt($('rfNode').value, 10);
      E.sendCommand(sim, { type: 'reinforce', at: sim.t + E.STEP, node: node });
    };
    $('btnParams').onclick = function () {
      var gap = parseFloat($('gap').value);
      var speed = parseFloat($('speed').value);
      E.sendCommand(sim, { type: 'setGap', at: sim.t + E.STEP, value: gap });
      E.sendCommand(sim, { type: 'setSpeed', at: sim.t + E.STEP, value: speed });
    };
    $('btnMove').onclick = function () {
      E.sendCommand(sim, {
        type: 'movePier', at: sim.t + E.STEP,
        id: $('pierId').value, node: parseInt($('pierNode').value, 10)
      });
    };
  }

  bind();
  load('wrongReinforce');
  requestAnimationFrame(tick);
})();
