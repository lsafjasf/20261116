export const CHAPTERS = [
  {
    id: "flow",
    number: "01",
    kicker: "流向",
    title: "谁在穿过城市",
    short: "晨昏流向",
    description: "看人潮如何沿八条走廊涌入与离开中心城。"
  },
  {
    id: "speed",
    number: "02",
    kicker: "速度",
    title: "拥堵如何蔓延",
    short: "速度脉搏",
    description: "速度是强度，不是可相加的份额；它不能被堆叠。"
  },
  {
    id: "transit",
    number: "03",
    kicker: "公共性",
    title: "公交承担了什么",
    short: "公交分担",
    description: "比较各片区公交与其他方式承担的人次，观察公共出行的底盘。"
  }
];

export const DIRECTIONS = [
  { id: "all", label: "双向合计" },
  { id: "inbound", label: "入城" },
  { id: "outbound", label: "出城" }
];

export const PERIODS = [
  { id: "all", label: "全天", hours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] },
  { id: "am", label: "早高峰 06–09", hours: [6, 7, 8, 9] },
  { id: "midday", label: "平峰 10–16", hours: [10, 11, 12, 13, 14, 15, 16] },
  { id: "pm", label: "晚高峰 17–19", hours: [17, 18, 19] },
  { id: "night", label: "夜间 22–05", hours: [22, 23, 0, 1, 2, 3, 4, 5] }
];

export const RECORD_SCOPES = [
  { id: "clean", label: "仅清洗后记录" },
  { id: "audit", label: "含异常记录（审计）" }
];

export const REQUIRED_FIELDS = ["id", "corridorId", "districtId", "hour", "direction", "flow", "avgSpeed", "busShare"];
export const FLOW_CAPACITY_MULTIPLIER = 2;
export const SPEED_MIN = 2.5;
export const SPEED_MAX = 80;

export const DEFAULT_FILTERS = {
  districtId: "all",
  direction: "all",
  period: "all",
  recordScope: "clean"
};

export function formatNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

export function formatCompact(value) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return formatNumber(value);
}

