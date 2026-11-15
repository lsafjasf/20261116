// 场景定义与自动操作策略：正常流程 / 设备故障 / 参数越限。
// 策略在每个仿真 tick 被调用，通过 applyAction 与统一时钟交互（与人工操作等价）。
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./sim.js"));
  } else {
    root.ColdScenarios = factory(root.ColdSim);
  }
})(typeof self !== "undefined" ? self : this, function (ColdSim) {
  "use strict";

  // 常规除霜策略：霜厚超阈值且库温有余量时轮流除霜，霜净即停；温度偏高时投备用机组。
  function routinePolicy(sim) {
    const defrosting = sim.zones.some(function (z) { return z.defrosting; });
    sim.zones.forEach(function (z) {
      if (z.defrosting && z.frost <= ColdSim.FROST_DONE) {
        ColdSim.applyAction(sim, { type: "defrostStop", zone: z.id });
      }
    });
    if (!defrosting) {
      for (let i = 0; i < sim.zones.length; i++) {
        const z = sim.zones[i];
        if (z.frost > 2.2 && z.temp < 6.5 && !sim.compressorFailed) {
          ColdSim.applyAction(sim, { type: "defrostStart", zone: i });
          break;
        }
      }
    }
    const hottest = Math.max.apply(null, sim.zones.map(function (z) { return z.temp; }));
    if (hottest > 7.0 && !sim.backupOn) ColdSim.applyAction(sim, { type: "backupToggle" });
    if (hottest < 4.0 && sim.backupOn && !sim.compressorFailed) {
      ColdSim.applyAction(sim, { type: "backupToggle" });
    }
  }

  const scenarios = {
    // 场景一：正常流程。含开门作业与高湿货物入库扰动。
    normal: {
      options: {
        seed: 101,
        envEvents: [
          { t: 900, type: "door", open: true },
          { t: 960, type: "door", open: false },
          { t: 1500, type: "humidCargo", zone: 0 },
          { t: 2400, type: "door", open: true },
          { t: 2460, type: "door", open: false },
        ],
      },
      policy: routinePolicy,
    },

    // 场景二：设备故障。t=1800 主压缩机故障，t=2400 修复。
    failure: {
      options: {
        seed: 202,
        envEvents: [
          { t: 1800, type: "compressorFail" },
          { t: 2400, type: "compressorRepair" },
        ],
      },
      policy: function (sim) {
        if (sim.compressorFailed && !sim.backupOn) {
          ColdSim.applyAction(sim, { type: "backupToggle" }); // 应急响应：投入备用制冷
        }
        if (!sim.compressorFailed && sim.backupOn) {
          const hottest = Math.max.apply(null, sim.zones.map(function (z) { return z.temp; }));
          if (hottest < 5.5) ColdSim.applyAction(sim, { type: "backupToggle" });
        }
        routinePolicy(sim);
      },
    },

    // 场景三：参数越限。除霜时长参数被错误设为 480s（远超安全值），
    // 导致库温超限；监测到报警后应急响应：中止除霜 + 备用制冷，恢复后继续流程。
    exceed: {
      options: {
        seed: 303,
        envEvents: [{ t: 1200, type: "door", open: true }, { t: 1260, type: "door", open: false }],
      },
      badDefrostLimit: 480, // 越限参数：除霜最长持续秒数
      policy: function (sim) {
        const z1 = sim.zones[1];
        const alarmed = sim.log.some(function (e) { return e.kind === "alarm"; });
        if (!alarmed) {
          // 错误参数驱动：除霜一直持续到 480s 才停
          if (!z1.defrosting && !z1.defrostDone && sim.clock >= 300) {
            ColdSim.applyAction(sim, { type: "defrostStart", zone: 1 });
          }
          if (z1.defrosting && z1.defrostTimer >= 480) {
            ColdSim.applyAction(sim, { type: "defrostStop", zone: 1 });
          }
        } else {
          const hottest = Math.max.apply(null, sim.zones.map(function (z) { return z.temp; }));
          if (hottest > 6.5) {
            // 应急响应：立即中止任何进行中的除霜，投入备用制冷
            sim.zones.forEach(function (z) {
              if (z.defrosting) ColdSim.applyAction(sim, { type: "defrostStop", zone: z.id });
            });
            if (!sim.backupOn) ColdSim.applyAction(sim, { type: "backupToggle" });
          } else {
            if (hottest < 4.5 && sim.backupOn) ColdSim.applyAction(sim, { type: "backupToggle" });
            // 恢复常规除霜（用安全阈值）
            routinePolicy(sim);
          }
        }
      },
    },
  };

  return scenarios;
});
