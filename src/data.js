export const SAMPLES = {
  A: {
    id: "A",
    name: "星港零售",
    subtitle: "Q3 CHANNEL SIGNAL",
    source: "commerce_q3.csv",
    versionBase: "v2026.11.16-A",
    entity: "channel",
    entityLabel: "渠道",
    primaryKey: "revenue",
    secondaryKey: "orders",
    primaryLabel: "成交额",
    secondaryLabel: "订单数",
    filterLabel: "全部渠道 · 全部地区",
    records: [
      { id: "TX-2401", entity: "天猫", region: "华东", revenue: 328400, orders: 2210, state: "完成" },
      { id: "TX-2402", entity: "抖音", region: "华南", revenue: null, orders: 1480, state: "完成" },
      { id: "TX-2402", entity: "抖音", region: "华南", revenue: 331800, orders: 1492, state: "重复回传" },
      { id: "TX-2404", entity: "京东", region: "华北", revenue: 9800000, orders: 126, state: "渠道异常" },
      { id: "TX-2405", entity: "小红书", region: "华东", revenue: 192800, orders: 960, state: "完成" },
      { id: "TX-2406", entity: "小程序", region: "西南", revenue: 244600, orders: 1310, state: "完成" }
    ],
    metrics: [
      { key: "revenue", label: "成交额", agg: "sum", format: "currency", short: "GMV" },
      { key: "orders", label: "订单数", agg: "sum", format: "integer", short: "ORDERS" },
      { key: "aov", label: "客单价", agg: "calc", format: "currency", short: "AOV", formula: "GMV / ORDERS" }
    ]
  },
  B: {
    id: "B",
    name: "研发运营",
    subtitle: "OPS CAPACITY SIGNAL",
    source: "ops_weekly.json",
    versionBase: "v2026.11.16-B",
    entity: "unit",
    entityLabel: "单元",
    primaryKey: "hours",
    secondaryKey: "spend",
    primaryLabel: "投入工时",
    secondaryLabel: "云成本",
    filterLabel: "全部单元 · 全部节点",
    records: [
      { id: "OP-101", entity: "基础设施", region: "核心", hours: 1860, spend: 224000, quality: 92 },
      { id: "OP-102", entity: "设计系统", region: "体验", hours: null, spend: 168400, quality: 88 },
      { id: "OP-102", entity: "设计系统", region: "体验", hours: 1510, spend: 171000, quality: 89 },
      { id: "OP-104", entity: "亚太节点", region: "边缘", hours: 31200000, spend: 415000, quality: 41 },
      { id: "OP-105", entity: "模型实验室", region: "智能", hours: 2450, spend: 318000, quality: 95 },
      { id: "OP-106", entity: "增长实验组", region: "增长", hours: 1340, spend: 147000, quality: 90 }
    ],
    metrics: [
      { key: "hours", label: "投入工时", agg: "sum", format: "integer", short: "HOURS" },
      { key: "spend", label: "云成本", agg: "sum", format: "currency", short: "SPEND" },
      { key: "quality", label: "平均质量", agg: "mean", keyName: "quality", format: "score", short: "QUALITY" }
    ]
  }
};

const numericKeys = ["revenue", "orders", "hours", "spend", "quality"];

const cleanNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const robustBounds = (values) => {
  if (values.length < 3) return { low: -Infinity, high: Infinity, center: median(values), mad: 0 };
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));
  if (mad === 0) return { low: center, high: center, center, mad };
  const spread = 1.4826 * mad * 3;
  return { low: center - spread, high: center + spread, center, mad };
};

const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

