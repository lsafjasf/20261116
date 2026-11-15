// 矿井救援升降机 —— 确定性仿真核心
// 所有状态迁移只发生在固定步长的仿真时钟 tick 中,
// 设备状态、环境变化、操作记录统一写入带时间戳的日志, 可完整回放。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MineSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DT = 0.5; // 每 tick 仿真秒数, 全局唯一时钟步长

  // 确定性 PRNG (mulberry32), 同一种子产生同一序列 -> 可重复仿真
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var LEVELS = [0, 150, 300, 450, 600]; // 各水平深度(m), L0=地面

  var CONFIG = {
    dt: DT,
    levels: LEVELS,
    cageSpeed: 3.0,          // m/s
    capacity: 400,           // 载重 kg
    batteryMax: 100,
    batteryRecharge: 0.35,   // 地面停靠时每 tick 充电
    energyPerMeterEmpty: 0.004,
    energyPerMeterPerKg: 0.000012,
    brakeWearPerStop: 4,     // 每次停靠制动磨损
    brakeWearLimit: 100,
    brakeRepairTicks: 60,    // 制动故障修复耗时(tick)
    tempSafeLimit: 40,       // 井段安全温度 ℃
    tempHardLimit: 55,       // 越限硬阈值 -> 参数越限故障
    heatStressRate: 0.01,    // 高温段等待人员热应激/tick
    heatStressLimit: 100,
    ventRecoveryTicks: 80,   // 通风恶化后恢复耗时
    soakTicks: 400           // 故障恢复后确认运行的固定时长
  };

  // 井段环境: 每段有温度与通风状态
  function initialSegments() {
    return [
      { id: 0, from: 0,   to: 150, temp: 26, vent: 'good' },
      { id: 1, from: 150, to: 300, temp: 31, vent: 'good' },
      { id: 2, from: 300, to: 450, temp: 36, vent: 'poor' },
      { id: 3, from: 450, to: 600, temp: 38, vent: 'poor' }
    ];
  }

  // 九名工人, 不同深度; 两组设备在地面待下送
  function initialActors() {
    var weights = [72, 85, 68, 90, 77, 64, 95, 81, 70];
    var atLevel = [1, 1, 2, 2, 2, 3, 3, 4, 4];
    var workers = weights.map(function (w, i) {
      return { id: 'W' + (i + 1), kind: 'worker', weight: w,
               level: atLevel[i], rescued: false, heatStress: 0 };
    });
    var equipment = [
      { id: 'EA', kind: 'equipment', weight: 180, level: 0, targetLevel: 3, delivered: false },
      { id: 'EB', kind: 'equipment', weight: 250, level: 0, targetLevel: 2, delivered: false }
    ];
    return workers.concat(equipment);
  }

  function createSim(seed) {
    var rng = makeRng(seed == null ? 20261116 : seed);
    var sim = {
      seed: seed == null ? 20261116 : seed,
      rng: rng,
      tick: 0,
      time: 0,
      cfg: CONFIG,
      segments: initialSegments(),
      actors: initialActors(),
      cage: { pos: 0, level: 0, load: [], moving: false, targetPos: 0, dir: 0 },
      battery: CONFIG.batteryMax,
      brakeWear: 0,
      brakeFailed: false,
      repairRemaining: 0,
      queue: [],          // 任务队列: {type:'rescue'|'deliver', actorId}
      activeJob: null,
      phase: 'idle',      // idle|toPickup|toDropoff|repair|done|failed
      failures: [],       // 故障记录 {tick,time,type,margin,response}
      log: [],            // 统一日志 {tick,time,cat,msg}
      opLog: [],          // 操作记录(用于回放) {tick,op,args}
      envEvents: [],      // 环境变化记录
      result: null,       // 'success' | 'failure'
      soak: null          // 恢复后浸泡观察 {remaining, baseline}
    };
    logEvent(sim, 'sys', '仿真初始化 seed=' + sim.seed);
    return sim;
  }

  function logEvent(sim, cat, msg, extra) {
    var entry = { tick: sim.tick, time: +sim.time.toFixed(2), cat: cat, msg: msg };
    if (extra) entry.data = extra;
    sim.log.push(entry);
    return entry;
  }

  function findActor(sim, id) {
    for (var i = 0; i < sim.actors.length; i++) {
      if (sim.actors[i].id === id) return sim.actors[i];
    }
    return null;
  }

  function loadWeight(sim) {
    return sim.cage.load.reduce(function (s, a) { return s + a.weight; }, 0);
  }

  function recordFailure(sim, type, margin, response) {
    var f = { tick: sim.tick, time: +sim.time.toFixed(2),
              type: type, margin: +margin.toFixed(3), response: response };
    sim.failures.push(f);
    logEvent(sim, 'fault', '故障[' + type + '] 余量=' + f.margin + ' 响应=' + response, f);
    return f;
  }

  // ---- 玩家/脚本操作(全部带 tick 时间戳进入 opLog, 支持回放) ----

  function applyOp(sim, op, args) {
    sim.opLog.push({ tick: sim.tick, op: op, args: args });
    logEvent(sim, 'op', '操作 ' + op + ' ' + JSON.stringify(args));
    if (op === 'enqueue') {
      sim.queue.push({ type: args.type, actorId: args.actorId });
    } else if (op === 'reorder') {
      var i = args.from, j = args.to;
      if (i >= 0 && i < sim.queue.length && j >= 0 && j < sim.queue.length) {
        var item = sim.queue.splice(i, 1)[0];
        sim.queue.splice(j, 0, item);
        logEvent(sim, 'op', '队列重排: ' + i + ' -> ' + j);
      }
    } else if (op === 'overload') {
      // 强制超载尝试: 把指定人员强行加入当前载荷
      var actor = findActor(sim, args.actorId);
      if (actor && actor.level === sim.cage.level && !sim.cage.moving) {
        sim.cage.load.push(actor);
        actor.level = -1;
        var w = loadWeight(sim);
        if (w > sim.cfg.capacity) {
          recordFailure(sim, 'overload', sim.cfg.capacity - w,
            '超载保护动作: 电机闭锁, 卸载超额载荷, 电量惩罚');
          sim.battery = Math.max(0, sim.battery - 8);
          sim.brakeWear = Math.min(sim.cfg.brakeWearLimit, sim.brakeWear + 6);
          // 卸载直到不超载
          while (loadWeight(sim) > sim.cfg.capacity && sim.cage.load.length) {
            var dropped = sim.cage.load.pop();
            dropped.level = sim.cage.level;
            logEvent(sim, 'sys', dropped.id + ' 被卸载回 L' + dropped.level);
          }
        }
      }
    }
  }

  // 重放: 从初始状态按 opLog 重放到指定 tick(含), 用于失败回放
  function replay(seed, opLog, untilTick) {
    var sim = createSim(seed);
    var ops = opLog.slice().sort(function (a, b) { return a.tick - b.tick; });
    var oi = 0;
    var end = untilTick == null ? Infinity : untilTick;
    while (sim.tick < end && !sim.result) {
      while (oi < ops.length && ops[oi].tick === sim.tick) {
        applyOp(sim, ops[oi].op, ops[oi].args);
        oi++;
      }
      step(sim);
    }
    return sim;
  }

  // 状态摘要哈希, 用于回放一致性校验
  function stateHash(sim) {
    var s = [sim.tick, sim.cage.pos.toFixed(2), sim.battery.toFixed(3),
             sim.brakeWear.toFixed(2), sim.phase,
             sim.actors.map(function (a) { return a.id + ':' + a.level; }).join(','),
             sim.segments.map(function (g) { return g.temp.toFixed(1) + g.vent; }).join(',')
            ].join('|');
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  // ---- 环境变化: 确定性时刻表 + 种子随机扰动, 全部记入 envEvents ----

  function updateEnvironment(sim) {
    var t = sim.tick;
    // 确定性热浪: t=240 段2 升温, t=700 段3 升温(可复现)
    if (t === 240) setTemp(sim, 2, 44, '通风管道受热, 段2温度上升');
    if (t === 700) setTemp(sim, 3, 46, '深层地热异常, 段3温度上升');
    // 通风恶化/恢复(种子随机, 回放一致)
    if (t > 0 && t % 150 === 0 && sim.rng() < 0.5) {
      var idx = Math.floor(sim.rng() * sim.segments.length);
      var seg = sim.segments[idx];
      if (seg.vent === 'good') {
        seg.vent = 'poor';
        seg.ventTimer = sim.cfg.ventRecoveryTicks;
        pushEnv(sim, 'vent', '段' + idx + ' 通风恶化');
      }
    }
    sim.segments.forEach(function (seg, i) {
      if (seg.vent === 'poor') {
        seg.temp = Math.min(60, seg.temp + 0.002); // 通风差缓慢升温
        if (seg.ventTimer != null && --seg.ventTimer <= 0) {
          seg.vent = 'good';
          seg.ventTimer = null;
          pushEnv(sim, 'vent', '段' + i + ' 通风恢复');
        }
      } else {
        var base = 26 + i * 4;
        if (seg.temp > base) seg.temp = Math.max(base, seg.temp - 0.005);
      }
      // 参数越限检测: 温度超过硬阈值
      if (seg.temp > sim.cfg.tempHardLimit && !seg.overLimit) {
        seg.overLimit = true;
        recordFailure(sim, 'param_overtemp', sim.cfg.tempHardLimit - seg.temp,
          '越限保护: 段' + i + ' 强制通风+暂停该段停靠');
        seg.vent = 'good'; // 系统响应: 强制通风降温
        seg.temp = sim.cfg.tempHardLimit - 2;
        seg.ventTimer = null;
        seg.overLimit = false;
        pushEnv(sim, 'temp', '段' + i + ' 温度越限后强制回落');
        startSoak(sim, 'overtemp_recovered');
      }
    });
  }

  function setTemp(sim, segId, temp, why) {
    sim.segments[segId].temp = temp;
    pushEnv(sim, 'temp', why + ' (段' + segId + '=' + temp + '℃)');
  }

  function pushEnv(sim, kind, msg) {
    var e = { tick: sim.tick, time: +sim.time.toFixed(2), kind: kind, msg: msg };
    sim.envEvents.push(e);
    logEvent(sim, 'env', msg);
  }

  function segmentAt(sim, depth) {
    for (var i = 0; i < sim.segments.length; i++) {
      var s = sim.segments[i];
      if (depth >= s.from && depth < s.to) return s;
    }
    return sim.segments[sim.segments.length - 1];
  }

  // ---- 任务执行: 取货 -> 送达 ----

  function nearestLevel(pos) {
    var best = 0, bd = Infinity;
    LEVELS.forEach(function (d, i) {
      var dd = Math.abs(d - pos);
      if (dd < bd) { bd = dd; best = i; }
    });
    return best;
  }

  function startMove(sim, targetLevel) {
    sim.cage.targetPos = LEVELS[targetLevel];
    sim.cage.dir = Math.sign(sim.cage.targetPos - sim.cage.pos);
    sim.cage.moving = true;
  }

  function arriveStop(sim) {
    sim.cage.moving = false;
    sim.cage.pos = sim.cage.targetPos;
    sim.cage.level = nearestLevel(sim.cage.pos);
    sim.brakeWear = Math.min(sim.cfg.brakeWearLimit,
                             sim.brakeWear + sim.cfg.brakeWearPerStop);
    logEvent(sim, 'dev', '停靠 L' + sim.cage.level +
             ' 制动磨损=' + sim.brakeWear.toFixed(0) + '/' + sim.cfg.brakeWearLimit);
    if (sim.brakeWear >= sim.cfg.brakeWearLimit && !sim.brakeFailed) {
      sim.brakeFailed = true;
      sim.repairRemaining = sim.cfg.brakeRepairTicks;
      recordFailure(sim, 'brake_wear',
        sim.cfg.brakeWearLimit - sim.brakeWear,
        '紧急抱闸, 闭锁运行, 启动检修 ' + sim.cfg.brakeRepairTicks + ' tick');
      sim.phase = 'repair';
    }
  }

  function tryLoad(sim, actor) {
    var w = loadWeight(sim) + actor.weight;
    if (w > sim.cfg.capacity) {
      logEvent(sim, 'sys', actor.id + ' 超重无法装载 (' + w + '>' +
               sim.cfg.capacity + '), 等待下一趟');
      return false;
    }
    sim.cage.load.push(actor);
    actor.level = -1; // 在轿厢内
    return true;
  }

  function unloadAll(sim, atLevel) {
    sim.cage.load.forEach(function (a) {
      a.level = atLevel;
      if (a.kind === 'worker' && atLevel === 0) {
        a.rescued = true;
        logEvent(sim, 'sys', a.id + ' 安全升井 ✔');
      }
      if (a.kind === 'equipment' && atLevel === a.targetLevel) {
        a.delivered = true;
        logEvent(sim, 'sys', a.id + ' 送达目标层 L' + atLevel + ' ✔');
      }
    });
    sim.cage.load = [];
  }

  function tickJob(sim) {
    if (!sim.activeJob) {
      if (!sim.queue.length) { sim.phase = 'idle'; return; }
      // 低电保护: 在地面等待回充, 防止中途电量耗尽
      if (sim.battery < 8 && sim.cage.level === 0) return;
      var job = sim.queue[0];
      var actor = findActor(sim, job.actorId);
      if (!actor || actor.rescued || actor.delivered) { sim.queue.shift(); return; }
      sim.activeJob = job;
      sim.queue.shift();
      sim.phase = 'toPickup';
    }
    var job2 = sim.activeJob;
    var target = findActor(sim, job2.actorId);
    if (sim.phase === 'toPickup') {
      if (sim.cage.level !== target.level || sim.cage.moving) {
        if (!sim.cage.moving) startMove(sim, target.level);
      } else {
        if (!tryLoad(sim, target)) { sim.activeJob = null; sim.phase = 'idle'; return; }
        sim.phase = 'toDropoff';
        logEvent(sim, 'sys', target.id + ' 已装载, 前往 ' +
          (target.kind === 'worker' ? '地面' : 'L' + target.targetLevel));
      }
    } else if (sim.phase === 'toDropoff') {
      var dest = target.kind === 'worker' ? 0 : target.targetLevel;
      if (sim.cage.level !== dest || sim.cage.moving) {
        if (!sim.cage.moving) startMove(sim, dest);
      } else {
        unloadAll(sim, dest);
        sim.activeJob = null;
        sim.phase = 'idle';
      }
    }
  }

  // ---- 主时钟: 每 tick 推进所有子系统, 顺序固定保证可重复 ----

  function step(sim) {
    if (sim.result) return;
    sim.tick++;
    sim.time = sim.tick * sim.cfg.dt;

    updateEnvironment(sim);

    // 制动检修倒计时
    if (sim.brakeFailed) {
      sim.repairRemaining--;
      if (sim.repairRemaining <= 0) {
        sim.brakeFailed = false;
        sim.brakeWear = 40; // 检修后部分恢复
        // 恢复被中断的任务现场: 已载货则继续送达, 否则重新接载
        if (sim.activeJob) {
          var t = findActor(sim, sim.activeJob.actorId);
          sim.phase = (t && t.level === -1) ? 'toDropoff' : 'toPickup';
        } else {
          sim.phase = 'idle';
        }
        logEvent(sim, 'dev', '制动系统检修完成, 磨损复位至 40');
        startSoak(sim, 'brake_repair');
      }
    } else if (sim.cage.moving) {
      // 轿厢运动 + 能耗(随负载变化)
      var w = loadWeight(sim);
      var dist = sim.cfg.cageSpeed * sim.cfg.dt;
      var remain = Math.abs(sim.cage.targetPos - sim.cage.pos);
      if (dist >= remain) dist = remain;
      sim.cage.pos += sim.cage.dir * dist;
      var e = dist * (sim.cfg.energyPerMeterEmpty +
                      sim.cfg.energyPerMeterPerKg * w);
      sim.battery = Math.max(0, sim.battery - e);
      if (dist >= remain - 1e-9) arriveStop(sim);
      if (sim.battery <= 0 && sim.cage.moving) {
        sim.cage.moving = false;
        recordFailure(sim, 'battery_empty', sim.battery,
          '低电保护: 就地停靠, 等待地面回充');
      }
    } else {
      // 停靠: 地面回充电量
      if (sim.cage.level === 0) {
        sim.battery = Math.min(sim.cfg.batteryMax,
                               sim.battery + sim.cfg.batteryRecharge);
      } else if (sim.battery <= 0) {
        // 井道内电量耗尽: 应急电源缓慢回充, 避免死锁
        sim.battery = Math.min(sim.cfg.batteryMax, sim.battery + 0.05);
      }
      if (!sim.brakeFailed) tickJob(sim);
    }

    // 高温段等待人员热应激
    sim.actors.forEach(function (a) {
      if (a.kind !== 'worker' || a.rescued || a.level < 0) return;
      var seg = segmentAt(sim, LEVELS[a.level] + 1);
      if (seg.temp > sim.cfg.tempSafeLimit) {
        a.heatStress = Math.min(sim.cfg.heatStressLimit,
          a.heatStress + sim.cfg.heatStressRate *
            (seg.vent === 'poor' ? 1.6 : 1));
      } else {
        a.heatStress = Math.max(0, a.heatStress - 0.2);
      }
    });

    // 浸泡观察: 故障恢复后固定时长内做不变量校验
    if (sim.soak) {
      var bad = checkInvariants(sim);
      if (bad) {
        recordFailure(sim, 'soak_violation', 0, '浸泡期发现状态异常: ' + bad);
        sim.soak = null;
      } else if (--sim.soak.remaining <= 0) {
        logEvent(sim, 'sys', '浸泡观察结束(' + sim.cfg.soakTicks +
                 ' tick), 无连锁错误, 无状态跳变');
        sim.soak = null;
      }
    }

    checkResult(sim);
  }

  function startSoak(sim, reason) {
    sim.soak = { remaining: sim.cfg.soakTicks, reason: reason,
                 baseline: stateHash(sim) };
    logEvent(sim, 'sys', '进入恢复后浸泡观察 ' + sim.cfg.soakTicks +
             ' tick (' + reason + ')');
  }

  function checkResult(sim) {
    var rescued = sim.actors.filter(function (a) {
      return a.kind === 'worker' && a.rescued; }).length;
    var delivered = sim.actors.filter(function (a) {
      return a.kind === 'equipment' && a.delivered; }).length;
    if (rescued === 9 && delivered >= 1) {
      sim.result = 'success';
      sim.phase = 'done';
      logEvent(sim, 'sys', '任务成功: 9 人全部升井, ' + delivered + ' 组设备到位');
    }
    var dead = sim.actors.some(function (a) {
      return a.kind === 'worker' && !a.rescued &&
             a.heatStress >= sim.cfg.heatStressLimit;
    });
    if (dead) {
      sim.result = 'failure';
      sim.phase = 'failed';
      recordFailure(sim, 'heat_casualty', 0, '人员热应激超限, 任务失败');
    }
  }

  // 不变量: 任何 tick 都必须成立, 用于浸泡期与测试
  function checkInvariants(sim) {
    if (!isFinite(sim.battery) || sim.battery < 0 ||
        sim.battery > sim.cfg.batteryMax + 1e-6) return 'battery';
    if (!isFinite(sim.cage.pos) || sim.cage.pos < 0 ||
        sim.cage.pos > LEVELS[LEVELS.length - 1]) return 'cage_pos';
    if (loadWeight(sim) > sim.cfg.capacity + 1e-6) return 'overload_state';
    if (sim.brakeWear < 0 || sim.brakeWear > sim.cfg.brakeWearLimit) return 'brake';
    var seen = {};
    for (var i = 0; i < sim.actors.length; i++) {
      var a = sim.actors[i];
      if (seen[a.id]) return 'dup_actor';
      seen[a.id] = true;
      if (a.level < -1 || a.level >= LEVELS.length) return 'actor_level';
      if (a.kind === 'worker' && !isFinite(a.heatStress)) return 'stress_nan';
    }
    for (var j = 0; j < sim.segments.length; j++) {
      if (!isFinite(sim.segments[j].temp)) return 'temp_nan';
    }
    return null;
  }

  return {
    CONFIG: CONFIG,
    createSim: createSim,
    step: step,
    applyOp: applyOp,
    replay: replay,
    stateHash: stateHash,
    checkInvariants: checkInvariants,
    startSoak: startSoak,
    loadWeight: loadWeight,
    findActor: findActor
  };
});
