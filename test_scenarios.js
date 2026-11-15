// 场景验证：正常流程 / 设备故障 / 参数越限。
// 记录故障时刻、当前余量、系统响应；恢复安全后持续运行 SOAK_TIME 秒，
// 检查是否存在隐藏的连锁错误或状态跳变。
"use strict";
const ColdSim = require("./sim.js");
const scenarios = require("./scenarios.js");

let failures = 0;
function check(cond, label) {
  if (cond) {
    console.log("  [PASS] " + label);
  } else {
    failures++;
    console.log("  [FAIL] " + label);
  }
}
function fmt(t) {
  return "t=" + String(t).padStart(4, "0") + "s";
}

// 运行场景，逐 tick 应用策略，并在恢复后做持续运行（soak）稳定性检查
function runScenario(name, sc, opts) {
  opts = opts || {};
  console.log("\n=== 场景: " + name + " ===");
  const sim = ColdSim.createSim(sc.options);
  let recoveredAt = null;
  let stableStreak = 0;
  let soakDone = false;
  const soakViolations = [];
  let prevTemps = sim.zones.map(function (z) { return z.temp; });
  let prevClock = sim.clock;
  const logLenAtRecovery = { n: 0 };

  while (!sim.over) {
    sc.policy(sim);
    ColdSim.step(sim);

    // 恢复检测：全部货区回到安全区并连续保持 30s
    const allSafe = sim.zones.every(function (z) {
      return z.temp >= ColdSim.TEMP_MIN && z.temp <= ColdSim.TEMP_MAX;
    });
    if (recoveredAt === null) {
      if (allSafe && sim.clock > 0) {
        stableStreak++;
        if (stableStreak >= 30 && (opts.needIncident ? sim.log.some(function (e) { return e.kind === "fault" || e.kind === "alarm"; }) : true)) {
          recoveredAt = sim.clock;
          logLenAtRecovery.n = sim.log.length;
          console.log("  恢复安全状态 @" + fmt(sim.clock) + "，余量 " + JSON.stringify(ColdSim.marginInfo(sim)) + "，进入 " + ColdSim.SOAK_TIME + "s 持续运行检查");
        }
      } else {
        stableStreak = 0;
      }
    } else if (!soakDone && sim.clock <= recoveredAt + ColdSim.SOAK_TIME) {
      // 持续运行检查：连锁错误与状态跳变
      if (sim.clock !== prevClock + ColdSim.DT) soakViolations.push("时钟跳变 @" + sim.clock);
      sim.zones.forEach(function (z, i) {
        if (!isFinite(z.temp) || !isFinite(z.frost)) soakViolations.push("NaN/Inf 状态 @" + sim.clock + " 货区" + (i + 1));
        if (Math.abs(z.temp - prevTemps[i]) > 0.2) soakViolations.push("温度跳变 " + prevTemps[i].toFixed(2) + "->" + z.temp.toFixed(2) + " @" + sim.clock + " 货区" + (i + 1));
        if (z.frost < -1e-9 || z.frost > ColdSim.FROST_MAX + 0.5) soakViolations.push("霜层越界 " + z.frost.toFixed(3) + "mm @" + sim.clock + " 货区" + (i + 1));
      });
      for (let i = logLenAtRecovery.n; i < sim.log.length; i++) {
        const e = sim.log[i];
        if (e.kind === "alarm" || e.kind === "fault" || e.kind === "fail") {
          soakViolations.push("恢复后连锁告警: " + e.msg + " @" + e.t);
        }
      }
      logLenAtRecovery.n = sim.log.length;
      if (sim.clock === recoveredAt + ColdSim.SOAK_TIME) soakDone = true;
    }
    prevTemps = sim.zones.map(function (z) { return z.temp; });
    prevClock = sim.clock;
  }

  if (opts.needIncident) {
    check(recoveredAt !== null, "故障/越限后恢复到安全状态");
    check(soakDone, "恢复后持续稳定运行 " + ColdSim.SOAK_TIME + "s");
    check(soakViolations.length === 0, "持续运行无连锁错误/状态跳变" + (soakViolations.length ? " -> " + soakViolations.slice(0, 3).join("; ") : ""));
  }
  return sim;
}

