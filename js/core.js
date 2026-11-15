(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LandslideCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DURATION = 120 * 60;
  const DT = 1;
  const OBSERVATION_SECONDS = 10 * 60;
  const FAILURE_MARGIN = 0.16;
  const RESCUE_WINDOWS = [35 * 60, 58 * 60, 82 * 60];

  const ANCHORS = [
    { id: "A", x: 0.285, y: 0.335, name: "后缘裂缝", short: "后缘", suitability: { displacement: 0.98, rain: 0.54, pore: 0.25 } },
    { id: "B", x: 0.405, y: 0.455, name: "中上部滑坡体", short: "中上", suitability: { displacement: 0.86, rain: 0.7, pore: 0.5 } },
    { id: "C", x: 0.3, y: 0.66, name: "坡脚渗流带", short: "坡脚", suitability: { displacement: 0.46, rain: 0.3, pore: 0.98 } },
    { id: "D", x: 0.565, y: 0.285, name: "坡顶开阔地", short: "坡顶", suitability: { displacement: 0.42, rain: 0.98, pore: 0.2 } },
    { id: "E", x: 0.48, y: 0.565, name: "中部监测平台", short: "中台", suitability: { displacement: 0.78, rain: 0.7, pore: 0.73 } },
    { id: "F", x: 0.575, y: 0.7, name: "谷侧排水沟", short: "谷侧", suitability: { displacement: 0.32, rain: 0.62, pore: 0.82 } },
  ];

  const SENSOR_TYPES = {
    displacement: {
      label: "位移计",
      short: "位移",
      unit: "mm",
      min: 0,
      max: 60,
      decimals: 1,
      baseNoise: 0.55,
      color: "#b8f26c",
    },
    rain: {
      label: "雨量计",
      short: "雨量",
      unit: "mm/h",
      min: 0,
      max: 120,
      decimals: 1,
      baseNoise: 1.4,
      color: "#6aa8ff",
    },
    pore: {
      label: "孔压计",
      short: "孔压",
      unit: "kPa",
      min: 0,
      max: 40,
      decimals: 1,
      baseNoise: 0.38,
      color: "#69d9cf",
    },
  };

  const SCENARIOS = {
    normal: {
      id: "normal",
      label: "正常流程",
      seed: 60701,
      faultType: null,
      faultTime: null,
      objective: "部署监测、发布预警、保留救援车道，并在两小时内维持边坡稳定。",
    },
    device: {
      id: "device",
      label: "设备故障",
      seed: 60702,
      faultType: "device_offline",
      faultTime: 22 * 60,
      objective: "雨量站将在 00:22 掉线。隔离故障、检修恢复，并完成十分钟稳定观察。",
    },
    parameter: {
      id: "parameter",
      label: "参数越限",
      seed: 60703,
      faultType: "parameter_outlier",
      faultTime: 31 * 60,
      objective: "00:31 将出现超量程读数。完成通道隔离、复位与十分钟稳定观察。",
    },
  };

  const ALERT_LEVELS = [
    { label: "常态监测", title: "建立监测基线", className: "level-0" },
    { label: "黄色关注", title: "坡体出现缓慢变形", className: "level-1" },
    { label: "橙色预警", title: "失稳窗口正在缩短", className: "level-2" },
    { label: "红色警报", title: "滑坡风险临界", className: "level-3" },
  ];

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function lerp(a, b, amount) {
    return a + (b - a) * amount;
  }

  function smoothstep(value) {
    const x = clamp(value, 0, 1);
    return x * x * (3 - 2 * x);
  }

  function round(value, digits = 1) {
    const scale = Math.pow(10, digits);
    return Math.round(value * scale) / scale;
  }

  function formatTime(seconds, withSeconds = true) {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (!withSeconds) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function rainAt(seconds) {
    const minute = seconds / 60;
    if (minute < 8) return 0.4;
    if (minute < 28) return lerp(0.4, 21, smoothstep((minute - 8) / 20));
    if (minute < 45) return 21 + Math.sin(minute * 0.46) * 1.9;
    if (minute < 70) return 30 + Math.sin(minute * 0.31) * 4.2;
    if (minute < 96) return lerp(30, 8, smoothstep((minute - 70) / 26));
    if (minute < 112) return lerp(8, 1.2, smoothstep((minute - 96) / 16));
    return 0.8;
  }

  class SeededRandom {
    constructor(seed) {
      this.state = (seed >>> 0) || 1;
    }

    next() {
      this.state = (this.state * 1664525 + 1013904223) >>> 0;
      return this.state / 4294967296;
    }

    centered() {
      return this.next() * 2 - 1;
    }
  }

  function emptyMetrics() {
    return {
      injuries: 0,
      rescueRuns: 0,
      rescueDelays: 0,
      routeUnavailableSeconds: 0,
      civilianPasses: 0,
      alertChanges: 0,
    };
  }

  class Simulation {
    constructor(options = {}) {
      const requestedScenario = SCENARIOS[options.scenarioId] ? options.scenarioId : "normal";
      this.scenario = SCENARIOS[requestedScenario];
      this.scenarioId = requestedScenario;
      this.seed = Number.isFinite(options.seed) ? options.seed : this.scenario.seed;
      this.random = new SeededRandom(this.seed);
      this.t = 0;
      this.finished = false;
      this.failed = false;
      this.failureReason = "";
      this.failureTime = null;
      this.warningIssued = false;
      this.warningTime = null;
      this.falseAlarm = false;
      this.roadMode = "OPEN";
      this.roadModeSince = 0;
      this.roadBlocked = false;
      this.collapseTime = null;
      this.reinforcement = {
        active: false,
        appliedAt: null,
        count: 0,
      };
      this.trueState = {
        displacement: 2.8,
        pore: 3.4,
        stability: 1,
        cumulativeRain: 0,
      };
      this.env = {
        rain: rainAt(0),
        cumulativeRain: 0,
        daylight: 1,
      };
      this.damageRate = 0.00002;
      this.timeToFailure = 999;
      this.alertScore = 0;
      this.alertLevel = 0;
      this.sensorNoiseBias = 0;
      this.systemAlertFloor = 0;
      this.degraded = false;
      this.logs = [];
      this.userActions = [];
      this.faults = [];
      this.faultInjected = { device: false, parameter: false };
      this.observation = {
        active: false,
        complete: false,
        invalid: false,
        startedAt: null,
        remaining: OBSERVATION_SECONDS,
        levelAtStart: 0,
        jumps: 0,
        lastLevel: 0,
      };
      this.metrics = emptyMetrics();
      this.sensors = [];
      this.rescueLog = RESCUE_WINDOWS.map((time) => ({ time, status: "pending" }));
      this.snapshots = [];
      this.headless = Boolean(options.headless);

      this.addSensor("rain", "D", {
        id: "R0",
        fixed: true,
        quality: 0.74,
        name: "既有雨量站",
        silent: true,
      });
      this.logEvent("system", "演练启动", `${this.scenario.label}场景载入；随机种子 ${this.seed}。`);
      this.updateSensors();
      this.sampleSensors(true);
      this.updateRisk();
    }

    addSensor(type, anchorId, options = {}) {
      const spec = SENSOR_TYPES[type];
      const anchor = ANCHORS.find((item) => item.id === anchorId);
      if (!spec || !anchor) return { ok: false, reason: "未知的传感器或点位" };
      if (this.sensors.some((sensor) => sensor.anchorId === anchorId)) {
        return { ok: false, reason: `${anchor.name} 已占用` };
      }
      if (this.t >= DURATION || this.failed) return { ok: false, reason: "仿真已结束" };

      const suitability = anchor.suitability[type];
      const quality = options.quality == null ? suitability : options.quality;
      const sensor = {
        id: options.id || `S${this.sensors.length}-${anchorId}`,
        type,
        anchorId,
        name: options.name || `${spec.label} ${anchor.short}`,
        quality,
        status: "online",
        reading: null,
        lastGood: null,
        lastGoodAt: null,
        installedAt: this.t,
        fixed: Boolean(options.fixed),
        noise: 0,
        faultValue: null,
      };
      this.sensors.push(sensor);
      if (!options.silent) {
        const grade = quality >= 0.8 ? "优" : quality >= 0.58 ? "良" : "偏差";
        this.logEvent(
          "decision",
          `部署${spec.label}`,
          `${anchor.name} · 点位适配度 ${grade} ${Math.round(quality * 100)}%`,
          { action: "deploy_sensor", type, anchorId }
        );
        this.userActions.push({ t: this.t, type: "deploy_sensor", payload: { type, anchorId } });
      }
      this.updateSensors();
      this.updateRisk();
      return { ok: true, sensor };
    }

    sampleSensors(force = false) {
      if (!force && this.t % 5 !== 0) return;
      const qualityNoise = (quality) => 1 + Math.pow(1 - quality, 1.35) * 5.2;

      for (const sensor of this.sensors) {
        if (sensor.status === "offline" || sensor.status === "outlier") {
          sensor.noise = 0;
          continue;
        }
        const spec = SENSOR_TYPES[sensor.type];
        let trueValue = 0;
        if (sensor.type === "rain") trueValue = this.env.rain;
        if (sensor.type === "displacement") trueValue = this.trueState.displacement;
        if (sensor.type === "pore") trueValue = this.trueState.pore;
        const noise = this.random.centered() * spec.baseNoise * qualityNoise(sensor.quality);
        sensor.noise = noise;
        sensor.reading = clamp(trueValue + noise, 0, spec.max * 1.15);
        sensor.lastGood = sensor.reading;
        sensor.lastGoodAt = this.t;
      }
      this.updateRisk();
    }

    getSensor(type, preferredId) {
      if (preferredId) {
        const match = this.sensors.find((sensor) => sensor.id === preferredId);
        if (match) return match;
      }
      return this.sensors.find((sensor) => sensor.type === type && !sensor.fixed) ||
        this.sensors.find((sensor) => sensor.type === type);
    }

    averageReading(type) {
      const usable = this.sensors.filter(
        (sensor) => sensor.type === type && sensor.status === "online" && sensor.reading != null
      );
      if (!usable.length) return null;
      return usable.reduce((sum, sensor) => sum + sensor.reading, 0) / usable.length;
    }

    getConfidence() {
      const online = this.sensors.filter((sensor) => sensor.status === "online");
      if (!online.length) return 0;
      return online.reduce((sum, sensor) => sum + sensor.quality, 0) / online.length;
    }

    updateSensors() {
      this.sensorNoiseBias = this.sensors
        .filter((sensor) => sensor.status === "online" && sensor.reading != null)
        .reduce((sum, sensor) => sum + Math.abs(sensor.noise || 0) * (1 - sensor.quality), 0);
      return this.sensors;
    }

    getRiskFactors() {
      const rain = this.fusedReading("rain");
      const displacement = this.fusedReading("displacement");
      const pore = this.fusedReading("pore");
      const rainFactor = rain == null ? 0 : clamp((rain - 1.5) / 34, 0, 1) * 24;
      const displacementFactor = displacement == null ? 0 : clamp((displacement - 7) / 18, 0, 1) * 34;
      const poreFactor = pore == null ? 0 : clamp((pore - 6) / 9.5, 0, 1) * 19;
      const stabilityFactor = clamp((1 - this.trueState.stability) / 0.84, 0, 1) * 23;
      return {
        rain,
        displacement,
        pore,
        rainFactor,
        displacementFactor,
        poreFactor,
        stabilityFactor,
      };
    }

    updateRisk() {
      const factors = this.getRiskFactors();
      const noisyPenalty = clamp(this.sensorNoiseBias * 5.5, 0, 9);
      let rawScore = factors.rainFactor + factors.displacementFactor +
        factors.poreFactor + factors.stabilityFactor + noisyPenalty;
      rawScore = clamp(rawScore, 0, 100);
      if (!Number.isFinite(this.smoothedScore)) this.smoothedScore = rawScore;
      else this.smoothedScore = this.smoothedScore * 0.86 + rawScore * 0.14;
      const score = clamp(Math.round(this.smoothedScore), 0, 100);

      let naturalLevel = this.alertLevel;
      if (naturalLevel < 3 && score >= [27, 49, 70][naturalLevel]) naturalLevel += 1;
      else if (naturalLevel > 0 && score < [22, 43, 64][naturalLevel - 1]) naturalLevel -= 1;
      const nextLevel = Math.max(naturalLevel, this.systemAlertFloor);

      if (nextLevel !== this.alertLevel) {
        this.metrics.alertChanges += 1;
        if (this.observation.active && !this.observation.complete) {
          this.observation.jumps += 1;
        }
        this.alertLevel = nextLevel;
        if (!this.headless) {
          this.logEvent(
            "alert",
            `系统警戒升至${ALERT_LEVELS[nextLevel].label}`,
            `综合风险 ${score}/100；阈值融合雨量、位移、孔压与稳定余量。`,
            { action: "alert_level", level: nextLevel }
          );
        }
      } else {
        this.alertLevel = nextLevel;
      }

      this.alertScore = score;
      this.observation.lastLevel = nextLevel;
      this.factors = factors;
      return { score, level: nextLevel, factors };
    }

    getMetricSnapshot(extra = {}) {
      return Object.assign({
        simTime: this.t,
        displacement: round(this.trueState.displacement, 1),
        pore: round(this.trueState.pore, 1),
        rain: round(this.env.rain, 1),
        cumulativeRain: round(this.env.cumulativeRain, 1),
        marginPct: round(this.trueState.stability * 100, 1),
        ttfMin: this.timeToFailure >= 998 ? null : round(this.timeToFailure, 1),
        alertLevel: this.alertLevel,
        roadMode: this.roadMode,
        degraded: this.degraded,
      }, extra);
    }

    logEvent(category, title, detail, extra = {}) {
      const metrics = this.getMetricSnapshot();
      const event = {
        id: `E${this.logs.length + 1}`,
        t: this.t,
        time: formatTime(this.t),
        category,
        title,
        detail,
        marginPct: metrics.marginPct,
        ttfMin: metrics.ttfMin,
        rain: metrics.rain,
        displacement: metrics.displacement,
        pore: metrics.pore,
        ...extra,
      };
      this.logs.push(event);
      return event;
    }

    fusedReading(type) {
      const online = this.sensors.filter(
        (sensor) => sensor.type === type && sensor.status === "online" && sensor.reading != null
      );
      if (online.length) {
        return online.reduce((sum, sensor) => sum + sensor.reading, 0) / online.length;
      }
      const fallback = this.sensors.filter(
        (sensor) => sensor.type === type && sensor.lastGood != null
      );
      if (!fallback.length) return null;
      const conservative = fallback.reduce((sum, sensor) => sum + sensor.lastGood, 0) / fallback.length;
      return conservative * (type === "rain" ? 1.18 : 1.06);
    }

    stepPhysics() {
      const rain = this.env.rain;
      this.trueState.cumulativeRain += rain / 3600 * DT;
      this.env.cumulativeRain = this.trueState.cumulativeRain;

      this.trueState.displacement += (
        0.00115 +
        rain * 0.00006 +
        Math.max(0, this.trueState.pore - 5.5) * 0.00004
      ) * DT;
      this.trueState.pore += (0.0004 + rain * 0.000045) * DT;
      this.trueState.pore = clamp(this.trueState.pore, 3.4, 30);

      let damage = (
        0.00002 +
        rain * 0.000006 +
        Math.max(0, this.trueState.displacement - 6) * 0.000002 +
        Math.max(0, this.trueState.pore - 5) * 0.000004
      );

      if (this.reinforcement.active) {
        damage *= 0.27;
        this.trueState.stability += 0.00022 * DT;
      }
      this.damageRate = damage;
      this.trueState.stability = clamp(this.trueState.stability - damage * DT, 0, 1);

      if (this.reinforcement.active && this.trueState.stability > 0.88) {
        this.trueState.stability = Math.min(1, this.trueState.stability + 0.00008 * DT);
      }

      if (this.trueState.stability <= FAILURE_MARGIN + 0.005) {
        this.timeToFailure = 0;
      } else if (this.reinforcement.active && this.trueState.stability > 0.3) {
        this.timeToFailure = 999;
      } else {
        this.timeToFailure = (this.trueState.stability - FAILURE_MARGIN) / Math.max(damage, 0.000001) / 60;
      }
    }

    advance() {
      if (this.finished || this.failed) return this.getSnapshot();

      this.t += DT;
      this.env.rain = Math.max(0, rainAt(this.t));
      this.stepPhysics();
      this.sampleSensors();
      this.checkScenarioFault();
      this.updateRisk();
      this.checkRescueWindow();
      this.checkObservation();
      this.checkFailure();

      if (this.roadMode === "FULL_CLOSED" || this.roadBlocked) {
        this.metrics.routeUnavailableSeconds += DT;
      }
      if (this.t % 60 === 0) {
        this.snapshots.push({
          t: this.t,
          stability: this.trueState.stability,
          displacement: this.trueState.displacement,
          pore: this.trueState.pore,
          rain: this.env.rain,
          alertLevel: this.alertLevel,
          roadMode: this.roadMode,
        });
      }
      if (this.t >= DURATION) this.finish();
      return this.getSnapshot();
    }

    checkScenarioFault() {
      if (!this.scenario.faultType) return;
      if (this.t < this.scenario.faultTime) return;
      if (this.scenario.faultType === "device_offline" && !this.faultInjected.device) {
        this.injectDeviceFault();
      }
      if (this.scenario.faultType === "parameter_outlier" && !this.faultInjected.parameter) {
        this.injectParameterFault();
      }
    }

    injectDeviceFault(sensorId) {
      const sensor = sensorId ? this.sensors.find((item) => item.id === sensorId) : this.getSensor("rain");
      if (!sensor || sensor.status === "offline") return false;
      const response = "自动隔离故障通道；保持最后有效读数并提高降雨不确定度；警戒等级至少提升至黄色。";
      sensor.status = "offline";
      sensor.reading = null;
      this.faultInjected.device = true;
      this.degraded = true;
      this.systemAlertFloor = Math.max(this.systemAlertFloor, 1);
      const fault = {
        id: `F${this.faults.length + 1}`,
        type: "device_offline",
        typeLabel: "设备故障",
        sensorId: sensor.id,
        sensorName: sensor.name,
        time: this.t,
        timeLabel: formatTime(this.t),
        marginPct: round(this.trueState.stability * 100, 1),
        ttfMin: this.timeToFailure >= 998 ? null : round(this.timeToFailure, 1),
        rain: round(this.env.rain, 1),
        displacement: round(this.trueState.displacement, 1),
        pore: round(this.trueState.pore, 1),
        response,
        recoveredAt: null,
        observationVerified: false,
      };
      this.faults.push(fault);
      this.logEvent("fault", `设备掉线 · ${sensor.name}`, `${response} 当前余量 ${fault.marginPct}%`, {
        action: "fault",
        faultType: fault.type,
        sensorId: sensor.id,
      });
      this.updateRisk();
      return true;
    }

    injectParameterFault(sensorId) {
      let sensor = sensorId ? this.sensors.find((item) => item.id === sensorId) : null;
      if (!sensor) {
        sensor = this.sensors.find(
          (item) => item.type === "displacement" && item.status === "online"
        ) || this.getSensor("rain");
      }
      if (!sensor || sensor.status === "outlier") return false;
      const spec = SENSOR_TYPES[sensor.type];
      const outlierValue = round(spec.max * 4 + 37.7, 1);
      const response = "识别为超量程读数；通道冻结并隔离，保留趋势估计；警戒等级至少提升至橙色，等待人工确认。";
      sensor.status = "outlier";
      sensor.faultValue = outlierValue;
      sensor.reading = outlierValue;
      this.faultInjected.parameter = true;
      this.degraded = true;
      this.systemAlertFloor = Math.max(this.systemAlertFloor, 2);
      const fault = {
        id: `F${this.faults.length + 1}`,
        type: "parameter_outlier",
        typeLabel: "参数越限",
        sensorId: sensor.id,
        sensorName: sensor.name,
        sensorType: sensor.type,
        invalidReading: outlierValue,
        limit: spec.max,
        unit: spec.unit,
        time: this.t,
        timeLabel: formatTime(this.t),
        marginPct: round(this.trueState.stability * 100, 1),
        ttfMin: this.timeToFailure >= 998 ? null : round(this.timeToFailure, 1),
        rain: round(this.env.rain, 1),
        displacement: round(this.trueState.displacement, 1),
        pore: round(this.trueState.pore, 1),
        response,
        recoveredAt: null,
        observationVerified: false,
      };
      this.faults.push(fault);
      this.logEvent(
        "fault",
        `参数越限 · ${sensor.name}`,
        `${outlierValue} ${spec.unit} 超出 ${spec.min}–${spec.max} ${spec.unit}；${response} 当前余量 ${fault.marginPct}%`,
        { action: "fault", faultType: fault.type, sensorId: sensor.id }
      );
      this.updateRisk();
      return true;
    }

    repairFault() {
      if (!this.faults.length || this.observation.active) return { ok: false, reason: "当前没有可检修通道" };
      const sensor = this.sensors.find(
        (item) => item.status === "offline" || item.status === "outlier"
      );
      if (!sensor) return { ok: false, reason: "没有待恢复的通道" };
      const fault = this.faults.find((item) => item.sensorId === sensor.id && !item.recoveredAt);
      sensor.status = "online";
      sensor.reading = sensor.lastGood;
      sensor.faultValue = null;
      this.degraded = false;
      if (fault) fault.recoveredAt = this.t;
      this.observation = {
        active: true,
        complete: false,
        invalid: false,
        startedAt: this.t,
        remaining: OBSERVATION_SECONDS,
        levelAtStart: this.alertLevel,
        jumps: 0,
        lastLevel: this.alertLevel,
        faultCountAtStart: this.faults.length,
      };
      this.logEvent(
        "observation",
        "通道恢复 · 开始稳定观察",
        `${sensor.name} 已恢复；固定观察 10 分钟，监测重复故障与警戒等级跳变。`,
        { action: "repair_fault", sensorId: sensor.id }
      );
      this.userActions.push({ t: this.t, type: "repair_fault", payload: {} });
      this.sampleSensors(true);
      this.updateRisk();
      return { ok: true, sensor, observation: this.observation };
    }

    checkObservation() {
      if (!this.observation.active || this.observation.complete) return;
      const remaining = Math.max(0, OBSERVATION_SECONDS - (this.t - this.observation.startedAt));
      this.observation.remaining = remaining;
      const newFault = this.faults.length > this.observation.faultCountAtStart;
      const unhealthy = this.sensors.some(
        (sensor) => sensor.status === "offline" || sensor.status === "outlier"
      );
      if (newFault || unhealthy) this.observation.invalid = true;
      if (remaining > 0) return;

      this.observation.active = false;
      this.observation.complete = true;
      this.observation.invalid = this.observation.invalid || this.observation.jumps > 0;
      const fault = this.faults.find((item) => item.recoveredAt && !item.observationVerified);
      if (fault) {
        fault.observationVerified = !this.observation.invalid;
        fault.observationCompletedAt = this.t;
      }
      if (this.observation.invalid) {
        this.logEvent(
          "fault",
          "恢复观察未通过",
          `检测到 ${this.observation.jumps} 次状态跳变或新的通道异常，需重新检修。`,
          { action: "observation_failed" }
        );
      } else {
        this.logEvent(
          "observation",
          "恢复观察通过",
          "连续 10 分钟无重复故障、无警戒等级跳变；未发现隐藏连锁错误。",
          { action: "observation_verified" }
        );
      }
      if (this.faults.every((item) => !item.recoveredAt || item.observationVerified)) {
        this.systemAlertFloor = 0;
      }
      this.updateRisk();
    }

    issueWarning() {
      if (this.warningIssued) return { ok: false, reason: "预警已发布" };
      if (this.finished || this.failed) return { ok: false, reason: "仿真已结束" };
      this.warningIssued = true;
      this.warningTime = this.t;
      const level = Math.max(1, this.alertLevel);
      this.falseAlarm = this.trueState.stability > 0.82 && this.trueState.displacement < 6.5;
      this.userActions.push({
        t: this.t,
        type: "issue_warning",
        payload: { level, score: this.alertScore },
      });
      this.logEvent(
        "alert",
        `发布${ALERT_LEVELS[level].label}`,
        this.falseAlarm
          ? `研判风险 ${this.alertScore}/100；真实坡体仍稳定，记一次低置信度误报。`
          : `研判风险 ${this.alertScore}/100；预警窗口已固定写入决策记录。`,
        { action: "issue_warning", level, falseAlarm: this.falseAlarm }
      );
      return { ok: true, level, falseAlarm: this.falseAlarm };
    }

    reinforceSlope() {
      if (this.reinforcement.count >= 2) return { ok: false, reason: "加固作业已完成" };
      if (this.finished || this.failed) return { ok: false, reason: "仿真已结束" };
      this.reinforcement.count += 1;
      this.reinforcement.active = true;
      this.reinforcement.appliedAt = this.t;
      this.trueState.stability = clamp(this.trueState.stability + 0.055, 0, 1);
      this.userActions.push({ t: this.t, type: "reinforce", payload: {} });
      this.logEvent(
        "decision",
        "坡面加固开始",
        "削坡反压与排水作业启动；失稳速率降低，安全余量开始恢复。",
        { action: "reinforce" }
      );
      this.updateRisk();
      return { ok: true };
    }

    setRoadMode(mode) {
      const allowed = ["OPEN", "CONTROLLED", "FULL_CLOSED"];
      if (!allowed.includes(mode) || mode === this.roadMode) {
        return { ok: false, reason: "交通状态未变化" };
      }
      if (this.finished || this.failed) return { ok: false, reason: "仿真已结束" };
      this.roadMode = mode;
      this.roadModeSince = this.t;
      const labels = {
        OPEN: "恢复社会车辆通行",
        CONTROLLED: "启动应急管制",
        FULL_CLOSED: "实施全幅封路",
      };
      const details = {
        OPEN: "社会车辆恢复通行；需持续复核安全余量。",
        CONTROLLED: "封闭社会车辆，保留一条救援车道；救援窗口维持可用。",
        FULL_CLOSED: "双向道路全部封闭；此状态会阻断救援车辆并计入通道不可用时间。",
      };
      this.logEvent("decision", labels[mode], details[mode], {
        action: "road_mode",
        mode,
      });
      this.userActions.push({ t: this.t, type: "set_road_mode", payload: { mode } });
      return { ok: true };
    }

    checkRescueWindow() {
      for (const rescue of this.rescueLog) {
        if (rescue.status !== "pending" || this.t < rescue.time) continue;
        this.metrics.rescueRuns += 1;
        if (this.roadMode === "FULL_CLOSED" || this.roadBlocked) {
          rescue.status = "delayed";
          this.metrics.rescueDelays += 1;
          this.logEvent(
            "rescue",
            "救援车受阻",
            this.roadBlocked
              ? "道路已断路，救援车辆无法通过 K12+460。"
              : "全幅封路截断救援通道，救援车辆被迫绕行。",
            { action: "rescue_delayed", rescueTime: rescue.time }
          );
        } else {
          rescue.status = "passed";
          this.logEvent(
            "rescue",
            "救援车通过",
            this.roadMode === "CONTROLLED"
              ? "应急管制有效，社会车辆清空，救援车沿保留车道通过。"
              : "道路保持通行，救援车正常通过。",
            { action: "rescue_passed", rescueTime: rescue.time }
          );
        }
      }
    }

    checkFailure() {
      if (this.roadBlocked || this.trueState.stability > FAILURE_MARGIN) return;
      this.roadBlocked = true;
      this.collapseTime = this.t;
      const injuries = this.roadMode === "OPEN" ? 1 : 0;
      this.metrics.injuries += injuries;
      this.failed = true;
      this.failureTime = this.t;
      this.failureReason = injuries
        ? "坡体失稳断路，社会车辆未及时清空，发生人员受伤。"
        : "坡体失稳造成道路中断，救援通道不可用。";
      this.logEvent(
        "fault",
        "边坡失稳 · 道路中断",
        `${this.failureReason} 当前余量 ${round(this.trueState.stability * 100, 1)}%。`,
        { action: "collapse", injuries }
      );
    }

    finish() {
      if (this.finished || this.failed) return;
      this.finished = true;
      this.success = this.getSuccess();
      this.logEvent(
        this.success ? "observation" : "fault",
        this.success ? "两小时演练完成" : "演练结束 · 目标未完成",
        this.success
          ? "无人员受伤，救援通道全程可用，决策记录完整。"
          : this.getFailureSummary(),
        { action: "finish", success: this.success }
      );
    }

    getSuccess() {
      return Boolean(
        this.finished &&
        !this.failed &&
        this.warningIssued &&
        this.metrics.injuries === 0 &&
        !this.roadBlocked &&
        this.metrics.rescueDelays === 0 &&
        this.metrics.routeUnavailableSeconds === 0
      );
    }

    getFailureSummary() {
      if (this.failed) return this.failureReason;
      const reasons = [];
      if (!this.warningIssued) reasons.push("未发布预警");
      if (this.metrics.rescueDelays > 0) reasons.push("救援通道曾中断");
      if (this.roadMode === "FULL_CLOSED") reasons.push("结束时道路仍全幅封闭");
      if (!this.finished) reasons.push("仿真未运行至两小时");
      return reasons.join("；") || "未满足成功条件";
    }

    getSnapshot() {
      return {
        t: this.t,
        timeLabel: formatTime(this.t),
        finished: this.finished,
        failed: this.failed,
        success: this.finished ? this.getSuccess() : false,
        failureReason: this.failureReason,
        failureTime: this.failureTime,
        scenario: this.scenario,
        env: { ...this.env },
        trueState: { ...this.trueState },
        alertScore: this.alertScore,
        alertLevel: this.alertLevel,
        alert: ALERT_LEVELS[this.alertLevel],
        factors: this.factors ? { ...this.factors } : null,
        timeToFailure: this.timeToFailure,
        warningIssued: this.warningIssued,
        warningTime: this.warningTime,
        falseAlarm: this.falseAlarm,
        roadMode: this.roadMode,
        roadBlocked: this.roadBlocked,
        degraded: this.degraded,
        observation: { ...this.observation },
        reinforcement: { ...this.reinforcement },
        metrics: { ...this.metrics },
        sensors: this.sensors.map((sensor) => ({ ...sensor })),
        logs: this.logs.slice(),
        faults: this.faults.map((fault) => ({ ...fault })),
        rescueLog: this.rescueLog.map((rescue) => ({ ...rescue })),
      };
    }
  }

  function buildDecisionRecord(sim) {
    const snapshot = sim.getSnapshot();
    const maxRain = sim.snapshots.reduce((max, item) => Math.max(max, item.rain), 0);
    const minStability = sim.snapshots.reduce(
      (min, item) => Math.min(min, item.stability),
      sim.trueState.stability
    );
    const maxDisplacement = sim.snapshots.reduce(
      (max, item) => Math.max(max, item.displacement),
      sim.trueState.displacement
    );
    const maxPore = sim.snapshots.reduce(
      (max, item) => Math.max(max, item.pore),
      sim.trueState.pore
    );
    return {
      schema: "ridge-sentinel-decision/v1",
      generatedAt: new Date().toISOString(),
      scenario: {
        id: sim.scenarioId,
        label: sim.scenario.label,
        objective: sim.scenario.objective,
      },
      clock: {
        fixedStepSeconds: DT,
        durationSeconds: DURATION,
        elapsedSeconds: sim.t,
        elapsedLabel: formatTime(sim.t),
        seed: sim.seed,
      },
      result: {
        success: sim.finished ? sim.getSuccess() : false,
        finished: sim.finished,
        failed: sim.failed,
        failureReason: sim.failureReason || null,
        safetyGoalMet: sim.metrics.injuries === 0,
        rescueRouteAvailable: sim.metrics.routeUnavailableSeconds === 0 && !sim.roadBlocked,
        warningIssued: sim.warningIssued,
        warningTime: sim.warningTime,
        falseAlarm: sim.falseAlarm,
        injuries: sim.metrics.injuries,
        rescueDelays: sim.metrics.rescueDelays,
        routeUnavailableSeconds: sim.metrics.routeUnavailableSeconds,
      },
      environment: {
        cumulativeRainMm: round(sim.trueState.cumulativeRain, 1),
        maxRainMmPerHour: round(maxRain, 1),
        minStabilityPct: round(minStability * 100, 1),
        maxDisplacementMm: round(maxDisplacement, 1),
        maxPoreKpa: round(maxPore, 1),
        final: snapshot.trueState,
      },
      sensors: sim.sensors.map((sensor) => ({
        id: sensor.id,
        name: sensor.name,
        type: sensor.type,
        anchorId: sensor.anchorId,
        status: sensor.status,
        qualityPct: Math.round(sensor.quality * 100),
        installedAt: sensor.installedAt,
        lastGood: sensor.lastGood,
      })),
      road: {
        finalMode: sim.roadMode,
        blocked: sim.roadBlocked,
        collapsedAt: sim.collapseTime,
        rescueWindows: sim.rescueLog,
      },
      recoveryObservation: {
        durationSeconds: OBSERVATION_SECONDS,
        startedAt: sim.observation.startedAt,
        active: sim.observation.active,
        complete: sim.observation.complete,
        invalid: sim.observation.invalid,
        levelJumps: sim.observation.jumps,
      },
      faults: sim.faults,
      timeline: sim.logs,
    };
  }

  function recordToMarkdown(record) {
    const resultText = record.result.success ? "成功" : "未完成";
    const safetyText = record.result.safetyGoalMet ? "无人员受伤" : "发生人员受伤";
    const routeText = record.result.rescueRouteAvailable ? "全程可用" : "曾中断";
    const categoryLabels = {
      system: "系统",
      decision: "处置",
      alert: "预警",
      fault: "故障",
      rescue: "救援",
      observation: "观察",
    };
    const lines = [
      "# 山脊哨兵 · 滑坡预警决策记录",
      "",
      `- 场景：${record.scenario.label}`,
      `- 仿真种子：${record.clock.seed}`,
      `- 固定步长：${record.clock.fixedStepSeconds} s`,
      `- 记录时长：${record.clock.elapsedLabel} / 02:00:00`,
      `- 生成时间：${record.generatedAt}`,
      "",
      "## 结果",
      "",
      `- 目标结果：${resultText}`,
      `- 人员安全：${safetyText}`,
      `- 救援通道：${routeText}`,
      `- 预警：${record.result.warningIssued ? `已发布（${formatTime(record.result.warningTime)}）` : "未发布"}`,
      `- 误报标记：${record.result.falseAlarm ? "是" : "否"}`,
      "",
      "## 环境峰值",
      "",
      `- 累计降雨：${record.environment.cumulativeRainMm} mm`,
      `- 最大雨强：${record.environment.maxRainMmPerHour} mm/h`,
      `- 最低安全余量：${record.environment.minStabilityPct}%`,
      `- 最大位移：${record.environment.maxDisplacementMm} mm`,
      `- 最高孔压：${record.environment.maxPoreKpa} kPa`,
      "",
      "## 传感器",
      "",
      "| ID | 传感器 | 点位 | 状态 | 适配度 |",
      "| --- | --- | --- | --- | --- |",
      ...record.sensors.map((sensor) =>
        `| ${sensor.id} | ${sensor.name} | ${sensor.anchorId} | ${sensor.status} | ${sensor.qualityPct}% |`
      ),
      "",
      "## 故障与恢复",
      "",
    ];

    if (!record.faults.length) {
      lines.push("本次记录未发生设备或参数故障。", "");
    } else {
      for (const fault of record.faults) {
        lines.push(
          `### ${fault.id} · ${fault.typeLabel}`,
          "",
          `- 发生时刻：${fault.timeLabel}（${fault.time} s）`,
          `- 当前余量：${fault.marginPct}%`,
          `- 预计稳定时间：${fault.ttfMin == null ? "大于 120 min" : `${fault.ttfMin} min`}`,
          `- 故障对象：${fault.sensorName}`,
          `- 系统响应：${fault.response}`,
          `- 恢复时刻：${fault.recoveredAt == null ? "未恢复" : formatTime(fault.recoveredAt)}`,
          `- 十分钟观察：${fault.observationVerified ? "通过，无连锁错误" : "未通过或未完成"}`,
          ""
        );
      }
    }

    lines.push("## 决策时间线", "", "| 仿真时刻 | 类别 | 事件 | 当前余量 |", "| --- | --- | --- | --- |");
    for (const event of record.timeline) {
      lines.push(`| ${event.time} | ${categoryLabels[event.category] || event.category} | ${event.title} | ${event.marginPct}% |`);
    }
    lines.push("", "## 成功判定", "", "- 两小时内无车辆受伤", "- 救援通道全程可用", "- 完成至少一次预警");
    return lines.join("\n");
  }

  function runCase(scenarioId, actions, options = {}) {
    const sim = new Simulation({ scenarioId, headless: true });
    const ordered = actions.slice().sort((a, b) => a.time - b.time);
    let actionIndex = 0;

    while (!sim.finished && !sim.failed && sim.t < DURATION) {
      while (actionIndex < ordered.length && ordered[actionIndex].time <= sim.t) {
        const action = ordered[actionIndex];
        try {
          action.run(sim);
        } catch (error) {
          action.error = error.message;
        }
        actionIndex += 1;
      }
      sim.advance();
    }

    const fault = sim.faults[0] || null;
    const success = sim.finished && sim.getSuccess();
    const checks = [];
    const check = (label, pass) => checks.push({ label, pass: Boolean(pass) });
    check("运行至两小时", sim.t >= DURATION);
    check("人员安全", sim.metrics.injuries === 0);
    check("救援通道可用", sim.metrics.routeUnavailableSeconds === 0 && !sim.roadBlocked);
    check("成功判定", success);

    if (scenarioId === "normal") {
      check("无故障注入", sim.faults.length === 0);
    } else {
      check("发生目标故障", sim.faults.length === 1);
      check("故障时刻准确", fault && fault.time === sim.scenario.faultTime);
      check("记录当前余量", fault && fault.marginPct > 0);
      check("系统响应已记录", fault && Boolean(fault.response));
      check("十分钟观察完成", sim.observation.complete);
      check("无状态跳变", !sim.observation.invalid && sim.observation.jumps === 0);
      check("无隐藏连锁错误", sim.faults.length === 1 && fault && fault.observationVerified);
    }

    return {
      id: scenarioId,
      label: sim.scenario.label,
      passed: checks.every((item) => item.pass),
      success,
      simTime: sim.t,
      timeLabel: formatTime(sim.t),
      faultTime: fault ? fault.timeLabel : null,
      faultMargin: fault ? fault.marginPct : null,
      faultResponse: fault ? fault.response : null,
      recoveredAt: fault && fault.recoveredAt != null ? formatTime(fault.recoveredAt) : null,
      observation: sim.observation.complete
        ? (sim.observation.invalid ? "未通过" : "通过，无状态跳变")
        : "未进入观察期",
      injuries: sim.metrics.injuries,
      rescueDelays: sim.metrics.rescueDelays,
      checks,
      error: ordered.find((action) => action.error)?.error || null,
    };
  }

  function runReliabilitySuite() {
    const addCommonSensors = (sim) => {
      sim.addSensor("displacement", "A");
      sim.addSensor("pore", "C");
    };

    const commonActions = [
      { time: 0, run: addCommonSensors },
      { time: 36 * 60, run: (sim) => sim.issueWarning() },
      { time: 20 * 60, run: (sim) => sim.setRoadMode("CONTROLLED") },
      { time: 38 * 60, run: (sim) => sim.reinforceSlope() },
    ];

    return [
      runCase("normal", commonActions.slice()),
      runCase("device", [
        ...commonActions,
        { time: 25 * 60, run: (sim) => sim.repairFault() },
      ]),
      runCase("parameter", [
        ...commonActions,
        { time: 34 * 60, run: (sim) => sim.repairFault() },
      ]),
    ];
  }

  return {
    DURATION,
    DT,
    OBSERVATION_SECONDS,
    FAILURE_MARGIN,
    RESCUE_WINDOWS,
    ANCHORS,
    SENSOR_TYPES,
    SCENARIOS,
    ALERT_LEVELS,
    Simulation,
    SeededRandom,
    clamp,
    round,
    formatTime,
    rainAt,
    buildDecisionRecord,
    recordToMarkdown,
    runReliabilitySuite,
  };
});
