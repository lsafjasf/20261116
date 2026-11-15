export const TICK_SECONDS = 0.05;
export const VERIFY_SECONDS = 12;

export const LIMITS = Object.freeze({
  wind: 18,
  sway: 1.25,
  contact: 0.95,
  humidity: 82,
  tempMin: 10,
  tempMax: 30,
  motorTemp: 86,
});

export const SCENARIOS = Object.freeze({
  normal: {
    id: "normal",
    code: "NORMAL",
    name: "正常窗口",
    description: "稳定风况下完成三片叶片修复，并安全回收平台。",
    seed: 7407,
    window: 120,
    windBase: 8.2,
    windWave: 0.72,
    tempBase: 18.6,
    humidityBase: 58,
    damage: [0.78, 0.54, 0.34],
  },
  equipment: {
    id: "equipment",
    code: "EQUIP-FAULT",
    name: "设备故障",
    description: "打磨机主轴过热，系统自动回撤、切换备用头并完成稳定观察。",
    seed: 7419,
    window: 120,
    windBase: 7.6,
    windWave: 0.62,
    tempBase: 17.8,
    humidityBase: 61,
    damage: [0.74, 0.61, 0.4],
    equipmentFaultAt: 34.5,
  },
  parameter: {
    id: "parameter",
    code: "PARAM-LIMIT",
    name: "参数越限",
    description: "首片叶片固化阶段湿度越过工艺上限，触发除湿与停机联锁。",
    seed: 7441,
    window: 120,
    windBase: 8.8,
    windWave: 0.68,
    tempBase: 20.4,
    humidityBase: 61,
    damage: [0.69, 0.57, 0.43],
    parameterFault: true,
  },
  instability: {
    id: "instability",
    code: "PLATFORM-ABORT",
    name: "平台失稳",
    description: "短时强阵风使平台摆幅越过中止阈值，执行一次不可恢复的作业中止与安全回收。",
    seed: 7463,
    window: 120,
    windBase: 10.1,
    windWave: 0.82,
    tempBase: 18.1,
    humidityBase: 59,
    damage: [0.81, 0.49, 0.37],
    gust: { center: 42, width: 8, amplitude: 8.6 },
  },
});

export const STAGE_LABELS = Object.freeze({
  travel: "平台进场",
  sand: "表面打磨",
  coat: "涂层补涂",
  dry: "固化干燥",
  light: "灯光复位",
  recover: "平台回收",
  complete: "任务完成",
  aborted: "中止回收",
  window: "风窗关闭",
});

export const STATUS_LABELS = Object.freeze({
  running: "作业进行中",
  fault_hold: "故障安全保持",
  verifying: "恢复稳定观察",
  aborting: "失稳中止回收",
  complete: "修复成功",
  aborted_safe: "中止 · 平台安全",
  failed: "任务失败",
});

const STAGE_ORDER = ["travel", "sand", "coat", "dry", "light"];
const STAGE_WEIGHTS = { sand: 0.34, coat: 0.2, dry: 0.28, light: 0.18 };
const MAX_LOG_ENTRIES = 320;
const MAX_HISTORY_FRAMES = 7000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 2) => Number(value.toFixed(digits));

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stageDuration(stage, severity) {
  if (stage === "travel") return 2.4;
  if (stage === "sand") return 7.3 + severity * 5.5;
  if (stage === "coat") return 5.2;
  if (stage === "dry") return 7.4;
  if (stage === "light") return 2.6;
  return 7;
}

function stageIndex(stage) {
  return STAGE_ORDER.indexOf(stage);
}

function formatStageProgress(stage, progress) {
  return `${STAGE_LABELS[stage] || stage} ${Math.round(progress * 100)}%`;
}

export class Simulation {
  constructor(scenarioId = "normal") {
    this.reset(scenarioId);
  }

  reset(scenarioId = this.scenario?.id || "normal") {
    const scenario = SCENARIOS[scenarioId] || SCENARIOS.normal;
    this.scenario = scenario;
    this.random = mulberry32(scenario.seed);
    this.t = 0;
    this.tick = 0;
    this.accumulator = 0;
    this.running = true;
    this.speed = 1;
    this.pauseReason = null;
    this.terminal = false;
    this.terminalAt = null;
    this.outcome = null;
    this.frames = [];
    this.logs = [];
    this.logSequence = 0;
    this.faults = [];
    this.currentFaultId = null;
    this.instabilityAbortUsed = false;
    this.triggered = {
      equipment: false,
      parameter: false,
      instability: false,
      window30: false,
      window12: false,
      window0: false,
    };
    this.envNoise = 0;
    this.env = {
      wind: scenario.windBase,
      temp: scenario.tempBase,
      humidity: scenario.humidityBase,
      humidityBias: 0,
      gust: 0,
      dryOk: true,
    };
    this.platform = {
      sway: 0.12,
      mode: "transit",
      gap: 0.46,
      unstableTicks: 0,
    };
    this.equipment = {
      sander: { active: false, temp: 41.5, state: "待机" },
      lamp: { active: false, state: "待机", voltage: 0.2 },
      recoveryMode: false,
    };
    this.window = {
      duration: scenario.window,
      remaining: scenario.window,
      state: "open",
      closed: false,
    };
    this.mission = {
      status: "running",
      stage: "travel",
      stageElapsed: 0,
      bladeIndex: 0,
      repairedCount: 0,
      resumedAt: null,
      stageStartedAt: 0,
      completedAt: null,
    };
    this.blades = scenario.damage.map((severity, index) => ({
      id: index + 1,
      label: `B${index + 1}`,
      severity,
      damage: severity,
      repaired: false,
      stages: {
        travel: 0,
        sand: 0,
        coat: 0,
        dry: 0,
        light: 0,
      },
    }));
    this.verification = null;
    this._lastDryWarning = -10;
    this._lastContactWarning = -10;
    this._log("CLOCK", "时钟同步", "场景种子载入，固定步长 50 ms，仿真时钟归零。", "info");
    this._log("WEATHER", "风窗开启", `作业窗口 ${scenario.window.toFixed(0)} s，阵风与湿度由同一环境时钟驱动。`, "info");
    this._log("MISSION", "平台进场", "维修平台离开母船，向 B1 叶片接近。", "info");
    this._captureFrame(true);
    return this;
  }

