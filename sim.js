// 港区危险货柜装船仿真核心 —— 确定性、可回放
// 设备状态、环境变化、操作记录统一挂在同一个仿真时钟(tick)上。
(function (global) {
  'use strict';

  var TICK_MS = 500;            // 1 tick = 0.5s 仿真时间
  var TIME_LIMIT = 240;         // 任务时限 240 tick = 120s
  var WIND_TRAVEL_LIMIT = 15;   // 风速超过此值禁止吊装/移动
  var RATED_LOAD = 40;          // 吊机额定载荷(t)
  var EVAC_GRACE = 6;           // 隔离违规宽限 tick, 超时触发局部疏散
  var LEAK_DRIFT_INTERVAL = 2;  // 泄漏物每 2 tick 顺风扩散一格

  // 确定性随机数 (mulberry32)
  function rngNext(state) {
    state.rngState = (state.rngState + 0x6D2B79F5) >>> 0;
    var t = state.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // 槽位布局: 2 行 x 4 列, 坐标用于隔离距离(曼哈顿)
  var SLOT_COLS = 4;
  var SLOT_POS = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 },
    { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }
  ];

  // 隔离矩阵: 危险等级组合 -> 最小曼哈顿距离
  function minIsolation(h1, h2) {
    var key = h1 < h2 ? h1 + '-' + h2 : h2 + '-' + h1;
    var table = { '1-1': 1, '1-2': 2, '1-3': 2, '2-2': 2, '2-3': 3, '3-3': 1 };
    return table[key];
  }

  function createSim(seed) {
    return {
      seed: seed >>> 0,
      rngState: seed >>> 0,
      tick: 0,
      phase: 'running',          // running | success | failed
      failReason: null,
      crane: {
        mode: 'idle',            // idle | busy | fault
        task: null,              // {kind:'move'|'load', container, target, ticksLeft}
        carrying: null,
        stability: 100,          // 当前稳定裕量 %
        fault: null,             // 注入的设备故障类型
        inhibited: false,
        inhibitReason: ''
      },
      containers: [
        { id: 'C1', hazard: 1, weight: 20, loc: { type: 'slot', i: 6 }, leaking: 0 },
        { id: 'C2', hazard: 2, weight: 32, loc: { type: 'slot', i: 3 }, leaking: 0 },
        { id: 'C3', hazard: 3, weight: 12, loc: { type: 'slot', i: 4 }, leaking: 0 }
      ],
      wind: { dirDeg: 90, speed: 6 },   // dirDeg: 0=北 90=东
      curtain: { active: false, until: 0 },
      plume: [],                 // 泄漏危害区占据的槽位索引
      violation: null,           // {pair:[idA,idB], since}
      evacuation: null,          // {zone, tick}
      ops: [],                   // 操作记录 {tick, op}
      events: [],                // 事件日志 {tick, type, msg, margin}
      stats: { loaded: 0 }
    };
  }

  function logEvent(state, type, msg, margin) {
    var e = { tick: state.tick, type: type, msg: msg };
    if (margin !== undefined) e.margin = Math.round(margin * 10) / 10;
    state.events.push(e);
    return e;
  }

  function slotOf(state, id) {
    for (var i = 0; i < state.containers.length; i++) {
      if (state.containers[i].id === id) return state.containers[i];
    }
    return null;
  }

  function slotOccupied(state, i) {
    return state.containers.some(function (c) {
      return c.loc.type === 'slot' && c.loc.i === i;
    });
  }
  // ---- 操作接口(全部记录进 ops, 支持回放) ----
  function applyOp(state, op) {
    if (state.phase !== 'running') return { ok: false, err: 'mission-over' };
    var rec = { tick: state.tick, op: JSON.parse(JSON.stringify(op)) };
    var c, task;
    switch (op.type) {
      case 'move':               // 吊运货柜到槽位
      case 'load': {             // 吊运货柜上船
        c = slotOf(state, op.container);
        if (!c || c.loc.type !== 'slot') return { ok: false, err: 'bad-container' };
        if (state.crane.mode !== 'idle') return { ok: false, err: 'crane-busy' };
        if (op.type === 'move') {
          if (op.target < 0 || op.target >= SLOT_POS.length || slotOccupied(state, op.target)) {
            return { ok: false, err: 'bad-slot' };
          }
        }
        var dur = 4 + Math.round(c.weight / 8);   // 重箱作业更慢
        task = { kind: op.type, container: c.id, origin: c.loc.i, target: op.type === 'move' ? op.target : -1, ticksLeft: dur, duration: dur };
        state.crane.task = task;
        state.crane.mode = 'busy';
        state.crane.carrying = c.id;
        c.loc = { type: 'crane' };
        state.ops.push(rec);
        logEvent(state, 'OP', (op.type === 'load' ? '开始装船 ' : '开始堆存 ') + c.id);
        return { ok: true };
      }
      case 'curtain':            // 防火水幕 开/关
        state.curtain.active = !!op.on;
        state.curtain.until = op.on ? state.tick + (op.duration || 20) : 0;
        state.ops.push(rec);
        logEvent(state, 'OP', op.on ? '防火水幕开启' : '防火水幕关闭');
        return { ok: true };
      case 'repair':             // 故障修复
        if (state.crane.fault) {
          state.crane.fault = null;
          if (state.crane.mode === 'fault') state.crane.mode = 'idle';
          refreshInhibit(state);
          state.ops.push(rec);
          logEvent(state, 'RECOVER', '吊机故障已修复, 系统恢复安全状态');
          return { ok: true };
        }
        return { ok: false, err: 'no-fault' };
      case 'injectFault':        // 测试注入: 设备故障
        state.crane.fault = op.fault || 'brake';
        state.ops.push(rec);
        logEvent(state, 'FAULT', '设备故障注入: ' + state.crane.fault, state.crane.stability);
        return { ok: true };
      case 'forceWind':          // 测试注入: 强制风向风速
        state.wind.dirDeg = op.dirDeg;
        state.wind.speed = op.speed;
        state.ops.push(rec);
        logEvent(state, 'ENV', '风向突变 ' + op.dirDeg + '° / ' + op.speed + ' m/s');
        return { ok: true };
      case 'triggerLeak': {      // 测试注入: 货柜泄漏
        c = slotOf(state, op.container);
        if (c) { c.leaking = 1; state.ops.push(rec); logEvent(state, 'LEAK', c.id + ' 发生泄漏'); }
        return { ok: !!c };
      }
      default:
        return { ok: false, err: 'unknown-op' };
    }
  }
  // ---- 环境: 风(确定性随机游走) ----
  function updateWind(state) {
    if (state.tick % 10 !== 0) return;
    var r = rngNext(state);
    state.wind.dirDeg = (state.wind.dirDeg + Math.floor(r * 90) - 45 + 360) % 360;
    var r2 = rngNext(state);
    state.wind.speed = Math.max(2, Math.min(18, state.wind.speed + Math.round(r2 * 6) - 3));
  }

  // ---- 吊机联锁状态(水幕/风/疏散/故障任一触发即禁止吊装) ----
  function refreshInhibit(state) {
    var crane = state.crane;
    crane.inhibited = false;
    crane.inhibitReason = '';
    if (state.curtain.active) { crane.inhibited = true; crane.inhibitReason = '水幕开启, 吊装窗口关闭'; }
    if (state.wind.speed > WIND_TRAVEL_LIMIT) { crane.inhibited = true; crane.inhibitReason = '风速超限'; }
    if (state.evacuation) { crane.inhibited = true; crane.inhibitReason = '局部疏散中'; }
    if (crane.fault) { crane.inhibited = true; crane.inhibitReason = '设备故障: ' + crane.fault; }
  }

  // ---- 吊机: 稳定性 = f(载荷, 风, 故障) ----
  function updateCrane(state) {
    var crane = state.crane;
    var load = crane.carrying ? slotOf(state, crane.carrying).weight : 0;
    var margin = 100 - load * 1.2 - state.wind.speed * 2 - (crane.fault ? 60 : 0);
    crane.stability = Math.max(-50, Math.min(100, margin));
    refreshInhibit(state);

    if (crane.mode === 'busy' && crane.task) {
      if (crane.inhibited) {
        // 吊装窗口与水幕/故障/疏散错开: 中断当前任务, 货柜落回原槽位
        var c0 = slotOf(state, crane.task.container);
        c0.loc = { type: 'slot', i: crane.task.origin };
        logEvent(state, 'ABORT', '吊装中断: ' + crane.inhibitReason + ', ' + c0.id + ' 已安全落回', crane.stability);
        crane.task = null; crane.carrying = null; crane.mode = crane.fault ? 'fault' : 'idle';
        return;
      }
      if (crane.stability < 0) {
        var c1 = slotOf(state, crane.task.container);
        c1.loc = { type: 'slot', i: crane.task.origin };
        logEvent(state, 'FAULT', '吊机失稳! 任务中止, ' + c1.id + ' 落回原位', crane.stability);
        crane.task = null; crane.carrying = null; crane.mode = 'fault';
        crane.fault = crane.fault || 'instability';
        return;
      }
      crane.task.ticksLeft--;
      if (crane.task.ticksLeft <= 0) {
        var c2 = slotOf(state, crane.task.container);
        if (crane.task.kind === 'load') {
          c2.loc = { type: 'ship' };
          state.stats.loaded++;
          logEvent(state, 'LOAD', c2.id + ' 装船完成 (' + state.stats.loaded + '/3)', crane.stability);
        } else {
          c2.loc = { type: 'slot', i: crane.task.target };
          logEvent(state, 'MOVE', c2.id + ' 堆存到槽位 ' + crane.task.target, crane.stability);
        }
        crane.task = null; crane.carrying = null; crane.mode = 'idle';
      }
    } else if (crane.mode === 'fault' && !crane.fault) {
      crane.mode = 'idle';
    }
  }
  // ---- 泄漏扩散: 危害区顺风向相邻货区推进, 水幕可抑制 ----
  function updateLeak(state) {
    state.plume = [];
    var leaking = state.containers.filter(function (c) {
      return c.leaking && c.loc.type === 'slot';
    });
    if (!leaking.length) return;
    leaking.forEach(function (c) {
      state.plume.push(c.loc.i);
      if (state.curtain.active) return;              // 水幕抑制扩散
      if (state.tick % LEAK_DRIFT_INTERVAL !== 0) return;
      // 风向映射到网格推进方向 (东=+x, 南=+y)
      var rad = state.wind.dirDeg * Math.PI / 180;
      var dx = Math.round(Math.sin(rad)), dy = Math.round(Math.cos(rad));
      var p = SLOT_POS[c.loc.i];
      var nx = p.x + dx, ny = p.y + dy;
      if (nx < 0 || nx >= SLOT_COLS || ny < 0 || ny > 1) return;
      var ni = ny * SLOT_COLS + nx;
      if (state.plume.indexOf(ni) < 0) {
        state.plume.push(ni);
        logEvent(state, 'PLUME', '泄漏物顺风扩散到槽位 ' + ni + ' (风向 ' + state.wind.dirDeg + '°)');
      }
    });
  }

  // ---- 隔离检查: 违规计时, 超时触发局部疏散 ----
  function updateIsolation(state) {
    var inSlot = state.containers.filter(function (c) { return c.loc.type === 'slot'; });
    var bad = null;
    for (var i = 0; i < inSlot.length && !bad; i++) {
      for (var j = i + 1; j < inSlot.length && !bad; j++) {
        var a = inSlot[i], b = inSlot[j];
        var pa = SLOT_POS[a.loc.i], pb = SLOT_POS[b.loc.i];
        var dist = Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y);
        if (dist < minIsolation(a.hazard, b.hazard)) bad = [a.id, b.id];
      }
    }
    if (bad) {
      if (!state.violation) {
        state.violation = { pair: bad, since: state.tick };
        logEvent(state, 'ALARM', '隔离违规: ' + bad[0] + ' 与 ' + bad[1] + ' 距离不足, ' + EVAC_GRACE + ' tick 内未纠正将局部疏散');
      }
      if (state.tick - state.violation.since >= EVAC_GRACE && !state.evacuation) {
        state.evacuation = { zone: '堆场' + bad.join('/') + ' 区域', tick: state.tick };
        state.phase = 'failed';
        state.failReason = '局部疏散: 隔离违规未在宽限内纠正';
        logEvent(state, 'EVAC', '局部疏散启动! 区域: ' + state.evacuation.zone);
      }
    } else {
      if (state.violation) logEvent(state, 'OK', '隔离违规已纠正');
      state.violation = null;
    }
  }

  // ---- 主时钟: 所有子系统统一在此推进 ----
  function step(state) {
    if (state.phase !== 'running') return state;
    state.tick++;
    if (state.curtain.active && state.tick >= state.curtain.until) {
      state.curtain.active = false;
      logEvent(state, 'ENV', '防火水幕自动关闭, 吊装窗口恢复');
    }
    updateWind(state);
    updateCrane(state);
    updateLeak(state);
    updateIsolation(state);
    if (state.phase === 'running') {
      if (state.stats.loaded >= 3) {
        state.phase = 'success';
        logEvent(state, 'WIN', '三只货柜全部在时限内装船, 无隔离违规, 任务成功');
      } else if (state.tick >= TIME_LIMIT) {
        state.phase = 'failed';
        state.failReason = '超出任务时限';
        logEvent(state, 'FAIL', '超出任务时限, 任务失败');
      }
    }
    return state;
  }

  function run(state, ticks) {
    for (var i = 0; i < ticks && state.phase === 'running'; i++) step(state);
    return state;
  }

  // 状态哈希: 用于确定性/回放一致性校验
  function hashState(state) {
    var s = JSON.stringify([
      state.tick, state.rngState, state.phase, state.crane, state.containers,
      state.wind, state.curtain, state.plume, state.stats
    ]);
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  // 回放: 从种子与操作记录重建任意时刻状态(失败回放)
  function replay(seed, ops, untilTick) {
    var state = createSim(seed);
    var idx = 0;
    ops = ops || [];
    while (state.phase === 'running' && (untilTick === undefined || state.tick < untilTick)) {
      while (idx < ops.length && ops[idx].tick === state.tick) {
        applyOp(state, ops[idx].op);
        idx++;
      }
      step(state);
      if (untilTick === undefined && idx >= ops.length && state.tick > TIME_LIMIT + 100) break;
    }
    return state;
  }

  var API = {
    TICK_MS: TICK_MS, TIME_LIMIT: TIME_LIMIT, WIND_TRAVEL_LIMIT: WIND_TRAVEL_LIMIT,
    RATED_LOAD: RATED_LOAD, EVAC_GRACE: EVAC_GRACE, SLOT_POS: SLOT_POS,
    createSim: createSim, applyOp: applyOp, step: step, run: run,
    replay: replay, hashState: hashState, minIsolation: minIsolation
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.PortSim = API;
})(typeof window !== 'undefined' ? window : globalThis);
