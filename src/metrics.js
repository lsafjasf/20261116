// Windowing, error metrics, versioning and export payload construction.

import { round6 } from './engine.js';

export const WINDOWS = [
  { id: 'W1', label: '窗口 1（前半段）' },
  { id: 'W2', label: '窗口 2（后半段）' }
];

// Split at the midpoint timestamp. Both windows always contain defects in
// the fixed samples, and the relative row order is never changed.
export function splitWindows(rows) {
  const first = rows[0]?.timestamp ?? 0;
  const last = rows[rows.length - 1]?.timestamp ?? 0;
  const midpoint = (first + last) / 2;
  const buckets = { W1: [], W2: [] };
  for (const row of rows) {
    buckets[row.timestamp <= midpoint ? 'W1' : 'W2'].push(row);
  }
  return buckets;
}

export function seriesMetrics(seriesEntries, seriesId) {
  let sumAbs = 0;
  let maxAbs = -Infinity;
  let maxAt = null;
  let count = 0;
  const points = [];
  for (const entry of seriesEntries) {
    const actual = entry.values[seriesId];
    const reference = entry.reference[seriesId];
    const diff = round6(actual - reference);
    const abs = Math.abs(diff);
    sumAbs += abs;
    count += 1;
    if (abs > maxAbs) {
      maxAbs = abs;
      maxAt = entry.timestamp;
    }
    points.push({ timestamp: entry.timestamp, actual, reference, diff, abs });
  }
  return {
    seriesId,
    count,
    mae: count ? round6(sumAbs / count) : 0,
    maxDev: round6(maxAbs === -Infinity ? 0 : maxAbs),
    maxAt,
    points
  };
}

export function evaluateWindow(cleanedRows, windowRows, seriesIds) {
  const perSeries = {};
  let totalAbs = 0;
  let totalMax = 0;
  let totalCount = 0;
  for (const seriesId of seriesIds) {
    const metrics = seriesMetrics(windowRows, seriesId);
    perSeries[seriesId] = metrics;
    totalAbs += metrics.mae * metrics.count;
    totalCount += metrics.count;
    totalMax = Math.max(totalMax, metrics.maxDev);
  }
  return {
    rowCount: windowRows.length,
    totalRows: cleanedRows.length,
    overall: {
      mae: totalCount ? round6(totalAbs / totalCount) : 0,
      maxDev: round6(totalMax)
    },
    perSeries
  };
}

// Stable 32-bit FNV-1a hash for a canonical JSON payload.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

export function hashPayload(payload) {
  const text = JSON.stringify(canonical(payload));
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ('0000000' + (hash >>> 0).toString(16)).slice(-8);
}

export function buildDataVersion(sampleId, rules, cleanedRows) {
  const digest = hashPayload({
    sampleId,
    rules,
    rows: cleanedRows.map((row) => [row.index, row.timestamp, row.values])
  });
  return `${sampleId}-r${cleanedRows.length}-${digest}`;
}

// Single source of truth used by the status bar, PNG metadata and log export.
export function buildExportScope(state) {
  return {
    sampleId: state.sampleId,
    windowId: state.windowId,
    seriesIds: state.seriesIds,
    rules: state.rules,
    dataVersion: state.dataVersion,
    generatedAt: new Date().toISOString(),
    counts: {
      rawRows: state.rawRows.length,
      cleanedRows: state.cleanedRows.length,
      windowRows: state.windowRows.length,
      duplicatesRemoved: state.pipeline.dedupe.removedCount
    },
    metrics: state.windowEvaluation.overall
  };
}

export function buildCleaningLog(state) {
  const scope = buildExportScope(state);
  return {
    exportScope: scope,
    pipelineLog: state.pipeline.log,
    replacementsBySeries: Object.fromEntries(
      Object.entries(state.pipeline.perSeries).map(([id, detail]) => [
        id,
        detail.replacements
      ])
    ),
    windowMetrics: state.windowEvaluation
  };
}

export function buildProject(state) {
  return {
    format: 'ts-cleaning-monitor/project',
    formatVersion: 1,
    savedAt: new Date().toISOString(),
    sampleId: state.sampleId,
    rulesByWindow: state.rulesByWindow,
    activeWindow: state.windowId,
    dataVersion: state.dataVersion,
    samples: state.samples
  };
}