  advance(realSeconds) {
    if (!this.running) return 0;
    const scaled = Math.max(0, realSeconds) * this.speed;
    this.accumulator += Math.min(scaled, 1.2);
    let steps = 0;
    while (this.accumulator + 1e-9 >= TICK_SECONDS && steps < 32) {
      this._tick();
      this.accumulator -= TICK_SECONDS;
      steps += 1;
    }
    if (steps === 32) this.accumulator = 0;
    return steps;
  }

  pause(reason = "operator") {
    if (!this.running) return false;
    this.running = false;
    this.pauseReason = reason;
    this._log("CLOCK", "时钟暂停", `操作员暂停仿真时钟（${reason}）。`, "info");
    return true;
  }

  resume() {
    if (this.running) return false;
    this.running = true;
    this.pauseReason = null;
    this.accumulator = 0;
    this._log("CLOCK", "时钟恢复", "仿真时钟恢复推进，状态由同一时间轴继续。", "info");
    return true;
  }

  stepOnce() {
    if (this.running) this.pause("single-step");
    this._tick();
    this._log("CLOCK", "单步推进", `仿真时钟推进 ${TICK_SECONDS.toFixed(2)} s。`, "info");
    return this.t;
  }

  setSpeed(speed) {
    const next = [1, 2, 4].includes(speed) ? speed : 1;
    this.speed = next;
    this._log("CLOCK", "速度变更", `仿真速度设为 ${next}×；固定步长保持不变。`, "info");
    return next;
  }

  _tick() {
    this.t = round(this.t + TICK_SECONDS, 4);
    this.tick += 1;

    this._updateEnvironment();
    this._updatePlatform();
    this._updateEquipment();

    if (!this.terminal) {
      this._updateWindow();
      this._checkFaultTriggers();
    }

    if (this.mission.status === "running" && !this.terminal) {
      this._advanceMission();
    } else if (!this.terminal) {
      this._updateRecovery();
    }

    if (this.verification && this.mission.status === "verifying") {
      this._sampleVerification();
    }

    if (!this.terminal) this._updatePlatformMode();
    this._captureFrame(this.tick % 4 === 0 || this.currentFaultId !== null);
  }

  _updateEnvironment() {
    this.envNoise = this.envNoise * 0.93 + (this.random() - 0.5) * 0.34;
    const scenario = this.scenario;
    const t = this.t;
    let gust = 0;

    if (scenario.gust) {
      const { center, width, amplitude } = scenario.gust;
      const x = (t - center) / width;
      gust = amplitude * Math.exp(-(x * x));
    }

    this.env.gust = gust;
    this.env.wind = Math.max(
      0.4,
      scenario.windBase +
        Math.sin(t / 5.3) * scenario.windWave +
        Math.sin(t / 1.85 + 0.8) * 0.34 +
        this.envNoise +
        gust,
    );

    let humidityBiasTarget = 0;
    const activeBlade = this.blades[this.mission.bladeIndex];
    if (
      scenario.parameterFault &&
      !this.triggered.parameter &&
      this.mission.status === "running" &&
      activeBlade &&
      this.mission.stage === "dry" &&
      activeBlade.stages.dry > 0.04
    ) {
      humidityBiasTarget = 28;
    }
    this.env.humidityBias += (humidityBiasTarget - this.env.humidityBias) * (1 - Math.exp(-TICK_SECONDS / 1.35));
    if (this.currentFault("PARAMETER")) {
      this.env.humidityBias *= Math.exp(-TICK_SECONDS / 1.6);
    }

    this.env.humidity =
      scenario.humidityBase +
      Math.sin(t / 10.3 + 0.4) * 2.2 +
      Math.sin(t / 3.1) * 0.55 +
      this.envNoise * 1.6 +
      this.env.humidityBias;
    this.env.temp =
      scenario.tempBase +
      Math.sin(t / 16.5) * 1.35 +
      Math.sin(t / 4.7 + 1.1) * 0.18 +
      this.envNoise * 0.2;

    this.env.wind = round(clamp(this.env.wind, 0.4, 32), 2);
    this.env.humidity = round(clamp(this.env.humidity, 20, 99), 1);
    this.env.temp = round(clamp(this.env.temp, -5, 45), 1);
    this.env.dryOk =
      this.env.temp >= LIMITS.tempMin &&
      this.env.temp <= LIMITS.tempMax &&
      this.env.humidity <= LIMITS.humidity;
  }

