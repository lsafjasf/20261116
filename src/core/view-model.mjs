import { STATIONS } from './constants.mjs';
import { gapSegments } from './clean-data.mjs';

export function clampCursor(hour, window) {
  if (hour < window.start) return window.start;
  if (hour > window.end) return window.end;
  return hour;
}

// 统一时间轴映射：曲线 x 轴与地图时间控件使用同一个函数，保证刻度/范围同步
export function makeTimeScale(window, width, padding) {
  const span = window.end - window.start;
  const usable = width - padding.left - padding.right;
  return {
    xForHour: (hour) => padding.left + ((hour - window.start) / span) * usable,
    hourForX: (x) => {
      const h = window.start + ((x - padding.left) / usable) * span;
      return Math.round(h);
    },
    ticks: Array.from({ length: span + 1 }, (_, i) => window.start + i)
  };
}

function validValues(slotsOfStation, field, window) {
  const out = [];
  for (let hour = window.start; hour <= window.end; hour += 1) {
    const v = slotsOfStation[hour].values[field];
    if (v !== null) out.push({ hour, value: v });
  }
  return out;
}

// 窗口统计：仅基于有效值；空值/异常不计入，也不插值
export function computeWindowStats(clean, window) {
  const perStation = {};
  const domains = { tempC: [Infinity, -Infinity], precipMm: [Infinity, -Infinity] };
  const peaks = [];
  const gaps = [];

  for (const station of STATIONS) {
    const series = clean.byStation[station.id];
    const entry = { stationId: station.id, fields: {} };
    for (const field of ['tempC', 'precipMm', 'windDirDeg']) {
      const vals = validValues(series, field, window);
      if (vals.length > 0) {
        const values = vals.map((p) => p.value);
        entry.fields[field] = {
          count: vals.length,
          min: Math.min(...values),
          max: Math.max(...values)
        };
        if (field === 'tempC' || field === 'precipMm') {
          domains[field][0] = Math.min(domains[field][0], entry.fields[field].min);
          domains[field][1] = Math.max(domains[field][1], entry.fields[field].max);
        }
      } else {
        entry.fields[field] = { count: 0, min: null, max: null };
      }
    }

    // 峰值：窗口内有效最大值所在小时（含并列时取首个）
    for (const field of ['tempC', 'precipMm']) {
      const vals = validValues(series, field, window);
      if (vals.length > 0) {
        const top = vals.reduce((a, b) => (b.value > a.value ? b : a));
        peaks.push({ stationId: station.id, field, hour: top.hour, value: top.value });
      }
    }

    for (const field of ['tempC', 'precipMm', 'windDirDeg']) {
      for (const seg of gapSegments(series, field, window)) {
        gaps.push({ stationId: station.id, field, start: seg[0], end: seg[1] });
      }
    }
    perStation[station.id] = entry;
  }

  if (domains.tempC[0] === Infinity) domains.tempC = [0, 1];
  if (domains.precipMm[0] === Infinity) domains.precipMm = [0, 1];
  return { perStation, domains, peaks, gaps };
}

// 游标时刻各站点读数（空值保留 null，由读数面板显式标注“缺测”）
export function cursorReadout(clean, hour) {
  return STATIONS.map((station) => {
    const slot = clean.byStation[station.id][hour];
    return {
      stationId: station.id,
      stationName: station.name,
      hour,
      values: slot.values,
      reasons: slot.reasons
    };
  });
}