export function formatPct(value, digits = 0) {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatSpeed(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}` : "—";
}

export function periodHours(periodId) {
  return PERIODS.find((item) => item.id === periodId)?.hours ?? PERIODS[0].hours;
}

export function periodLabel(periodId) {
  return PERIODS.find((item) => item.id === periodId)?.label ?? PERIODS[0].label;
}

export function scopeLabel(scopeId) {
  return RECORD_SCOPES.find((item) => item.id === scopeId)?.label ?? RECORD_SCOPES[0].label;
}

export function directionLabel(directionId) {
  return DIRECTIONS.find((item) => item.id === directionId)?.label ?? DIRECTIONS[0].label;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function getCorridor(dataset, corridorId) {
  return dataset.corridors.find((corridor) => corridor.id === corridorId) ?? null;
}

export function getDistrict(dataset, districtId) {
  return dataset.districts.find((district) => district.id === districtId) ?? null;
}

function anomalyNote(type, field, value) {
  if (type === "missing") return `${field} 为空或不是数字`;
  if (type === "duplicate") return `记录 ID 已出现，保留首条`;
  if (field === "flow") return `流量 ${formatNumber(value)} 超出容量上限`;
  if (field === "avgSpeed") return `速度 ${value} 超出可信范围`;
  if (field === "busShare") return `公交分担率 ${value} 超出 0–1`;
  return `${field} 异常`;
}

export function normalizeDataset(dataset) {
  if (!dataset || !Array.isArray(dataset.observations) || !Array.isArray(dataset.corridors)) {
    throw new Error("数据集缺少 observations 或 corridors");
  }

  const anomalies = [];
  const numericRows = [];
  const missingIndexes = new Set();
  const outlierIndexes = new Set();
  const firstByRecordId = new Map();
  const duplicateIndexes = new Set();

  dataset.observations.forEach((raw, index) => {
    const missingFields = REQUIRED_FIELDS.filter((field) => {
      if (field === "id" || field === "corridorId" || field === "districtId" || field === "direction") {
        return raw[field] === null || raw[field] === undefined || raw[field] === "";
      }
      return asNumber(raw[field]) === null;
    });

    if (missingFields.length) {
      missingIndexes.add(index);
      missingFields.forEach((field) => {
        anomalies.push({
          type: "missing",
          rowId: raw.id ?? `row-${index + 1}`,
          rowKey: `${raw.id ?? "row"}#${index}`,
          field,
          value: raw[field],
          note: anomalyNote("missing", field, raw[field])
        });
      });
      return;
    }

    const row = {
      ...raw,
      hour: Number(raw.hour),
      flow: Number(raw.flow),
      avgSpeed: Number(raw.avgSpeed),
      busShare: Number(raw.busShare),
      _rowKey: `${raw.id}#${index}`,
      _sourceIndex: index
    };
    numericRows.push(row);
  });

  for (const row of numericRows) {
    if (!firstByRecordId.has(row.id)) {
      firstByRecordId.set(row.id, row._sourceIndex);
    } else {
      duplicateIndexes.add(row._sourceIndex);
      anomalies.push({
        type: "duplicate",
        rowId: row.id,
        rowKey: row._rowKey,
        field: "id",
        value: row.id,
        note: anomalyNote("duplicate", "id", row.id)
      });
    }
  }

  for (const row of numericRows) {
    const corridor = getCorridor(dataset, row.corridorId);
    const flowLimit = (corridor?.capacity ?? Number.POSITIVE_INFINITY) * FLOW_CAPACITY_MULTIPLIER;
    const outlierFields = [];
    if (row.flow < 0 || row.flow > flowLimit) outlierFields.push("flow");
    if (row.avgSpeed < SPEED_MIN || row.avgSpeed > SPEED_MAX) outlierFields.push("avgSpeed");
    if (row.busShare < 0 || row.busShare > 1) outlierFields.push("busShare");
    if (outlierFields.length) {
      outlierIndexes.add(row._sourceIndex);
      outlierFields.forEach((field) => {
        anomalies.push({
          type: "outlier",
          rowId: row.id,
          rowKey: row._rowKey,
          field,
          value: row[field],
          note: anomalyNote("outlier", field, row[field])
        });
      });
    }
  }

  const allNumericRows = numericRows.map((row) => {
    const quality = outlierIndexes.has(row._sourceIndex)
      ? "outlier"
      : duplicateIndexes.has(row._sourceIndex)
        ? "duplicate"
        : "valid";
    return { ...row, _quality: quality };
  });

  const cleanRows = allNumericRows.filter((row) => row._quality === "valid");
  const auditRows = allNumericRows;
  const countsByType = anomalies.reduce((accumulator, anomaly) => {
    accumulator[anomaly.type] = (accumulator[anomaly.type] ?? 0) + 1;
    return accumulator;
  }, {});

  return {
    datasetId: dataset.id,
    version: dataset.version,
    rawCount: dataset.observations.length,
    missingCount: missingIndexes.size,
    duplicateCount: duplicateIndexes.size,
    outlierCount: outlierIndexes.size,
    cleanCount: cleanRows.length,
    auditCount: auditRows.length,
    excludedCount: dataset.observations.length - cleanRows.length,
    anomalyCounts: {
      missing: countsByType.missing ?? 0,
      duplicate: countsByType.duplicate ?? 0,
      outlier: countsByType.outlier ?? 0
    },
    anomalies,
    cleanRows,
    auditRows
  };
}

export function sanitizeFilters(filters = {}) {
  return {
    districtId: filters.districtId ?? DEFAULT_FILTERS.districtId,
    direction: DIRECTIONS.some((item) => item.id === filters.direction) ? filters.direction : "all",
    period: PERIODS.some((item) => item.id === filters.period) ? filters.period : "all",
    recordScope: RECORD_SCOPES.some((item) => item.id === filters.recordScope) ? filters.recordScope : "clean"
  };
}