  _updatePlatform() {
    const gust = Math.max(0, this.env.wind - 11);
    const target =
      0.045 * this.env.wind +
      0.095 * Math.pow(gust, 1.25) +
      Math.sin(this.t * 1.4) * 0.075 +
      Math.sin(this.t * 0.31 + 1.7) * 0.045;
    const alpha = 1 - Math.exp(-TICK_SECONDS / 0.92);
    this.platform.sway += (target - this.platform.sway) * alpha;
    this.platform.sway = round(clamp(this.platform.sway, 0.03, 4.5), 3);

    if (this.env.wind > 13.5 || this.platform.sway > LIMITS.contact) {
      this.platform.unstableTicks += 1;
    } else {
      this.platform.unstableTicks = Math.max(0, this.platform.unstableTicks - 1);
    }

    const active = ["sand", "coat", "dry", "light"].includes(this.mission.stage);
    let gapTarget = active ? 0 : 0.46;
    if (this.mission.status === "fault_hold" || this.mission.status === "aborting") gapTarget = 0.36;
    if (this.mission.stage === "recover") gapTarget = 0.88;
    if (this.mission.status === "complete") gapTarget = 0.95;
    if (this.mission.status === "aborted_safe") gapTarget = 1.1;
    this.platform.gap += (gapTarget - this.platform.gap) * (1 - Math.exp(-TICK_SECONDS / 0.55));
  }

  _updateEquipment() {
    const sander = this.equipment.sander;
    const sanding =
      this.mission.status === "running" &&
      this.mission.stage === "sand" &&
      !this.currentFault();
    sander.active = sanding;
    sander.state = sanding ? "负载运行" : this.currentFault("EQUIPMENT") ? "过温锁定" : "待机";
    const targetTemp = sanding ? 68.5 : this.currentFault("EQUIPMENT") ? 43 : 42;
    sander.temp += (targetTemp - sander.temp) * (1 - Math.exp(-TICK_SECONDS / 4.2));
    if (this.scenario.equipmentFaultAt && !this.triggered.equipment && this.t >= this.scenario.equipmentFaultAt) {
      sander.temp = Math.max(sander.temp, LIMITS.motorTemp + 1.6);
    }
    sander.temp = round(clamp(sander.temp, 28, 98), 1);

    const lamp = this.equipment.lamp;
    lamp.active = this.mission.status === "running" && this.mission.stage === "light";
    lamp.state = lamp.active ? "序列点灯" : this.currentFault() ? "联锁关闭" : "待机";
    lamp.voltage = lamp.active ? round(23.6 + Math.sin(this.t * 8) * 0.24, 2) : 0.2;
  }

  _updateWindow() {
    if (this.window.closed) return;
    this.window.remaining = round(Math.max(0, this.window.remaining - TICK_SECONDS), 3);
    const value = this.window.remaining;
    const priorState = this.window.state;
    this.window.state = value <= 12 ? "critical" : value <= 30 ? "warning" : "open";

    if (priorState !== this.window.state && this.window.state !== "open") {
      const source = this.window.state === "warning" ? "WARN" : "CRITICAL";
      this._log("WEATHER", "风窗余量告警", `剩余 ${value.toFixed(1)} s，平台回收余量低于 ${this.window.state === "warning" ? 30 : 12} s。`, this.window.state === "warning" ? "warn" : "error");
      if (source === "WARN") this.triggered.window30 = true;
    }

    if (value <= 0.001) {
      this.window.closed = true;
      this.window.state = "closed";
      if (!this.terminal) {
        this._triggerFault("WINDOW", "风窗关闭", "风速窗口耗尽，平台未能在安全时限内回收。", {
          margin: "窗口 0.0 s",
        });
        this.mission.status = "failed";
        this.terminal = true;
        this.terminalAt = this.t;
        this.outcome = "window_failure";
      }
    }
  }

  _checkFaultTriggers() {
    if (this.currentFault() || this.terminal) return;

    if (
      this.scenario.equipmentFaultAt &&
      !this.triggered.equipment &&
      this.t >= this.scenario.equipmentFaultAt &&
      this.mission.stage === "sand"
    ) {
      this.triggered.equipment = true;
      this.equipment.sander.temp = Math.max(this.equipment.sander.temp, LIMITS.motorTemp + 1.8);
      this._triggerFault(
        "EQUIPMENT",
        "打磨机主轴过热",
        "打磨机轴承温升越过 86°C 保护线，主轴驱动已断电并请求备用工具头。",
        { motor: true },
      );
      return;
    }

    if (
      this.scenario.parameterFault &&
      !this.triggered.parameter &&
      this.mission.stage === "dry" &&
      this.env.humidity > LIMITS.humidity
    ) {
      this.triggered.parameter = true;
      this._triggerFault(
        "PARAMETER",
        "固化湿度越限",
        "固化区相对湿度越过 82% 工艺上限，涂料交联质量窗口关闭。",
        { humidity: true },
      );
      return;
    }

    if (
      this.platform.sway > LIMITS.sway &&
      this.platform.unstableTicks >= 8 &&
      !this.triggered.instability
    ) {
      this.triggered.instability = true;
      this.instabilityAbortUsed = true;
      this._triggerFault(
        "INSTABILITY",
        "维修平台失稳",
        "阵风使平台摆幅持续越过 1.25 m 中止阈值，执行一次平台失稳中止。",
        { sway: true, abort: true },
      );
    }
  }

