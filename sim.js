// 除冰仿真核心:确定性、可回放。浏览器与 Node 共用。
(function (global) {
  'use strict';

  const DT = 0.1;                 // 仿真步长(秒),固定时钟
  const TANK_CAPACITY = 240;      // 除冰液容量(升)
  const MAX_SPRAY_PER_CMD = 60;   // 单次喷洒指令上限(升)
  const SPRAY_RATE = 2;           // 喷洒速率(升/秒)
  const LITERS_PER_ICE = 40;      // 完全清除 ice=1.0 所需有效液量(升)
  const TRUCK_SPEED = 6;          // 喷洒车速度(米/秒)
  const HOLDOVER_PER_LITER = 4;   // 每升有效液量提供的防冰保持时间(秒)
  const POLLUTION_PER_LITER = 0.15; // 每升喷出液体的基础排水污染
  const POLLUTION_LIMIT = 100;    // 污染上限,超过判负
  const REICE_RATE = 0.004;       // 无保护且降雪时二次结冰速率(1/秒)
  const WIND_DRIFT_REF = 12;      // 风速参考值:此风速下覆盖率减半(米/秒)
  const REPAIR_TIME = 20;         // 泵故障修复时间(秒)
  const SOAK_TIME = 60;           // 故障恢复后持续观察时间(秒)

  const PLANE_STANDS = [
    { x: 200, y: 300 },
    { x: 450, y: 300 },
    { x: 700, y: 300 },
  ];
  const DEPOT = { x: 80, y: 480 };

  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function createSim(seed, scenarioEvents) {
    const rng = makeRng(seed || 1);
    const sim = {
      tick: 0,
      time: 0,
      rng: rng,
      wind: { speed: 2, dirDeg: 90, gustUntil: 0, gustSpeed: 0 },
      snow: 0.5,
      temp: -4,
      tank: TANK_CAPACITY,
      pollution: 0,
      truck: {
        x: DEPOT.x, y: DEPOT.y,
        state: 'idle', // idle|moving|spraying|broken|repairing
        targetPlane: -1,
        sprayRemaining: 0,
        sprayDelivered: 0,
        pumpOk: true,
        repairTimer: 0,
      },
      planes: PLANE_STANDS.map(function (p, i) {
        return {
          id: i, x: p.x, y: p.y,
          ice: 1.0,
          holdover: 0,
          deiced: false,
          departed: false,
          reicedAlerted: false,
          windowOpen: 60 + i * 40,
          windowClose: 240 + i * 60,
        };
      }),
      events: (scenarioEvents || []).slice().sort(function (a, b) { return a.tick - b.tick; }),
      log: [],
      actionLog: [],
      outcome: null, // null|'success'|'fail'
      failReason: null,
      failTick: null,
    };
    logEvent(sim, 'SIM_START', '仿真开始 seed=' + (seed || 1));
    return sim;
  }

  function margins(sim) {
    let minSlack = Infinity;
    sim.planes.forEach(function (p) {
      if (!p.departed) minSlack = Math.min(minSlack, p.windowClose - sim.time);
    });
    if (minSlack === Infinity) minSlack = 0;
    const maxIce = Math.max.apply(null, sim.planes.map(function (p) { return p.ice; }));
    return {
      fluid: Math.round(sim.tank * 10) / 10,
      pollutionHeadroom: Math.round((POLLUTION_LIMIT - sim.pollution) * 10) / 10,
      minWindowSlack: Math.round(minSlack * 10) / 10,
      maxIce: Math.round(maxIce * 1000) / 1000,
    };
  }

  function logEvent(sim, type, msg) {
    sim.log.push({
      tick: sim.tick,
      time: Math.round(sim.time * 10) / 10,
      type: type,
      msg: msg,
      margins: margins(sim),
    });
  }

  // 玩家/脚本动作。每个动作在指定 tick 应用,并记录进 actionLog 供回放。
  function applyAction(sim, action) {
    if (sim.outcome) return;
    sim.actionLog.push({ tick: sim.tick, type: action.type, plane: action.plane, amount: action.amount });
    const truck = sim.truck;
    if (action.type === 'goto') {
      if (truck.state === 'broken' || truck.state === 'repairing') {
        logEvent(sim, 'ACTION_REJECTED', '车辆维修中,无法移动');
        return;
      }
      truck.targetPlane = action.plane;
      truck.state = 'moving';
      logEvent(sim, 'ACTION', '前往机位 ' + action.plane);
    } else if (action.type === 'spray') {
      let amount = action.amount;
      if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
        logEvent(sim, 'PARAM_OUT_OF_LIMIT', '喷洒量非法: ' + action.amount + ',已忽略(余量 ' + sim.tank.toFixed(1) + 'L)');
        return;
      }
      if (amount > MAX_SPRAY_PER_CMD || amount > sim.tank) {
        const clamped = Math.min(MAX_SPRAY_PER_CMD, sim.tank);
        logEvent(sim, 'PARAM_OUT_OF_LIMIT',
          '喷洒量越限: 请求 ' + amount + 'L,钳制为 ' + clamped.toFixed(1) +
          'L(单次上限 ' + MAX_SPRAY_PER_CMD + 'L,罐内余量 ' + sim.tank.toFixed(1) + 'L)');
        amount = clamped;
      }
      if (truck.state === 'broken' || truck.state === 'repairing' || !truck.pumpOk) {
        logEvent(sim, 'ACTION_REJECTED', '泵故障,无法喷洒');
        return;
      }
      if (truck.state !== 'arrived' && truck.state !== 'idle' && truck.state !== 'spraying') {
        logEvent(sim, 'ACTION_REJECTED', '车辆未到位,无法喷洒');
        return;
      }
      if (truck.targetPlane < 0) {
        logEvent(sim, 'ACTION_REJECTED', '未指定目标机位');
        return;
      }
      truck.sprayRemaining = amount;
      truck.sprayDelivered = 0;
      truck.state = 'spraying';
      logEvent(sim, 'ACTION', '开始喷洒机位 ' + truck.targetPlane + ' 计划 ' + amount.toFixed(1) + 'L');
    } else if (action.type === 'repair') {
      if (truck.state === 'broken') {
        truck.state = 'repairing';
        truck.repairTimer = REPAIR_TIME;
        logEvent(sim, 'ACTION', '开始维修泵,预计 ' + REPAIR_TIME + 's');
      }
    } else if (action.type === 'takeoff') {
      const p = sim.planes[action.plane];
      if (!p || p.departed) return;
      if (p.ice > 0.01) {
        fail(sim, '飞机 ' + p.id + ' 带冰起飞(冰层 ' + p.ice.toFixed(2) + '),事故');
        return;
      }
      if (sim.time > p.windowClose) {
        fail(sim, '飞机 ' + p.id + ' 错过起飞窗口');
        return;
      }
      p.departed = true;
      logEvent(sim, 'TAKEOFF', '飞机 ' + p.id + ' 在窗口内起飞');
      if (sim.planes.every(function (q) { return q.departed; })) {
        sim.outcome = 'success';
        logEvent(sim, 'SUCCESS', '全部飞机安全起飞,任务成功');
      }
    }
  }

  function fail(sim, reason) {
    if (sim.outcome) return;
    sim.outcome = 'fail';
    sim.failReason = reason;
    sim.failTick = sim.tick;
    logEvent(sim, 'FAIL', reason);
  }

  function updateEnvironment(sim) {
    const w = sim.wind;
    // 基础风 + 阵风事件 + 噪声,全部来自确定性 RNG
    let base = 3 + 2 * Math.sin(sim.time / 30);
    if (sim.time < w.gustUntil) base = w.gustSpeed;
    w.speed = Math.max(0, base + (sim.rng() - 0.5) * 1.5);
    w.dirDeg = 90 + 20 * Math.sin(sim.time / 45) + (sim.rng() - 0.5) * 10;
    sim.snow = Math.min(1, Math.max(0.1, 0.5 + 0.3 * Math.sin(sim.time / 50)));
  }

  function fireEvents(sim) {
    while (sim.events.length && sim.events[0].tick <= sim.tick) {
      const ev = sim.events.shift();
      if (ev.type === 'pump_failure') {
        sim.truck.pumpOk = false;
        if (sim.truck.state === 'spraying') sim.truck.sprayRemaining = 0;
        if (sim.truck.state !== 'repairing') sim.truck.state = 'broken';
        logEvent(sim, 'EQUIPMENT_FAILURE', '喷洒泵故障!系统响应: 停止喷洒,等待维修指令');
      } else if (ev.type === 'wind_gust') {
        sim.wind.gustSpeed = ev.speed;
        sim.wind.gustUntil = sim.time + ev.duration;
        logEvent(sim, 'WIND_GUST', '阵风 ' + ev.speed + ' m/s,持续 ' + ev.duration + 's,喷雾将被吹偏');
      } else if (ev.type === 'snow') {
        sim.snow = ev.intensity;
        logEvent(sim, 'ENV', '降雪强度调整为 ' + ev.intensity);
      }
    }
  }

  function moveTruck(sim) {
    const truck = sim.truck;
    if (truck.state !== 'moving') return;
    const p = sim.planes[truck.targetPlane];
    const tx = p.x - 40, ty = p.y + 60;
    const dx = tx - truck.x, dy = ty - truck.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const stepLen = TRUCK_SPEED * DT;
    if (dist <= stepLen) {
      truck.x = tx; truck.y = ty;
      truck.state = 'arrived';
      logEvent(sim, 'TRUCK', '到达机位 ' + p.id);
    } else {
      truck.x += dx / dist * stepLen;
      truck.y += dy / dist * stepLen;
    }
  }

  function sprayTick(sim) {
    const truck = sim.truck;
    if (truck.state !== 'spraying') return;
    if (truck.sprayRemaining <= 0 || sim.tank <= 0) {
      finishSpray(sim);
      return;
    }
    const p = sim.planes[truck.targetPlane];
    const sprayed = Math.min(SPRAY_RATE * DT, truck.sprayRemaining, sim.tank);
    // 风把喷雾吹偏:覆盖率随风速下降,飘失部分加重排水污染
    const coverage = 1 / (1 + sim.wind.speed / WIND_DRIFT_REF);
    const delivered = sprayed * coverage;
    const drifted = sprayed - delivered;
    truck.sprayRemaining -= sprayed;
    truck.sprayDelivered += delivered;
    sim.tank -= sprayed;
    sim.pollution += sprayed * POLLUTION_PER_LITER + drifted * POLLUTION_PER_LITER;
    const iceBefore = p.ice;
    p.ice = Math.max(0, p.ice - delivered / LITERS_PER_ICE);
    const overshoot = delivered - (iceBefore - p.ice) * LITERS_PER_ICE;
    if (overshoot > 0) sim.pollution += overshoot * POLLUTION_PER_LITER * 0.5; // 过量喷洒浪费
    if (p.ice === 0 && !p.deiced) {
      p.deiced = true;
      p.holdover = truck.sprayDelivered * HOLDOVER_PER_LITER;
      logEvent(sim, 'DEICED', '飞机 ' + p.id + ' 除冰完成,防冰保持 ' + p.holdover.toFixed(0) + 's');
    }
    if (truck.sprayRemaining <= 0) finishSpray(sim);
  }

  function finishSpray(sim) {
    const truck = sim.truck;
    logEvent(sim, 'SPRAY_DONE', '喷洒结束,有效落液 ' + truck.sprayDelivered.toFixed(1) + 'L');
    truck.sprayRemaining = 0;
    truck.state = 'arrived';
  }

  function planesTick(sim) {
    sim.planes.forEach(function (p) {
      if (p.departed) return;
      if (p.holdover > 0) {
        p.holdover -= DT;
      } else if (p.deiced && p.ice < 1 && sim.snow > 0.1) {
        p.ice = Math.min(1, p.ice + REICE_RATE * sim.snow * DT);
        if (p.ice > 0.05 && !p.reicedAlerted) {
          p.reicedAlerted = true;
          logEvent(sim, 'REICING', '飞机 ' + p.id + ' 二次结冰!需要重新除冰');
        }
      }
      if (!p.departed && sim.time > p.windowClose && !sim.outcome) {
        fail(sim, '飞机 ' + p.id + ' 错过起飞窗口(关闭于 ' + p.windowClose + 's)');
      }
    });
    if (sim.pollution >= POLLUTION_LIMIT && !sim.outcome) {
      fail(sim, '排水污染超标(' + sim.pollution.toFixed(1) + ' >= ' + POLLUTION_LIMIT + ')');
    }
  }

  function repairTick(sim) {
    const truck = sim.truck;
    if (truck.state !== 'repairing') return;
    truck.repairTimer -= DT;
    if (truck.repairTimer <= 0) {
      truck.pumpOk = true;
      truck.state = 'idle';
      truck.targetPlane = -1;
      logEvent(sim, 'EQUIPMENT_RECOVERED', '泵修复完成,系统恢复到安全状态');
    }
  }

  // 主步进:固定时钟 DT。actions 为本 tick 应用的动作数组。
  function step(sim, actions) {
    if (sim.outcome) return sim;
    (actions || []).forEach(function (a) { applyAction(sim, a); });
    fireEvents(sim);
    updateEnvironment(sim);
    moveTruck(sim);
    sprayTick(sim);
    repairTick(sim);
    planesTick(sim);
    sim.tick += 1;
    sim.time = Math.round(sim.tick * DT * 1000) / 1000;
    return sim;
  }

  // 不变量检查:用于恢复后持续运行(SOAK)期间发现隐藏连锁错误
  function checkInvariants(sim) {
    const violations = [];
    function bad(msg) { violations.push('tick=' + sim.tick + ' ' + msg); }
    if (!isFinite(sim.time) || !isFinite(sim.tank) || !isFinite(sim.pollution)) bad('数值出现 NaN/Infinity');
    if (sim.tank < -1e-9 || sim.tank > TANK_CAPACITY + 1e-9) bad('液罐越界: ' + sim.tank);
    if (sim.pollution < -1e-9) bad('污染为负: ' + sim.pollution);
    sim.planes.forEach(function (p) {
      if (p.ice < -1e-9 || p.ice > 1 + 1e-9) bad('飞机 ' + p.id + ' 冰层越界: ' + p.ice);
      if (!isFinite(p.ice) || !isFinite(p.holdover)) bad('飞机 ' + p.id + ' 状态非法');
    });
    const states = ['idle', 'moving', 'arrived', 'spraying', 'broken', 'repairing'];
    if (states.indexOf(sim.truck.state) < 0) bad('车辆状态非法: ' + sim.truck.state);
    if (sim.truck.pumpOk && sim.truck.state === 'broken') bad('状态跳变: 泵正常但车辆处于 broken');
    return violations;
  }

  // 回放:用相同 seed/事件/动作序列重建仿真,直到 untilTick(含)或结束
  function replay(seed, scenarioEvents, actionLog, untilTick) {
    const sim = createSim(seed, scenarioEvents);
    let cursor = 0;
    const limit = typeof untilTick === 'number' ? untilTick : Infinity;
    while (!sim.outcome && sim.tick <= limit) {
      const acts = [];
      while (cursor < actionLog.length && actionLog[cursor].tick === sim.tick) {
        acts.push(actionLog[cursor]); cursor += 1;
      }
      step(sim, acts);
      if (sim.tick > limit) break;
    }
    return sim;
  }

  const API = {
    DT: DT, TANK_CAPACITY: TANK_CAPACITY, MAX_SPRAY_PER_CMD: MAX_SPRAY_PER_CMD,
    SPRAY_RATE: SPRAY_RATE, LITERS_PER_ICE: LITERS_PER_ICE, TRUCK_SPEED: TRUCK_SPEED,
    HOLDOVER_PER_LITER: HOLDOVER_PER_LITER, POLLUTION_LIMIT: POLLUTION_LIMIT,
    REPAIR_TIME: REPAIR_TIME, SOAK_TIME: SOAK_TIME, PLANE_STANDS: PLANE_STANDS, DEPOT: DEPOT,
    createSim: createSim, step: step, replay: replay,
    margins: margins, checkInvariants: checkInvariants,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.DeiceSim = API;
})(typeof window !== 'undefined' ? window : globalThis);
