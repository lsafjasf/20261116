// UI 主控: 仿真驱动(暂停/单步/恢复) + 面板 + 操作 + 失败回放
(function () {
  'use strict';
  var S = MineSim, R = MineRender, A = MineAudio;
  var sim = S.createSim(20261116);
  var running = false;       // 暂停/恢复
  var speed = 4;             // 每帧推进 tick 数
  var lastFaultCount = 0;

  var canvas = document.getElementById('cv');
  var ctx = canvas.getContext('2d');
  var $ = function (id) { return document.getElementById(id); };

  // ---- 操作 ----
  function op(name, args) {
    A.ensure();
    S.applyOp(sim, name, args);
    refreshPanels();
  }

  function reset(seed) {
    sim = S.createSim(seed == null ? 20261116 : seed);
    lastFaultCount = 0;
    refreshPanels();
  }

  // 失败回放: 从初始状态按操作日志重放到首个故障发生时刻
  function replayFault() {
    if (!sim.failures.length) { alert('尚无故障记录'); return; }
    var fTick = sim.failures[0].tick;
    sim = S.replay(sim.seed, sim.opLog, fTick);
    running = false;
    $('btnPause').textContent = '恢复';
    refreshPanels();
    log('回放至故障时刻 tick=' + fTick);
  }

  // ---- 主循环: 仿真时钟唯一推进点 ----
  function frame() {
    if (running && !sim.result) {
      for (var i = 0; i < speed; i++) S.step(sim);
      if (sim.failures.length > lastFaultCount) {
        lastFaultCount = sim.failures.length;
        A.alarm();
      }
      refreshPanels();
    }
    R.draw(ctx, sim, canvas.width, canvas.height);
    A.update(sim);
    requestAnimationFrame(frame);
  }

  function stepOnce() {
    running = false;
    $('btnPause').textContent = '恢复';
    S.step(sim);
    refreshPanels();
  }

  // ---- 面板 ----
  function bar(label, val, max, color) {
    var pct = Math.max(0, Math.min(100, 100 * val / max));
    return '<div class="bar"><span>' + label + '</span>' +
      '<div class="track"><div class="fill" style="width:' + pct +
      '%;background:' + color + '"></div></div>' +
      '<b>' + (typeof val === 'number' ? val.toFixed(0) : val) + '</b></div>';
  }

  function refreshPanels() {
    $('clock').textContent = 'tick=' + sim.tick + '  t=' + sim.time.toFixed(1) + 's' +
      (running ? ' ▶' : ' ⏸') + (sim.result ? '  结果: ' + sim.result : '');
    $('status').innerHTML =
      bar('电量', sim.battery, sim.cfg.batteryMax, '#4CAF50') +
      bar('制动磨损', sim.brakeWear, sim.cfg.brakeWearLimit, '#e0a030') +
      bar('载重', S.loadWeight(sim), sim.cfg.capacity, '#5aa7e0') +
      '<div>阶段: ' + sim.phase + (sim.soak ? ' | 浸泡观察剩 ' + sim.soak.remaining : '') + '</div>';

    // 任务队列(可重排)
    var q = sim.queue.map(function (job, i) {
      return '<li>' + i + '. ' + (job.type === 'rescue' ? '救援' : '下送') +
        ' ' + job.actorId +
        ' <button data-up="' + i + '">↑</button><button data-down="' + i + '">↓</button></li>';
    }).join('');
    $('queue').innerHTML = q || '<li>(空)</li>';

    // 故障记录
    $('faults').innerHTML = sim.failures.map(function (f) {
      return '<li>[' + f.tick + 's' + '] <b>' + f.type + '</b> 余量=' +
        f.margin + '<br>响应: ' + f.response + '</li>';
    }).join('') || '<li>无</li>';

    // 日志(末 30 条)
    $('log').innerHTML = sim.log.slice(-30).map(function (e) {
      return '<div class="log-' + e.cat + '">[' + e.tick + '] ' + e.msg + '</div>';
    }).join('');
    $('log').scrollTop = 1e6;
  }

  function log(msg) {
    sim.log.push({ tick: sim.tick, time: sim.time, cat: 'op', msg: msg });
    refreshPanels();
  }

  // ---- 事件绑定 ----
  function buildActorButtons() {
    var html = '';
    sim.actors.forEach(function (a) {
      var label = a.kind === 'worker'
        ? '救援 ' + a.id + '(' + a.weight + 'kg@L' + a.level + ')'
        : '下送 ' + a.id + '(' + a.weight + 'kg→L' + a.targetLevel + ')';
      html += '<button data-enq="' + a.id + '" data-kind="' + a.kind + '">' +
        label + '</button>';
    });
    $('actors').innerHTML = html;
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t.dataset.enq) {
      op('enqueue', {
        type: t.dataset.kind === 'worker' ? 'rescue' : 'deliver',
        actorId: t.dataset.enq
      });
    } else if (t.dataset.up != null) {
      var i = +t.dataset.up;
      op('reorder', { from: i, to: Math.max(0, i - 1) });
    } else if (t.dataset.down != null) {
      var j = +t.dataset.down;
      op('reorder', { from: j, to: Math.min(sim.queue.length - 1, j + 1) });
    }
  });

  $('btnPause').onclick = function () {
    A.ensure();
    running = !running;
    $('btnPause').textContent = running ? '暂停' : '恢复';
  };
  $('btnStep').onclick = stepOnce;
  $('btnReset').onclick = function () { reset(); running = false; $('btnPause').textContent = '恢复'; };
  $('btnReplay').onclick = replayFault;
  $('btnOverload').onclick = function () {
    // 强制超载: 把当前层可载对象逐一强装, 直至触发超载保护
    var here = sim.actors.filter(function (a) {
      return a.level === sim.cage.level && !a.rescued && !a.delivered;
    });
    if (!here.length) { alert('当前层没有可装载对象'); return; }
    here.forEach(function (a) { op('overload', { actorId: a.id }); });
  };
  $('speed').onchange = function () { speed = +this.value; };

  buildActorButtons();
  refreshPanels();
  requestAnimationFrame(frame);
})();
