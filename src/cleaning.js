// Cleaning pipeline. Rows are never sorted: every stage preserves the input
// sampling order and returns intermediate snapshots for the debug panel.

import { round6 } from './engine.js';

export const DEFAULT_RULES = {
  dedupe: true,
  nullStrategy: 'linear', // linear | forward | zero
  spikeStrategy: 'median', // median | clip | none
  spikeWindow: 5,
  spikeThreshold: 2.8
};

function assertOrder(rows) {
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].timestamp < rows[i - 1].timestamp) {
      throw new Error('sampling order violated at row ' + i);
    }
  }
}

function valueKey(row, seriesIds) {
  return seriesIds.map((id) => String(row.values[id])).join('|');
}

// Stage 1: collapse rows that repeat the same timestamp and value vector.
export function dedupeRows(rows, seriesIds) {
  const seen = new Set();
  const kept = [];
  const removed = [];
  for (const row of rows) {
    const key = row.timestamp + '#' + valueKey(row, seriesIds);
    if (seen.has(key)) {
      removed.push(row);
    } else {
      seen.add(key);
      kept.push(structuredClone(row));
    }
  }
  return { rows: kept, removed, keptCount: kept.length, removedCount: removed.length };
}

function interpolate(series, index, strategy) {
  if (strategy === 'zero') return 0;
  let prev = index - 1;
  while (prev >= 0 && series[prev].clean === null) prev -= 1;
  let next = index + 1;
  while (next < series.length && series[next].clean === null) next += 1;
  const hasPrev = prev >= 0;
  const hasNext = next < series.length;
  if (strategy === 'forward') {
    return hasPrev ? series[prev].clean : hasNext ? series[next].clean : 0;
  }
  // linear interpolation between nearest valid neighbors
  if (hasPrev && hasNext) {
    const span = next - prev;
    const ratio = (index - prev) / span;
    return round6(
      series[prev].clean + (series[next].clean - series[prev].clean) * ratio
    );
  }
  if (hasPrev) return series[prev].clean;
  if (hasNext) return series[next].clean;
  return 0;
}

function median(sorted) {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function rollingStats(series, index, window) {
  const start = Math.max(0, index - window);
  const end = Math.min(series.length, index + window + 1);
  const neighbors = [];
  for (let i = start; i < end; i += 1) {
    if (i !== index && series[i].clean !== null) neighbors.push(series[i].clean);
  }
  const sorted = [...neighbors].sort((a, b) => a - b);
  if (neighbors.length < 4) {
    return { med: series[index].clean, mad: Infinity, robustSigma: Infinity };
  }
  const med = median(sorted);
  const deviations = neighbors.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = median(deviations);
  const robustSigma = Math.max(1.4826 * mad, 0.8);
  return { med, mad, robustSigma };
}

// Series-wide robust scale. Unlike a small rolling window it stays stable at
// the edges where only one-sided neighbors are available.
function globalRobustScale(series) {
  const values = series.map((entry) => entry.clean).sort((a, b) => a - b);
  const med = median(values);
  const deviations = values.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return {
    median: med,
    robustSigma: Math.max(1.4826 * median(deviations), 0.8)
  };
}

// Run the full pipeline and collect per-stage snapshots plus an audit log.
export function cleanSeries(sample, rules) {
  const effective = { ...DEFAULT_RULES, ...rules };
  const { rows: rawRows, seriesIds } = sample;
  assertOrder(rawRows);

  const log = [];
  log.push({ stage: 'input', rowsIn: rawRows.length, note: 'order check passed' });

  const dedupe = effective.dedupe
    ? dedupeRows(rawRows, seriesIds)
    : {
        rows: structuredClone(rawRows),
        removed: [],
        keptCount: rawRows.length,
        removedCount: 0
      };
  log.push({
    stage: 'dedupe',
    enabled: effective.dedupe,
    rowsOut: dedupe.rows.length,
    removed: dedupe.removedCount
  });

  const rows = dedupe.rows;
  const perSeries = {};
  for (const seriesId of seriesIds) {
    const series = rows.map((row) => ({
      row,
      raw: row.values[seriesId],
      clean: row.values[seriesId],
      filled: false,
      spike: false,
      z: null
    }));

    let nullCount = 0;
    for (let i = 0; i < series.length; i += 1) {
      if (series[i].clean === null) {
        series[i].clean = round6(interpolate(series, i, effective.nullStrategy));
        series[i].filled = true;
        nullCount += 1;
      }
    }

    let spikeCount = 0;
    const replacements = [];
    if (effective.spikeStrategy !== 'none') {
      const globalScale = globalRobustScale(series);
      for (let i = 0; i < series.length; i += 1) {
        const { med } = rollingStats(series, i, effective.spikeWindow);
        const z =
          Math.abs(series[i].clean - globalScale.median) / globalScale.robustSigma;
        series[i].z = round6(z);
        const absDeviation = Math.abs(series[i].clean - globalScale.median);
        if (z > effective.spikeThreshold && absDeviation > 3) {
          series[i].spike = true;
          spikeCount += 1;
          replacements.push({
            index: series[i].row.index,
            timestamp: series[i].row.timestamp,
            before: series[i].clean,
            robustZ: round6(z),
            median: round6(globalScale.median)
          });
        }
      }
      for (const item of series.filter((entry) => entry.spike)) {
        const { med } = rollingStats(
          series,
          series.indexOf(item),
          effective.spikeWindow
        );
        item.clean =
          effective.spikeStrategy === 'clip'
            ? round6(
                globalScale.median +
                  Math.sign(item.clean - globalScale.median) *
                    effective.spikeThreshold *
                    globalScale.robustSigma
              )
            : round6(med);
      }
    }

    perSeries[seriesId] = { series, nullCount, spikeCount, replacements };
    log.push({
      stage: 'clean:' + seriesId,
      nullFilled: nullCount,
      spikes: spikeCount,
      nullStrategy: effective.nullStrategy,
      spikeStrategy: effective.spikeStrategy
    });
  }

  const lookup = new Map(
    seriesIds.map((seriesId) => [
      seriesId,
      new Map(perSeries[seriesId].series.map((entry) => [entry.row.timestamp, entry.clean]))
    ])
  );

  const cleanedRows = rows.map((row) => {
    const values = {};
    for (const seriesId of seriesIds) {
      values[seriesId] = lookup.get(seriesId).get(row.timestamp);
    }
    return { index: row.index, timestamp: row.timestamp, values, reference: row.reference };
  });
  assertOrder(cleanedRows);

  return { rules: effective, dedupe, perSeries, cleanedRows, log };
}
