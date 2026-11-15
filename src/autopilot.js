/*
 * 自动驾驶 / 场景脚本
 * 所有脚本输出标准操作意图，因此可被记录与逐 tick 回放
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.Autopilot = factory(root.CableSim);
})(typeof self !== 'undefined' ? self : this, function (CableSim) {
  'use strict';

  const { clamp } = CableSim;

  class Script {
    constructor(sim, name) {
      this.sim = sim;
      this.name = name;
      this.notes = [];
    }

    holdX(target, tolerance = 0.4) {
      const e = target - this.sim.ship.x;
      if (this._target !== target) { this._target = target; this._ie = 0; }
      this._ie = clamp(this._ie + e * 0.1, -15, 15);
      return clamp(e * 0.5 + this._ie * 0.05 - this.sim.ship.v * 5, -1, 1);
    }

    holdDepth(target) {
      const dz = this.sim.umbilical.z - target;
      return clamp(-dz * 0.9 - this.sim.umbilical.depthRate * 2.5, -1, 1);
    }

    until(cond, build, maxTicks = 4000) {
      let n = 0;
      while (!cond(this.sim) && this.sim.mode === 'running' && n < maxTicks) {
        this.sim.step(build(this.sim));
        n++;
      }
      return n;
    }

    holdAt(targetX, targetZ, extra = {}) {
      return Object.assign({ throttle: this.holdX(targetX), winch: this.holdDepth(targetZ) }, extra);
    }

    workJoint(index, targetX, targetZ, tool, phaseKey) {
      const j = this.sim.joints[index];
      const n = this.until(
        () => j[phaseKey],
        () => this.holdAt(targetX, targetZ, { tool })
      );
      this.notes.push(`joint${index}.${phaseKey}@t=${this.sim.time}(${n}ticks)`);
    }
  }

  // 正常流程：两个接头的定位/切割/接头安装，随后回收并进入 soak
  function runNormal(sim) {
    const sc = new Script(sim, 'normal');
    const workZ = sim.cfg.WATER_DEPTH - sim.cfg.JOINT_WORK_Z;
    const j0x = sim.joints[0].x;
    const j1x = sim.joints[1].x;

    sc.until(() => sim.umbilical.z >= workZ - 0.3, () => ({ winch: 1, throttle: sc.holdX(j0x), tool: 'locator' }));
    sc.workJoint(0, j0x, workZ, 'locator', 'located');
    sc.workJoint(0, j0x, workZ, 'cutter', 'cut');
    sc.workJoint(0, j0x, workZ, 'arm', 'spliced');

    // 移动到第二个接头（提升工具避免拖底）
    sc.until(() => sim.umbilical.z <= workZ - 25, () => ({ winch: -1, throttle: sc.holdX(j1x) }));
    sc.until(() => Math.abs(sim.ship.x - j1x) < 1.2, () => ({ throttle: sc.holdX(j1x), winch: 0 }));
    sc.until(() => sim.umbilical.z >= workZ - 0.3, () => ({ winch: 1, throttle: sc.holdX(j1x), tool: 'locator' }));
    sc.workJoint(1, j1x, workZ, 'locator', 'located');
    sc.workJoint(1, j1x, workZ, 'arm', 'cut');
    sc.workJoint(1, j1x, workZ, 'arm', 'spliced');

    // 回收工具，触发成功后的 soak
    sc.until(() => sim.mode !== 'running', () => ({ winch: -1, throttle: sc.holdX(0) }));
    runToComplete(sim);
    return sc.notes;
  }

  // 设备故障：作业途中注入左舷推进器故障，靠冗余继续完成
  function runThrusterFault(sim) {
    const sc = new Script(sim, 'thruster_fault');
    const workZ = sim.cfg.WATER_DEPTH - sim.cfg.JOINT_WORK_Z;
    const j0x = sim.joints[0].x;
    let injected = false;
    sc.until(() => sim.umbilical.z >= workZ - 0.3, () => ({ winch: 1, throttle: sc.holdX(j0x), tool: 'locator' }));
    sc.workJoint(0, j0x, workZ, 'locator', 'located');
    sc.until(() => sim.joints[0].cut, () => {
      const intent = sc.holdAt(j0x, workZ, { tool: 'cutter' });
      if (!injected && sim.time >= sim.joints[0].located && sim.time > 40) {
        intent.injectFault = { type: 'portThruster' };
        injected = true;
      }
      return intent;
    });
    sc.workJoint(0, j0x, workZ, 'arm', 'spliced');

    const j1x = sim.joints[1].x;
    sc.until(() => sim.umbilical.z <= workZ - 25, () => ({ winch: -1, throttle: sc.holdX(j1x) }));
    sc.until(() => sim.umbilical.z >= workZ - 0.3, () => ({ winch: 1, throttle: sc.holdX(j1x), tool: 'locator' }));
    sc.workJoint(1, j1x, workZ, 'locator', 'located');
    sc.workJoint(1, j1x, workZ, 'arm', 'cut');
    sc.workJoint(1, j1x, workZ, 'arm', 'spliced');
    sc.until(() => sim.mode !== 'running', () => ({ winch: -1, throttle: sc.holdX(0) }));
    runToComplete(sim);
    return sc.notes;
  }

  // 参数越限：辅助泵并网造成持续电力过载 -> 中止 -> 恢复 -> soak；
  // soak 中再令船位漂移超限，验证第二次恢复
  function runOverload(sim) {
    const sc = new Script(sim, 'overload_and_drift');
    const workZ = sim.cfg.WATER_DEPTH - sim.cfg.JOINT_WORK_Z;
    const j0x = sim.joints[0].x;
    let pumpOn = false;
    sc.until(() => sim.umbilical.z >= workZ - 0.3, () => ({ winch: 1, throttle: sc.holdX(j0x), tool: 'cutter' }));
    sc.until(() => sim.mode !== 'running', () => {
      const intent = sc.holdAt(j0x, workZ, { tool: 'cutter' });
      if (!pumpOn && sim.time > 30) {
        intent.pump = true;
        pumpOn = true;
      }
      return intent;
    });
    triggerRecoveryAndSoak(sim);

    // soak 中漂移越限（推进器主动推向限值），随后再次恢复
    if (sim.mode === 'soak') {
      while (sim.mode === 'soak') sim.step({ throttle: 1 });
    }
    if (sim.mode === 'aborted') triggerRecoveryAndSoak(sim);
    runToComplete(sim);
    return sc.notes;
  }

  // 断缆恢复：近海底强行收揽制造过张力断缆 -> 恢复 -> soak
  function runUmbilicalBreak(sim) {
    const sc = new Script(sim, 'umbilical_break');
    const workZ = sim.cfg.WATER_DEPTH - sim.cfg.JOINT_WORK_Z;
    sc.until(() => sim.umbilical.z >= workZ - 0.2, () => ({ winch: 1, throttle: sc.holdX(0) }));
    sim.step({ injectFault: { type: 'winchJam' } });
    sc.until(() => sim.mode !== 'running', () => ({ winch: -1, throttle: sc.holdX(0) }));
    triggerRecoveryAndSoak(sim);
    runToComplete(sim);
    return sc.notes;
  }

  function triggerRecoveryAndSoak(sim) {
    let waited = 0;
    while (sim.mode === 'aborted' && waited < 30) { sim.step(null); waited++; }
    if (sim.mode === 'aborted') sim.step({ recover: true });
    runUntil(sim, (m) => m === 'soak' || m === 'complete');
  }

  function runUntil(sim, predicate, maxTicks = 6000) {
    let n = 0;
    while (!predicate(sim.mode) && n < maxTicks) {
      sim.step(sim.mode === 'aborted' ? { recover: true } : null);
      n++;
    }
    return n;
  }

  function runToComplete(sim, maxTicks = 6000) {
    let n = 0;
    while (sim.mode !== 'complete' && n < maxTicks) {
      sim.step(sim.mode === 'aborted' ? { recover: true } : null);
      n++;
    }
    return n;
  }

  // 基于确定性脚本的逐 tick 意图生成器（供 UI 仿真时钟驱动）
  const DRIVERS = {
    normal: runNormal,
    thruster: runThrusterFault,
    overload: runOverload,
    break: runUmbilicalBreak
  };

  function createDriver(name) {
    const sim = new CableSim.Simulation();
    const fn = DRIVERS[name];
    // 先离线生成完整意图序列（确定性，仅依赖 seed）
    fn(sim);
    const plan = sim.exportRecord().intents.map(({ tick, ...intent }) =>
      Object.keys(intent).length ? intent : null);
    return {
      plan,
      next(tickIndex) { return plan[tickIndex] !== undefined ? plan[tickIndex] : null; }
    };
  }

  return {
    Script, runNormal, runThrusterFault, runOverload,
    runUmbilicalBreak, runToComplete, triggerRecoveryAndSoak, createDriver
  };

  // __APPEND__
});
