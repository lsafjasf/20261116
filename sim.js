// 冷库除霜仿真核心：统一仿真时钟，设备状态、环境变化、操作记录全部挂在同一时钟上。
// 纯逻辑，无 DOM 依赖，浏览器与 Node 共用（用于场景验证与失败回放）。
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ColdSim = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DT = 1; // 仿真步长：1 秒
  const DURATION = 3600; // 一局模拟 1 小时
  const TEMP_MIN = 2;
  const TEMP_MAX = 8;
  const TEMP_TARGET = 5;
  const TEMP_HARD_LOW = 0;
  const TEMP_HARD_HIGH = 12;
  const EXCEED_GRACE = 150; // 连续超限容忍秒数，超过判失败
  const FROST_MAX = 5; // mm，霜层达到该值换热基本失效
  const FROST_DONE = 0.3; // mm，低于该值视为除霜完成
  const SOAK_TIME = 600; // 恢复安全后需持续稳定运行的秒数

  // 确定性伪随机（可复现环境扰动）
  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function createSim(options) {
    options = options || {};
    const rng = makeRng(options.seed || 12345);
    const sim = {
      clock: 0,
      dt: DT,
      running: false,
      over: false,
      success: false,
      failReason: null,
      failTime: null,
      compressorOn: true,
      compressorFailed: false,
      backupOn: false,
      doorOpen: false,
      log: [],
      actions: [], // 操作记录，用于回放
      envEvents: (options.envEvents || []).slice().sort((a, b) => a.t - b.t),
      rng: rng,
      zones: [],
    };
    const humid = options.humidCargo != null ? options.humidCargo : [false, true, false];
    for (let i = 0; i < 3; i++) {
      sim.zones.push({
        id: i,
        temp: TEMP_TARGET,
        frost: options.initialFrost != null ? options.initialFrost : 2.2 + i * 0.4,
        humidCargo: !!humid[i],
        humidity: humid[i] ? 1.8 : 1.0,
        fanOn: true,
        valveOn: true, // 供液电磁阀（恒温回差 3.2~3.8°C）
        defrosting: false,
        defrostTimer: 0,
        defrostDone: false,
        exceedTimer: 0,
        maxExceed: 0,
      });
    }
    emit(sim, "system", "仿真初始化，目标库温 " + TEMP_TARGET + "°C，安全区 [" + TEMP_MIN + "," + TEMP_MAX + "]°C");
    return sim;
  }

  function emit(sim, kind, msg, data) {
    sim.log.push(Object.assign({ t: sim.clock, kind: kind, msg: msg }, data || {}));
  }

  // ---- 玩家操作（全部记录到统一时钟，可回放）----
  function applyAction(sim, action) {
    if (sim.over) return;
    const a = Object.assign({}, action, { t: sim.clock });
    sim.actions.push(a);
    switch (action.type) {
      case "defrostStart": {
        const z = sim.zones[action.zone];
        if (z.defrosting) return;
        z.defrosting = true;
        z.defrostTimer = 0;
        emit(sim, "action", "蒸发器" + (action.zone + 1) + " 开始除霜（加热器投入，风机停转）", { zone: action.zone });
        break;
      }
      case "defrostStop": {
        const z = sim.zones[action.zone];
        if (!z.defrosting) return;
        z.defrosting = false;
        emit(sim, "action", "蒸发器" + (action.zone + 1) + " 停止除霜，本次加热 " + z.defrostTimer.toFixed(0) + "s，余霜 " + z.frost.toFixed(2) + "mm", { zone: action.zone });
        break;
      }
      case "fanToggle": {
        const z = sim.zones[action.zone];
        z.fanOn = !z.fanOn;
        emit(sim, "action", "蒸发器" + (action.zone + 1) + " 风机" + (z.fanOn ? "开启" : "关闭"), { zone: action.zone });
        break;
      }
      case "backupToggle":
        sim.backupOn = !sim.backupOn;
        emit(sim, "action", "备用制冷机组" + (sim.backupOn ? "投入" : "退出"));
        break;
      case "compressorToggle":
        if (sim.compressorFailed) {
          emit(sim, "action", "主压缩机故障中，无法启动");
          return;
        }
        sim.compressorOn = !sim.compressorOn;
        emit(sim, "action", "主压缩机" + (sim.compressorOn ? "启动" : "停机"));
        break;
      case "doorToggle":
        sim.doorOpen = !sim.doorOpen;
        emit(sim, "action", "库门" + (sim.doorOpen ? "打开，热空气涌入" : "关闭"));
        break;
    }
  }

  // ---- 环境事件（脚本化：开门、高湿货物、压缩机故障/修复）----
  function applyEnvEvent(sim, ev) {
    switch (ev.type) {
      case "door":
        sim.doorOpen = ev.open;
        emit(sim, "env", (ev.open ? "库门打开" : "库门关闭") + "（环境事件）");
        break;
      case "compressorFail":
        sim.compressorFailed = true;
        sim.compressorOn = false;
        emit(sim, "fault", "主压缩机故障停机！制冷中断", { margin: marginInfo(sim) });
        break;
      case "compressorRepair":
        sim.compressorFailed = false;
        sim.compressorOn = true;
        emit(sim, "env", "主压缩机修复并重启");
        break;
      case "humidCargo":
        sim.zones[ev.zone].humidCargo = true;
        sim.zones[ev.zone].humidity = 1.8;
        emit(sim, "env", "高湿货物进入货区" + (ev.zone + 1) + "，结霜加速");
        break;
    }
  }

  function marginInfo(sim) {
    let hottest = -Infinity, coldest = Infinity;
    sim.zones.forEach(function (z) {
      hottest = Math.max(hottest, z.temp);
      coldest = Math.min(coldest, z.temp);
    });
    return {
      toUpper: +(TEMP_MAX - hottest).toFixed(2),
      toLower: +(coldest - TEMP_MIN).toFixed(2),
      hottest: +hottest.toFixed(2),
      coldest: +coldest.toFixed(2),
    };
  }

  // ---- 单步推进（仿真时钟唯一推进入口）----
  function step(sim) {
    if (sim.over) return;
    const dt = sim.dt;
    sim.clock += dt;

    while (sim.envEvents.length && sim.envEvents[0].t <= sim.clock) {
      applyEnvEvent(sim, sim.envEvents.shift());
    }

    const avgTemp = sim.zones.reduce(function (s, z) { return s + z.temp; }, 0) / sim.zones.length;

    sim.zones.forEach(function (z) {
      // 负荷（°C/min）
      let load = 0.10; // 围护结构渗入
      if (sim.doorOpen) load += z.id === 2 ? 1.1 : 0.85; // 门附近货区冲击更大
      if (z.defrosting) load += 1.1; // 除霜加热器余热进库

      // 恒温回差：库温升至 3.8°C 开阀供液，降至 3.2°C 关阀
      if (z.temp >= 3.8) z.valveOn = true;
      else if (z.temp <= 3.2) z.valveOn = false;

      // 制冷（°C/min）
      let cool = 0;
      const frostFactor = Math.max(0.05, 1 - 0.9 * (z.frost / FROST_MAX));
      if (z.valveOn && z.fanOn && !z.defrosting) {
        if (sim.compressorOn && !sim.compressorFailed) cool += 0.45 * frostFactor;
        if (sim.backupOn) cool += 0.35 * frostFactor;
      }

      // 区间均温耦合
      const equalize = 0.001 * (avgTemp - z.temp);

      z.temp += ((load - cool) * dt) / 60 + equalize * dt;

      // 结霜：盘管制冷时结霜快，高湿货物加速
      const coolingActive = cool > 0.01;
      let frostRate = 1.5 * z.humidity * (coolingActive ? 1 : 0.25); // mm/h
      if (sim.doorOpen) frostRate *= 1.4;
      z.frost += (frostRate * dt) / 3600;

      // 除霜融霜
      if (z.defrosting) {
        z.defrostTimer += dt;
        z.frost -= (3.0 * dt) / 60; // 3 mm/min
        if (z.frost <= 0) z.frost = 0;
        if (!z.defrostDone && z.frost <= FROST_DONE) {
          z.defrostDone = true;
          emit(sim, "device", "蒸发器" + (z.id + 1) + " 除霜完成，余霜 " + z.frost.toFixed(2) + "mm", { zone: z.id });
        }
      }

      // 温控超限监测
      const out = z.temp < TEMP_MIN || z.temp > TEMP_MAX;
      if (out) {
        z.exceedTimer += dt;
        z.maxExceed = Math.max(z.maxExceed, z.exceedTimer);
        if (z.exceedTimer === dt) {
          emit(sim, "alarm", "货区" + (z.id + 1) + " 温度超限！" + z.temp.toFixed(2) + "°C 越出 [" + TEMP_MIN + "," + TEMP_MAX + "]", {
            zone: z.id,
            margin: marginInfo(sim),
          });
        }
        if (z.exceedTimer > EXCEED_GRACE && !sim.over) {
          endRun(sim, false, "货区" + (z.id + 1) + " 连续超限 " + z.exceedTimer.toFixed(0) + "s，冷链断裂");
        }
      } else {
        z.exceedTimer = 0;
      }
      if ((z.temp > TEMP_HARD_HIGH || z.temp < TEMP_HARD_LOW) && !sim.over) {
        endRun(sim, false, "货区" + (z.id + 1) + " 温度 " + z.temp.toFixed(2) + "°C 触及硬限，药品报废");
      }
    });

    // 成功判定：一小时到达，全部货区达标且除霜完成
    if (sim.clock >= DURATION && !sim.over) {
      const allDone = sim.zones.every(function (z) { return z.defrostDone; });
      const allInRange = sim.zones.every(function (z) { return z.temp >= TEMP_MIN && z.temp <= TEMP_MAX; });
      if (allDone && allInRange) endRun(sim, true, "一小时模拟结束：所有货区温度达标且除霜完成");
      else endRun(sim, false, "时间到：" + (allDone ? "" : "存在未完成除霜的蒸发器 ") + (allInRange ? "" : "存在温度不达标货区"));
    }
  }

  function endRun(sim, success, reason) {
    sim.over = true;
    sim.success = success;
    sim.failReason = success ? null : reason;
    sim.failTime = success ? null : sim.clock;
    emit(sim, success ? "success" : "fail", reason, { margin: marginInfo(sim) });
  }

  // 回放：用同一场景与操作记录重建到指定时刻（默认到失败时刻）
  function replay(options, actions, untilT) {
    const sim = createSim(options);
    const queue = actions.slice();
    const target = untilT != null ? untilT : Infinity;
    while (!sim.over && sim.clock < target && sim.clock < DURATION + 1) {
      while (queue.length && queue[0].t <= sim.clock) {
        const a = queue.shift();
        const saved = sim.clock;
        sim.clock = a.t;
        applyAction(sim, a);
        sim.clock = saved;
      }
      step(sim);
    }
    return sim;
  }

  return {
    DT: DT,
    DURATION: DURATION,
    TEMP_MIN: TEMP_MIN,
    TEMP_MAX: TEMP_MAX,
    TEMP_TARGET: TEMP_TARGET,
    FROST_MAX: FROST_MAX,
    FROST_DONE: FROST_DONE,
    SOAK_TIME: SOAK_TIME,
    createSim: createSim,
    applyAction: applyAction,
    step: step,
    replay: replay,
    marginInfo: marginInfo,
  };
});
