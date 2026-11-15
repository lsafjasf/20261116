import {
  GRID,
  SAMPLE_DEFINITIONS,
  buildRawRecords,
  generateBaseElevations,
  getSampleDefinition,
} from "./samples.js";

export const PROJECT_SCHEMA = "terrain-flow-project/v1";
export const DATA_SCHEMA_VERSION = "2026.11.16-r3";
export const LAYERS = Object.freeze(["terrain", "slope", "aspect", "flow"]);
export const LAYER_LABELS = Object.freeze({
  terrain: "地形",
  slope: "坡度",
  aspect: "坡向",
  flow: "汇流风险",
});
export const DEFAULT_STATE = Object.freeze({
  sampleId: "north-ridge",
  thresholdA: 62,
  thresholdB: 45,
  layer: "flow",
  showArrows: true,
  showGrid: true,
  selectedId: null,
  hoverId: null,
});

const ASPECT_LABELS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const ASPECT_ZH = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
const FLOW_VECTORS = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const pad = (value) => String(value).padStart(2, "0");

export function cellId(row, col) {
  return `${row}:${col}`;
}

export function parseCellId(id) {
  if (typeof id !== "string" || !/^\d+:\d+$/.test(id)) return null;
  const [row, col] = id.split(":").map(Number);
  if (row < 0 || row >= GRID.rows || col < 0 || col >= GRID.cols) return null;
  return { row, col };
}

export function bearingLabel(bearing) {
  const index = Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
  return ASPECT_LABELS[index];
}

export function bearingLabelZh(bearing) {
  const index = Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
  return ASPECT_ZH[index];
}