  _advanceMission() {
    const mission = this.mission;
    const blade = this.blades[mission.bladeIndex];

    if (mission.stage === "recover") {
      mission.stageElapsed += TICK_SECONDS;
      if (mission.stageElapsed >= 7) {
        mission.stageElapsed = 7;
        this._completeMission();
      }
      return;
    }

    if (!blade || !STAGE_ORDER.includes(mission.stage)) return;
    const stage = mission.stage;
    const duration = stageDuration(stage, blade.severity);
    const rate = this._stageRate(stage);
    const increment = (TICK_SECONDS / duration) * rate;
    blade.stages[stage] = clamp((blade.stages[stage] || 0) + increment, 0, 1);
    mission.stageElapsed += TICK_SECONDS * rate;

    if (blade.stages[stage] >= 1 || mission.stageElapsed >= duration) {
      blade.stages[stage] = 1;
      this._finishStage(stage);
    }
  }

  _stageRate(stage) {
    const contactQuality = clamp(1 - Math.max(0, this.platform.sway - LIMITS.contact) / 0.55, 0.12, 1);
    if (stage === "travel" || stage === "light") return 1;
    if (stage === "dry") {
      if (!this.env.dryOk) {
        if (this.t - this._lastDryWarning > 9) {
          this._lastDryWarning = this.t;
          this._log(
            "PROCESS",
            "固化条件不满足",
            `当前 ${this.env.temp.toFixed(1)}°C / ${this.env.humidity.toFixed(1)}%RH，固化进度暂停，等待温湿度进入工艺窗口。`,
            "warn",
          );
        }
        return 0;
      }
      return 1;
    }
    if (this.platform.sway > LIMITS.contact && this.t - this._lastContactWarning > 6) {
      this._lastContactWarning = this.t;
      this._log(
        "PLATFORM",
        "工具接触衰减",
        `摆幅 ${this.platform.sway.toFixed(2)} m 越过接触线，${STAGE_LABELS[stage]}效率降至 ${(contactQuality * 100).toFixed(0)}%。`,
        "warn",
      );
    }
    return contactQuality;
  }

  _finishStage(stage) {
    const mission = this.mission;
    const blade = this.blades[mission.bladeIndex];
    const currentIndex = stageIndex(stage);
    const nextStage = STAGE_ORDER[currentIndex + 1];

    if (stage === "sand") {
      this._log("TOOL", "打磨完成", `${blade.label} 表面粗化完成，粉尘回收正常，进入补涂。`, "info");
    } else if (stage === "coat") {
      this._log("TOOL", "补涂完成", `${blade.label} 涂层厚度达到目标区间，进入固化。`, "info");
    } else if (stage === "dry") {
      this._log("TOOL", "固化完成", `${blade.label} 涂层固化度与温湿度记录已归档。`, "success");
    } else if (stage === "light") {
      blade.repaired = true;
      mission.repairedCount += 1;
      this._log("MISSION", "叶片复位完成", `${blade.label} 灯光复位通过，累计完成 ${mission.repairedCount}/3 片叶片。`, "success");
      if (mission.repairedCount >= this.blades.length) {
        this._beginRecovery();
        return;
      }
      mission.bladeIndex += 1;
      mission.stage = "travel";
      mission.stageElapsed = 0;
      mission.stageStartedAt = this.t;
      this._log(
        "PLATFORM",
        "转场",
        `平台解除接触并移动到 B${mission.bladeIndex + 1}，风窗剩余 ${this.window.remaining.toFixed(1)} s。`,
        "info",
      );
      return;
    }

    if (!nextStage) return;
    mission.stage = nextStage;
    mission.stageElapsed = 0;
    mission.stageStartedAt = this.t;
    this._log(
      "MISSION",
      `${STAGE_LABELS[nextStage]}启动`,
      `${blade.label} · ${STAGE_LABELS[nextStage]}，仿真时刻 T+${this.t.toFixed(2)} s。`,
      "info",
    );
  }

  _beginRecovery() {
    this.mission.stage = "recover";
    this.mission.stageElapsed = 0;
    this.mission.stageStartedAt = this.t;
    this.platform.mode = "return";
    this._log("PLATFORM", "平台回收", "三片叶片修复完成，平台解除接触并返回安全回收位。", "info");
  }

  _completeMission() {
    if (this.terminal) return;
    this.mission.status = "complete";
    this.mission.completedAt = this.t;
    this.mission.stage = "complete";
    this.mission.stageElapsed = 7;
    this.terminal = true;
    this.terminalAt = this.t;
    this.outcome = "success";
    this.platform.mode = "docked";
    this.equipment.sander.active = false;
    this.equipment.lamp.active = false;
    this._log(
      "MISSION",
      "修复任务完成",
      `三处修复完成，平台安全回收。总用时 ${this.t.toFixed(1)} s，风窗余量 ${this.window.remaining.toFixed(1)} s。`,
      "success",
    );
    this._captureFrame(true);
  }

