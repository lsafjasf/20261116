/*
 * 临时轨道桥确定性仿真内核
 * 固定步长 0.1s，mulberry32 伪随机数，所有状态变化走同一时钟，
 * 可快照、可回放、可单步。浏览器与 Node 共用本文件。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BridgeEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STEP = 0.1;
  var DECK_LEN = 100;
  var NODE_COUNT = 11;
  var NODE_DX = DECK_LEN / (NODE_COUNT - 1);
  var INFLUENCE = 12;
  var REINFORCE_LIMIT = 2;
  var REINFORCE_BONUS = 90;
  var RESIDUAL_RATIO = 0.32;
  var RESIDUAL_LIMIT = 0.35;
  var DAMAGE_PER_STEP = 0.22;
  var INSTANT_FAIL_RATIO = 1.6;
  var CASCADE_DECK_PENALTY = 0.55;
  var SNAPSHOT_EVERY = 5;

  var LIMITS = {
    gap: [8, 60],
    speed: [2, 10],
    node: [0, NODE_COUNT - 1],
    reinforceAt: [0, 40]
  };

  var TRAIN_TYPES = {
    light:  { name: '轻型维修车', axleLoad: 16, axles: 4, carLen: 9 },
    medium: { name: '中型维修车', axleLoad: 23, axles: 5, carLen: 10 },
    heavy:  { name: '重型维修车', axleLoad: 31, axles: 6, carLen: 12 }
  };

  function mulberry32(seed) {
    var rng = { a: seed >>> 0 };
    rng.next = function () {
      rng.a |= 0;
      rng.a = (rng.a + 0x6D2B79F5) | 0;
      var t = Math.imul(rng.a ^ (rng.a >>> 15), 1 | rng.a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return rng;
  }

  function nodeX(i) { return i * NODE_DX; }

  function makeSupports() {
    return [
      { node: 0, kind: 'abutment', base: 180, cap: 180 },
      { node: 10, kind: 'abutment', base: 180, cap: 180 },
      { id: 'P3', node: 3, kind: 'pier', base: 95, cap: 95, faultCap: 40 },
      { id: 'P5', node: 5, kind: 'pier', base: 110, cap: 110, faultCap: 46, river: true,
        waterBase: 18, erosionRate: 0.035, health: 1 },
      { id: 'P7', node: 7, kind: 'pier', base: 95, cap: 95, faultCap: 40 },
      { node: 2, kind: 'cable', base: 45, cap: 45 },
      { node: 4, kind: 'cable', base: 45, cap: 45 },
      { node: 6, kind: 'cable', base: 45, cap: 45 },
      { node: 8, kind: 'cable', base: 45, cap: 45 }
    ];
  }

  function makeTrains(gap, speed) {
    var order = ['light', 'medium', 'heavy'];
    return order.map(function (type, idx) {
      var spec = TRAIN_TYPES[type];
      var len = spec.axles * spec.carLen;
      return {
        type: type,
        front: -gap * idx - len,
        length: len,
        speed: speed,
        axles: spec.axles,
        axleLoad: spec.axleLoad,
        carLen: spec.carLen,
        entered: false,
        exited: false,
        exitTime: null
      };
    });
  }

  function createSim(opts) {
    opts = opts || {};
    var gap = opts.gap != null ? opts.gap : 18;
    var speed = opts.speed != null ? opts.speed : 6;
    var seed = opts.seed != null ? opts.seed >>> 0 : 20261116;
    var rng = mulberry32(seed);
    return {
      stepIndex: 0,
      t: 0,
      rngState: seed,
      rng: rng,
      gap: gap,
      speed: speed,
      water: 0,
      supports: makeSupports(),
      trains: makeTrains(gap, speed),
      deckCap: (function () {
        var a = [];
        for (var i = 0; i < NODE_COUNT; i++) a.push(i === 0 || i === NODE_COUNT - 1 ? 0 : 42);
        return a;
      })(),
      reinforced: [],
      movesUsed: 0,
      faults: {},
      repairUntil: {},
      demand: new Array(NODE_COUNT).fill(0),
      capacity: new Array(NODE_COUNT).fill(0),
      ratio: new Array(NODE_COUNT).fill(0),
      peakRatio: new Array(NODE_COUNT).fill(0),
      damage: new Array(NODE_COUNT).fill(0),
      failed: [],
      events: [],
      snapshots: [],
      status: 'running',
      failReason: null,
      failTime: null,
      residual: 0,
      finished: false,
      finishTime: null,
      lastMargin: 1,
      commandLog: [],
      pending: [],
      penalties: {}
    };
  }

  function log(sim, type, msg, data) {
    sim.events.push({ t: sim.t, step: sim.stepIndex, type: type, msg: msg,
      data: data ? JSON.parse(JSON.stringify(data)) : null });
  }

  function supportAt(sim, node) {
    return sim.supports.filter(function (s) { return s.node === node; });
  }

  function sendCommand(sim, cmd) {
    var queued = Object.assign({}, cmd);
    if (queued.at == null) queued.at = sim.t;
    sim.pending.push(queued);
    sim.pending.sort(function (a, b) { return a.at - b.at; });
  }

  function scheduleFault(sim, fault) {
    sendCommand(sim, { type: 'injectFault', at: fault.at,
      kind: fault.kind, target: fault.target, duration: fault.duration || 0 });
  }

  function reject(sim, cmd, reason) {
    log(sim, 'reject', '参数越限/非法操作被拒绝: ' + reason, { cmd: cmd });
  }

  function applyCommand(sim, cmd) {
    sim.commandLog.push(JSON.parse(JSON.stringify(cmd)));
    var i, n;
    if (cmd.type === 'setGap' || cmd.type === 'setSpeed') {
      var field = cmd.type === 'setGap' ? 'gap' : 'speed';
      var range = LIMITS[field];
      if (typeof cmd.value !== 'number' || cmd.value < range[0] || cmd.value > range[1]) {
        reject(sim, cmd, field + '=' + cmd.value + ' 超出 [' + range[0] + ',' + range[1] + ']');
        return;
      }
      if (sim.trains.some(function (tr) { return tr.entered && !tr.exited; })) {
        reject(sim, cmd, '列车已上桥，禁止改变' + field);
        return;
      }
      sim[field] = cmd.value;
      log(sim, 'command', field + ' 调整为 ' + cmd.value, { cmd: cmd });
      return;
    }
    if (cmd.type === 'movePier') {
      if (sim.movesUsed >= 2) { reject(sim, cmd, '桥墩移动次数已用尽'); return; }
      if (cmd.node < 1 || cmd.node > NODE_COUNT - 2) { reject(sim, cmd, '目标节点非法'); return; }
      if (supportAt(sim, cmd.node).length) { reject(sim, cmd, '目标节点已有支撑'); return; }
      if (sim.trains.some(function (tr) { return tr.entered && !tr.exited; })) {
        reject(sim, cmd, '列车在桥时禁止移动桥墩'); return;
      }
      var pier = sim.supports.find(function (s) { return s.id === cmd.id && s.kind === 'pier'; });
      if (!pier) { reject(sim, cmd, '桥墩编号不存在'); return; }
      log(sim, 'move', pier.id + ' 节点 ' + pier.node + ' -> ' + cmd.node, { cmd: cmd });
      pier.node = cmd.node;
      sim.movesUsed += 1;
      return;
    }
    if (cmd.type === 'reinforce') {
      if (sim.reinforced.length >= REINFORCE_LIMIT) { reject(sim, cmd, '加固名额已用尽'); return; }
      if (cmd.node < LIMITS.node[0] || cmd.node > LIMITS.node[1]) {
        reject(sim, cmd, '加固节点越限'); return;
      }
      if (sim.reinforced.indexOf(cmd.node) >= 0) { reject(sim, cmd, '该节点已加固'); return; }
      if (sim.t > LIMITS.reinforceAt[1]) { reject(sim, cmd, '已超过加固时间窗 t=40s'); return; }
      sim.reinforced.push(cmd.node);
      log(sim, 'reinforce', '节点 ' + cmd.node + ' 加固完成 (+' + REINFORCE_BONUS + ')',
        { cmd: cmd, remaining: REINFORCE_LIMIT - sim.reinforced.length });
      return;
    }
    if (cmd.type === 'injectFault') {
      var key = cmd.kind + ':' + cmd.target;
      sim.faults[key] = { kind: cmd.kind, target: cmd.target,
        from: sim.t, until: cmd.duration ? sim.t + cmd.duration : null };
      log(sim, 'fault', '设备故障: ' + key + ' @t=' + sim.t.toFixed(1),
        { margin: Number(sim.lastMargin.toFixed(3)) });
      return;
    }
    if (cmd.type === 'repair') {
      var rk = cmd.kind + ':' + cmd.target;
      if (sim.faults[rk]) {
        sim.faults[rk].repairedAt = sim.t;
        sim.repairUntil[rk] = sim.t + (cmd.duration || 0);
        log(sim, 'repair', '故障 ' + rk + ' 已处置，恢复安全状态', { cmd: cmd });
      }
      return;
    }
    reject(sim, cmd, '未知命令');
  }

  function faultActive(sim, kind, target) {
    var f = sim.faults[kind + ':' + target];
    if (!f) return false;
    if (f.repairedAt != null) return false;
    if (f.until != null && sim.t >= f.until) return false;
    return true;
  }

  function advanceTrains(sim) {
    sim.trains.forEach(function (tr) {
      tr.front += tr.speed * STEP;
      var rear = tr.front - tr.length;
      if (!tr.entered && tr.front > 0) {
        tr.entered = true;
        log(sim, 'enter', TRAIN_TYPES[tr.type].name + ' 上桥', { front: tr.front });
      }
      if (tr.entered && !tr.exited && rear >= DECK_LEN) {
        tr.exited = true;
        tr.exitTime = sim.t;
        log(sim, 'exit', TRAIN_TYPES[tr.type].name + ' 完全通过', { t: sim.t });
      }
    });
  }

  function computeDemand(sim) {
    var d = new Array(NODE_COUNT).fill(0);
    sim.trains.forEach(function (tr) {
      if (!tr.entered || tr.exited) return;
      for (var a = 0; a < tr.axles; a++) {
        var x = tr.front - a * tr.carLen;
        if (x <= 0 || x >= DECK_LEN) continue;
        var jitter = (sim.rng.next() - 0.5) * 0.12;
        var dyn = 1.12 + jitter;
        for (var i = 0; i < NODE_COUNT; i++) {
          var dist = Math.abs(nodeX(i) - x);
          if (dist > INFLUENCE) continue;
          var w = (1 - dist / INFLUENCE) * (1 - dist / INFLUENCE);
          d[i] += tr.axleLoad * dyn * w;
        }
      }
    });
    sim.demand = d.map(function (v) { return Number(v.toFixed(4)); });
  }

  function computeCapacity(sim) {
    var cap = sim.deckCap.slice();
    sim.supports.forEach(function (s) {
      var c = s.base;
      if (s.kind === 'pier') {
        if (s.river && sim.water >= s.waterBase) {
          c = s.base * s.health;
        }
        if (faultActive(sim, 'pump', s.id)) c = Math.min(c, s.faultCap);
        if (faultActive(sim, 'tension', s.id)) c *= 0.45;
      }
      if (s.kind === 'cable' && faultActive(sim, 'cable', s.node)) c *= 0.25;
      s.cap = Number(c.toFixed(3));
      cap[s.node] += s.cap;
    });
    sim.reinforced.forEach(function (node) {
      cap[node] += REINFORCE_BONUS;
    });
    sim.failed.forEach(function (node) {
      cap[node] = 0;
      var left = Math.max(0, node - 1), right = Math.min(NODE_COUNT - 1, node + 1);
      cap[left] *= CASCADE_DECK_PENALTY;
      cap[right] *= CASCADE_DECK_PENALTY;
    });
    sim.capacity = cap.map(function (v) { return Number(v.toFixed(4)); });
  }

  function evaluateStress(sim) {
    var minMargin = 1;
    for (var i = 0; i < NODE_COUNT; i++) {
      var r = sim.capacity[i] > 0 ? sim.demand[i] / sim.capacity[i] : 0;
      if (sim.failed.indexOf(i) >= 0) r = 1.2;
      sim.ratio[i] = Number(r.toFixed(4));
      sim.peakRatio[i] = Math.max(sim.peakRatio[i], sim.ratio[i]);
      if (sim.capacity[i] > 0) {
        var margin = 1 - r;
        if (margin < minMargin) minMargin = margin;
      }
      if (sim.failed.indexOf(i) >= 0) continue;
      if (r >= 1) {
        sim.damage[i] = Number((sim.damage[i] + DAMAGE_PER_STEP).toFixed(3));
        if (sim.damage[i] >= 1 || r >= INSTANT_FAIL_RATIO) {
          failNode(sim, i, r);
        } else {
          log(sim, 'overload', '节点 ' + i + ' 过载 r=' + r.toFixed(2) +
            ' 损伤=' + sim.damage[i].toFixed(2),
            { node: i, ratio: Number(r.toFixed(3)), margin: Number((1 - r).toFixed(3)) });
        }
      } else {
        sim.damage[i] = Math.max(0, sim.damage[i] - 0.05);
      }
    }
    sim.lastMargin = Number(minMargin.toFixed(4));
  }

  function failNode(sim, node, ratio) {
    if (sim.failed.indexOf(node) >= 0) return;
    sim.failed.push(node);
    sim.supports = sim.supports.filter(function (s) {
      return s.node !== node || s.kind === 'abutment';
    });
    log(sim, 'nodefail', '节点 ' + node + ' 失稳 r=' + ratio.toFixed(2) +
      '，相邻节点容量被连锁折减', { node: node, ratio: Number(ratio.toFixed(3)) });
    if (sim.status === 'running') {
      sim.status = 'failed';
      sim.failReason = '节点 ' + node + ' 单点过载引发连锁失稳';
      sim.failTime = sim.t;
    }
  }

  function updateWater(sim) {
    sim.water = Math.min(28, 1.6 * sim.t);
    var river = sim.supports.find(function (s) { return s.river; });
    if (river && sim.water >= river.waterBase) {
      var submerged = sim.water - river.waterBase;
      river.health = Number(Math.max(0.18, 1 - submerged * river.erosionRate).toFixed(4));
    }
  }

  function checkFaultExpiry(sim) {
    Object.keys(sim.faults).forEach(function (key) {
      var f = sim.faults[key];
      if (f.repairedAt != null || f.until == null || f.expired) return;
      if (sim.t >= f.until) {
        f.expired = true;
        log(sim, 'faultclear', '故障 ' + key + ' 到时自动解除', { t: sim.t });
      }
    });
  }

  function snapshot(sim) {
    return {
      stepIndex: sim.stepIndex,
      t: Number(sim.t.toFixed(4)),
      rngState: sim.rng.a,
      water: Number(sim.water.toFixed(4)),
      gap: sim.gap,
      speed: sim.speed,
      supports: JSON.parse(JSON.stringify(sim.supports)),
      trains: JSON.parse(JSON.stringify(sim.trains)),
      reinforced: sim.reinforced.slice(),
      movesUsed: sim.movesUsed,
      faults: JSON.parse(JSON.stringify(sim.faults)),
      repairUntil: JSON.parse(JSON.stringify(sim.repairUntil)),
      damage: sim.damage.slice(),
      failed: sim.failed.slice(),
      demand: sim.demand.slice(),
      capacity: sim.capacity.slice(),
      ratio: sim.ratio.slice(),
      peakRatio: sim.peakRatio.slice(),
      lastMargin: sim.lastMargin,
      status: sim.status,
      failReason: sim.failReason,
      failTime: sim.failTime,
      finished: sim.finished,
      finishTime: sim.finishTime,
      residual: sim.residual
    };
  }

  function step(sim) {
    if (sim.finished) {
      sim.t = Number((sim.t + STEP).toFixed(4));
      sim.stepIndex += 1;
      while (sim.pending.length && sim.pending[0].at <= sim.t + 1e-9) {
        applyCommand(sim, sim.pending.shift());
      }
      updateWater(sim);
      computeDemand(sim);
      computeCapacity(sim);
      for (var k = 0; k < NODE_COUNT; k++) {
        var rr = sim.capacity[k] > 0 ? sim.demand[k] / sim.capacity[k] : 0;
        if (sim.failed.indexOf(k) >= 0) rr = 1.2;
        sim.ratio[k] = Number(rr.toFixed(4));
        sim.peakRatio[k] = Math.max(sim.peakRatio[k], sim.ratio[k]);
        if (sim.demand[k] === 0 && sim.failed.indexOf(k) < 0) {
          sim.damage[k] = Math.max(0, sim.damage[k] - 0.05);
        }
      }
      sim.residual = sim.status === 'failed' ? sim.residual : Math.max.apply(null, sim.ratio);
      return sim;
    }
    if (sim.status === 'failed') {
      sim.t = Number((sim.t + STEP).toFixed(4));
      sim.stepIndex += 1;
      while (sim.pending.length && sim.pending[0].at <= sim.t + 1e-9) {
        applyCommand(sim, sim.pending.shift());
      }
      updateWater(sim);
      advanceTrains(sim);
      computeDemand(sim);
      computeCapacity(sim);
      evaluateStress(sim);
      return sim;
    }
    sim.t = Number((sim.t + STEP).toFixed(4));
    sim.stepIndex += 1;
    while (sim.pending.length && sim.pending[0].at <= sim.t + 1e-9) {
      applyCommand(sim, sim.pending.shift());
    }
    checkFaultExpiry(sim);
    updateWater(sim);
    advanceTrains(sim);
    computeDemand(sim);
    computeCapacity(sim);
    evaluateStress(sim);
    if (sim.stepIndex % SNAPSHOT_EVERY === 0) {
      sim.snapshots.push(snapshot(sim));
    }
    var allOut = sim.trains.every(function (tr) { return tr.exited; });
    if (allOut && !sim.finished) {
      sim.finished = true;
      sim.finishTime = sim.t;
      sim.residual = Math.max.apply(null, sim.ratio);
      if (sim.status === 'failed') {
        log(sim, 'end', '运输结束但桥体已失稳', { residual: sim.residual });
      } else if (sim.residual > RESIDUAL_LIMIT) {
        sim.status = 'failed';
        sim.failReason = '残余应力 ' + sim.residual.toFixed(3) +
          ' 高于阈值 ' + RESIDUAL_LIMIT;
        sim.failTime = sim.t;
        log(sim, 'end', sim.failReason, { residual: Number(sim.residual.toFixed(3)) });
      } else {
        sim.status = 'success';
        log(sim, 'end', '全部列车通过，残余应力 ' + sim.residual.toFixed(3) +
          ' < ' + RESIDUAL_LIMIT + '，运输成功',
          { residual: Number(sim.residual.toFixed(3)) });
      }
    }
    return sim;
  }

  function run(sim, maxSteps) {
    var guard = maxSteps || 4000;
    while (!sim.finished && guard-- > 0) step(sim);
    var tailEnd = (sim.failTime || sim.t) + 12;
    while (sim.status === 'failed' && guard-- > 0 && sim.t < tailEnd) step(sim);
    return sim;
  }

  function restore(sim, snap, replay) {
    snap = JSON.parse(JSON.stringify(snap));
    Object.keys(snap).forEach(function (k) { sim[k] = snap[k]; });
    sim.rng = mulberry32(sim.rngState);
    sim.rng.a = sim.rngState;
    sim.pending = [];
    sim.events = [];
    sim.snapshots = [];
    if (replay) {
      sim.failed = [];
      sim.status = 'running';
      sim.failReason = null;
      sim.failTime = null;
      sim.finished = false;
      sim.finishTime = null;
      sim.supports = makeSupports();
      sim.supports.forEach(function (fresh, idx) {
        var old = snap.supports[idx];
        if (old) Object.assign(fresh, { node: old.node, health: old.health, cap: old.cap });
      });
    }
    return sim;
  }

  return {
    STEP: STEP,
    DECK_LEN: DECK_LEN,
    NODE_COUNT: NODE_COUNT,
    NODE_DX: NODE_DX,
    INFLUENCE: INFLUENCE,
    LIMITS: LIMITS,
    TRAIN_TYPES: TRAIN_TYPES,
    REINFORCE_LIMIT: REINFORCE_LIMIT,
    REINFORCE_BONUS: REINFORCE_BONUS,
    RESIDUAL_LIMIT: RESIDUAL_LIMIT,
    createSim: createSim,
    mulberry32: mulberry32,
    nodeX: nodeX,
    step: step,
    run: run,
    sendCommand: sendCommand,
    scheduleFault: scheduleFault,
    snapshot: snapshot,
    restore: restore,
    supportAt: supportAt
  };
});