function cleanElevation(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeRecords(sample, rawRecords, baseElevations) {
  const { rows, cols } = GRID;
  const elevations = baseElevations.map((value) => round(value, 1));
  const statuses = Array.from({ length: rows * cols }, () => "generated");
  const stats = {
    rawRecords: rawRecords.length,
    duplicateRecords: 0,
    nullRecords: 0,
    outlierRecords: 0,
    measuredRecords: 0,
    generatedRecords: 0,
    invalidRecords: 0,
  };
  const repairs = [];
  const byId = new Map();
  const sorted = [...rawRecords].sort(
    (left, right) =>
      new Date(right.observedAt).getTime() - new Date(left.observedAt).getTime(),
  );

  for (const record of sorted) {
    if (byId.has(record.id)) {
      stats.duplicateRecords += 1;
      continue;
    }
    const parsed = parseCellId(cellId(record.row, record.col));
    if (!parsed) {
      stats.invalidRecords += 1;
      continue;
    }
    byId.set(record.id, record);
    const index = parsed.row * cols + parsed.col;
    const base = baseElevations[index];
    const observed = cleanElevation(record.elevation);
    if (observed === null) {
      stats.nullRecords += 1;
      elevations[index] = round(base, 1);
      statuses[index] = "imputed";
      repairs.push({
        id: record.id,
        type: "null",
        action: "邻域基线填补",
        value: round(base, 1),
      });
      continue;
    }
    if (Math.abs(observed - base) > 320) {
      stats.outlierRecords += 1;
      const repaired = base + Math.sign(observed - base || 1) * 82;
      elevations[index] = round(repaired, 1);
      statuses[index] = "clamped";
      repairs.push({
        id: record.id,
        type: "outlier",
        action: "偏离基线 > 320 m，边界截断",
        value: round(repaired, 1),
      });
      continue;
    }
    stats.measuredRecords += 1;
    elevations[index] = round(observed, 1);
    statuses[index] = "measured";
  }

  stats.generatedRecords = rows * cols - byId.size;
  return { elevations, statuses, stats, repairs: repairs.slice(0, 6) };
}

function gradientAt(elevations, row, col) {
  const { rows, cols, cellSizeM } = GRID;
  const colBefore = Math.max(0, col - 1);
  const colAfter = Math.min(cols - 1, col + 1);
  const rowBefore = Math.max(0, row - 1);
  const rowAfter = Math.min(rows - 1, row + 1);
  const eastWestSpan = (colAfter - colBefore) * cellSizeM;
  const northSouthSpan = (rowAfter - rowBefore) * cellSizeM;
  const dzdx =
    (elevations[row * cols + colAfter] - elevations[row * cols + colBefore]) /
    eastWestSpan;
  const dzdy =
    (elevations[rowAfter * cols + col] - elevations[rowBefore * cols + col]) /
    northSouthSpan;
  return { dzdx, dzdy };
}

function computeTerrainMetrics(elevations) {
  const { rows, cols } = GRID;
  return elevations.map((elevation, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const { dzdx, dzdy } = gradientAt(elevations, row, col);
    const slopeRad = Math.atan(Math.hypot(dzdx, dzdy));
    const slopeDeg = (slopeRad * 180) / Math.PI;
    const aspectDeg = (((Math.atan2(-dzdx, dzdy) * 180) / Math.PI) % 360 + 360) % 360;
    const hillshade =
      0.5 * Math.cos(slopeRad) +
      0.5 * Math.sin(slopeRad) * Math.cos(((315 - aspectDeg) * Math.PI) / 180);
    return {
      slopeDeg: round(slopeDeg, 2),
      aspectDeg: round(aspectDeg, 1),
      hillshade: round(clamp(hillshade, 0.08, 1), 3),
      dzdx,
      dzdy,
    };
  });
}

function computeFlow(elevations) {
  const { rows, cols, cellSizeM } = GRID;
  const flow = elevations.map(() => ({
    downstreamIndex: -1,
    flowDirDeg: null,
    flowDirCode: "SINK",
    flowAccum: 1,
  }));

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      let bestDrop = 0;
      let bestDirection = -1;
      FLOW_VECTORS.forEach(([dx, dy], direction) => {
        const nextCol = col + dx;
        const nextRow = row + dy;
        if (nextCol < 0 || nextCol >= cols || nextRow < 0 || nextRow >= rows) return;
        const nextIndex = nextRow * cols + nextCol;
        const distance = Math.hypot(dx, dy) * cellSizeM;
        const drop = (elevations[index] - elevations[nextIndex]) / distance;
        if (drop > bestDrop + 1e-12) {
          bestDrop = drop;
          bestDirection = direction;
        }
      });
      if (bestDirection >= 0) {
        const [dx, dy] = FLOW_VECTORS[bestDirection];
        flow[index].downstreamIndex = (row + dy) * cols + col + dx;
        flow[index].flowDirDeg = bestDirection * 45;
        flow[index].flowDirCode = ASPECT_LABELS[bestDirection];
      }
    }
  }

  const descending = elevations
    .map((elevation, index) => ({ elevation, index }))
    .sort((left, right) => right.elevation - left.elevation);
  descending.forEach(({ index }) => {
    const downstream = flow[index].downstreamIndex;
    if (downstream >= 0) flow[downstream].flowAccum += flow[index].flowAccum;
  });
  const maxAccum = Math.max(...flow.map((entry) => entry.flowAccum));
  flow.forEach((entry) => {
    entry.riskIndex =
      maxAccum > 1
        ? round((Math.log1p(entry.flowAccum - 1) / Math.log1p(maxAccum - 1)) * 100, 1)
        : 0;
  });
  return { flow, maxAccum };
}