export function normalizeSample(sample, filter = "all", revision = 0) {
  const sourceRows = sample.records.map((record) => ({ ...record }));
  const scopedRows = filter === "all" ? sourceRows : sourceRows.filter((record) => record.entity === filter);
  const seen = new Set();
  const duplicates = [];
  const missingId = [];
  const unique = [];

  for (const source of scopedRows) {
    const record = { ...source };
    record.id = String(record.id ?? "").trim();
    record.entity = String(record.entity ?? "").trim();
    record.region = String(record.region ?? "").trim();
    if (!record.id) {
      missingId.push(record);
      continue;
    }
    if (seen.has(record.id)) {
      duplicates.push(record);
      continue;
    }
    seen.add(record.id);
    for (const key of numericKeys) {
      if (key in record) record[key] = cleanNumber(record[key]);
    }
    unique.push(record);
  }

  const bounds = {};
  for (const key of numericKeys) {
    const values = unique.map((record) => record[key]).filter((value) => value !== null && value !== undefined);
    if (values.length) bounds[key] = robustBounds(values);
  }

  const nullFields = [];
  const outliers = [];
  const accepted = unique.map((record) => {
    const normalized = { ...record, flags: [] };
    for (const key of numericKeys) {
      if (!(key in normalized)) continue;
      if (normalized[key] === null) {
        normalized.flags.push("null");
        nullFields.push({ id: normalized.id, field: key });
        continue;
      }
      const bound = bounds[key];
      if (bound && (normalized[key] < bound.low || normalized[key] > bound.high)) {
        normalized.flags.push("outlier");
        outliers.push({
          id: normalized.id,
          field: key,
          raw: normalized[key],
          clamped: bound.high,
          z: round(Math.abs(normalized[key] - bound.center) / (1.4826 * Math.max(bound.mad, 0.0001)), 2)
        });
        normalized[key] = bound.high;
      }
    }
    return normalized;
  });

  const sum = (key) => accepted.reduce((total, record) => total + (record[key] ?? 0), 0);
  const present = (key) => accepted.filter((record) => record[key] !== null && record[key] !== undefined);
  const mean = (key) => {
    const values = present(key);
    return values.length ? values.reduce((total, record) => total + record[key], 0) / values.length : 0;
  };

  const primary = sum(sample.primaryKey);
  const secondary = sum(sample.secondaryKey);
  const calculated = sample.id === "A"
    ? { revenue: primary, orders: secondary, aov: secondary ? primary / secondary : 0 }
    : { hours: primary, spend: secondary, quality: mean("quality") };

  return {
    sampleId: sample.id,
    sampleName: sample.name,
    source: sample.source,
    filter,
    filterLabel: filter === "all" ? sample.filterLabel : `${sample.entityLabel}：${filter}`,
    version: `${sample.versionBase}.r${revision}`,
    revision,
    sourceRows,
    scopedRows,
    accepted,
    duplicates,
    missingId,
    nullFields,
    outliers,
    bounds,
    calculated,
    rawCount: sourceRows.length,
    scopedCount: scopedRows.length,
    acceptedCount: accepted.length,
    quality: {
      score: Math.max(0, round(100 - nullFields.length * 2 - duplicates.length * 3 - outliers.length * 5, 1)),
      total: scopedRows.length,
      nulls: nullFields.length,
      duplicates: duplicates.length,
      outliers: outliers.length
    }
  };
}

export function sampleVersion(sample, filter, revision) {
  return `${sample.versionBase}.${filter === "all" ? "ALL" : filter}.r${revision}`;
}

export function formatNumber(value, kind = "integer") {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  if (kind === "currency") {
    if (Math.abs(number) >= 1000000) return `¥${(number / 1000000).toFixed(2)}M`;
    if (Math.abs(number) >= 1000) return `¥${(number / 1000).toFixed(1)}K`;
    return `¥${number.toFixed(0)}`;
  }
  if (kind === "score") return `${number.toFixed(1)}`;
  if (Math.abs(number) >= 10000) return `${(number / 1000).toFixed(1)}K`;
  return Math.round(number).toLocaleString("en-US");
}

export function formatFull(value, kind = "integer") {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  if (kind === "currency") return `¥${Math.round(number).toLocaleString("zh-CN")}`;
  if (kind === "score") return Number(number).toFixed(1);
  return Math.round(number).toLocaleString("zh-CN");
}

export function buildCards(sample, result) {
  const values = result.calculated;
  const extra = sample.id === "A"
    ? [
        { note: `AOV ${formatFull(values.aov, "currency")}` },
        { note: `${result.accepted.length} 渠道` },
        { note: `${result.outliers.length} 异常已钳制` }
      ]
    : [
        { note: `${result.accepted.length} 单元` },
        { note: `${formatFull(values.spend, "currency")} 云成本` },
        { note: `${result.quality.score} 质量分` }
      ];
  return sample.metrics.map((metric, index) => {
    let value = values[metric.key];
    if (metric.key === "quality") value = values.quality;
    return {
      label: metric.short,
      value: formatNumber(value, metric.format),
      full: formatFull(value, metric.format),
      note: extra[index]?.note || metric.formula || ""
    };
  });
}

export function dataSignature(result, cards) {
  const text = JSON.stringify({
    version: result.version,
    accepted: result.acceptedCount,
    values: result.calculated,
    cards: cards.map((card) => [card.label, card.value]),
    issueCounts: [result.quality.nulls, result.quality.duplicates, result.quality.outliers]
  });
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `0x${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
