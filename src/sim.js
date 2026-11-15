export const TICK_MINUTES = 1;
export const CYCLE_MINUTES = 720;
export const BASIN_AREA_M2 = 1150000;
export const TURBINE_COUNT = 3;
export const TURBINE_CAPACITY_M3S = 210;
export const GATE_CAPACITY_M3S = 850;
export const GENERATION_TARGET_MWH = 12;
export const GATE_HEAD_LIMIT_M = 1.65;
export const GATE_HEAD_WARN_M = 1.42;
export const BEARING_LIMIT_C = 104;
export const BEARING_WARN_C = 94;
export const AUDIT_MINUTES = 120;
export const REVERSE_MINUTES = 20;

export const STRATEGIES = {
  balanced: {
    key: "balanced",
    name: "稳航协同",
    short: "先守住通航与闸门余量，再争取电量",
    color: "#59d9c5",
    navLead: 34,
    navHold: 0,
    reverseLead: 24,
    spillAtHead: 2.15,
    gateCap: 0.92,
    bearingTarget: 83,
  },
  power: {
    key: "power",
    name: "电量冲刺",
    short: "压榨高水头时段，通航请求延后响应",
    color: "#ffbd59",
    navLead: 0,
    navHold: 17,
    reverseLead: 9,
    spillAtHead: 1.84,
    gateCap: 0.86,
    bearingTarget: 88,
  },
};

export const SCENARIOS = {
  normal: {
    key: "normal",
    name: "正常流程",
    description: "无预设故障，验证完整潮周期。",
    bearingFaultTick: null,
    pressureProbeTick: null,
  },
  bearing: {
    key: "bearing",
    name: "设备故障",
    description: "2号机组冷却回路失效，轴承温度持续上升。",
    bearingFaultTick: 294,
    pressureProbeTick: null,
  },
  pressure: {
    key: "pressure",
    name: "参数越限",
    description: "调度器在高压差下请求开闸，触发结构联锁。",
    bearingFaultTick: null,
    pressureProbeTick: 18,
  },
};

export const NAV_WINDOWS = [
  { id: "NAV-1", name: "首班通航", requestTick: 186, deadlineTick: 222 },
  { id: "NAV-2", name: "返程通航", requestTick: 450, deadlineTick: 486 },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 2) => Number(value.toFixed(digits));