export function processSample(sampleId) {
  const sample = getSampleDefinition(sampleId);
  const baseElevations = generateBaseElevations(sample.seed);
  const rawRecords = buildRawRecords(sample, baseElevations);
  const { elevations, statuses, stats, repairs } = normalizeRecords(
    sample,
    rawRecords,
    baseElevations,
  );
  const metrics = computeTerrainMetrics(elevations);
  const { flow, maxAccum } = computeFlow(elevations);
  const { rows, cols } = GRID;
  const cells = elevations.map((elevation, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const downstreamIndex = flow[index].downstreamIndex;
    return {
      id: cellId(row, col),
      index,
      row,
      col,
      elevation,
      baseElevation: round(baseElevations[index], 1),
      dataStatus: statuses[index],
      ...metrics[index],
      ...flow[index],
      downstreamId:
        downstreamIndex >= 0
          ? cellId(Math.floor(downstreamIndex / cols), downstreamIndex % cols)
          : null,
      isSink: downstreamIndex < 0,
      flowDirLabel: flow[index].flowDirDeg === null ? "汇" : flow[index].flowDirCode,
      aspectLabel: bearingLabel(metrics[index].aspectDeg),
      aspectLabelZh: bearingLabelZh(metrics[index].aspectDeg),
    };
  });
  return {
    sample,
    baseElevations,
    rawRecords,
    cells,
    byId: new Map(cells.map((cell) => [cell.id, cell])),
    stats,
    repairs,
    maxAccum,
    cols,
    rows,
    cellSizeM: GRID.cellSizeM,
    revision: sample.revision,
  };
}

export function getDrainagePath(topology, startId) {
  const start = topology.byId.get(startId);
  if (!start) return { ids: [], endReason: "无网格", lengthM: 0, cells: [] };
  const ids = [];
  const visited = new Set();
  let current = start;
  let lengthM = 0;
  while (current && !visited.has(current.id)) {
    ids.push(current.id);
    visited.add(current.id);
    if (current.isSink) break;
    const next = topology.byId.get(current.downstreamId);
    if (!next) break;
    const diagonal = current.row !== next.row && current.col !== next.col;
    lengthM += topology.cellSizeM * (diagonal ? Math.SQRT2 : 1);
    current = next;
  }
  const end = topology.byId.get(ids[ids.length - 1]);
  return {
    ids,
    cells: ids.map((id) => topology.byId.get(id)),
    lengthM: round(lengthM, 1),
    endReason: end?.isSink ? "洼地 / 出图边界" : "下游截断",
  };
}

export function compareThresholds(topology, thresholdA, thresholdB, selectedId = null) {
  const lower = Math.min(thresholdA, thresholdB);
  const upper = Math.max(thresholdA, thresholdB);
  const countA = topology.cells.filter((cell) => cell.riskIndex >= thresholdA).length;
  const countB = topology.cells.filter((cell) => cell.riskIndex >= thresholdB).length;
  const overlap = topology.cells.filter(
    (cell) => cell.riskIndex >= thresholdA && cell.riskIndex >= thresholdB,
  ).length;
  const onlyA = topology.cells.filter(
    (cell) => cell.riskIndex >= thresholdA && cell.riskIndex < thresholdB,
  ).length;
  const onlyB = topology.cells.filter(
    (cell) => cell.riskIndex >= thresholdB && cell.riskIndex < thresholdA,
  ).length;
  const selected = selectedId ? topology.byId.get(selectedId) : null;
  return {
    countA,
    countB,
    lower,
    upper,
    overlap,
    onlyA,
    onlyB,
    delta: Math.abs(countA - countB),
    selectedState:
      selected && selected.riskIndex >= thresholdA
        ? selected.riskIndex >= thresholdB
          ? "双阈值命中"
          : "仅阈值 A 命中"
        : selected && selected.riskIndex >= thresholdB
          ? "仅阈值 B 命中"
          : "未命中",
  };
}

export function legendForThresholds(topology, thresholdA, thresholdB) {
  const lower = Math.min(thresholdA, thresholdB);
  const upper = Math.max(thresholdA, thresholdB);
  const count = (predicate) => topology.cells.filter(predicate).length;
  return [
    {
      key: "low",
      label: `低风险 < ${lower}%`,
      count: count((cell) => cell.riskIndex < lower),
      color: "#7a94a8",
    },
    {
      key: "mid",
      label: `关注 ${lower}–${upper}%`,
      count: count((cell) => cell.riskIndex >= lower && cell.riskIndex < upper),
      color: "#e9a23b",
    },
    {
      key: "high",
      label: `高风险 ≥ ${upper}%`,
      count: count((cell) => cell.riskIndex >= upper),
      color: "#dc594b",
    },
  ];
}