// ---------- 场景一：正常流程 ----------
const s1 = runScenario("正常流程（含开门作业、高湿货物）", scenarios.normal);
const defrostDoneEvents = s1.log.filter(function (e) { return e.kind === "device" && e.msg.indexOf("除霜完成") >= 0; });
console.log("  除霜完成记录:");
defrostDoneEvents.forEach(function (e) { console.log("    " + fmt(e.t) + " " + e.msg); });
check(defrostDoneEvents.length === 3, "三组蒸发器均完成一次除霜周期");
check(!s1.log.some(function (e) { return e.kind === "alarm"; }), "全程无温控超限报警");
check(s1.success === true, "一小时模拟成功: " + (s1.success ? "全部货区达标且除霜完成" : s1.failReason));

// ---------- 场景二：设备故障 ----------
const s2 = runScenario("设备故障（t=1800 主压缩机停机）", scenarios.failure, { needIncident: true });
const fault = s2.log.find(function (e) { return e.kind === "fault"; });
check(!!fault && fault.t === 1800, "故障发生时刻记录: " + (fault ? fmt(fault.t) : "缺失"));
check(!!fault && fault.margin && fault.margin.toUpper > 0, "故障时余量记录: " + (fault ? JSON.stringify(fault.margin) : "缺失"));
const backupAct = s2.actions.find(function (a) { return a.type === "backupToggle"; });
check(!!backupAct && backupAct.t - fault.t <= 60, "系统响应: 备用制冷于故障后 " + (backupAct ? backupAct.t - fault.t : "?") + "s 投入");
check(s2.success === true, "故障恢复后完成全局: " + (s2.success ? "成功" : s2.failReason));

// ---------- 场景三：参数越限 ----------
const s3 = runScenario("参数越限（除霜时长误设 480s）", scenarios.exceed, { needIncident: true });
const alarm = s3.log.find(function (e) { return e.kind === "alarm"; });
check(!!alarm, "温控超限报警已触发并记录: " + (alarm ? fmt(alarm.t) + " " + alarm.msg : "缺失"));
check(!!alarm && alarm.margin, "越限时余量记录: " + (alarm ? JSON.stringify(alarm.margin) : "缺失"));
const stopAfter = alarm && s3.actions.find(function (a) { return a.type === "defrostStop" && a.t >= alarm.t; });
check(!!stopAfter, "系统响应: 报警后 " + (stopAfter ? stopAfter.t - alarm.t : "?") + "s 中止除霜");
check(s3.success === true, "越限恢复后完成全局: " + (s3.success ? "成功" : s3.failReason));

// ---------- 回放一致性 ----------
console.log("\n=== 失败回放 / 确定性校验 ===");
const replayed = ColdSim.replay(scenarios.exceed.options, s3.actions, alarm ? alarm.t : 0);
const origAt = (function () {
  const sim = ColdSim.createSim(scenarios.exceed.options);
  const q = s3.actions.slice();
  while (!sim.over && sim.clock < alarm.t) {
    while (q.length && q[0].t <= sim.clock) ColdSim.applyAction(sim, q.shift());
    ColdSim.step(sim);
  }
  return sim;
})();
check(
  replayed.zones.every(function (z, i) { return Math.abs(z.temp - origAt.zones[i].temp) < 1e-9; }),
  "回放到报警时刻的状态与原运行逐位一致"
);
console.log("  回放至报警时刻 " + fmt(replayed.clock) + "，货区温度: " + replayed.zones.map(function (z) { return z.temp.toFixed(2); }).join(" / "));

console.log("\n" + (failures ? "共 " + failures + " 项未通过" : "全部验证通过"));
process.exit(failures ? 1 : 0);
