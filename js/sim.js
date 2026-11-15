// 泄洪调度仿真核心：确定性仿真时钟，统一设备状态、环境变化与操作记录。
// 纯逻辑模块，不依赖 DOM，可在 Node 中直接测试与回放。

export const DT = 1;                    // 仿真步长（秒）
export const SIM_DURATION = 6 * 3600;   // 6 小时模拟
export const SOAK_DURATION = 30 * 60;   // 恢复安全后持续观察时间

export const LIMITS = {
  levelMax: 36,        // 坝体安全水位（m），超过即漫坝失败
  levelWarn: 33,       // 高水位预警
  levelMin: 16,        // 死水位，低于此闸门出流失效
  downSafe: 2400,      // 下游安全流量（m3/s）
  downHard: 2520,      // 下游硬上限（1.05 倍），持续超限即冲刷失败
  overLimitGrace: 30,  // 下游连续超限容忍秒数
};

export const GATE = {
  count: 3,
  sill: 18,            // 闸门底槛高程（m）
  coef: 220,           // 流量系数：Q = coef * open * sqrt(L - sill)
  rate: 0.02,          // 开度变化速度（1/s），全行程 50s
};

export const SPILL = {
  sill: 20,
  coef: 400,
  rate: 0.01,          // 泄洪道动作更慢，全行程 100s
};

const REPAIR_TIME = 120; // 闸门故障修复耗时（秒）

// mulberry32：可播种的确定性伪随机数
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 场景定义：环境激励 + 故障注入
export const SCENARIOS = {
  normal: {
    label: '正常调度',
    inflowScale: 1.0,
    faults: [],
  },
  gateFault: {
    label: '设备故障（2 号闸门卡涩）',
    inflowScale: 1.0,
    faults: [{ t: 5400, gate: 1 }],
  },
  extremeFlood: {
    label: '参数越限（超标准洪水）',
    inflowScale: 1.45,
    faults: [],
  },
};

export function fmtT(t) {
  const h = String(Math.floor(t / 3600)).padStart(2, '0');
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(t % 60)).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ---- 环境：上游来水 + 降雨（预报只给概率区间） ----
// 来水过程线（秒 -> m3/s）：基流 800，t=1800 突增，t=14400 回落。
function baseHydrograph(t) {
  if (t < 1800) return 800;
  if (t < 14400) return 800 + 1800 * Math.min(1, (t - 1800) / 900);
  return 2600 - 1400 * Math.min(1, (t - 14400) / 3600);
}

// 降雨事件：t in [3600, 7200)，实际强度由种子抽样；预报区间提前 1800s 发布。
const RAIN = { start: 3600, end: 7200, lead: 1800, mean: 500, spread: 0.35 };

class Environment {
  constructor(rng, inflowScale) {
    this.scale = inflowScale;
    // 实际降雨强度：在均值 ±spread 内抽样（仿真时钟驱动，回放可复现）
    this.rainActual = RAIN.mean * (1 - RAIN.spread + 2 * RAIN.spread * rng());
    // 预报只提供概率区间，且带一次抽样误差
    const err = 0.9 + 0.2 * rng();
    this.forecastLo = RAIN.mean * (1 - RAIN.spread) * err;
    this.forecastHi = RAIN.mean * (1 + RAIN.spread) * err;
  }
  inflowAt(t) {
    let q = baseHydrograph(t) * this.scale;
    if (t >= RAIN.start && t < RAIN.end) q += this.rainActual * this.scale;
    return q;
  }
  forecast(t) {
    if (t < RAIN.start - RAIN.lead || t >= RAIN.end) return null;
    return { lo: this.forecastLo, hi: this.forecastHi, start: RAIN.start, end: RAIN.end };
  }
}