function checksum(values) {
  let hash = 2166136261;
  for (const value of values) {
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

export function buildAuditSnapshot(topology, thresholdA, thresholdB) {
  const roundSum = (values, digits = 2) =>
    round(values.reduce((sum, value) => sum + value, 0), digits);
  const keyValues = {
    elevation: checksum(topology.cells.map((cell) => cell.elevation)),
    slope: checksum(topology.cells.map((cell) => cell.slopeDeg)),
    aspect: checksum(topology.cells.map((cell) => cell.aspectDeg)),
    flowDirection: checksum(topology.cells.map((cell) => cell.flowDirCode)),
    flowAccumulation: checksum(topology.cells.map((cell) => cell.flowAccum)),
    risk: checksum(topology.cells.map((cell) => cell.riskIndex)),
  };
  return {
    objectCount: topology.cells.length + topology.rawRecords.length,
    gridObjects: topology.cells.length,
    recordObjects: topology.rawRecords.length,
    keyValues,
    totals: {
      elevation: roundSum(topology.cells.map((cell) => cell.elevation), 1),
      slope: roundSum(topology.cells.map((cell) => cell.slopeDeg), 2),
      flowAccumulation: topology.cells.reduce((sum, cell) => sum + cell.flowAccum, 0),
    },
    thresholds: { thresholdA, thresholdB },
    riskCounts: compareThresholds(topology, thresholdA, thresholdB),
  };
}

export function auditSnapshotsEqual(before, after) {
  return (
    before.objectCount === after.objectCount &&
    before.gridObjects === after.gridObjects &&
    before.recordObjects === after.recordObjects &&
    JSON.stringify(before.keyValues) === JSON.stringify(after.keyValues) &&
    JSON.stringify(before.totals) === JSON.stringify(after.totals) &&
    JSON.stringify(before.thresholds) === JSON.stringify(after.thresholds)
  );
}

export function normalizeUiState(input = {}) {
  const sampleId = SAMPLE_DEFINITIONS.some((sample) => sample.id === input.sampleId)
    ? input.sampleId
    : DEFAULT_STATE.sampleId;
  const thresholdA = clamp(Number(input.thresholdA ?? DEFAULT_STATE.thresholdA), 0, 100);
  const thresholdB = clamp(Number(input.thresholdB ?? DEFAULT_STATE.thresholdB), 0, 100);
  return {
    sampleId,
    thresholdA: Math.round(thresholdA),
    thresholdB: Math.round(thresholdB),
    layer: LAYERS.includes(input.layer) ? input.layer : DEFAULT_STATE.layer,
    showArrows: input.showArrows !== false,
    showGrid: input.showGrid !== false,
    selectedId: parseCellId(input.selectedId) ? input.selectedId : null,
    hoverId: parseCellId(input.hoverId) ? input.hoverId : null,
  };
}

export function createProject(uiState, extra = {}) {
  return {
    schema: PROJECT_SCHEMA,
    savedAt: new Date().toISOString(),
    appVersion: DATA_SCHEMA_VERSION,
    state: normalizeUiState(uiState),
    snapshot: extra.snapshot || null,
  };
}

export function parseProject(project) {
  if (!project || project.schema !== PROJECT_SCHEMA) {
    throw new Error("工程格式不受支持");
  }
  if (!project.state) throw new Error("工程缺少 state 字段");
  const state = normalizeUiState(project.state);
  return {
    state,
    savedAt: project.savedAt || null,
    appVersion: project.appVersion || "unknown",
  };
}

export { checksum, pad, round };
