// 港区装船仿真 —— Canvas 渲染 + Web Audio + 时钟控制(暂停/单步/恢复/失败回放)
(function () {
  'use strict';
  var S = window.PortSim;
  var cv = document.getElementById('cv');
  var ctx = cv.getContext('2d');

  var seed = (Math.random() * 0xffffffff) >>> 0;
  var state = S.createSim(seed);
  var paused = false;
  var selected = null;          // 选中的货柜 id
  var replaying = null;         // {ops, idx}
  var lastEventCount = 0;

  // 槽位屏幕坐标
  var SLOT_W = 100, SLOT_H = 76, SLOT_GAP = 18, SLOT_X = 70, SLOT_Y = 210;
  function slotRect(i) {
    var p = S.SLOT_POS[i];
    return { x: SLOT_X + p.x * (SLOT_W + SLOT_GAP), y: SLOT_Y + p.y * (SLOT_H + SLOT_GAP), w: SLOT_W, h: SLOT_H };
  }
  var SHIP = { x: 660, y: 200, w: 200, h: 180 };

  // ---------- Web Audio: 吊机轰鸣 + 警报 ----------
  var AC = null, craneOsc = null, craneGain = null, alarmOsc = null, alarmGain = null, alarmLfo = null;
  function ensureAudio() {
    if (AC) return;
    AC = new (window.AudioContext || window.webkitAudioContext)();
    craneOsc = AC.createOscillator(); craneOsc.type = 'sawtooth';
    craneGain = AC.createGain(); craneGain.gain.value = 0;
    craneOsc.connect(craneGain).connect(AC.destination); craneOsc.start();
    alarmOsc = AC.createOscillator(); alarmOsc.type = 'square'; alarmOsc.frequency.value = 700;
    alarmGain = AC.createGain(); alarmGain.gain.value = 0;
    alarmLfo = AC.createOscillator(); alarmLfo.type = 'square'; alarmLfo.frequency.value = 3;
    var lfoGain = AC.createGain(); lfoGain.gain.value = 250;
    alarmLfo.connect(lfoGain).connect(alarmOsc.frequency);
    alarmOsc.connect(alarmGain).connect(AC.destination);
    alarmOsc.start(); alarmLfo.start();
  }
  function updateAudio() {
    if (!AC) return;
    var c = state.crane;
    if (c.mode === 'busy' && !paused) {
      var load = c.carrying ? weightOf(c.carrying) : 0;
      craneOsc.frequency.value = 60 + load * 2.5;          // 重箱 -> 更低沉
      craneGain.gain.setTargetAtTime(0.08, AC.currentTime, 0.05);
    } else {
      craneGain.gain.setTargetAtTime(0, AC.currentTime, 0.1);
    }
    var alarmOn = state.violation || state.crane.fault || state.evacuation || state.phase === 'failed';
    alarmGain.gain.setTargetAtTime(alarmOn ? 0.05 : 0, AC.currentTime, 0.05);
  }
  function weightOf(id) {
    var c = state.containers.find(function (x) { return x.id === id; });
    return c ? c.weight : 0;
  }

  // ---------- 时钟控制 ----------
  document.getElementById('btnPause').onclick = function () { ensureAudio(); paused = true; };
  document.getElementById('btnResume').onclick = function () { ensureAudio(); paused = false; replaying = null; };
  document.getElementById('btnStep').onclick = function () { ensureAudio(); paused = true; tickOnce(); };
  document.getElementById('btnReset').onclick = function () {
    seed = (Math.random() * 0xffffffff) >>> 0;
    state = S.createSim(seed); paused = false; replaying = null; selected = null; lastEventCount = 0;
  };
  document.getElementById('btnReplay').onclick = function () {
    ensureAudio();
    // 失败回放: 用同一种子 + 操作记录从头精确重演
    replaying = { ops: state.ops.slice(), idx: 0 };
    state = S.createSim(seed);
    paused = false; selected = null; lastEventCount = 0;
  };
  document.getElementById('btnCurtain').onclick = function () {
    ensureAudio();
    S.applyOp(state, { type: 'curtain', on: !state.curtain.active, duration: 20 });
  };
  document.getElementById('btnRepair').onclick = function () {
    ensureAudio();
    S.applyOp(state, { type: 'repair' });
  };

  function tickOnce() {
    if (replaying) {
      // 回放模式: 按记录的时刻重放操作
      while (replaying.idx < replaying.ops.length && replaying.ops[replaying.idx].tick === state.tick) {
        S.applyOp(state, replaying.ops[replaying.idx].op);
        replaying.idx++;
      }
      if (replaying.idx >= replaying.ops.length && state.phase !== 'running') replaying = null;
    }
    S.step(state);
  }

  setInterval(function () {
    if (!paused) tickOnce();
    render();
    updateAudio();
    updatePanels();
  }, S.TICK_MS);
  // ---------- 鼠标交互: 选货柜 -> 点槽位堆存 / 点船装船 ----------
  cv.addEventListener('click', function (ev) {
    ensureAudio();
    if (replaying) return;
    var r = cv.getBoundingClientRect();
    var mx = ev.clientX - r.left, my = ev.clientY - r.top;
    // 点船舶: 装船
    if (selected && mx >= SHIP.x && mx <= SHIP.x + SHIP.w && my >= SHIP.y && my <= SHIP.y + SHIP.h) {
      S.applyOp(state, { type: 'load', container: selected });
      selected = null;
      return;
    }
    // 点槽位
    for (var i = 0; i < S.SLOT_POS.length; i++) {
      var sr = slotRect(i);
      if (mx >= sr.x && mx <= sr.x + sr.w && my >= sr.y && my <= sr.y + sr.h) {
        var here = state.containers.find(function (c) {
          return c.loc.type === 'slot' && c.loc.i === i;
        });
        if (here) {
          selected = here.id;
        } else if (selected) {
          S.applyOp(state, { type: 'move', container: selected, target: i });
          selected = null;
        }
        return;
      }
    }
    selected = null;
  });

  // ---------- 面板 ----------
  function updatePanels() {
    document.getElementById('clock').textContent =
      'tick ' + state.tick + ' / ' + S.TIME_LIMIT +
      (paused ? '  [已暂停]' : '') + (replaying ? '  [回放中]' : '') +
      '  阶段: ' + state.phase;
    var c = state.crane;
    document.getElementById('status').textContent =
      '吊机: ' + c.mode + (c.inhibited ? ' (联锁: ' + c.inhibitReason + ')' : '') + '\n' +
      '稳定裕量: ' + Math.round(c.stability) + '%' + (c.fault ? '  故障: ' + c.fault : '') + '\n' +
      '风: ' + state.wind.dirDeg + '° / ' + state.wind.speed + ' m/s (上限 ' + S.WIND_TRAVEL_LIMIT + ')\n' +
      '水幕: ' + (state.curtain.active ? '开启(吊装窗口关闭)' : '关闭') + '\n' +
      '已装船: ' + state.stats.loaded + '/3' +
      (state.violation ? '\n⚠ 隔离违规: ' + state.violation.pair.join(' vs ') : '') +
      (state.evacuation ? '\n🚨 局部疏散: ' + state.evacuation.zone : '');
    var log = document.getElementById('log');
    for (var i = lastEventCount; i < state.events.length; i++) {
      var e = state.events[i];
      var d = document.createElement('div');
      d.className = e.type;
      d.textContent = 't=' + e.tick + ' [' + e.type + '] ' + e.msg +
        (e.margin !== undefined ? ' (余量' + e.margin + ')' : '');
      log.appendChild(d);
    }
    if (state.events.length !== lastEventCount) log.scrollTop = log.scrollHeight;
    lastEventCount = state.events.length;
  }
  // ---------- Canvas 渲染 ----------
  var HAZ_COLOR = { 1: '#e8a33d', 2: '#b06fe0', 3: '#4fc46f' };
  var HAZ_NAME = { 1: '易燃', 2: '有毒', 3: '腐蚀' };
  function render() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    // 码头地面 / 海面
    ctx.fillStyle = '#2b3a4a'; ctx.fillRect(0, 0, cv.width, 420);
    ctx.fillStyle = '#1a4a6b'; ctx.fillRect(0, 420, cv.width, 180);
    ctx.strokeStyle = '#4a6a8a'; ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.moveTo(0, 420); ctx.lineTo(cv.width, 420); ctx.stroke();
    ctx.setLineDash([]);
    // 船舶
    ctx.fillStyle = '#5a6a7a';
    ctx.fillRect(SHIP.x, SHIP.y + 160, SHIP.w, 80);
    ctx.fillStyle = '#8a9aaa';
    ctx.fillRect(SHIP.x + 20, SHIP.y + 130, SHIP.w - 40, 30);
    ctx.fillStyle = '#cfe3f5'; ctx.font = '14px sans-serif';
    ctx.fillText('货轮 (点击装船)', SHIP.x + 40, SHIP.y + 150);
    // 已装船货柜画在船上
    var li = 0;
    state.containers.forEach(function (c) {
      if (c.loc.type === 'ship') {
        drawContainer(c, SHIP.x + 15 + li * 60, SHIP.y + 90, 56, 38);
        li++;
      }
    });
    // 槽位 + 危害区
    for (var i = 0; i < S.SLOT_POS.length; i++) {
      var sr = slotRect(i);
      ctx.strokeStyle = '#5a7a9a'; ctx.lineWidth = 1;
      ctx.strokeRect(sr.x, sr.y, sr.w, sr.h);
      ctx.fillStyle = '#7a9ab8'; ctx.font = '11px sans-serif';
      ctx.fillText('槽' + i, sr.x + 4, sr.y + 13);
      if (state.plume.indexOf(i) >= 0) {
        ctx.fillStyle = 'rgba(255,60,60,0.35)';
        ctx.fillRect(sr.x, sr.y, sr.w, sr.h);
        ctx.fillStyle = '#ff9a9a';
        ctx.fillText('危害区', sr.x + sr.w - 40, sr.y + 13);
      }
    }
    // 隔离违规连线
    if (state.violation) {
      var a = state.containers.find(function (x) { return x.id === state.violation.pair[0]; });
      var b = state.containers.find(function (x) { return x.id === state.violation.pair[1]; });
      if (a && b && a.loc.type === 'slot' && b.loc.type === 'slot') {
        var ra = slotRect(a.loc.i), rb = slotRect(b.loc.i);
        ctx.strokeStyle = '#ff5050'; ctx.lineWidth = 3; ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(ra.x + ra.w / 2, ra.y + ra.h / 2);
        ctx.lineTo(rb.x + rb.w / 2, rb.y + rb.h / 2);
        ctx.stroke(); ctx.setLineDash([]);
      }
    }
    // 货柜(槽位中)
    state.containers.forEach(function (c) {
      if (c.loc.type === 'slot') {
        var r2 = slotRect(c.loc.i);
        drawContainer(c, r2.x + 8, r2.y + 18, r2.w - 16, r2.h - 26);
      }
    });
    // 吊机: 横梁 + 小车 + 吊具
    var crane = state.crane;
    ctx.strokeStyle = crane.fault ? '#c04040' : '#c0a040'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(60, 150); ctx.lineTo(880, 150); ctx.stroke();
    var trolleyX = 470;
    if (crane.carrying) {
      var cc = state.containers.find(function (x) { return x.id === crane.carrying; });
      if (cc) {
        var prog = crane.task ? 1 - crane.task.ticksLeft / crane.task.duration : 1;
        var from = crane.task && crane.task.origin >= 0 ? slotRect(crane.task.origin) : null;
        var toX = crane.task && crane.task.kind === 'load' ? SHIP.x + 60
          : crane.task && crane.task.target >= 0 ? slotRect(crane.task.target).x : 470;
        var fromX = from ? from.x : 470;
        trolleyX = fromX + (toX - fromX) * prog;
        ctx.strokeStyle = '#ddd'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(trolleyX + 28, 150); ctx.lineTo(trolleyX + 28, 190); ctx.stroke();
        drawContainer(cc, trolleyX, 190, 56, 38);
      }
    }
    ctx.fillStyle = crane.mode === 'busy' ? '#e0c040' : '#8090a0';
    ctx.fillRect(trolleyX + 8, 138, 40, 24);
    // 稳定裕量条
    ctx.fillStyle = '#223'; ctx.fillRect(70, 165, 200, 12);
    ctx.fillStyle = crane.stability > 40 ? '#4fc46f' : crane.stability > 0 ? '#e8a33d' : '#e04040';
    ctx.fillRect(70, 165, Math.max(0, Math.min(200, crane.stability * 2)), 12);
    ctx.fillStyle = '#cfe3f5'; ctx.font = '12px sans-serif';
    ctx.fillText('吊机稳定裕量 ' + Math.round(crane.stability) + '%', 70, 160);
    if (crane.inhibited) {
      ctx.fillStyle = '#ffcf5a';
      ctx.fillText('⛔ ' + crane.inhibitReason, 300, 176);
    }
    // 风向箭头
    var wx = 810, wy = 70, rad = state.wind.dirDeg * Math.PI / 180;
    ctx.strokeStyle = '#7fc8ff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(wx, wy);
    ctx.lineTo(wx + Math.sin(rad) * 40, wy + Math.cos(rad) * 40); ctx.stroke();
    ctx.beginPath(); ctx.arc(wx, wy, 4, 0, 7); ctx.fillStyle = '#7fc8ff'; ctx.fill();
    ctx.fillText('风 ' + state.wind.dirDeg + '° ' + state.wind.speed + 'm/s', wx - 60, wy - 14);
    // 防火水幕
    if (state.curtain.active) {
      ctx.strokeStyle = 'rgba(90,180,255,0.8)'; ctx.lineWidth = 2;
      for (var k = 0; k < 12; k++) {
        ctx.beginPath();
        ctx.moveTo(620 + k * 4, 180);
        ctx.lineTo(620 + k * 4, 420);
        ctx.stroke();
      }
      ctx.fillStyle = '#9fd4ff';
      ctx.fillText('防火水幕开启中 (吊装窗口关闭)', 480, 200);
    }
    // 疏散 / 结算覆盖层
    if (state.evacuation) {
      ctx.fillStyle = 'rgba(200,30,30,0.25)'; ctx.fillRect(40, 180, 560, 220);
      ctx.fillStyle = '#ffb0b0'; ctx.font = 'bold 18px sans-serif';
      ctx.fillText('🚨 局部疏散: ' + state.evacuation.zone, 220, 300);
    }
    if (state.phase !== 'running') {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = state.phase === 'success' ? '#7be495' : '#ff7b7b';
      ctx.font = 'bold 34px sans-serif';
      ctx.fillText(state.phase === 'success' ? '任务成功!' : '任务失败', 330, 280);
      ctx.font = '16px sans-serif'; ctx.fillStyle = '#e0e6ed';
      ctx.fillText(state.phase === 'success'
        ? '三只货柜全部在时限内装船, 无隔离违规'
        : (state.failReason || ''), 300, 315);
    }
  }

  function drawContainer(c, x, y, w, h) {
    ctx.fillStyle = HAZ_COLOR[c.hazard];
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = selected === c.id ? '#ffffff' : '#222';
    ctx.lineWidth = selected === c.id ? 3 : 1;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#10202f'; ctx.font = 'bold 12px sans-serif';
    ctx.fillText(c.id, x + 4, y + 14);
    ctx.font = '10px sans-serif';
    ctx.fillText(HAZ_NAME[c.hazard] + ' ' + c.weight + 't', x + 4, y + h - 5);
    if (c.leaking) {
      ctx.fillStyle = '#ff4040';
      ctx.fillText('泄漏!', x + w - 36, y + 14);
    }
  }
})();