export function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function clockLabel(tick) {
  const total = 6 * 60 + tick;
  const hours = Math.floor(total / 60) % 24;
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function tideAt(tick) {
  const angle = (Math.PI * 2 * tick) / CYCLE_MINUTES - Math.PI / 2;
  return {
    seaLevel: 3.7 + 2.15 * Math.sin(angle),
    trend: Math.cos(angle),
  };
}

export function formatMargin(value, unit = "") {
  const sign = value > 0 ? "+" : "";
  return `${sign}${round(value, 2)}${unit}`;
}

export class TidalSimulation {
  constructor({
    scenarioKey = "normal",
    strategyKey = "balanced",
    seed = 605,
    commandTrack = [],
    auto = true,
  } = {}) {
    if (!SCENARIOS[scenarioKey]) throw new Error(`Unknown scenario: ${scenarioKey}`);
    if (!STRATEGIES[strategyKey]) throw new Error(`Unknown strategy: ${strategyKey}`);

    this.scenarioKey = scenarioKey;
    this.strategyKey = strategyKey;
    this.strategy = STRATEGIES[strategyKey];
    this.scenario = SCENARIOS[scenarioKey];
    this.seed = seed;
    this.random = mulberry32(seed);
    this.commandTrack = commandTrack.map((command) => ({ ...command }));
    this.appliedCommands = new Set();
    this.auto = auto;
    this.tick = 0;
    this.ended = false;
    this.sequence = 0;
    this.log = [];
    this.history = [];
    this.incidents = [];
    this.stateHash = "00000000";
    this.lastAppliedCommand = -1;
    this.manual = {
      gateOpening: null,
      gateHoldUntil: 0,
      emergencyStop: false,
      navPriorityUntil: 0,
      maintenanceUntil: 0,
    };
    this.audit = {
      active: false,
      startTick: null,
      elapsed: 0,
      required: AUDIT_MINUTES,
      violations: [],
      passed: false,
      finished: false,
    };
    this.navWindows = NAV_WINDOWS.map((window) => ({
      ...window,
      status: "scheduled",
      startedTick: null,
      completedTick: null,
      onTime: null,
    }));
    this.lock = {
      phase: "idle",
      phaseTick: 0,
      phaseLeft: 0,
      activeWindow: null,
      transitProgress: 0,
      waitingForHead: false,
    };

    const tide = tideAt(0);
    this.state = {
      tick: 0,
      clock: clockLabel(0),
      seaLevel: round(tide.seaLevel, 3),
      basinLevel: 4.08,
      head: round(tide.seaLevel - 4.08, 3),
      tidePhase: tide.trend >= 0 ? "涨潮" : "落潮",
      tideTrend: tide.trend,
      flow: {
        turbine: 0,
        gate: 0,
        total: 0,
      },
      powerMW: 0,
      energyMWh: 0,
      targetMWh: GENERATION_TARGET_MWH,
      turbine: {
        direction: "ebb",
        targetDirection: "ebb",
        status: "running",
        reverseLeft: 0,
        reverseProgress: 0,
        speed: 0.62,
        lastReverseTick: -120,
      },
      units: Array.from({ length: TURBINE_COUNT }, (_, index) => ({
        id: index + 1,
        status: index === 0 ? "maintenance" : "online",
        load: 0,
        bearingTemp: 62 + index * 1.5,
        tripReason: null,
      })),
      gate: {
        opening: 0,
        command: 0,
        pressure: round(Math.abs(tide.seaLevel - 4.08), 3),
        limit: GATE_HEAD_LIMIT_M,
        margin: round(GATE_HEAD_LIMIT_M - Math.abs(tide.seaLevel - 4.08), 2),
        damage: 0,
        interlocked: false,
        reason: "待命",
      },
      lock: {
        phase: "idle",
        activeWindow: null,
        waitingForHead: false,
        transitProgress: 0,
      },
      safety: {
        status: "normal",
        openIncident: null,
        unresolved: 0,
        maxBearing: 63.5,
        gateMargin: round(GATE_HEAD_LIMIT_M - Math.abs(tide.seaLevel - 4.08), 2),
      },
      counts: {
        onTimeNav: 0,
        delayedNav: 0,
        completedNav: 0,
        reversals: 0,
        incidents: 0,
      },
      scenario: {
        key: scenarioKey,
        bearingFaultActive: false,
        pressureProbeFired: false,
      },
      audit: {
        active: false,
        elapsed: 0,
        required: AUDIT_MINUTES,
        passed: false,
      },
    };
    this.history.push(this.historyPoint());
    this.initialUnits = this.state.units.map((unit) => ({ ...unit }));
    this.logEvent("system", "仿真就绪", `${this.strategy.name} · ${this.scenario.name} · 种子 ${seed}`);
    this.updateChecksum();
  }

  logEvent(kind, title, detail = "", severity = "info", data = {}) {
    this.sequence += 1;
    const entry = {
      seq: this.sequence,
      tick: this.tick,
      clock: clockLabel(this.tick),
      kind,
      title,
      detail,
      severity,
      data,
      hash: this.stateHash,
    };
    this.log.push(entry);
    return entry;
  }

  snapshotCore() {
    const { turbine: unit, gate, lock, safety } = this.state;
    return {
      tick: this.tick,
      sea: round(this.state.seaLevel, 4),
      basin: round(this.state.basinLevel, 4),
      head: round(this.state.head, 4),
      flow: [round(this.state.flow.turbine, 3), round(this.state.flow.gate, 3)],
      power: round(this.state.powerMW, 4),
      energy: round(this.state.energyMWh, 4),
      direction: unit.direction,
      targetDirection: unit.targetDirection,
      turbineStatus: unit.status,
      reverseLeft: unit.reverseLeft,
      gateOpening: round(gate.opening, 4),
      gateDamage: round(gate.damage, 4),
      gateInterlocked: gate.interlocked,
      lockPhase: lock.phase,
      lockWindow: lock.activeWindow,
      safety: safety.status,
      unitStates: this.state.units.map((item) => [
        item.id,
        item.status,
        round(item.bearingTemp, 3),
      ]),
    };
  }

  updateChecksum() {
    this.stateHash = hashString(JSON.stringify(this.snapshotCore()));
    this.state.tick = this.tick;
    this.state.clock = clockLabel(this.tick);
    return this.stateHash;
  }

  historyPoint() {
    return {
      tick: this.tick,
      clock: clockLabel(this.tick),
      sea: round(this.state.seaLevel, 3),
      basin: round(this.state.basinLevel, 3),
      head: round(this.state.head, 3),
      power: round(this.state.powerMW, 3),
      flow: round(this.state.flow.total, 1),
      gate: round(this.state.gate.opening, 3),
      energy: round(this.state.energyMWh, 3),
    };
  }

  queueCommand(type, payload = {}) {
    const command = {
      id: `cmd-${this.commandTrack.length + 1}`,
      tick: this.tick,
      type,
      payload,
    };
    this.commandTrack.push(command);
    return command;
  }

  applyCommand(type, payload = {}, source = "manual") {
    if (type === "gate") {
      const opening = clamp(Number(payload.opening) || 0, 0, 1);
      this.manual.gateOpening = opening;
      this.manual.gateHoldUntil = this.tick + 24;
      this.logEvent(
        "operation",
        "人工设定泄水闸",
        `目标开度 ${Math.round(opening * 100)}%，保持 24 分钟`,
        "action",
        { opening },
      );
    } else if (type === "emergency-stop") {
      this.manual.emergencyStop = true;
      this.manual.maintenanceUntil = this.tick + 15;
      this.stopTurbines("人工紧急停机", "warning");
      this.setGateTarget(0, "紧急停机联锁");
    } else if (type === "nav-priority") {
      this.manual.navPriorityUntil = this.tick + 60;
      this.stopTurbines("人工通航优先", "info");
      this.logEvent("operation", "通航优先接管", "涡轮停机，泄水闸进入均压模式", "action");
    } else if (type === "auto") {
      this.manual.gateOpening = null;
      this.manual.emergencyStop = false;
      this.manual.navPriorityUntil = 0;
      this.manual.maintenanceUntil = 0;
      this.logEvent("operation", "恢复自动调度", "解除人工保持并交回策略控制器", "action");
    }
    this.updateChecksum();
    if (source === "manual") this.queueCommand(type, payload);
  }

  applyScheduledCommands() {
    for (const command of this.commandTrack) {
      const key = command.id ?? `${command.tick}-${command.type}-${JSON.stringify(command.payload)}`;
      if (command.tick !== this.tick || this.appliedCommands.has(key)) continue;
      this.appliedCommands.add(key);
      this.lastAppliedCommand = this.tick;
      this.applyCommand(command.type, command.payload, "replay");
    }
  }

  setGateTarget(opening, reason) {
    this.state.gate.command = clamp(opening, 0, 1);
    this.state.gate.reason = reason;
  }

  stopTurbines(reason, severity = "info") {
    const turbine = this.state.turbine;
    if (turbine.status === "running") {
      this.logEvent("equipment", "涡轮停机", reason, severity);
    }
    turbine.status = "stopped";
    turbine.targetDirection = turbine.direction;
    turbine.speed = 0;
    turbine.reverseLeft = 0;
    turbine.reverseProgress = 0;
    for (const unit of this.state.units) {
      unit.load = 0;
    }
  }

  requestDirection(direction, reason = "自动换向") {
    const turbine = this.state.turbine;
    if (!direction || turbine.targetDirection === direction) return false;
    if (turbine.status === "fault" || this.state.gate.interlocked) return false;
    if (this.tick - turbine.lastReverseTick < 16) return false;
    turbine.targetDirection = direction;
    turbine.status = "reversing";
    turbine.reverseLeft = REVERSE_MINUTES;
    turbine.reverseProgress = 0;
    turbine.speed = 0;
    turbine.lastReverseTick = this.tick;
    for (const unit of this.state.units) unit.load = 0;
    this.state.counts.reversals += 1;
    this.logEvent(
      "equipment",
      "涡轮换向开始",
      `${direction === "flood" ? "涨潮侧" : "落潮侧"}指向，需 ${REVERSE_MINUTES} 分钟；${reason}`,
      "action",
      { direction, minutes: REVERSE_MINUTES },
    );
    return true;
  }

  nextNavigationWindow() {
    return this.navWindows.find((window) => window.status === "scheduled")
      ?? this.navWindows.find((window) => window.status === "active")
      ?? null;
  }

  desiredDirection() {
    const lead = this.strategy.reverseLead;
    const forecastSea = tideAt(this.tick + lead).seaLevel;
    const gap = forecastSea - this.state.basinLevel;
    if (gap > 0.18) return "flood";
    if (gap < -0.18) return "ebb";
    return this.state.turbine.direction;
  }

  beginNavigation(window) {
    if (window.status !== "scheduled") return;
    window.status = "active";
    window.startedTick = this.tick;
    this.lock.activeWindow = window.id;
    this.lock.phase = "approach";
    this.lock.phaseLeft = 2;
    this.lock.phaseTick = this.tick;
    this.lock.waitingForHead = true;
    this.lock.transitProgress = 0;
    this.stopTurbines(`${window.name}请求接管`, "info");
    this.logEvent(
      "navigation",
      `${window.name}进入排队`,
      `截止 ${clockLabel(window.deadlineTick)}，船闸等待压差 ≤ 0.90 m`,
      "action",
      { window: window.id, deadline: window.deadlineTick },
    );
  }

  autoDispatch() {
    const turbine = this.state.turbine;
    const head = this.state.seaLevel - this.state.basinLevel;
    const absHead = Math.abs(head);
    const inMaintenance =
      this.tick < this.manual.maintenanceUntil ||
      this.state.units.some((unit) => unit.status === "fault");
    const navPriority = this.tick < this.manual.navPriorityUntil;
    const upcoming = this.nextNavigationWindow();

    let navTarget = false;
    if (upcoming && upcoming.status === "active") {
      navTarget = true;
    } else if (upcoming && upcoming.status === "scheduled") {
      const lead = this.strategy.navLead;
      const holdUntil = upcoming.requestTick + this.strategy.navHold;
      if (this.tick >= upcoming.requestTick - lead && this.tick < holdUntil) {
        navTarget = true;
      }
      if (
        this.tick >= upcoming.requestTick &&
        this.tick < holdUntil &&
        !upcoming.holdLogged
      ) {
        upcoming.holdLogged = true;
        this.logEvent(
          "navigation",
          `${upcoming.name}请求被延后`,
          `电量策略继续运行 ${this.strategy.navHold} 分钟，截止 ${clockLabel(upcoming.deadlineTick)}`,
          "warning",
          { window: upcoming.id, holdMinutes: this.strategy.navHold },
        );
      }
      if (this.tick >= holdUntil) {
        this.beginNavigation(upcoming);
        navTarget = true;
      }
    }

    if (navTarget || navPriority || inMaintenance || this.manual.emergencyStop) {
      if (turbine.status === "reversing") {
        turbine.reverseLeft = Math.max(0, turbine.reverseLeft);
      } else if (turbine.status !== "fault") {
        this.stopTurbines(
          inMaintenance
            ? "检修/故障联锁保持停机"
            : navTarget
              ? "通航均压窗口"
              : "人工保持停机",
          "info",
        );
      }
    }

    if (this.lock.phase !== "idle" && this.lock.phase !== "done") {
      this.stopTurbines("船闸作业期间涡轮隔离", "info");
    }

    let gateTarget = 0;
    let gateReason = "自动保持关闭";
    const lockIsEqualizing = !["idle", "approach"].includes(this.lock.phase);
    const navNeedsWater =
      !lockIsEqualizing && (navTarget || navPriority || this.lock.waitingForHead);
    if (navNeedsWater && absHead > 0.72) {
      if (absHead <= GATE_HEAD_LIMIT_M - 0.04) {
        gateTarget = clamp(0.52 + absHead * 0.22, 0.42, this.strategy.gateCap);
        gateReason = "船闸均压";
      } else {
        gateTarget = 0;
        gateReason = "压差超限，禁止开闸";
      }
    } else if (!navNeedsWater && absHead > this.strategy.spillAtHead) {
      if (absHead <= GATE_HEAD_WARN_M) {
        gateTarget = Math.min(this.strategy.gateCap, 0.18);
        gateReason = "高水头泄压";
      } else {
        gateTarget = 0;
        gateReason = "压差告警，闸门闭锁";
      }
    }
    if (this.manual.gateOpening !== null && this.tick < this.manual.gateHoldUntil) {
      gateTarget = this.manual.gateOpening;
      gateReason = "人工开度保持";
    }
    if (this.state.gate.interlocked) {
      gateTarget = 0;
      gateReason = "结构联锁";
    }
    this.setGateTarget(gateTarget, gateReason);

    if (
      !navTarget &&
      !navPriority &&
      !inMaintenance &&
      !this.manual.emergencyStop &&
      this.lock.phase === "idle"
    ) {
      const desired = this.desiredDirection();
      if (turbine.status === "stopped") {
        if (desired === turbine.direction) {
          turbine.status = "running";
          this.logEvent("equipment", "涡轮并网", `${desired === "flood" ? "涨潮" : "落潮"}向恢复发电`);
        } else {
          this.requestDirection(desired, "自动潮向预测");
        }
      } else if (
        turbine.status === "running" &&
        desired !== turbine.targetDirection
      ) {
        this.requestDirection(desired, "自动潮向预测");
      }
    }
  }

  updateNavigation() {
    const lock = this.lock;
    for (const window of this.navWindows) {
      if (
        window.status !== "scheduled" &&
        window.status !== "active" &&
        window.status !== "completed"
      ) continue;
      if (
        window.status !== "completed" &&
        this.tick > window.deadlineTick &&
        !window.delayed
      ) {
        window.delayed = true;
        window.status = window.status === "scheduled" ? "missed" : "active";
        this.state.counts.delayedNav += 1;
        this.logEvent(
          "navigation",
          `${window.name}超时`,
          `当前 ${clockLabel(this.tick)}，已超过截止 ${clockLabel(window.deadlineTick)}`,
          "danger",
          { window: window.id },
        );
      }
    }

    if (lock.phase === "idle" || lock.phase === "done") return;
    const window = this.navWindows.find((item) => item.id === lock.activeWindow);
    if (!window) {
      lock.phase = "idle";
      return;
    }
    const head = Math.abs(this.state.seaLevel - this.state.basinLevel);

    if (lock.phase === "approach") {
      if (head <= 0.9) {
        lock.phase = "equalize";
        lock.phaseLeft = 7;
        lock.waitingForHead = false;
        this.logEvent(
          "navigation",
          "船闸开始均压",
          `压差 ${head.toFixed(2)} m，均压 7 分钟后开闸`,
          "success",
        );
      } else {
        lock.waitingForHead = true;
      }
      return;
    }

    lock.phaseLeft -= 1;
    if (lock.phase === "equalize") {
      if (lock.phaseLeft <= 0) {
        lock.phase = "transit";
        lock.phaseLeft = 12;
        this.logEvent("navigation", "船闸开启", `${window.name}船舶开始进闸`, "action");
      }
    } else if (lock.phase === "transit") {
      lock.transitProgress = 1 - lock.phaseLeft / 12;
      if (lock.phaseLeft <= 0) {
        lock.phase = "exit";
        lock.phaseLeft = 4;
        lock.transitProgress = 1;
        this.logEvent("navigation", "船舶过闸完成", `${window.name}正在关闭闸室`, "success");
      }
    } else if (lock.phase === "exit" && lock.phaseLeft <= 0) {
      const onTime = this.tick <= window.deadlineTick;
      window.completedTick = this.tick;
      window.onTime = onTime && !window.delayed;
      window.status = window.delayed || !onTime ? "delayed" : "completed";
      this.state.counts.completedNav += 1;
      if (window.onTime) {
        this.state.counts.onTimeNav += 1;
      } else {
        if (!window.delayed) this.state.counts.delayedNav += 1;
        window.delayed = true;
      }
      this.logEvent(
        "navigation",
        `${window.name}${window.onTime ? "准点完成" : "延误完成"}`,
        `完成 ${clockLabel(this.tick)} · 截止 ${clockLabel(window.deadlineTick)}`,
        window.onTime ? "success" : "danger",
        { window: window.id, onTime: window.onTime },
      );
      lock.phase = "idle";
      lock.phaseLeft = 0;
      lock.activeWindow = null;
      lock.transitProgress = 0;
    }
  }

  triggerPressureIncident(pressure, requestedOpening) {
    const gate = this.state.gate;
    const margin = round(GATE_HEAD_LIMIT_M - pressure, 2);
    gate.opening = 0;
    gate.command = 0;
    gate.interlocked = true;
    gate.reason = "压差越限联锁";
    this.state.counts.incidents += 1;
    this.state.safety.status = "fault";
    this.state.safety.unresolved += 1;
    this.state.safety.openIncident = `pressure-${this.incidents.length + 1}`;
    this.manual.gateOpening = null;
    this.manual.gateHoldUntil = 0;
    const incident = {
      id: `INC-${this.incidents.length + 1}`,
      type: "pressure",
      title: "泄水闸压差越限拦截",
      tick: this.tick,
      clock: clockLabel(this.tick),
      parameter: "闸门压差",
      value: round(pressure, 2),
      limit: GATE_HEAD_LIMIT_M,
      unit: "m",
      margin,
      thresholdText: `压差 ≤ ${GATE_HEAD_LIMIT_M.toFixed(2)} m（请求开度 ${Math.round(requestedOpening * 100)}%）`,
      response: "操作票拒绝，闸门在 1 个控制拍内闭锁到 0%；结构损伤未增加，持续泄压与检修确认。",
      stateHash: this.stateHash,
      resolvedTick: null,
      resolved: false,
      auditPassed: null,
    };
    this.incidents.push(incident);
    this.logEvent(
      "safety",
      incident.title,
      `${incident.parameter} ${incident.value} m，余量 ${formatMargin(margin, " m")}；闸门闭锁`,
      "danger",
      { incident: incident.id, margin },
    );
  }

  recoverIncident() {
    const incident = [...this.incidents]
      .reverse()
      .find((item) => !item.resolved);
    if (!incident) return null;
    if (incident.type === "equipment") {
      const unit = this.state.units.find((item) => item.id === 2);
      unit.status = "online";
      unit.tripReason = null;
      unit.bearingTemp = 66;
      unit.load = 0;
      this.state.turbine.status = "stopped";
      this.state.turbine.targetDirection = this.state.turbine.direction;
      this.state.turbine.speed = 0;
      this.state.scenario.bearingFaultActive = false;
    } else if (incident.type === "pressure") {
      this.state.gate.interlocked = false;
      this.state.gate.opening = 0;
      this.state.gate.command = 0;
      this.state.gate.reason = "越限复位，检修确认";
    }
    incident.resolved = true;
    incident.resolvedTick = this.tick;
    this.state.safety.unresolved = Math.max(0, this.state.safety.unresolved - 1);
    this.state.safety.openIncident =
      this.incidents.some((item) => !item.resolved) ? this.state.safety.openIncident : null;
    this.state.safety.status = this.state.safety.unresolved > 0 ? "fault" : "recovering";
    this.manual.emergencyStop = false;
    this.manual.maintenanceUntil = this.tick + 18;
    this.setGateTarget(0, "恢复后隔离观察");
    this.audit = {
      active: true,
      startTick: this.tick,
      elapsed: 0,
      required: AUDIT_MINUTES,
      violations: [],
      passed: false,
      finished: false,
    };
    this.logEvent(
      "recovery",
      "事故复位，进入长稳校验",
      `从 ${clockLabel(this.tick)} 起固定运行 ${AUDIT_MINUTES} 分钟，逐步放开负荷`,
      "success",
      { incident: incident.id, auditMinutes: AUDIT_MINUTES },
    );
    this.updateChecksum();
    return incident;
  }

  auditTick(previous) {
    if (!this.audit.active) return;
    this.audit.elapsed += 1;
    this.state.audit.elapsed = this.audit.elapsed;
    const checks = [
      ["海位有限", Number.isFinite(this.state.seaLevel)],
      ["库位有限", Number.isFinite(this.state.basinLevel)],
      ["水位跃变", Math.abs(this.state.basinLevel - previous.basinLevel) <= 0.16],
      ["水头跃变", Math.abs(this.state.head - previous.head) <= 0.2],
      ["闸门跃变", Math.abs(this.state.gate.opening - previous.gateOpening) <= 0.2],
      ["功率有限", Number.isFinite(this.state.powerMW) && this.state.powerMW <= 10.2],
      ["无新增事故", this.state.counts.incidents === previous.incidents],
      [
        "闸门未越限开闸",
        this.state.gate.opening <= 0.005 ||
          this.state.gate.pressure <= GATE_HEAD_LIMIT_M + 0.04,
      ],
      ["轴承余量", this.state.safety.maxBearing <= BEARING_LIMIT_C + 0.2],
    ];
    for (const [name, passed] of checks) {
      if (!passed) {
        this.audit.violations.push({
          tick: this.tick,
          clock: clockLabel(this.tick),
          name,
        });
      }
    }
    if (this.audit.elapsed >= this.audit.required) {
      this.audit.active = false;
      this.audit.finished = true;
      this.audit.passed = this.audit.violations.length === 0;
      this.state.audit.active = false;
      this.state.audit.passed = this.audit.passed;
      this.state.safety.status = this.audit.passed ? "normal" : "fault";
      for (const incident of this.incidents) {
        if (incident.resolved && incident.auditPassed === null) {
          incident.auditPassed = this.audit.passed;
        }
      }
      this.logEvent(
        "recovery",
        this.audit.passed ? "长稳校验通过" : "长稳校验发现异常",
        this.audit.passed
          ? `${AUDIT_MINUTES} 分钟内无连锁故障、无数值跳变，设备状态已稳定`
          : `发现 ${this.audit.violations.length} 项校验异常`,
        this.audit.passed ? "success" : "danger",
        { violations: this.audit.violations.length },
      );
    }
  }

  step() {
    if (this.ended) return this.state;
    this.applyScheduledCommands();
    this.injectScenarioEvents();
    this.autoDispatch();

    const previous = {
      basinLevel: this.state.basinLevel,
      head: this.state.head,
      gateOpening: this.state.gate.opening,
      incidents: this.state.counts.incidents,
    };

    this.validateGate(this.state.seaLevel - this.state.basinLevel);
    this.updateGateOpening();
    this.updateReverse();
    this.updateHydraulics();
    this.updateBearingTemperatures();
    this.updateNavigation();
    this.auditTick(previous);

    this.tick += 1;
    if (this.tick === 41) {
      const unit = this.state.units[0];
      if (unit.status === "maintenance" && this.state.turbine.status !== "fault") {
        unit.status = "online";
        this.logEvent("equipment", "1号机组检修完成", "三台机组恢复可用容量", "success");
      }
    }
    this.state.safety.status = this.state.safety.unresolved > 0
      ? "fault"
      : this.audit.active
        ? "recovering"
        : this.state.safety.status === "fault"
          ? "recovering"
          : "normal";
    this.updateChecksum();
    this.history.push(this.historyPoint());
    if (this.tick >= CYCLE_MINUTES) this.finalize();
    return this.state;
  }

  runTo(targetTick) {
    const target = clamp(targetTick, this.tick, CYCLE_MINUTES);
    while (!this.ended && this.tick < target) this.step();
    return this.state;
  }

  complete() {
    return this.runTo(CYCLE_MINUTES);
  }

  finalize() {
    this.ended = true;
    for (const window of this.navWindows) {
      if (!["completed", "delayed"].includes(window.status)) {
        if (!window.delayed) this.state.counts.delayedNav += 1;
        window.status = "missed";
        window.delayed = true;
        this.logEvent(
          "navigation",
          `${window.name}未完成`,
          `${clockLabel(CYCLE_MINUTES)} 周期结束，窗口已关闭`,
          "danger",
        );
      }
    }
    const unresolved = this.incidents.some((incident) => !incident.resolved);
    const auditFailed = this.incidents.length > 0 && (
      !this.audit.finished || !this.audit.passed || this.audit.violations.length > 0
    );
    const equipmentSafe =
      !unresolved &&
      !auditFailed &&
      this.state.gate.damage < 2 &&
      !this.state.gate.interlocked;
    const energyPassed = this.state.energyMWh >= GENERATION_TARGET_MWH;
    const navigationPassed = this.state.counts.onTimeNav === NAV_WINDOWS.length;
    this.result = {
      tick: this.tick,
      clock: clockLabel(this.tick),
      success: equipmentSafe && energyPassed && navigationPassed,
      equipmentSafe,
      energyPassed,
      navigationPassed,
      energyMWh: round(this.state.energyMWh, 2),
      targetMWh: GENERATION_TARGET_MWH,
      onTimeNav: this.state.counts.onTimeNav,
      delayedNav: this.state.counts.delayedNav,
      incidents: this.state.counts.incidents,
      unresolvedIncidents: this.incidents.filter((incident) => !incident.resolved).length,
      gateDamage: round(this.state.gate.damage, 2),
      maxBearing: round(this.state.safety.maxBearing, 1),
      auditPassed: this.incidents.length === 0 ? null : this.audit.passed,
      stateHash: this.stateHash,
    };
    const reasons = [];
    if (!equipmentSafe) reasons.push("设备安全未闭环");
    if (!energyPassed) reasons.push(`电量差 ${round(GENERATION_TARGET_MWH - this.state.energyMWh, 2)} MWh`);
    if (!navigationPassed) reasons.push("通航窗口未全部准点");
    this.logEvent(
      "result",
      this.result.success ? "潮周期任务达成" : "潮周期任务未达成",
      reasons.length ? reasons.join(" · ") : "设备安全 · 两次通航准点 · 电量达标",
      this.result.success ? "success" : "danger",
      this.result,
    );
  }

  getRecentEvents(limit = 8) {
    return this.log.slice(-limit).reverse();
  }

  getResults() {
    return this.result ?? {
      tick: this.tick,
      clock: clockLabel(this.tick),
      success: false,
      equipmentSafe: this.state.safety.unresolved === 0,
      energyPassed: this.state.energyMWh >= GENERATION_TARGET_MWH,
      navigationPassed: this.state.counts.onTimeNav === NAV_WINDOWS.length,
      energyMWh: round(this.state.energyMWh, 2),
      targetMWh: GENERATION_TARGET_MWH,
      onTimeNav: this.state.counts.onTimeNav,
      delayedNav: this.state.counts.delayedNav,
      incidents: this.state.counts.incidents,
      unresolvedIncidents: this.incidents.filter((incident) => !incident.resolved).length,
      gateDamage: round(this.state.gate.damage, 2),
      maxBearing: round(this.state.safety.maxBearing, 1),
      stateHash: this.stateHash,
    };
  }

  injectScenarioEvents() {
    if (
      this.scenario.bearingFaultTick !== null &&
      this.tick === this.scenario.bearingFaultTick &&
      !this.state.scenario.bearingFaultActive
    ) {
      this.state.scenario.bearingFaultActive = true;
      this.logEvent(
        "fault",
        "2号机组冷却流量下降",
        "轴承热惯性上升，温度保护尚未触发",
        "warning",
        { unit: 2, limitC: BEARING_LIMIT_C },
      );
    }
    if (
      this.scenario.pressureProbeTick !== null &&
      this.tick === this.scenario.pressureProbeTick &&
      !this.state.scenario.pressureProbeFired
    ) {
      this.state.scenario.pressureProbeFired = true;
      this.manual.gateOpening = 0.78;
      this.manual.gateHoldUntil = this.tick + 6;
      this.logEvent(
        "fault",
        "调度器请求高压差开闸",
        "压差保护与操作票校验正在裁决",
        "warning",
        { requestedOpening: 0.78, limitM: GATE_HEAD_LIMIT_M },
      );
    }
  }

  validateGate(head) {
    const gate = this.state.gate;
    gate.pressure = round(Math.abs(head), 3);
    gate.margin = round(GATE_HEAD_LIMIT_M - Math.abs(head), 2);
    this.state.safety.gateMargin = gate.margin;
    const probe =
      this.state.scenario.pressureProbeFired &&
      !this.incidents.some((incident) => incident.type === "pressure");
    const forcedOpen = this.manual.gateOpening !== null &&
      this.tick < this.manual.gateHoldUntil &&
      this.manual.gateOpening > 0.02;

    if (forcedOpen && Math.abs(head) > GATE_HEAD_LIMIT_M) {
      if (probe) {
        this.triggerPressureIncident(Math.abs(head), this.manual.gateOpening);
      } else {
        this.logEvent(
          "safety",
          "压差保护拒绝开闸",
          `当前压差 ${Math.abs(head).toFixed(2)} m，超过 ${GATE_HEAD_LIMIT_M.toFixed(2)} m 结构限值`,
          "warning",
        );
      }
      gate.opening = 0;
      gate.command = 0;
      gate.reason = "压差联锁";
      return;
    }

    if (gate.opening > 0.01 && Math.abs(head) > GATE_HEAD_LIMIT_M) {
      gate.damage = round(
        gate.damage + (Math.abs(head) - GATE_HEAD_LIMIT_M) * gate.opening * 0.8,
        3,
      );
      if (!gate.interlocked) {
        gate.interlocked = true;
        gate.opening = 0;
        gate.reason = "结构损伤联锁";
        this.logEvent("safety", "闸门结构联锁", "压差与开度组合越限，闸门立即关闭", "danger");
      }
    }
  }

  updateReverse() {
    const turbine = this.state.turbine;
    if (turbine.status !== "reversing") return;
    turbine.reverseLeft = Math.max(0, turbine.reverseLeft - 1);
    turbine.reverseProgress = 1 - turbine.reverseLeft / REVERSE_MINUTES;
    turbine.speed = Math.sin(turbine.reverseProgress * Math.PI) * 0.18;
    if (turbine.reverseLeft === 0) {
      turbine.direction = turbine.targetDirection;
      turbine.status = "running";
      turbine.speed = 0.2;
      this.logEvent(
        "equipment",
        "涡轮换向完成",
        `${turbine.direction === "flood" ? "涨潮" : "落潮"}向指向锁止，可以重新并网`,
        "success",
        { direction: turbine.direction },
      );
    }
  }

  updateHydraulics() {
    const state = this.state;
    const turbine = state.turbine;
    const gate = state.gate;
    const onlineUnits = state.units.filter((unit) => unit.status === "online");
    const capacity = onlineUnits.length * TURBINE_CAPACITY_M3S;
    const headBefore = state.seaLevel - state.basinLevel;
    const directionSign = turbine.direction === "flood" ? 1 : -1;
    const aligned = Math.sign(headBefore) === directionSign;
    const flowFraction = clamp((Math.abs(headBefore) - 0.12) / 1.08, 0, 1);
    let turbineFlow = 0;
    if (
      turbine.status === "running" &&
      onlineUnits.length > 0 &&
      aligned &&
      Math.abs(headBefore) > 0.12
    ) {
      turbineFlow = directionSign * capacity * flowFraction;
    }

    const gateFlowFraction = clamp(Math.sqrt(Math.abs(headBefore) / 1.2), 0, 1.45);
    const gateFlow = gate.opening > 0.001
      ? Math.sign(headBefore) * GATE_CAPACITY_M3S * gate.opening * gateFlowFraction
      : 0;
    const totalFlow = turbineFlow + gateFlow;

    state.basinLevel = clamp(
      state.basinLevel + (totalFlow * 60) / BASIN_AREA_M2,
      0.65,
      6.65,
    );
    const nextTide = tideAt(this.tick + 1);
    state.seaLevel = nextTide.seaLevel;
    state.tideTrend = nextTide.trend;
    state.tidePhase = nextTide.trend >= 0 ? "涨潮" : "落潮";
    state.head = round(state.seaLevel - state.basinLevel, 4);
    state.flow.turbine = round(turbineFlow, 2);
    state.flow.gate = round(gateFlow, 2);
    state.flow.total = round(totalFlow, 2);

    const efficiency = clamp(
      0.91 - Math.abs(Math.abs(headBefore) - 2.15) * 0.034,
      0.68,
      0.91,
    );
    const unitCount = Math.max(1, onlineUnits.length);
    const rawPower = (9.81 * Math.abs(turbineFlow) * Math.abs(headBefore) * efficiency) / 1000;
    const capacityMW = onlineUnits.length * 3.3;
    state.powerMW = round(
      turbine.status === "running" ? Math.min(rawPower, capacityMW) : 0,
      3,
    );
    state.energyMWh = round(state.energyMWh + state.powerMW / 60, 4);

    const load = state.powerMW / Math.max(0.1, unitCount * 3.3);
    state.turbine.speed = turbine.status === "running"
      ? clamp(0.32 + flowFraction * 0.68, 0, 1)
      : turbine.status === "reversing"
        ? turbine.speed
        : Math.max(0, state.turbine.speed - 0.05);
    for (const unit of state.units) {
      if (unit.status === "online") {
        unit.load = round(clamp(load, 0, 1.04), 3);
      } else {
        unit.load = 0;
      }
    }

    if (gate.opening > 0.01 && Math.abs(headBefore) > GATE_HEAD_LIMIT_M + 0.05) {
      gate.damage = round(
        gate.damage + (Math.abs(headBefore) - GATE_HEAD_LIMIT_M) * gate.opening * 0.35,
        3,
      );
    }
    gate.pressure = round(Math.abs(headBefore), 3);
    gate.margin = round(GATE_HEAD_LIMIT_M - Math.abs(headBefore), 2);
    state.safety.gateMargin = gate.margin;
  }

  updateGateOpening() {
    const gate = this.state.gate;
    if (gate.interlocked) {
      gate.opening = 0;
      return;
    }
    const target = gate.command;
    const delta = target - gate.opening;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), 0.13);
    gate.opening = round(clamp(gate.opening + step, 0, 1), 4);
    if (Math.abs(gate.opening - target) < 0.005) gate.opening = round(target, 4);
  }

  updateBearingTemperatures() {
    const coolingLoss = this.state.scenario.bearingFaultActive;
    for (const unit of this.state.units) {
      if (unit.status === "fault" || unit.status === "maintenance") continue;
      const base = 47 + unit.load * 38 + (this.strategyKey === "power" ? 4 : 0);
      const faultHeat = coolingLoss && unit.id === 2 ? 58 : 0;
      const target = base + faultHeat;
      const rate = target > unit.bearingTemp ? 0.052 : 0.18;
      unit.bearingTemp = round(
        unit.bearingTemp + (target - unit.bearingTemp) * rate,
        3,
      );
      if (
        coolingLoss &&
        unit.id === 2 &&
        unit.bearingTemp >= BEARING_LIMIT_C &&
        unit.status === "online"
      ) {
        this.triggerBearingIncident(unit);
      }
    }
    this.state.safety.maxBearing = round(
      Math.max(
        this.state.safety.maxBearing,
        ...this.state.units.map((unit) => unit.bearingTemp),
      ),
      1,
    );
  }

  triggerBearingIncident(unit) {
    unit.status = "fault";
    unit.load = 0;
    unit.tripReason = "轴承温度高";
    const turbine = this.state.turbine;
    turbine.status = "fault";
    turbine.speed = 0;
    turbine.targetDirection = turbine.direction;
    this.state.powerMW = 0;
    this.state.flow.turbine = 0;
    this.state.flow.total = this.state.flow.gate;
    this.state.counts.incidents += 1;
    this.state.safety.status = "fault";
    this.state.safety.unresolved += 1;
    this.state.safety.openIncident = `bearing-${this.incidents.length + 1}`;
    this.manual.maintenanceUntil = this.tick + 8;
    this.setGateTarget(0, "机组故障联锁");
    const incident = {
      id: `INC-${this.incidents.length + 1}`,
      type: "equipment",
      title: "2号机组轴承过热停机",
      tick: this.tick,
      clock: clockLabel(this.tick),
      parameter: "轴承温度",
      value: round(unit.bearingTemp, 2),
      limit: BEARING_LIMIT_C,
      unit: "°C",
      margin: round(BEARING_LIMIT_C - unit.bearingTemp, 2),
      thresholdText: `2号机组温度 ≥ ${BEARING_LIMIT_C} °C`,
      response: "三台涡轮联锁停机，泄水闸关闭，负荷归零；故障机组隔离等待检修复位。",
      stateHash: this.stateHash,
      resolvedTick: null,
      resolved: false,
      auditPassed: null,
    };
    this.incidents.push(incident);
    this.logEvent(
      "fault",
      incident.title,
      `${incident.parameter} ${incident.value} ${incident.unit}，余量 ${formatMargin(incident.margin, incident.unit)}；全站联锁停机`,
      "danger",
      { incident: incident.id, margin: incident.margin },
    );
  }
}
