export const CONFIG = {
  tickHz: 60,
  tickDt: 1 / 60,

  // 梭子速度单位：投梭次数/秒
  speedMin: 1.0,
  speedMax: 3.0,
  safeSpeedLow: 1.4,
  safeSpeedHigh: 2.5,
  speedStart: 2.0,

  // 张力（cN）
  tensionBase: 32,
  tensionShedDelta: 4,
  tensionNoise: 0.6,
  tensionNormal: 40,
  tensionAnomaly: 52,
  tensionBreak: 62,
  tensionRecovered: 34,

  // 风险事件概率（每次投梭结算时掷一次随机数）
  pSlowMissAtMin: 0.35,
  pAnomalyAtMax: 0.12,
  pBreakPerTick: 0.04,

  // 织物与资源
  targetLengthCm: 10,
  initialWeft: 240,
  initialBobbins: 3,
  weftPerPick: 1,
  bobbinWeft: 80,

  // 机械
  shuttleCycleTicksAtSpeed1: 60,
};

export const PHASE = {
  READY: 'READY',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  STOPPED: 'STOPPED',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
};

export const FAULT = {
  NONE: null,
  MISS_PICK: 'MISS_PICK',
  ANOMALY: 'ANOMALY',
  BREAK: 'BREAK',
  NO_WEFT: 'NO_WEFT',
};