// ---- 仿真主体 ----
export class Sim {
  // opts: { seed, scenario, soak }  soak=true 时到达 6h 不结束，用于恢复后持续观察
  constructor(opts = {}) {
    this.seed = opts.seed ?? 1;
    this.scenarioName = opts.scenario ?? 'normal';
    this.scenario = SCENARIOS[this.scenarioName];
    if (!this.scenario) throw new Error(`未知场景: ${this.scenarioName}`);
    this.soak = !!opts.soak;
    this.rng = mulberry32(this.seed);
    this.env = new Environment(this.rng, this.scenario.inflowScale);

    this.t = 0;
    this.level = 28;                 // 库水位（m）
    this.surfaceArea = 2.0e6;        // 库面面积（m2，简化恒定）
    this.gates = [];
    for (let i = 0; i < GATE.count; i++) {
      this.gates.push({ open: 0, target: 0, stuck: false, repairLeft: 0 });
    }
    this.spill = { open: 0, target: 0 };
    this.qIn = 0; this.qOut = 0; this.qGate = [0, 0, 0]; this.qSpill = 0;
    this.overLimitRun = 0;           // 下游连续超限计时
    this.scour = 0;                  // 河岸冲刷累积量（超限流量积分）
    this.status = 'running';         // running | success | failed
    this.failReason = null;
    this.safeSince = null;           // 恢复安全状态的时刻（用于 soak 判定）
    this.log = [];                   // 统一仿真时钟日志：操作 + 事件
    this.faultsPending = this.scenario.faults.map(f => ({ ...f }));
    this._record('init', { scenario: this.scenarioName, seed: this.seed });
  }

  _record(type, data = {}) {
    this.log.push({ t: this.t, clock: fmtT(this.t), type, ...data });
  }

  margins() {
    return {
      level: +(LIMITS.levelMax - this.level).toFixed(3),   // 坝体余量（m）
      flow: +(LIMITS.downSafe - this.qOut).toFixed(1),     // 下游流量余量（m3/s）
    };
  }

  inSafeZone() {
    return this.level < LIMITS.levelWarn && this.qOut <= LIMITS.downSafe;
  }

  // 推进一个仿真时钟步
  step() {
    if (this.status !== 'running') return;

    // 1) 故障注入（仿真时钟驱动）
    for (const f of this.faultsPending) {
      if (this.t >= f.t) {
        const g = this.gates[f.gate];
        g.stuck = true; g.repairLeft = 0;
        this._record('fault', {
          device: `gate${f.gate + 1}`, detail: '闸门卡涩，开度冻结',
          margins: this.margins(), response: '等待玩家修复指令',
        });
      }
    }
    this.faultsPending = this.faultsPending.filter(f => this.t < f.t);

    // 2) 设备动态：开度跟踪目标，速度受限；修复计时
    for (let i = 0; i < GATE.count; i++) {
      const g = this.gates[i];
      if (g.stuck) {
        if (g.repairLeft > 0) {
          g.repairLeft -= DT;
          if (g.repairLeft <= 0) {
            g.stuck = false; g.repairLeft = 0;
            this._record('recover', {
              device: `gate${i + 1}`, detail: '修复完成，恢复可控',
              margins: this.margins(), response: '闸门重新跟踪目标开度',
            });
          }
        }
      } else {
        const d = g.target - g.open;
        const step = GATE.rate * DT;
        g.open += Math.abs(d) <= step ? d : Math.sign(d) * step;
      }
    }
    const sp = this.spill;
    const dsp = sp.target - sp.open;
    const spStep = SPILL.rate * DT;
    sp.open += Math.abs(dsp) <= spStep ? dsp : Math.sign(dsp) * spStep;

    // 3) 水力计算
    this.qIn = this.env.inflowAt(this.t);
    this.qGate = this.gates.map(g =>
      GATE.coef * g.open * Math.sqrt(Math.max(0, this.level - GATE.sill)));
    this.qSpill = SPILL.coef * sp.open * Math.sqrt(Math.max(0, this.level - SPILL.sill));
    this.qOut = this.qGate.reduce((a, b) => a + b, 0) + this.qSpill;

    // 4) 库水位更新：dL = (Qin - Qout) * dt / 库面面积
    this.level += ((this.qIn - this.qOut) * DT) / this.surfaceArea;

    // 5) 下游超限计时与冲刷累积
    if (this.qOut > LIMITS.downHard) {
      this.overLimitRun += DT;
      this.scour += (this.qOut - LIMITS.downSafe) * DT / 1000;
    } else {
      if (this.overLimitRun > 0 && this.overLimitRun <= LIMITS.overLimitGrace) {
        this._record('alarm_clear', { detail: '下游流量回落到硬上限内', margins: this.margins() });
      }
      this.overLimitRun = 0;
    }

    // 6) 失败判定
    if (this.level >= LIMITS.levelMax) {
      this._fail('漫坝：库水位超过坝体安全上限');
    } else if (this.overLimitRun > LIMITS.overLimitGrace) {
      this._fail('下游冲刷：叠加流量持续超过河道安全承载');
    }

    // 7) 安全状态跟踪（供恢复后 soak 观察）
    if (this.status === 'running') {
      if (this.inSafeZone()) {
        if (this.safeSince === null) this.safeSince = this.t;
      } else {
        this.safeSince = null;
      }
    }

    // 8) 结束判定
    this.t += DT;
    if (this.status === 'running' && !this.soak && this.t >= SIM_DURATION) {
      this.status = 'success';
      this._record('success', { detail: '六小时模拟结束，坝体与下游均达标', margins: this.margins() });
    }
  }

