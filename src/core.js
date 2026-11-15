/*
 * 海底电缆维修仿真核心
 * - 固定步长确定性时钟，固定 seed 的 RNG
 * - 设备状态 / 环境变化 / 操作记录统一在 tick 上推进
 * - 无 DOM 依赖，可在 Node 与浏览器中运行
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CableSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DT = 0.1;                  // 仿真步长 (s)
  const SUBSTEPS = 2;             // 每 tick 物理子步
  const WATER_DEPTH = 80;         // 海床深度 (m)
  const DRIFT_LIMIT = 15;         // 船位漂移限值 (m)
  const WINCH_RATE = 1.5;         // 脐带收放速率 (m/s)
  const TENSION_WEIGHT = 42000;   // 工具+脐带水中重力 (N)
  const TENSION_BREAK = 120000;   // 脐带断裂张力 (N)
  const TENSION_WARN = 95000;     // 张力告警 (N)
  const SPRING_K = 4200;          // 脐带横向等效刚度 (N/m)
  const SPRING_KE = 5000;         // 脐带纵向弹性刚度 (N/m)
  const SPRING_KD = 16000;        // 纵向阻尼 (N·s/m)
  const OFFSET_TAU = 2.0;         // 横向偏移松弛时间 (s)
  const SHIP_MASS = 40000;        // 船体等效质量 (kg)
  const SHIP_DRAG = 45000;        // 船体水流阻尼 (N·s/m)
  const SHIP_THRUST_MAX = 90000;  // 推进器最大推力 (N)
  const TOOL_DRAG = 1400;         // 工具水流阻力系数
  const POWER_BASE = 8;           // 基础负载 (kW)
  const POWER_THRUST = 20;        // 满推力附加负载 (kW)
  const POWER_TOOL = { locator: 6, cutter: 42, arm: 26 };
  const POWER_PUMP = 55;          // 辅助泵负载 (kW)
  const POWER_LIMIT = 100;        // 电力过载限值 (kW)
  const OVERLOAD_LIMIT_T = 10;    // 持续过载容忍 (s)
  const JOINT_RADIUS = 3.5;       // 接头作业半径 (m)
  const JOINT_WORK_Z = 3;         // 距海床作业高度 (m)
  const PHASE_DUR = { locate: 5, cut: 8, splice: 10 };
  const RECOVERY_PHASE_T = 8;     // 恢复流程每阶段时长 (s)
  const SOAK_T = 45;              // 恢复后稳定运行时长 (s)
  const RECOVER_DEPTH = 12;       // 安全回收深度 (m)

  const JOINT_DEFS = [
    { x: 9, z: WATER_DEPTH, tool: 'cutter' },
    { x: -10, z: WATER_DEPTH, tool: 'arm' }
  ];

  const DEFAULT_CFG = {
    DT, SUBSTEPS, WATER_DEPTH, DRIFT_LIMIT, WINCH_RATE,
    TENSION_WEIGHT, TENSION_BREAK, TENSION_WARN,
    SPRING_K, SPRING_KE, SPRING_KD, OFFSET_TAU,
    SHIP_MASS, SHIP_DRAG, SHIP_THRUST_MAX, TOOL_DRAG,
    POWER_BASE, POWER_THRUST, POWER_TOOL, POWER_PUMP,
    POWER_LIMIT, OVERLOAD_LIMIT_T,
    JOINT_RADIUS, JOINT_WORK_Z, PHASE_DUR,
    RECOVERY_PHASE_T, SOAK_T, RECOVER_DEPTH, JOINT_DEFS
  };

  function hashSeed(seed) {
    let h = 2166136261 >>> 0;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // mulberry32：固定 seed 下完全确定的伪随机序列
  class Rng {
    constructor(seed) {
      this.seed = hashSeed(seed);
      this.s = this.seed;
    }
    next() {
      this.s |= 0;
      this.s = (this.s + 0x6D2B79F5) | 0;
      let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // 两层海流：上层(0-40m)与下层(40-80m)，在交界处平滑过渡
  function currentAt(t, depth) {
    const upper = 0.9 * Math.sin(0.07 * t) + 0.25 * Math.sin(0.21 * t + 1.7);
    const lower = -0.55 * Math.cos(0.05 * t + 0.8) + 0.18 * Math.sin(0.13 * t);
    const blend = clamp((depth - 36) / 8, 0, 1);
    const s = blend * blend * (3 - 2 * blend);
    return upper * (1 - s) + lower * s;
  }

  function round3(v) { return Math.round(v * 1000) / 1000; }

  class Simulation {
    constructor(options = {}) {
      this.cfg = Object.assign({}, DEFAULT_CFG, options.cfg || {});
      this.seed = options.seed != null ? options.seed : 'cable-sim-2026';
      this.reset();
    }

    reset() {
      const c = this.cfg;
      this.rng = new Rng(this.seed);
      this.tick = 0;
      this.time = 0;
      this.mode = 'running';            // running | aborted | recovering | soak | complete
      this.events = [];
      this.intents = [];
      this.ship = { x: 0, v: 0, command: 0, thrust: 0, currentForce: 0 };
      this.umbilical = {
        L: c.RECOVER_DEPTH, z: c.RECOVER_DEPTH, depthRate: 0,
        offset: 0, offsetRate: 0, tension: c.TENSION_WEIGHT,
        broken: false, jamStretch: 0
      };
      this.tool = {
        name: 'locator', x: 0, z: c.RECOVER_DEPTH,
        phase: null, progress: 0, progressText: 'idle'
      };
      this.power = { load: c.POWER_BASE, limit: c.POWER_LIMIT, overloadT: 0, pumpOn: false };
      this.thrusters = { port: { healthy: true, effort: 1 }, starboard: { healthy: true, effort: 1 } };
      this.joints = c.JOINT_DEFS.map((j) => ({
        x: j.x, z: j.z, requiredTool: j.tool,
        located: false, cut: false, spliced: false,
        activePhase: null, phaseElapsed: 0, phaseDone: false
      }));
      this.stats = {
        tensionMax: c.TENSION_WEIGHT, powerMax: c.POWER_BASE,
        offsetMax: 0, driftMax: 0, thrustMax: 0
      };
      this.fault = null;                 // 计划/发生中的设备故障
      this.recovery = null;             // 恢复流程状态
      this.soakElapsed = 0;
      this.completedAt = null;
      this.abortInfo = null;
      this._lastHash = this.stateHash();
      return this;
    }

    get t() { return this.time; }

    // 当前各安全通道余量（负值=越限），事件记录时一并写入
    margins() {
      const c = this.cfg;
      const u = this.umbilical;
      return {
        tension_kN: round3((c.TENSION_BREAK - u.tension) / 1000),
        drift_m: round3(c.DRIFT_LIMIT - Math.abs(this.ship.x)),
        power_kW: round3(c.POWER_LIMIT - this.power.load),
        overload_s: round3(c.OVERLOAD_LIMIT_T - this.power.overloadT),
        offset_m: round3(c.JOINT_RADIUS * 2 - Math.abs(u.offset))
      };
    }

    logEvent(kind, message, extra = {}) {
      const ev = {
        tick: this.tick, time: round3(this.time), kind, message,
        mode: this.mode, margins: this.margins(), ...extra
      };
      this.events.push(ev);
      return ev;
    }

    // 可用于回放一致性比对的状态指纹（不含 RNG 内部态与事件列表）
    stateHash() {
      const u = this.umbilical, s = this.ship, p = this.power, tl = this.tool;
      const j = this.joints.map((x) =>
        `${x.located ? 1 : 0}${x.cut ? 1 : 0}${x.spliced ? 1 : 0}${round3(x.phaseElapsed)}`
      ).join('|');
      const key = [
        this.mode, round3(this.time), round3(s.x), round3(s.v), round3(s.command),
        round3(u.L), round3(u.z), round3(u.offset), round3(u.tension), u.broken,
        tl.name, round3(tl.progress), round3(p.load), round3(p.overloadT), p.pumpOn,
        this.thrusters.port.healthy, this.thrusters.starboard.healthy,
        this.soakElapsed, j
      ].join('#');
      let h = 2166136261 >>> 0;
      for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16).padStart(8, '0');
    }

    // 记录并应用一次操作意图（tick 边界处生效，保证回放一致）
    step(intent = null) {
      if (this.mode === 'complete') return this;
      const rec = intent ? { tick: this.tick, ...intent } : { tick: this.tick, hold: true };
      this.intents.push(rec);
      this._applyDiscrete(intent);

      if (this.mode === 'aborted') {
        this._stepIdle();
      } else if (this.mode === 'recovering') {
        this._stepRecovery();
      } else if (this.mode === 'soak') {
        if (intent) this._soakIntent = intent;
        this._stepSoak();
      } else {
        this._stepRunning(intent);
      }

      this.tick += 1;
      this.time = round3(this.tick * this.cfg.DT);
      this._checkInvariants();
      this._lastHash = this.stateHash();
      return this;
    }

    _applyDiscrete(intent) {
      if (!intent) return;
      if (intent.tool && intent.tool !== this.tool.name) {
        const prev = this.tool.name;
        this.tool.name = intent.tool;
        this.logEvent('tool_switch', `工具切换 ${prev} -> ${intent.tool}（电力负载变化）`);
      }
      if (typeof intent.pump === 'boolean' && intent.pump !== this.power.pumpOn) {
        this.power.pumpOn = intent.pump;
        this.logEvent('pump', intent.pump ? '辅助泵并网' : '辅助泵解列');
      }
      if (intent.injectFault) this._injectFault(intent.injectFault);
      if (intent.recover && this.mode === 'aborted') this._startRecovery();
    }

    _injectFault(spec) {
      const f = { type: spec.type, at: this.time, tick: this.tick, acknowledged: false };
      this.fault = f;
      if (spec.type === 'portThruster') {
        this.thrusters.port.healthy = false;
        this.thrusters.port.effort = 0.3;
        this.logEvent('fault', '左舷推进器故障：推力降级至 30%', {
          fault: f, response: '动力定位冗余重构，右舷推进器接管'
        });
      } else if (spec.type === 'sensorBias') {
        this.logEvent('fault', '张力传感器偏置故障注入', {
          fault: f, response: '告警挂起，等待人工确认'
        });
      } else if (spec.type === 'winchJam') {
        this.umbilical.jamStretch = 0;
        this.logEvent('fault', '绞车卡滞故障：脐带长度锁定，继续收揽将积累过张力', {
          fault: f, response: '张力告警，禁止强行收揽'
        });
      }
    }

    _thrustEffort() {
      return (this.thrusters.port.effort + this.thrusters.starboard.effort) / 2;
    }

    _stepRunning(intent) {
      const c = this.cfg;
      const h = this.cfg.DT / c.SUBSTEPS;
      const throttle = intent && typeof intent.throttle === 'number'
        ? clamp(intent.throttle, -1, 1) : this.ship.command;
      const winch = intent && typeof intent.winch === 'number'
        ? clamp(intent.winch, -1, 1) : 0;
      this.ship.command = throttle;

      for (let i = 0; i < c.SUBSTEPS; i++) {
        this._substepPhysics(h, throttle, winch);
      }
      this._updatePower(throttle);
      this._updateJoints();
      this._updateStats();
      this._checkAborts();
      if (this.mode === 'running') this._checkSuccess();
    }

    _substepPhysics(h, throttle, winch) {
      const c = this.cfg;
      const u = this.umbilical, s = this.ship;
      const surfaceCurrent = currentAt(this.time + h, 0);
      const toolCurrent = currentAt(this.time + h, u.z);

      // 船体：推进器 + 海流力 - 阻尼
      const effort = this._thrustEffort();
      s.thrust = throttle * c.SHIP_THRUST_MAX * effort;
      s.currentForce = 1600 * surfaceCurrent;
      const sAcc = (s.thrust + s.currentForce - c.SHIP_DRAG * s.v) / c.SHIP_MASS;
      s.v += sAcc * h;
      s.x += s.v * h;

      // 脐带长度（绞车）；卡滞时长度锁定，收揽力转为弹性拉伸
      const jammed = this.fault && this.fault.type === 'winchJam';
      if (!u.broken && !jammed) u.L = Math.max(2, u.L + winch * c.WINCH_RATE * h);
      if (jammed && winch < 0 && !u.broken) {
        u.jamStretch = (u.jamStretch || 0) + Math.abs(winch) * c.WINCH_RATE * h * 1.4;
      }

      // 工具纵向：绞车长度为目标，阻尼一阶跟随（水中重力由预张力平衡）
      const mTool = 4000;
      const dz = u.L - u.z;
      const targetRate = clamp(1.6 * dz, -2.0, 2.0);
      const rateTau = 0.35;
      u.depthRate += (targetRate - u.depthRate) * (h / rateTau);
      u.z += u.depthRate * h;
      if (u.z > c.WATER_DEPTH - c.JOINT_WORK_Z) {
        u.z = c.WATER_DEPTH - c.JOINT_WORK_Z;
        u.depthRate = Math.min(0, u.depthRate);
      }

      // 工具横向：海流推力与脐带横向弹性
      const fCurrent = c.TOOL_DRAG * toolCurrent;
      const toolVx = u.offsetRate + s.v;
      const toolAcc = (fCurrent - c.SPRING_K * u.offset) / mTool;
      u.offsetRate = toolVx + toolAcc * h - s.v;
      u.offset += u.offsetRate * h;

      // 张力合成：预张力 + 纵向弹性 + 横向分量 + 收揽动载
      if (u.broken) {
        u.tension = 0;
      } else {
        const horiz = (0.5 * c.SPRING_K * u.offset * u.offset) / Math.max(u.L, 1);
        // 收揽时脐带短于悬挂长度 -> 弹性拉伸；放揽过长 -> 松弛
        const stretch = Math.max(0, u.z - u.L) + (u.jamStretch || 0);
        const dyn = 0.08 * c.SPRING_KD * Math.max(0, -u.depthRate);
        u.tension = Math.max(
          c.TENSION_WEIGHT * 0.25,
          c.TENSION_WEIGHT + c.SPRING_KE * stretch + horiz + dyn
        );
      }
      this.tool.x = s.x + u.offset;
      this.tool.z = u.z;
    }

    _updatePower(throttle) {
      const c = this.cfg;
      if (this.umbilical.broken) {
        this.power.load = c.POWER_BASE;
        return;
      }
      const thrustLoad = c.POWER_THRUST * Math.abs(throttle);
      let load = c.POWER_BASE + thrustLoad + c.POWER_TOOL[this.tool.name];
      if (this.power.pumpOn) load += c.POWER_PUMP;
      this.power.load = round3(load);
      if (load > c.POWER_LIMIT) {
        this.power.overloadT = round3(this.power.overloadT + c.DT);
      } else {
        this.power.overloadT = round3(Math.max(0, this.power.overloadT - c.DT * 2));
      }
    }

    _updateJoints() {
      const c = this.cfg;
      const tool = this.tool;
      for (let i = 0; i < this.joints.length; i++) {
        const j = this.joints[i];
        if (j.spliced) continue;
        const inRange = Math.abs(tool.x - j.x) <= c.JOINT_RADIUS
          && Math.abs(tool.z - (j.z - c.JOINT_WORK_Z)) <= c.JOINT_RADIUS;
        if (!inRange) {
          j.activePhase = null;
          j.phaseElapsed = 0;
          continue;
        }
        if (!j.located) {
          if (tool.name === 'locator') this._advancePhase(j, 'locate', '定位');
          else j.activePhase = null;
        } else if (!j.cut) {
          if (tool.name === j.requiredTool) this._advancePhase(j, 'cut', '切割');
          else j.activePhase = null;
        } else {
          if (tool.name === 'arm') this._advancePhase(j, 'splice', '接头安装');
          else j.activePhase = null;
        }
      }
      const active = this.joints.find((j) => j.activePhase);
      if (active) {
        tool.phase = active.activePhase;
        tool.progress = round3(active.phaseElapsed / c.PHASE_DUR[active.activePhase]);
        tool.progressText = `${active.activePhase} ${Math.round(tool.progress * 100)}%`;
      } else {
        tool.phase = null;
        tool.progress = 0;
        tool.progressText = 'idle';
      }
    }

    _advancePhase(joint, phase, label) {
      const c = this.cfg;
      if (joint.activePhase !== phase) {
        joint.activePhase = phase;
        joint.phaseElapsed = 0;
        this.logEvent('joint_phase', `接头 x=${joint.x} 开始${label}（${phase}）`);
      }
      joint.phaseElapsed = round3(joint.phaseElapsed + c.DT);
      if (joint.phaseElapsed >= c.PHASE_DUR[phase]) {
        const flag = phase === 'locate' ? 'located' : phase === 'cut' ? 'cut' : 'spliced';
        joint[flag] = true;
        joint.activePhase = null;
        joint.phaseElapsed = 0;
        this.logEvent('joint_done', `接头 x=${joint.x} ${label}完成`, {
          phase, jointIndex: this.joints.indexOf(joint), margins: this.margins()
        });
      }
    }

    _updateStats() {
      this.stats.tensionMax = Math.max(this.stats.tensionMax, this.umbilical.tension);
      this.stats.powerMax = Math.max(this.stats.powerMax, this.power.load);
      this.stats.offsetMax = Math.max(this.stats.offsetMax, Math.abs(this.umbilical.offset));
      this.stats.driftMax = Math.max(this.stats.driftMax, Math.abs(this.ship.x));
      this.stats.thrustMax = Math.max(this.stats.thrustMax, Math.abs(this.ship.thrust));
    }

    _abort(reason, message, extra = {}) {
      this.mode = 'aborted';
      this.ship.command = 0;
      this.abortInfo = { reason, at: this.time, tick: this.tick, ...extra };
      this.logEvent('abort', message, { reason, ...extra });
    }

    _checkAborts() {
      const c = this.cfg;
      if (this.umbilical.tension >= c.TENSION_BREAK && !this.umbilical.broken) {
        const peakTension = this.umbilical.tension;
        this.umbilical.broken = true;
        this.umbilical.tension = 0;
        this.umbilical.jamStretch = 0;
        this.fault = null;
        this._abort('umbilical_break', '脐带断裂：张力越过断裂限值，任务中止', {
          tension_kN: round3(peakTension / 1000),
          peakMargin_kN: round3((c.TENSION_BREAK - peakTension) / 1000)
        });
        return;
      }
      if (Math.abs(this.ship.x) > c.DRIFT_LIMIT) {
        this._abort('drift_exceeded', `船位漂移超限 |x|=${round3(Math.abs(this.ship.x))}m > ${c.DRIFT_LIMIT}m`, {
          drift_m: round3(Math.abs(this.ship.x))
        });
        return;
      }
      if (this.power.overloadT >= c.OVERLOAD_LIMIT_T) {
        this._abort('power_overload',
          `持续电力过载 ${round3(this.power.load)}kW 超过 ${c.OVERLOAD_LIMIT_T}s，保护性中止`, {
          load_kW: this.power.load
        });
      }
    }

    _checkSuccess() {
      if (!this.joints.every((j) => j.spliced)) return;
      if (this.umbilical.z > this.cfg.RECOVER_DEPTH + 1) return;
      this.mode = 'soak';
      this.soakElapsed = 0;
      this.logEvent('all_joints_done', '两处接头完成，工具回收到安全深度，进入稳定观察');
    }

    _startRecovery() {
      this.mode = 'recovering';
      this.recovery = { phase: 'isolate', elapsed: 0, sequence: ['isolate', 'retrieve', 'inspect', 'secure'] };
      this.power.pumpOn = false;
      this.ship.command = 0;
      this.logEvent('recovery_start', '启动恢复流程：隔离故障并回收工具', {
        abortReason: this.abortInfo && this.abortInfo.reason
      });
    }

    _stepIdle() {
      // 中止后系统保持安全待命，仅更新环境相关读数
      const c = this.cfg;
      const surfaceCurrent = currentAt(this.time, 0);
      this.ship.currentForce = 1600 * surfaceCurrent;
      this.ship.thrust = 0;
      this.ship.v = 0;
      this._updateStats();
      void c;
    }

    _stepRecovery() {
      const c = this.cfg;
      const r = this.recovery;
      r.elapsed = round3(r.elapsed + c.DT);
      if (r.phase === 'isolate') {
        this.ship.thrust = 0;
        this.ship.v = 0;
      } else if (r.phase === 'retrieve') {
        // 回收同时将船位拉回安全包络
        const back = clamp(-this.ship.x * 0.6 - this.ship.v * 2, -1, 1);
        const surfaceCurrent = currentAt(this.time, 0);
        this.ship.thrust = back * c.SHIP_THRUST_MAX * this._thrustEffort();
        this.ship.currentForce = 1600 * surfaceCurrent;
        const sAcc = (this.ship.thrust + this.ship.currentForce - c.SHIP_DRAG * this.ship.v) / c.SHIP_MASS;
        this.ship.v += sAcc * c.DT;
        this.ship.x += this.ship.v * c.DT;
        if (!this.umbilical.broken) {
          const pull = Math.min(0.8, Math.max(0, this.umbilical.z - c.RECOVER_DEPTH) * 0.08);
          this.umbilical.L = Math.max(2, this.umbilical.L - pull * c.WINCH_RATE * 2.5 * c.DT);
          this.umbilical.z = Math.max(c.RECOVER_DEPTH, this.umbilical.z - pull * 0.5 * c.DT);
          this.umbilical.tension = c.TENSION_WEIGHT * (1 + 0.05 * pull);
        } else {
          this.umbilical.z = c.RECOVER_DEPTH;
        }
      } else if (r.phase === 'inspect') {
        // 设备复检：恢复推进器冗余
        this.thrusters.port.healthy = true;
        this.thrusters.port.effort = 1;
      }
      if (r.elapsed >= c.RECOVERY_PHASE_T) {
        const idx = r.sequence.indexOf(r.phase);
        this.logEvent('recovery_phase', `恢复阶段 ${r.phase} 完成`, { phase: r.phase });
        if (idx === r.sequence.length - 1) {
          this.mode = 'soak';
          this.soakElapsed = 0;
          this.umbilical.broken = false;
          this.umbilical.tension = c.TENSION_WEIGHT;
          this.umbilical.L = c.RECOVER_DEPTH;
          this.umbilical.z = c.RECOVER_DEPTH;
          this.umbilical.offset = 0;
          this.umbilical.offsetRate = 0;
          this.umbilical.depthRate = 0;
          this.power.overloadT = 0;
          this.power.load = c.POWER_BASE;
          this.fault = null;
          this.logEvent('recovery_complete', '系统恢复到安全状态，开始固定时长稳定运行', {
            soak_s: c.SOAK_T
          });
          this._soakIntent = null;
        } else {
          r.phase = r.sequence[idx + 1];
          r.elapsed = 0;
        }
      }
      this._updateStats();
    }

    _stepSoak() {
      const c = this.cfg;
      // 默认良性保持输入；显式意图可注入激励用于越限测试
      const hold = this._soakIntent && typeof this._soakIntent.throttle === 'number'
        ? clamp(this._soakIntent.throttle, -1, 1)
        : clamp(-this.ship.x * 0.2, -1, 1);
      const winch = this._soakIntent && typeof this._soakIntent.winch === 'number'
        ? clamp(this._soakIntent.winch, -1, 1) : 0;
      for (let i = 0; i < c.SUBSTEPS; i++) {
        this._substepPhysics(c.DT / c.SUBSTEPS, hold, winch);
      }
      this._updatePower(hold);
      this._updateStats();
      this.soakElapsed = round3(this.soakElapsed + c.DT);
      if (this.soakElapsed >= c.SOAK_T) {
        this.mode = 'complete';
        this.completedAt = this.time;
        this.logEvent('soak_complete',
          `稳定运行 ${c.SOAK_T}s 无连锁错误或状态跳变，流程结束`, { soak_s: c.SOAK_T });
      }
      this._checkAborts();
    }

    _checkInvariants() {
      const c = this.cfg;
      const u = this.umbilical;
      const violations = [];
      const finite = (v) => Number.isFinite(v);
      if (![u.tension, u.z, u.L, u.offset, this.ship.x, this.ship.v, this.power.load]
        .every(finite)) violations.push('non_finite_state');
      if (u.tension < 0 || u.L < 0 || u.z < 0 || u.z > c.WATER_DEPTH + 0.01) {
        violations.push('physical_range');
      }
      if (!u.broken && u.tension > c.TENSION_BREAK && this.mode !== 'aborted') {
        violations.push('tension_break_not_handled');
      }
      const validModes = ['running', 'aborted', 'recovering', 'soak', 'complete'];
      if (!validModes.includes(this.mode)) violations.push('illegal_mode');
      if (violations.length) {
        const ev = this.logEvent('invariant_violation',
          `不变量检查失败: ${violations.join(',')}`, { violations });
        if (!this.invariantViolations) this.invariantViolations = [];
        this.invariantViolations.push(ev);
      }
    }

    // 回放：按记录的操作意图重放到指定 tick
    replayTo(tickLimit) {
      const recorded = this.intents.slice();
      this.reset();
      const limit = tickLimit == null ? recorded.length : Math.min(tickLimit, recorded.length);
      for (let i = 0; i < limit; i++) {
        const { tick, ...intent } = recorded[i];
        void tick;
        this.step(Object.keys(intent).length ? intent : null);
      }
      this.intents = recorded.slice(0, limit);
      return this;
    }

    // 从一次 exportRecord() 的结果进行确定性回放
    replayRecord(record, tickLimit) {
      this.reset();
      const recorded = record.intents;
      const limit = tickLimit == null ? recorded.length : Math.min(tickLimit, recorded.length);
      for (let i = 0; i < limit; i++) {
        const { tick, ...intent } = recorded[i];
        void tick;
        this.step(Object.keys(intent).length ? intent : null);
      }
      this.intents = recorded.slice(0, limit);
      return this;
    }

    exportRecord() {
      return {
        seed: this.seed, cfg: this.cfg, tick: this.tick, time: this.time,
        mode: this.mode, events: this.events, intents: this.intents,
        joints: this.joints, stats: this.stats, abortInfo: this.abortInfo,
        completedAt: this.completedAt,
        invariantViolations: this.invariantViolations || [],
        hash: this._lastHash
      };
    }
  }

  return {
    Simulation, Rng, currentAt, hashSeed,
    constants: DEFAULT_CFG, round3, clamp
  };

  // __APPEND__
});