  _triggerFault(kind, title, cause, flags = {}) {
    if (this.currentFault() || this.faults.some((fault) => fault.kind === kind)) return;
    const blade = this.blades[this.mission.bladeIndex];
    const fault = {
      id: `F-${String(this.faults.length + 1).padStart(2, "0")}`,
      kind,
      code: kind === "INSTABILITY" ? "SAFE-ABORT" : kind === "EQUIPMENT" ? "EQ-OVERTEMP" : kind === "PARAMETER" ? "ENV-LIMIT" : "WIN-CLOSE",
      title,
      cause,
      time: round(this.t, 2),
      tick: this.tick,
      stage: this.mission.stage,
      blade: blade?.label || "--",
      status: "active",
      margin: this._captureMargins(),
      response: [],
      verification: {
        status: "pending",
        duration: VERIFY_SECONDS,
        startedAt: null,
        endedAt: null,
        samples: 0,
        violations: [],
        maxDelta: {},
      },
      recoveredAt: null,
    };

    this.faults.push(fault);
    this.currentFaultId = fault.id;
    this.equipment.sander.active = false;
    this.equipment.lamp.active = false;
    this.platform.mode = kind === "INSTABILITY" ? "retract" : "hold";

    if (kind === "INSTABILITY") {
      this.mission.status = "aborting";
      this._respond(fault, 0, "SAFETY", "执行平台失稳中止", "切断推进与打磨动力，平台进入被动稳定。", "error");
      this._respond(fault, 0.2, "TOOL", "工具回撤", "打磨头沿法向回撤 350 mm，消除叶片反作用力。", "warn");
      this._respond(fault, 0.9, "PLATFORM", "稳定器释放", "平台蓄能器与阻尼器接管，禁止复位推进。", "warn");
    } else if (kind === "EQUIPMENT") {
      this.mission.status = "fault_hold";
      this._respond(fault, 0, "SAFETY", "打磨机过温联锁", "主轴驱动断电，工具接触力归零。", "error");
      this._respond(fault, 0.25, "TOOL", "打磨头自动回撤", "回撤 350 mm 并锁定主轴。", "warn");
      this._respond(fault, 1.1, "PLATFORM", "动力定位保持", "平台保持安全距离，暂停转场。", "warn");
      this._respond(fault, 3.0, "TOOL", "切换备用打磨头", "备用头绝缘与空载转速检查通过。", "info");
      this._respond(fault, 5.4, "THERMAL", "热交换器全功率", "主轴温度开始向安全值收敛。", "info");
    } else if (kind === "PARAMETER") {
      this.mission.status = "fault_hold";
      this._respond(fault, 0, "SAFETY", "固化工艺联锁", "停止补涂与加热，冻结当前固化计时。", "error");
      this._respond(fault, 0.35, "TOOL", "喷涂阀关闭", "喷枪卸压，未固化涂料转入回收罐。", "warn");
      this._respond(fault, 1.0, "ENV", "除湿机组启动", "固化区隔离并启动 100% 除湿旁路。", "info");
      this._respond(fault, 2.8, "PROCESS", "温湿度复测", "等待相对湿度回到 82% 以下。", "info");
    } else {
      this.mission.status = "fault_hold";
      this._respond(fault, 0, "SAFETY", "风窗关闭", "任务禁止继续，平台进入应急回收。", "error");
    }

    this._log("SAFETY", title, `${cause} 故障时刻 T+${this.t.toFixed(2)} s，阶段 ${STAGE_LABELS[this.mission.stage]}。`, "error");
    this._captureFrame(true);
    return fault;
  }

  _respond(fault, offset, source, title, detail, level = "info") {
    if (!fault._plan) fault._plan = [];
    fault._plan.push({ offset, source, title, detail, level, done: false });
  }

  _updateRecovery() {
    const fault = this.currentFault();
    if (!fault || fault.kind === "WINDOW") return;

    const elapsed = this.t - fault.time;
    this._drainResponses(fault, elapsed);

    if (fault.verification.status === "running") return;
    if (fault.verification.status !== "pending") return;
    if (elapsed < 2.4) return;
    if (fault._plan && !fault._plan.every((item) => item.done)) return;

    if (!fault.stableAt && this._recoveryClear(fault)) {
      fault.stableAt = round(this.t, 2);
      this._log(
        "SAFETY",
        "安全状态确认",
        `${this._faultShortName(fault.kind)}响应已收敛，平台摆幅 ${this.platform.sway.toFixed(2)} m。`,
        "info",
      );
    }

    if (fault.stableAt && this._recoveryClear(fault)) {
      this._beginVerification(fault);
    }
  }

  _drainResponses(fault, elapsed) {
    if (!fault._plan) return;
    for (const item of fault._plan) {
      if (item.done || elapsed + 1e-6 < item.offset) continue;
      item.done = true;
      const entry = {
        at: round(this.t, 2),
        offset: item.offset,
        source: item.source,
        message: item.title,
        detail: item.detail,
        level: item.level,
      };
      fault.response.push(entry);
      this._log(item.source, item.title, item.detail, item.level);
    }
  }

