// Pure data engine: deterministic sample generation, cleaning pipeline,
// metrics and export payloads. Shared by the browser UI and Node tests.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function round6(x) {
  if (!Number.isFinite(x)) return x;
  return Math.round(x * 1e6) / 1e6;
}

// Clean reference ground truth: smooth periodic + slow drift, three series.
export function referenceValue(seriesId, t) {
  const base = { s1: 40, s2: 60, s3: 25 }[seriesId];
  const amp = { s1: 12, s2: 8, s3: 15 }[seriesId];
  const period = { s1: 26, s2: 34, s3: 21 }[seriesId];
  return round6(
    base +
      amp * Math.sin((2 * Math.PI * t) / period) +
      2.5 * Math.cos((2 * Math.PI * t) / 57) +
      0.04 * t
  );
}

// Deterministic defect manifest per sample so tests can assert exact behavior.
export const DEFECT_MANIFEST = {
  sampleA: {
    nulls: [3, 11, 19, 27, 38, 46, 55],
    duplicates: [7, 22, 41],
    spikes: [
      { index: 5, factor: 6 },
      { index: 16, factor: -5 },
      { index: 33, factor: 7 },
      { index: 50, factor: -6 }
    ]
  },
  sampleB: {
    nulls: [2, 14, 24, 36, 48, 60, 62],
    duplicates: [4, 18, 30, 52],
    spikes: [
      { index: 9, factor: 8 },
      { index: 27, factor: -7 },
      { index: 44, factor: 6 },
      { index: 63, factor: -9 }
    ]
  }
};

// Build one fixed sample: 64 ordered rows x 3 series, injected defects.
export function generateSample(sampleId) {
  const seed = sampleId === 'sampleA' ? 20261116 : 987654321;
  const rand = mulberry32(seed);
  const manifest = DEFECT_MANIFEST[sampleId];
  const length = 64;
  const seriesIds = ['s1', 's2', 's3'];
  const rows = [];

  for (let index = 0; index < length; index += 1) {
    const timestamp = 1700000000000 + index * 60000; // 1-minute cadence
    const row = { index, timestamp, values: {}, reference: {} };
    for (const seriesId of seriesIds) {
      const truth = referenceValue(seriesId, index);
      row.reference[seriesId] = truth;
      let value = round6(truth + (rand() - 0.5) * 0.8);
      row.values[seriesId] = value;
    }
    rows.push(row);
  }

  injectDefects(rows, manifest, seriesIds, rand);
  return {
    sampleId,
    seed,
    generatedAt: '2026-11-16T00:00:00+08:00',
    cadenceMs: 60000,
    seriesIds,
    manifest,
    rows
  };
}

function injectDefects(rows, manifest, seriesIds, rand) {
  // Nulls and spikes are applied while rows still sit at their canonical index,
  // so every manifest entry maps to one deterministic row.
  for (const index of manifest.nulls) {
    const seriesId = seriesIds[index % seriesIds.length];
    rows[index].values[seriesId] = null;
  }
  for (const spike of manifest.spikes) {
    const seriesId = seriesIds[spike.index % seriesIds.length];
    const row = rows[spike.index];
    const current = row.values[seriesId];
    row.values[seriesId] = round6(
      (current ?? 0) + spike.factor * 10 + (rand() - 0.5)
    );
    row.spike = { seriesId, factor: spike.factor };
  }
  // Duplicate rows are inserted last and intentionally repeat the timestamp.
  for (const index of manifest.duplicates) {
    const source = rows.find((candidate) => candidate.index === index);
    const dup = structuredClone(source);
    dup.duplicateOf = index;
    rows.splice(rows.indexOf(source) + 1, 0, dup);
  }
}
