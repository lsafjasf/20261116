// 中央状态 store：所有参数变化都经过 set()，并计算受影响的逻辑区域，
// 引擎据此只更新对应的 uniform / 资源，界面刷新不会触发场景重建。

export const REGIONS = Object.freeze([
  'quality',
  'weather',
  'wind',
  'humidity',
  'sun',
  'camera',
  'time',
  'viewport',
  'playback',
]);

const LIMITS = Object.freeze({
  windSpeed: [0, 30],
  humidity: [0, 1],
  sunAzimuth: [0, 360],
  sunElevation: [1, 89],
  camAzimuth: [-75, 75],
  camElevation: [-8, 30],
});

export function clampParam(key, value) {
  const limit = LIMITS[key];
  const num = Number(value);
  if (!limit || !Number.isFinite(num)) return null;
  return Math.min(limit[1], Math.max(limit[0], num));
}

function regionOfKey(key) {
  if (key === 'quality') return 'quality';
  if (key === 'windSpeed' || key === 'windDir') return 'wind';
  if (key === 'humidity') return 'humidity';
  if (key === 'sunAzimuth' || key === 'sunElevation') return 'sun';
  if (key === 'camAzimuth' || key === 'camElevation') return 'camera';
  if (key === 'simTime') return 'time';
  if (key === 'width' || key === 'height' || key === 'pixelRatio') return 'viewport';
  if (key === 'paused') return 'playback';
  return 'weather';
}

export class Store {
  constructor(initial) {
    this.state = structuredClone(initial);
    this.listeners = new Set();
    this.updateLog = [];
    this.seq = 0;
    this.rejected = [];
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // patch: 扁平的键值片段；返回真正发生变化的区域集合。
  set(patch, source = 'ui') {
    const changedRegions = new Set();
    const changedKeys = [];
    const rejected = [];
    for (const [key, raw] of Object.entries(patch)) {
      if (!(key in this.state)) {
        rejected.push({ key, reason: 'unknown-key' });
        continue;
      }
      if (key in LIMITS) {
        const clamped = clampParam(key, raw);
        if (clamped === null) {
          rejected.push({ key, value: raw, reason: 'non-finite' });
          continue;
        }
        if (clamped !== this.state[key]) {
          this.state[key] = clamped;
          changedKeys.push(key);
          changedRegions.add(regionOfKey(key));
        }
        continue;
      }
      if (this.state[key] !== raw) {
        this.state[key] = raw;
        changedKeys.push(key);
        changedRegions.add(regionOfKey(key));
      }
    }
    if (rejected.length) {
      this.rejected.push({ seq: this.seq, source, rejected });
    }
    if (changedRegions.size === 0) {
      return { changedRegions, changedKeys: [], fullRebuild: false, noop: true };
    }
    const fullRebuild = changedRegions.has('quality');
    const record = {
      seq: this.seq++,
      source,
      changedKeys,
      changedRegions: [...changedRegions],
      fullRebuild,
      time: performance.now(),
    };
    this.updateLog.push(record);
    for (const fn of this.listeners) fn(record);
    return { ...record, noop: false };
  }

  // 用快照恢复：与当前状态做 diff，只标记真正变化的区域。
  restore(snapshot, source = 'restore') {
    const patch = {};
    for (const [key, value] of Object.entries(snapshot.state)) {
      if (key in this.state) patch[key] = value;
    }
    return this.set(patch, source);
  }

  snapshot() {
    return { version: 1, state: structuredClone(this.state) };
  }

  regionCounts() {
    const counts = Object.fromEntries(REGIONS.map((r) => [r, 0]));
    for (const rec of this.updateLog) {
      for (const r of rec.changedRegions) counts[r] += 1;
    }
    return counts;
  }
}