export function selectRows(processed, filters) {
  const safe = sanitizeFilters(filters);
  const source = safe.recordScope === "audit" ? processed.auditRows : processed.cleanRows;
  const hours = new Set(periodHours(safe.period));
  return source.filter((row) => {
    if (safe.districtId !== "all" && row.districtId !== safe.districtId) return false;
    if (safe.direction !== "all" && row.direction !== safe.direction) return false;
    return hours.has(row.hour);
  });
}

function weightedAverage(rows, valueField, weightField = "flow") {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    const weight = finiteNumber(row[weightField]) ? row[weightField] : 0;
    numerator += row[valueField] * weight;
    denominator += weight;
  }
  if (denominator > 0) return numerator / denominator;
  if (!rows.length) return null;
  return rows.reduce((sum, row) => sum + row[valueField], 0) / rows.length;
}

function sum(rows, valueField) {
  return rows.reduce((total, row) => total + (finiteNumber(row[valueField]) ? row[valueField] : 0), 0);
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function groupRows(rows, keySelector) {
  const groups = new Map();
  for (const row of rows) {
    const key = keySelector(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

export function buildFilterSummary(dataset, filters) {
  const safe = sanitizeFilters(filters);
  const district = safe.districtId === "all" ? "全部片区" : getDistrict(dataset, safe.districtId)?.name ?? safe.districtId;
  return `${district} · ${periodLabel(safe.period)} · ${directionLabel(safe.direction)} · ${scopeLabel(safe.recordScope)}`;
}

export function selectedRowsHash(rows) {
  const signature = [...rows]
    .sort((left, right) => left._rowKey.localeCompare(right._rowKey))
    .map((row) => [row.id, row.corridorId, row.hour, row.direction, row.flow, row.avgSpeed, row.busShare]);
  return stableHash(signature);
}

export function stableHash(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function buildView(dataset, processed, filters) {
  const safe = sanitizeFilters(filters);
  const rows = selectRows(processed, safe);
  const totalFlow = sum(rows, "flow");
  const busRiders = rows.reduce((total, row) => total + row.flow * row.busShare, 0);
  const avgSpeed = weightedAverage(rows, "avgSpeed");
  const transitShare = totalFlow > 0 ? busRiders / totalFlow : null;
  const inboundFlow = sum(rows.filter((row) => row.direction === "inbound"), "flow");
  const outboundFlow = sum(rows.filter((row) => row.direction === "outbound"), "flow");
  const incidentCount = rows.reduce((total, row) => total + (row.incidentCount || 0), 0);

  const corridorGroups = groupRows(rows, (row) => row.corridorId);
  const corridors = [...corridorGroups.entries()].map(([corridorId, group]) => {
    const corridor = getCorridor(dataset, corridorId);
    const flow = sum(group, "flow");
    const bus = group.reduce((total, row) => total + row.flow * row.busShare, 0);
    const speed = weightedAverage(group, "avgSpeed");
    return {
      id: corridorId,
      name: corridor?.name ?? corridorId,
      districtId: corridor?.districtId ?? group[0].districtId,
      path: corridor?.path ?? [],
      capacity: corridor?.capacity ?? null,
      baseSpeed: corridor?.baseSpeed ?? null,
      flow,
      busRiders: bus,
      avgSpeed: round(speed, 1),
      transitShare: flow > 0 ? bus / flow : null,
      congestion: corridor?.baseSpeed ? round(Math.max(0, 1 - speed / corridor.baseSpeed), 3) : null,
      observations: group.length
    };
  }).sort((left, right) => right.flow - left.flow);

  const districtGroups = groupRows(rows, (row) => row.districtId);
  const districts = [...districtGroups.entries()].map(([districtId, group]) => {
    const district = getDistrict(dataset, districtId);
    const flow = sum(group, "flow");
    const bus = group.reduce((total, row) => total + row.flow * row.busShare, 0);
    return {
      id: districtId,
      name: district?.name ?? districtId,
      center: district?.center ?? null,
      tone: district?.tone ?? "#5c6259",
      flow,
      busRiders: bus,
      otherRiders: Math.max(0, flow - bus),
      avgSpeed: round(weightedAverage(group, "avgSpeed"), 1),
      transitShare: flow > 0 ? bus / flow : null,
      observations: group.length
    };
  }).sort((left, right) => right.flow - left.flow);

  const hourGroups = groupRows(rows, (row) => row.hour);
  const hours = [...hourGroups.entries()].map(([hour, group]) => {
    const inbound = sum(group.filter((row) => row.direction === "inbound"), "flow");
    const outbound = sum(group.filter((row) => row.direction === "outbound"), "flow");
    return {
      hour: Number(hour),
      label: `${String(hour).padStart(2, "0")}:00`,
      inbound,
      outbound,
      total: inbound + outbound,
      avgSpeed: round(weightedAverage(group, "avgSpeed"), 1)
    };
  }).sort((left, right) => left.hour - right.hour);

  const slowest = [...corridors].filter((corridor) => Number.isFinite(corridor.avgSpeed))
    .sort((left, right) => left.avgSpeed - right.avgSpeed)[0] ?? null;
  const fastest = [...corridors].filter((corridor) => Number.isFinite(corridor.avgSpeed))
    .sort((left, right) => right.avgSpeed - left.avgSpeed)[0] ?? null;

  return {
    rows,
    rowCount: rows.length,
    sourceRowCount: processed.rawCount,
    cleanRowCount: processed.cleanCount,
    auditRowCount: processed.auditCount,
    totalFlow,
    busRiders: round(busRiders, 0),
    avgSpeed: round(avgSpeed, 1),
    transitShare: round(transitShare, 4),
    inboundFlow,
    outboundFlow,
    inboundShare: totalFlow > 0 ? round(inboundFlow / totalFlow, 4) : null,
    incidentCount,
    corridors,
    districts,
    hours,
    topCorridor: corridors[0] ?? null,
    slowestCorridor: slowest,
    fastestCorridor: fastest,
    congestedCount: corridors.filter((corridor) => corridor.avgSpeed !== null && corridor.avgSpeed < 20).length,
    filterSummary: buildFilterSummary(dataset, safe),
    filters: safe,
    dataHash: selectedRowsHash(rows)
  };
}

function narrativeForFlow(view, filters) {
  if (!view.rowCount) {
    return {
      summary: "当前筛选没有可计算的观测。请放宽片区、时段或记录范围。",
      lede: "没有观测，就没有可讲述的流向；各视图已同步清空。",
      paragraphs: ["筛选条件与数据版本仍保留在页面顶部，调整后所有数字会重新计算。"],
      metrics: [
        { label: "筛选后对象", value: "0", unit: "条" },
        { label: "总流量", value: "—", unit: "人次/小时" },
        { label: "走廊", value: "0", unit: "条" }
      ]
    };
  }
  const top = view.topCorridor;
  const directionText = filters.direction === "all"
    ? `入城占 ${formatPct(view.inboundShare)}，出城占 ${formatPct(1 - view.inboundShare)}`
    : `${directionLabel(filters.direction)}方向共计 ${formatNumber(view.totalFlow)} 人次/小时`;
  return {
    summary: `${top.name}是本切片最繁忙的走廊，承担 ${formatCompact(top.flow)} 人次/小时。`,
    lede: `在“${view.filterSummary}”口径下，${view.rowCount} 条观测合计 ${formatNumber(view.totalFlow)} 人次/小时。${directionText}。`,
    paragraphs: [
      `当前 ${view.corridors.length} 条有观测的走廊中，${top.name}占当前总流量的 ${formatPct(top.flow / view.totalFlow)}。这不是一条孤立的线，而是中心城与外围片区之间最短、也最拥挤的连接之一。`,
      `公交承担约 ${formatNumber(view.busRiders)} 人次/小时，折合全部流量的 ${formatPct(view.transitShare)}。切换上方筛选，地图线宽、逐小时柱和正文数字会使用同一口径同时更新。`
    ],
    metrics: [
      { label: "筛选后对象", value: formatNumber(view.rowCount), unit: "条观测" },
      { label: "总流量", value: formatCompact(view.totalFlow), unit: "人次/小时" },
      { label: "最高走廊", value: top.name, unit: `${formatCompact(top.flow)} 人次/小时` }
    ]
  };
}

function narrativeForSpeed(view) {
  if (!view.rowCount || !view.slowestCorridor) {
    return {
      summary: "当前筛选没有可计算的速度观测。",
      lede: "速度视图已与筛选同步清空，未用上一状态冒充当前结果。",
      paragraphs: ["速度是强度指标，不能把多条走廊的速度相加成一个“总速度”。"],
      metrics: [
        { label: "筛选后对象", value: "0", unit: "条" },
        { label: "平均速度", value: "—", unit: "公里/小时" },
        { label: "低于 20", value: "0", unit: "条走廊" }
      ]
    };
  }
  const slow = view.slowestCorridor;
  const fast = view.fastestCorridor;
  return {
    summary: `${slow.name}最慢，加权平均 ${formatSpeed(slow.avgSpeed)} 公里/小时。`,
    lede: `当前切片的路网加权平均速度为 ${formatSpeed(view.avgSpeed)} 公里/小时；${view.congestedCount} 条走廊低于 20 公里/小时。`,
    paragraphs: [
      `${slow.name}与最快的${fast.name}相差 ${formatSpeed(fast.avgSpeed - slow.avgSpeed)} 公里/小时。速度由流量加权，目的是避免样本少的时段被误放大，但它仍然不能跨走廊相加。`,
      `图中每条横线是一条完整走廊的流量加权速度。即使同时选中多个片区，也不会出现“堆叠速度”；遇到此操作，页面会明确退回不可堆叠的分组视图。`
    ],
    metrics: [
      { label: "加权均速", value: formatSpeed(view.avgSpeed), unit: "公里/小时" },
      { label: "慢行走廊", value: formatNumber(view.congestedCount), unit: `共 ${view.corridors.length} 条` },
      { label: "速度落差", value: formatSpeed(fast.avgSpeed - slow.avgSpeed), unit: "公里/小时" }
    ]
  };
}

function narrativeForTransit(view) {
  if (!view.rowCount) {
    return {
      summary: "当前筛选没有可计算的公交观测。",
      lede: "公交分担视图已同步清空。",
      paragraphs: ["调整筛选后，各片区公交与其他方式的人员流量会一起重算。"],
      metrics: [
        { label: "筛选后对象", value: "0", unit: "条" },
        { label: "公交人次", value: "—", unit: "人次/小时" },
        { label: "分担率", value: "—", unit: "占全部流量" }
      ]
    };
  }
  const topDistrict = view.districts[0];
  return {
    summary: `公交承担 ${formatPct(view.transitShare, 1)} 的城市交通流量，约 ${formatNumber(view.busRiders)} 人次/小时。`,
    lede: `${topDistrict.name}是本切片流量最高的片区；每 100 人次出行中，有 ${Math.round(view.transitShare * 100)} 人次由公交承担。`,
    paragraphs: [
      `公交与其他方式在片区尺度可以相加，因此这里使用堆叠柱：柱子的总高度就是该片区全部观测流量。把“公交”理解为公共底盘，而不是拥堵本身。`,
      `审计样例中的异常分担率不会悄悄混入清洗结果；若主动切换到含异常记录，测试徽标和调试面板会同时提示口径已改变。`
    ],
    metrics: [
      { label: "公交人次", value: formatCompact(view.busRiders), unit: "人次/小时" },
      { label: "公交分担", value: formatPct(view.transitShare, 1), unit: "占全部流量" },
      { label: "覆盖片区", value: formatNumber(view.districts.length), unit: "个片区" }
    ]
  };
}

export function buildNarrative(view, chapterId, filters) {
  if (chapterId === "speed") return narrativeForSpeed(view, filters);
  if (chapterId === "transit") return narrativeForTransit(view, filters);
  return narrativeForFlow(view, filters);
}

export function buildExportManifest(dataset, processed, view, chapterId) {
  const chapter = CHAPTERS.find((item) => item.id === chapterId) ?? CHAPTERS[0];
  const selectedQuality = view.filters.recordScope === "audit";
  return {
    kind: "city-pulse-chapter-export/v1",
    city: dataset.city,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    datasetId: dataset.id,
    datasetVersion: dataset.version,
    datasetReleasedAt: dataset.releasedAt,
    filterSummary: view.filterSummary,
    filters: { ...view.filters },
    exportScope: `当前章节「${chapter.title}」；当前筛选；${scopeLabel(view.filters.recordScope)}`,
    exclusionPolicy: selectedQuality
      ? "保留可计数的重复与异常行；空值行仍被排除。"
      : "空值、重复 ID 与异常值均被清洗排除。",
    objectCount: view.rowCount,
    sourceObjectCount: processed.rawCount,
    cleanObjectCount: processed.cleanCount,
    auditObjectCount: processed.auditCount,
    keyValues: {
      totalFlow: Math.round(view.totalFlow),
      avgSpeed: view.avgSpeed,
      busRiders: Math.round(view.busRiders),
      transitShare: view.transitShare,
      corridorCount: view.corridors.length,
      topCorridor: view.topCorridor?.name ?? null
    },
    dataHash: view.dataHash,
    generatedAt: new Date().toISOString()
  };
}

export function createProject(dataset, settings, name = "临江市交通报道工程") {
  const safeFilters = sanitizeFilters(settings);
  const chapterId = CHAPTERS.some((chapter) => chapter.id === settings.chapterId)
    ? settings.chapterId
    : CHAPTERS[0].id;
  const project = {
    schema: "city-pulse-project/v1",
    name,
    savedAt: new Date().toISOString(),
    dataset: JSON.parse(JSON.stringify(dataset)),
    settings: {
      ...safeFilters,
      chapterId,
      noMotion: Boolean(settings.noMotion),
      stackAttempted: Boolean(settings.stackAttempted)
    }
  };
  project.checksum = stableHash({
    datasetVersion: dataset.version,
    datasetId: dataset.id,
    settings: project.settings
  });
  return project;
}

export function validateProject(project) {
  if (!project || project.schema !== "city-pulse-project/v1") {
    throw new Error("工程文件版本不兼容");
  }
  if (!project.dataset || !Array.isArray(project.dataset.observations) || !Array.isArray(project.dataset.corridors)) {
    throw new Error("工程文件缺少可重载的数据快照");
  }
  if (!Array.isArray(project.dataset.districts)) {
    throw new Error("工程文件缺少片区定义");
  }
  if (!project.settings || typeof project.settings !== "object") {
    throw new Error("工程文件缺少视图设置");
  }
  const expected = stableHash({
    datasetVersion: project.dataset.version,
    datasetId: project.dataset.id,
    settings: {
      ...sanitizeFilters(project.settings),
      chapterId: CHAPTERS.some((chapter) => chapter.id === project.settings.chapterId)
        ? project.settings.chapterId
        : CHAPTERS[0].id,
      noMotion: Boolean(project.settings.noMotion),
      stackAttempted: Boolean(project.settings.stackAttempted)
    }
  });
  if (project.checksum && project.checksum !== expected) {
    throw new Error("工程校验和不匹配，文件可能已损坏");
  }
  return project;
}

export function projectSettingsFromState(state) {
  return {
    ...sanitizeFilters(state.filters),
    chapterId: state.chapterId,
    noMotion: Boolean(state.noMotion),
    stackAttempted: Boolean(state.stackAttempted)
  };
}