  _recoveryClear(fault) {
    if (this.platform.sway >= 0.94) return false;
    if (fault.kind === "EQUIPMENT") return this.equipment.sander.temp <= 64;
    if (fault.kind === "PARAMETER") return this.env.humidity <= 80 && this.env.dryOk;
    if (fault.kind === "INSTABILITY") {
      return this.env.wind <= 14.8 && this.platform.sway <= 0.52;
    }
    return true;
  }

  _beginVerification(fault) {
    if (fault.verification.status !== "pending") return;
    const startedAt = round(this.t, 2);
    const endsAt = round(startedAt + VERIFY_SECONDS, 2);
    this.verification = {
      faultId: fault.id,
      startedAt,
      endsAt,
      duration: VERIFY_SECONDS,
      samples: 0,
      status: "running",
      violations: [],
      maxDelta: {
        sway: 0,
        wind: 0,
        humidity: 0,
        temp: 0,
        motor: 0,
      },
    };
    this._verifyPrev = this._verificationSample();
    fault.verification = {
      status: "running",
      duration: VERIFY_SECONDS,
      startedAt,
      endsAt,
      samples: 0,
      violations: [],
      maxDelta: clone(this.verification.maxDelta),
    };
    this.mission.status = "verifying";
    this._log(
      "VERIFY",
      "固定稳定观察启动",
      `系统将在 ${VERIFY_SECONDS.toFixed(1)} s 内持续检查状态跳变、联锁回弹与连锁故障。`,
      "info",
    );
  }

  _verificationSample() {
    return {
      t: this.t,
      stage: this.mission.stage,
      stageElapsed: this.mission.stageElapsed,
      status: this.mission.status,
      window: this.window.remaining,
      sway: this.platform.sway,
      wind: this.env.wind,
      humidity: this.env.humidity,
      temp: this.env.temp,
      motor: this.equipment.sander.temp,
    };
  }

  _sampleVerification() {
    const verification = this.verification;
    const fault = this.faults.find((item) => item.id === verification.faultId);
    if (!fault) return;
    const prev = this._verifyPrev;
    const now = this._verificationSample();
    const delta = {
      sway: Math.abs(now.sway - prev.sway),
      wind: Math.abs(now.wind - prev.wind),
      humidity: Math.abs(now.humidity - prev.humidity),
      temp: Math.abs(now.temp - prev.temp),
      motor: Math.abs(now.motor - prev.motor),
    };

    verification.samples += 1;
    for (const key of Object.keys(delta)) {
      verification.maxDelta[key] = round(Math.max(verification.maxDelta[key], delta[key]), 4);
    }

    const checks = [
      ["STATE_JUMP_SWAY", delta.sway > 0.22, `平台摆幅单步跳变 ${delta.sway.toFixed(3)} m`],
      ["STATE_JUMP_WIND", delta.wind > 2.2, `风速单步跳变 ${delta.wind.toFixed(3)} m/s`],
      ["STATE_JUMP_RH", delta.humidity > 2.4, `湿度单步跳变 ${delta.humidity.toFixed(3)} %RH`],
      ["STATE_JUMP_TEMP", delta.temp > 0.8, `环境温度单步跳变 ${delta.temp.toFixed(3)} °C`],
      ["STATE_JUMP_MOTOR", delta.motor > 1.2, `主轴温度单步跳变 ${delta.motor.toFixed(3)} °C`],
      ["STAGE_REGRESSION", now.stage !== prev.stage, "作业阶段在观察窗内发生跳变"],
      ["PROGRESS_CHANGED", Math.abs(now.stageElapsed - prev.stageElapsed) > 1e-6, "冻结的阶段进度发生漂移"],
      ["WINDOW_REVERSED", now.window > prev.window + 1e-6, "风窗余量发生回跳"],
      ["LIMIT_REBREACH_RH", now.humidity > LIMITS.humidity, "恢复观察期间湿度再次越过工艺上限"],
      ["LIMIT_REBREACH_WIND", now.wind > LIMITS.wind, "恢复观察期间风速再次越过作业上限"],
      ["LIMIT_REBREACH_SWAY", now.sway > LIMITS.sway, "恢复观察期间平台摆幅再次越过中止线"],
      ["LIMIT_REBREACH_MOTOR", now.motor > LIMITS.motorTemp, "恢复观察期间主轴温度再次越过保护线"],
    ];

    for (const [code, failed, message] of checks) {
      if (failed && !verification.violations.some((item) => item.code === code)) {
        verification.violations.push({ code, message, at: round(this.t, 2) });
      }
    }

    if (!Object.values(now).every((value) => typeof value === "string" || Number.isFinite(value))) {
      if (!verification.violations.some((item) => item.code === "NON_FINITE_STATE")) {
        verification.violations.push({ code: "NON_FINITE_STATE", message: "检测到非有限数值状态", at: round(this.t, 2) });
      }
    }

    fault.verification.samples = verification.samples;
    fault.verification.violations = clone(verification.violations);
    fault.verification.maxDelta = clone(verification.maxDelta);
    this._verifyPrev = now;

    if (this.t + 1e-6 >= verification.endsAt) {
      this._finishVerification(fault);
    }
  }

