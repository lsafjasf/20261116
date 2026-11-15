// CSV 导出、热图数据与导出口径一致性校验（无 DOM 依赖）

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  const header = columns.map((c) => csvCell(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(','));
  return [header, ...body].join('\n') + '\n';
}

export function vehicleRows(result) {
  return [...result.vehicles.values()].map((v) => ({
    vehicleId: v.id,
    origin: v.origin,
    destination: v.destination,
    release: v.release,
    deadline: v.deadline,
    state: v.state,
    arrivedTick: v.arrivedTick === null ? '' : v.arrivedTick,
    travelTicks: v.travelTicks,
    waitTicks: v.waitTicks,
    distance: Math.round(v.distance * 1000) / 1000,
    eventCount: v.events.length,
    path: v.path.join('>'),
  }));
}

export const VEHICLE_COLUMNS = [
  { key: 'vehicleId', label: 'vehicle_id' },
  { key: 'origin', label: 'origin' },
  { key: 'destination', label: 'destination' },
  { key: 'release', label: 'release_tick' },
  { key: 'deadline', label: 'deadline_tick' },
  { key: 'state', label: 'final_state' },
  { key: 'arrivedTick', label: 'arrived_tick' },
  { key: 'travelTicks', label: 'travel_ticks' },
  { key: 'waitTicks', label: 'wait_ticks' },
  { key: 'distance', label: 'distance' },
  { key: 'eventCount', label: 'event_count' },
  { key: 'path', label: 'final_path' },
];

export function eventRows(result) {
  const rows = [];
  for (const v of result.vehicles.values()) {
    for (const e of v.events) {
      rows.push({
        tick: e.tick,
        vehicleId: e.vehicleId,
        type: e.type,
        edgeId: e.edgeId === null ? '' : e.edgeId,
        reachable: e.reachable,
        cost: e.cost === null ? '' : e.cost,
        expansions: e.expansions,
        path: e.path,
        detail: e.detail,
      });
    }
  }
  return rows.sort((a, b) => a.tick - b.tick || a.vehicleId.localeCompare(b.vehicleId));
}

export const EVENT_COLUMNS = [
  { key: 'tick', label: 'tick' },
  { key: 'vehicleId', label: 'vehicle_id' },
  { key: 'type', label: 'event_type' },
  { key: 'edgeId', label: 'edge_id' },
  { key: 'reachable', label: 'reachable' },
  { key: 'cost', label: 'plan_cost' },
  { key: 'expansions', label: 'dijkstra_expansions' },
  { key: 'path', label: 'edge_path' },
  { key: 'detail', label: 'detail' },
];

export function heatmapRows(result) {
  return result.heatmap.map((h) => ({
    edgeId: h.id,
    capacity: h.capacity,
    avgLoad: h.avgLoad,
    occupancyRatio: h.ratio,
  }));
}

export const HEATMAP_COLUMNS = [
  { key: 'edgeId', label: 'edge_id' },
  { key: 'capacity', label: 'capacity' },
  { key: 'avgLoad', label: 'avg_load' },
  { key: 'occupancyRatio', label: 'occupancy_ratio' },
];

// 导出前后对象数量与关键数值一致性：从 CSV 文本反解析后再比对
function parseCsv(text) {
  const lines = text.trimEnd().split('\n');
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
}

const numOrZero = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// 比对内存结果与导出 CSV 反解析结果，返回逐项核对结论
export function verifyExport(result, csvBundle) {
  const checks = [];
  const vRows = vehicleRows(result);
  const parsedV = parseCsv(csvBundle.vehiclesCsv);
  checks.push({
    name: '车辆对象数量一致',
    expected: vRows.length,
    actual: parsedV.length,
    pass: vRows.length === parsedV.length,
  });
  const eRows = eventRows(result);
  const parsedE = parseCsv(csvBundle.eventsCsv);
  checks.push({
    name: '决策事件数量一致',
    expected: eRows.length,
    actual: parsedE.length,
    pass: eRows.length === parsedE.length,
  });
  const hRows = heatmapRows(result);
  const parsedH = parseCsv(csvBundle.heatmapCsv);
  checks.push({
    name: '道路热图对象数量一致',
    expected: hRows.length,
    actual: parsedH.length,
    pass: hRows.length === parsedH.length,
  });

  const keySum = (rows, key) => rows.reduce((s, r) => s + numOrZero(r[key]), 0);
  const pairs = [
    ['总行驶 tick', 'travel_ticks', 'travelTicks'],
    ['总等待 tick', 'wait_ticks', 'waitTicks'],
    ['总行驶距离', 'distance', 'distance'],
  ];
  for (const [label, csvKey, memKey] of pairs) {
    const expected = Math.round(keySum(vRows, memKey) * 1000) / 1000;
    const actual = Math.round(keySum(parsedV, csvKey) * 1000) / 1000;
    checks.push({ name: `${label}一致`, expected, actual, pass: expected === actual });
  }
  const memArrived = result.stats.arrived;
  const csvArrived = parsedV.filter((r) => r.final_state === 'arrived').length;
  checks.push({ name: '到达车辆数一致', expected: memArrived, actual: csvArrived, pass: memArrived === csvArrived });

  return {
    pass: checks.every((c) => c.pass),
    checks,
    scope: {
      vehicles: vRows.length,
      events: eRows.length,
      heatEdges: hRows.length,
      stats: { ...result.stats },
    },
  };
}

export function buildCsvBundle(result) {
  return {
    vehiclesCsv: toCsv(vehicleRows(result), VEHICLE_COLUMNS),
    eventsCsv: toCsv(eventRows(result), EVENT_COLUMNS),
    heatmapCsv: toCsv(heatmapRows(result), HEATMAP_COLUMNS),
  };
}