  _fail(reason) {
    this.status = 'failed';
    this.failReason = reason;
    this._record('failure', { detail: reason, margins: this.margins(), response: '仿真终止，可回放失败过程' });
  }

  // ---- 玩家操作（全部进入统一仿真时钟日志，可回放） ----
  setGateTarget(i, v) {
    if (this.status !== 'running') return;
    const g = this.gates[i];
    if (!g) return;
    const val = Math.min(1, Math.max(0, v));
    if (g.stuck) {
      this._record('op_rejected', { device: `gate${i + 1}`, detail: '闸门卡涩，指令被拒绝', margins: this.margins() });
      return;
    }
    g.target = val;
    this._record('op', { device: `gate${i + 1}`, action: 'setTarget', value: val });
  }

  setSpillTarget(v) {
    if (this.status !== 'running') return;
    const val = Math.min(1, Math.max(0, v));
    this.spill.target = val;
    this._record('op', { device: 'spillway', action: 'setTarget', value: val });
  }

  repairGate(i) {
    if (this.status !== 'running') return;
    const g = this.gates[i];
    if (!g || !g.stuck || g.repairLeft > 0) return;
    g.repairLeft = REPAIR_TIME;
    this._record('op', { device: `gate${i + 1}`, action: 'repair', value: REPAIR_TIME });
  }

  // 快照：用于 UI 渲染与测试断言
  snapshot() {
    return {
      t: this.t, clock: fmtT(this.t), status: this.status, failReason: this.failReason,
      level: +this.level.toFixed(4), qIn: +this.qIn.toFixed(1), qOut: +this.qOut.toFixed(1),
      qGate: this.qGate.map(q => +q.toFixed(1)), qSpill: +this.qSpill.toFixed(1),
      gates: this.gates.map(g => ({ open: +g.open.toFixed(3), target: g.target, stuck: g.stuck, repairLeft: g.repairLeft })),
      spill: { open: +this.spill.open.toFixed(3), target: this.spill.target },
      margins: this.margins(), scour: +this.scour.toFixed(2),
      forecast: this.env.forecast(this.t),
      safeSince: this.safeSince,
    };
  }

  // 确定性回放：同种子 + 同操作日志 => 同轨迹。返回重放到尾的 Sim。
  static replay(log, opts = {}) {
    const init = log.find(e => e.type === 'init');
    const sim = new Sim({
      seed: opts.seed ?? init?.seed ?? 1,
      scenario: opts.scenario ?? init?.scenario ?? 'normal',
      soak: opts.soak ?? false,
    });
    const ops = log.filter(e => e.type === 'op');
    let oi = 0;
    const until = opts.until ?? Infinity;
    while (sim.status === 'running' && sim.t < until) {
      while (oi < ops.length && ops[oi].t <= sim.t) {
        const o = ops[oi++];
        if (o.action === 'setTarget' && o.device.startsWith('gate')) {
          sim.setGateTarget(Number(o.device.slice(4)) - 1, o.value);
        } else if (o.action === 'setTarget' && o.device === 'spillway') {
          sim.setSpillTarget(o.value);
        } else if (o.action === 'repair') {
          sim.repairGate(Number(o.device.slice(4)) - 1);
        }
      }
      sim.step();
    }
    return sim;
  }
}