  _finishVerification(fault) {
    const verification = this.verification;
    const passed = verification.violations.length === 0;
    verification.status = passed ? "passed" : "failed";
    verification.endedAt = round(this.t, 2);
    fault.verification = {
      status: verification.status,
      duration: VERIFY_SECONDS,
      startedAt: verification.startedAt,
      endedAt: verification.endedAt,
      samples: verification.samples,
      violations: clone(verification.violations),
      maxDelta: clone(verification.maxDelta),
    };

    if (!passed) {
      this.mission.status = "failed";
      this.terminal = true;
      this.terminalAt = this.t;
      this.outcome = "verification_failure";
      fault.status = "verification_failed";
      this._log(
        "VERIFY",
        "稳定观察失败",
        `发现 ${verification.violations.length} 项状态异常，任务锁定为失败状态。`,
        "error",
      );
      this._captureFrame(true);
      return;
    }

    this._log(
      "VERIFY",
      "稳定观察通过",
      `${VERIFY_SECONDS.toFixed(1)} s / ${verification.samples} 个采样点，无连锁故障与状态跳变。`,
      "success",
    );

    if (fault.kind === "INSTABILITY") {
      fault.status = "aborted_safe";
      fault.recoveredAt = round(this.t, 2);
      this.mission.status = "aborted_safe";
      this.mission.stage = "aborted";
      this.platform.mode = "stowed";
      this.terminal = true;
      this.terminalAt = this.t;
      this.outcome = "safe_abort";
      this.currentFaultId = null;
      this._log(
        "MISSION",
        "平台安全回收",
        `失稳中止已执行，平台进入收纳位。剩余风窗 ${this.window.remaining.toFixed(1)} s。`,
        "warn",
      );
    } else {
      fault.status = "recovered";
      fault.recoveredAt = round(this.t, 2);
      this.mission.status = "running";
      this.mission.resumedAt = round(this.t, 2);
      this.currentFaultId = null;
      this._log(
        "MISSION",
        "作业恢复",
        `${this._faultShortName(fault.kind)}已排除，从${STAGE_LABELS[this.mission.stage]}阶段继续，风窗剩余 ${this.window.remaining.toFixed(1)} s。`,
        "success",
      );
    }
    this._captureFrame(true);
  }

  _updatePlatformMode() {
    const status = this.mission.status;
    const stage = this.mission.stage;
    if (status === "complete") {
      this.platform.mode = "docked";
    } else if (status === "aborted_safe") {
      this.platform.mode = "stowed";
    } else if (status === "aborting") {
      this.platform.mode = "retract";
    } else if (status === "fault_hold" || status === "verifying") {
      this.platform.mode = "hold";
    } else if (stage === "recover") {
      this.platform.mode = "return";
    } else if (stage === "travel") {
      this.platform.mode = "transit";
    } else {
      this.platform.mode = "contact";
    }
  }

  currentFault(kind) {
    if (!this.currentFaultId) return null;
    const fault = this.faults.find((item) => item.id === this.currentFaultId);
    if (!fault) return null;
    return kind ? (fault.kind === kind ? fault : null) : fault;
  }

  _faultShortName(kind) {
    return {
      EQUIPMENT: "打磨机过热",
      PARAMETER: "湿度越限",
      INSTABILITY: "平台失稳",
      WINDOW: "风窗关闭",
    }[kind] || kind;
  }

  _captureMargins() {
    return {
      windowSec: round(this.window.remaining, 1),
      swayM: round(LIMITS.sway - this.platform.sway, 2),
      contactM: round(LIMITS.contact - this.platform.sway, 2),
      windMs: round(LIMITS.wind - this.env.wind, 1),
      humidityRH: round(LIMITS.humidity - this.env.humidity, 1),
      tempC: round(Math.min(this.env.temp - LIMITS.tempMin, LIMITS.tempMax - this.env.temp), 1),
      motorC: round(LIMITS.motorTemp - this.equipment.sander.temp, 1),
    };
  }

