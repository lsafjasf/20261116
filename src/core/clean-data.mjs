import { isWithinRange, key } from './sample-builder.mjs';
import { STATIONS, VALID_RANGE } from './constants.mjs';

const FIELDS = Object.keys(VALID_RANGE);

// 返回 { slots: Map(key -> slot), byStation, audit, quarantine }
// slot: { stationId, hour, values:{field: number|null}, reasons:{field:'missing'|'outlier'} }
export function cleanDataset(dataset) {
  const raw = dataset.rawRecords;
  const chosen = new Map();
  let duplicateDropped = 0;

  for (const rec of raw) {
    const k = key(rec.stationId, rec.hour);
    const prev = chosen.get(k);
    if (!prev) {
      chosen.set(k, rec);
    } else if (rec.seq > prev.seq) {
      chosen.set(k, rec);
      duplicateDropped += 1;
    } else {
      duplicateDropped += 1;
    }
  }

  const slots = new Map();
  const quarantine = [];
  const nullReasons = { missing: 0, outlier: 0 };

  for (const station of STATIONS) {
    for (let hour = 0; hour < 24; hour += 1) {
      const k = key(station.id, hour);
      const rec = chosen.get(k);
      const slot = { stationId: station.id, hour, values: {}, reasons: {} };
      for (const field of FIELDS) {
        const v = rec ? rec[field] : null;
        if (v === null || v === undefined || Number.isNaN(v)) {
          slot.values[field] = null;
          slot.reasons[field] = 'missing';
          nullReasons.missing += 1;
        } else if (!isWithinRange(field, v)) {
          slot.values[field] = null;
          slot.reasons[field] = 'outlier';
          nullReasons.outlier += 1;
          quarantine.push({ stationId: station.id, hour, field, badValue: v,
                            range: VALID_RANGE[field] });
        } else {
          slot.values[field] = v;
        }
      }
      slots.set(k, slot);
    }
  }

  const byStation = {};
  for (const station of STATIONS) {
    byStation[station.id] = Array.from({ length: 24 }, (_, hour) =>
      slots.get(key(station.id, hour)));
  }

  const audit = {
    datasetId: dataset.id,
    rawCount: raw.length,
    uniqueSlots: chosen.size,
    duplicateDropped,
    quarantined: quarantine.length,
    missingNulls: nullReasons.missing,
    outlierNulls: nullReasons.outlier
  };

  return { slots, byStation, audit, quarantine };
}

// 找出字段在窗口内的连续断档区间（用于验证“不用连续线伪造”）
export function gapSegments(slotsOfStation, field, window) {
  const segs = [];
  let start = null;
  for (let hour = window.start; hour <= window.end; hour += 1) {
    const v = slotsOfStation[hour].values[field];
    if (v === null) {
      if (start === null) start = hour;
    } else if (start !== null) {
      segs.push([start, hour - 1]);
      start = null;
    }
  }
  if (start !== null) segs.push([start, window.end]);
  return segs;
}
