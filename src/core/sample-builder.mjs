import { STATIONS, VALID_RANGE } from './constants.mjs';

// 确定性基线：无随机数，保证内置样例每次完全一致。
// 每条原始记录带 seq，重复记录以 seq 最大者（最后写入）为准。
export function buildBaseRecords(baseDate, seed) {
  const records = [];
  let seq = 0;
  for (const station of STATIONS) {
    const s = Number(station.id.slice(1));
    for (let hour = 0; hour < 24; hour += 1) {
      const wave = Math.sin((hour - 9 + s) / 3.6) * 6;
      records.push({
        stationId: station.id,
        hour,
        date: baseDate,
        tempC: round1(14 + wave + s * 1.4),
        precipMm: hour >= 14 && hour <= 19 ? round1((hour - 13) * (1.2 + s * 0.3)) : 0,
        windDirDeg: Math.round((hour * 17 + s * 80) % 360),
        windSpeedKmh: round1(6 + ((hour * 7 + s * 11) % 18)),
        cloudPct: Math.round(20 + 55 * (0.5 + 0.5 * Math.sin(hour / 3 + s))),
        seq: seq++
      });
    }
  }
  return records;
}

// anomalies: { nulls:[[stationId,hour,field]], outliers:[[stationId,hour,field,badValue]],
//             duplicates:[[stationId,hour,overrides]] }
export function applyAnomalies(records, baseDate, anomalies, seqStart) {
  const out = records.map((r) => ({ ...r }));
  let seq = seqStart;
  const byKey = new Map(out.map((r) => [key(r.stationId, r.hour), r]));

  for (const [stationId, hour, field] of anomalies.nulls ?? []) {
    byKey.get(key(stationId, hour))[field] = null;
  }
  for (const [stationId, hour, field, bad] of anomalies.outliers ?? []) {
    byKey.get(key(stationId, hour))[field] = bad;
  }
  for (const [stationId, hour, overrides] of anomalies.duplicates ?? []) {
    const original = byKey.get(key(stationId, hour));
    // 重复记录：追加一条同键记录，seq 更大；清洗阶段保留最后一条
    out.push({ ...original, ...overrides, seq: seq++, date: baseDate, _duplicate: true });
  }
  return out;
}

export function key(stationId, hour) {
  return `${stationId}#${hour}`;
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}

export function isWithinRange(field, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return false;
  const [lo, hi] = VALID_RANGE[field];
  return value >= lo && value <= hi;
}