  _log(source, title, message, level = "info") {
    this.logSequence += 1;
    const entry = {
      id: this.logSequence,
      t: round(this.t, 2),
      tick: this.tick,
      source,
      title,
      message,
      level,
    };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_ENTRIES);
    }
    return entry;
  }

  _captureFrame(force = false) {
    if (!force && this.tick % 4 !== 0) return;
    const previous = this.frames[this.frames.length - 1];
    if (previous && Math.abs(previous.t - this.t) < 1e-9) return;
    this.frames.push(clone(this._buildView(false)));
    if (this.frames.length > MAX_HISTORY_FRAMES) this.frames.shift();
  }

  getFaultReplay(faultId = this.faults[0]?.id, preSeconds = 8) {
    const fault = this.faults.find((item) => item.id === faultId);
    if (!fault) return [];
    const start = Math.max(0, fault.time - preSeconds);
    const frames = this.frames.filter((frame) => frame.t >= start - 1e-6 && frame.t <= fault.time + 0.11);
    if (!frames.length) return [];
    const result = frames.map((frame) => clone(frame));
    const last = result[result.length - 1];
    last.replay = {
      faultId: fault.id,
      faultTime: fault.time,
      offset: round(last.t - fault.time, 2),
      atFault: last.t >= fault.time - 1e-6,
    };
    return result;
  }

  getView(includeLogs = true) {
    const blade = this.blades[this.mission.bladeIndex];
    const currentFault = this.currentFault();
    const latestFault = this.faults[this.faults.length - 1] || null;
    const fault = currentFault || latestFault;
    const active = !this.terminal && ["running", "fault_hold", "verifying", "aborting"].includes(this.mission.status);
    return {
      scenario: {
        id: this.scenario.id,
        code: this.scenario.code,
        name: this.scenario.name,
        description: this.scenario.description,
        seed: this.scenario.seed,
      },
      t: round(this.t, 2),
      tick: this.tick,
      running: this.running,
      speed: this.speed,
      terminal: this.terminal,
      outcome: this.outcome,
      clock: {
        state: this.running ? "running" : "paused",
        tickSeconds: TICK_SECONDS,
        pauseReason: this.pauseReason,
      },
      mission: {
        status: this.mission.status,
        statusLabel: STATUS_LABELS[this.mission.status] || this.mission.status,
        stage: this.mission.stage,
        stageLabel: STAGE_LABELS[this.mission.stage] || this.mission.stage,
        stageElapsed: round(this.mission.stageElapsed, 2),
        stageProgress:
          this.mission.stage === "recover"
            ? round(clamp(this.mission.stageElapsed / 7, 0, 1), 4)
            : round(clamp(this.blades[this.mission.bladeIndex]?.stages[this.mission.stage] || 0, 0, 1), 4),
        bladeIndex: this.mission.bladeIndex,
        activeBlade: blade?.label || "--",
        repairedCount: this.mission.repairedCount,
        resumedAt: this.mission.resumedAt,
        completedAt: this.mission.completedAt,
      },
      window: {
        duration: this.window.duration,
        remaining: this.window.remaining,
        ratio: round(this.window.remaining / this.window.duration, 4),
        state: this.window.state,
        open: !this.window.closed,
      },
      env: {
        wind: this.env.wind,
        windLimit: LIMITS.wind,
        gust: round(this.env.gust, 2),
        temp: this.env.temp,
        humidity: this.env.humidity,
        humidityLimit: LIMITS.humidity,
        tempMin: LIMITS.tempMin,
        tempMax: LIMITS.tempMax,
        dryOk: this.env.dryOk,
      },
      platform: {
        sway: this.platform.sway,
        swayLimit: LIMITS.sway,
        contactMargin: round(LIMITS.contact - this.platform.sway, 3),
        contactQuality: round(clamp(1 - Math.max(0, this.platform.sway - LIMITS.contact) / 0.55, 0, 1), 3),
        mode: this.platform.mode,
        gap: round(this.platform.gap, 3),
      },
      equipment: {
        sander: {
          active: this.equipment.sander.active,
          temp: this.equipment.sander.temp,
          tempLimit: LIMITS.motorTemp,
          state: this.equipment.sander.state,
        },
        lamp: {
          active: this.equipment.lamp.active,
          state: this.equipment.lamp.state,
          voltage: this.equipment.lamp.voltage,
        },
      },
      blades: this.blades.map((item) => {
        const progress = item.repaired
          ? 1
          : Object.entries(STAGE_WEIGHTS).reduce(
              (sum, [key, weight]) => sum + (item.stages[key] || 0) * weight,
              0,
            );
        return {
          id: item.id,
          label: item.label,
          severity: item.severity,
          damage: item.damage,
          repaired: item.repaired,
          progress: round(progress, 4),
          percent: item.repaired ? 100 : Math.round(progress * 100),
          stages: clone(item.stages),
          active: active && this.mission.bladeIndex === item.id - 1 && this.mission.stage !== "recover",
          currentStage: this.mission.bladeIndex === item.id - 1 ? this.mission.stage : null,
          status: item.repaired ? "repaired" : this.mission.bladeIndex === item.id - 1 ? "active" : "pending",
        };
      }),
      fault: fault ? this._serializeFault(fault, currentFault?.id === fault.id) : null,
      currentFaultId: this.currentFaultId,
      faults: this.faults.map((item) => this._serializeFault(item, currentFault?.id === item.id)),
      verification: this.verification
        ? {
            ...clone(this.verification),
            remaining: round(Math.max(0, this.verification.endsAt - this.t), 2),
          }
        : null,
      instabilityAbortUsed: this.instabilityAbortUsed,
      logs: includeLogs ? clone(this.logs) : [],
      eventCount: this.logSequence,
      historyFrames: this.frames.length,
    };
  }

  _serializeFault(fault, active) {
    return {
      id: fault.id,
      kind: fault.kind,
      code: fault.code,
      title: fault.title,
      cause: fault.cause,
      time: fault.time,
      tick: fault.tick,
      stage: fault.stage,
      stageLabel: STAGE_LABELS[fault.stage] || fault.stage,
      blade: fault.blade,
      status: active ? "active" : fault.status,
      active,
      stableAt: fault.stableAt || null,
      recoveredAt: fault.recoveredAt,
      margin: clone(fault.margin),
      response: clone(fault.response),
      verification: clone(fault.verification),
    };
  }

  _buildView(includeLogs) {
    return this.getView(includeLogs);
  }
}

export function runScenario(scenarioId, maxTicks = 4000) {
  const sim = new Simulation(scenarioId);
  let ticks = 0;
  while (!sim.terminal && ticks < maxTicks) {
    sim._tick();
    ticks += 1;
  }
  return { sim, ticks, view: sim.getView() };
}

export function createSimulation(scenarioId) {
  return new Simulation(scenarioId);
}
