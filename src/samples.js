export const GRID = Object.freeze({
  cols: 30,
  rows: 18,
  cellSizeM: 100,
  origin: "30.12°N, 118.47°E",
});

export const SAMPLE_DEFINITIONS = Object.freeze([
  {
    id: "north-ridge",
    code: "A",
    name: "北岭沟谷",
    revision: "2026.11.16-A",
    fixture: "FX-A-071",
    seed: 81531,
    stride: 7,
    offset: 2,
    nullCells: [
      [4, 6],
      [12, 19],
    ],
    duplicateCells: [
      [3, 21],
      [9, 9],
    ],
    outlierCells: [
      [6, 14],
      [14, 24],
    ],
    description: "北岭背斜与主沟交汇，汇流集中，适合比较中高风险阈值。",
  },
  {
    id: "south-terrace",
    code: "B",
    name: "南坡台地",
    revision: "2026.11.16-B",
    fixture: "FX-B-142",
    seed: 27409,
    stride: 9,
    offset: 4,
    nullCells: [
      [2, 10],
      [8, 3],
      [15, 22],
    ],
    duplicateCells: [
      [5, 18],
      [11, 13],
    ],
    outlierCells: [
      [4, 25],
      [13, 5],
    ],
    description: "南坡缓台地与两条支沟，风险区更分散，用于阈值敏感性对照。",
  },
]);

export function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothNoise(seed, cols, rows) {
  const random = mulberry32(seed);
  const coarseCols = 7;
  const coarseRows = 5;
  const coarse = Array.from({ length: coarseRows * coarseCols }, random);
  const sample = (col, row) => {
    const x = (col / (cols - 1)) * (coarseCols - 1);
    const y = (row / (rows - 1)) * (coarseRows - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(coarseCols - 1, x0 + 1);
    const y1 = Math.min(coarseRows - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const top = coarse[y0 * coarseCols + x0] * (1 - tx) + coarse[y0 * coarseCols + x1] * tx;
    const bottom =
      coarse[y1 * coarseCols + x0] * (1 - tx) + coarse[y1 * coarseCols + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  };
  return sample;
}

export function generateBaseElevations(seed, cols = GRID.cols, rows = GRID.rows) {
  const noise = smoothNoise(seed, cols, rows);
  const seedShift = ((seed % 97) / 97) * Math.PI;
  return Array.from({ length: rows * cols }, (_, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const x = col / (cols - 1);
    const y = row / (rows - 1);
    const ridge =
      148 * Math.exp(-(((x - 0.28) / 0.24) ** 2 + ((y - 0.27) / 0.34) ** 2));
    const shoulder =
      104 * Math.exp(-(((x - 0.74) / 0.19) ** 2 + ((y - 0.66) / 0.27) ** 2));
    const valley =
      -118 * Math.exp(-(((x - 0.57) / 0.12) ** 2 + ((y - 0.48) / 0.75) ** 2));
    const waves =
      28 * Math.sin(x * 12.4 + seedShift) * Math.cos(y * 8.2 - seedShift * 0.4);
    const trend = 72 * (1 - x) + 36 * (1 - y);
    const texture = (noise(col, row) - 0.5) * 54;
    return 292 + ridge + shoulder + valley + waves + trend + texture;
  });
}

const pad = (value, length = 2) => String(value).padStart(length, "0");

export function buildRawRecords(sample, baseElevations) {
  const { cols, rows } = GRID;
  const forced = new Set();
  const addCell = (col, row) => forced.add(`${row}:${col}`);
  sample.nullCells.forEach(([row, col]) => addCell(col, row));
  sample.duplicateCells.forEach(([row, col]) => addCell(col, row));
  sample.outlierCells.forEach(([row, col]) => addCell(col, row));

  const random = mulberry32(sample.seed ^ 0xa5a5a5a5);
  const records = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const selected =
        (row * 13 + col * 7 + sample.offset) % sample.stride === 0 ||
        forced.has(`${row}:${col}`);
      if (!selected) continue;
      const base = baseElevations[row * cols + col];
      records.push({
        id: `${sample.code}-R${pad(row)}C${pad(col)}`,
        row,
        col,
        elevation: Math.round((base + (random() - 0.5) * 19) * 10) / 10,
        observedAt: `2026-11-${pad(2 + (row % 12))}T${pad(8 + (col % 8))}:00:00+08:00`,
        source: "固定样例 / RTK",
      });
    }
  }

  const recordAt = (row, col) =>
    records.find((record) => record.row === row && record.col === col);

  sample.duplicateCells.forEach(([row, col], index) => {
    const current = recordAt(row, col);
    records.push({
      ...current,
      elevation: Math.round((current.elevation - 7.4 - index * 2.1) * 10) / 10,
      observedAt: "2026-11-01T09:10:00+08:00",
      source: "固定样例 / 重复记录",
    });
  });

  sample.nullCells.forEach(([row, col]) => {
    recordAt(row, col).elevation = null;
  });

  sample.outlierCells.forEach(([row, col], index) => {
    recordAt(row, col).elevation = index % 2 === 0 ? 9999 : -620;
  });

  return records;
}

export function getSampleDefinition(sampleId) {
  return SAMPLE_DEFINITIONS.find((sample) => sample.id === sampleId) || SAMPLE_DEFINITIONS[0];
}
