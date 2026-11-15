import { LAYER_ORDER } from "./core.js";

function frame(id, label, series) {
  return { id, label, series };
}

function scaleSeries(series, factor, offset = 0) {
  return series.map((item) => ({
    ...item,
    data: item.data.map((point) => ({
      ...point,
      y: point.y == null ? null : Number((point.y * factor + offset).toFixed(3))
    }))
  }));
}

function chart(config) {
  const frames = config.frames.map((item, index) => {
    if (index === 0) return item;
    return item;
  });
  return {
    id: config.id,
    width: config.width ?? 920,
    height: config.height ?? 460,
    padding: config.padding ?? 22,
    title: config.title,
    subtitle: config.subtitle ?? "",
    xLabel: config.xLabel ?? "",
    yLabel: config.yLabel ?? "",
    xAxis: config.xAxis ?? { type: "linear", tickCount: 7 },
    yAxis: config.yAxis ?? { type: "linear", tickCount: 6 },
    background: config.background ?? "#ffffff",
    fontFamily: config.fontFamily ?? "'AtlasNoto', 'Noto Sans SC', system-ui, sans-serif",
    fontSize: config.fontSize ?? 12,
    exportScale: config.exportScale ?? 2,
    frames,
    selectedFrame: 0
  };
}

export function chartToSpec(source, layerOrder = LAYER_ORDER) {
  const selected = Math.max(0, Math.min(source.selectedFrame ?? 0, source.frames.length - 1));
  return {
    width: source.width,
    height: source.height,
    padding: source.padding,
    title: source.title,
    subtitle: source.subtitle,
    xLabel: source.xLabel,
    yLabel: source.yLabel,
    xAxis: { ...source.xAxis, label: source.xLabel },
    yAxis: { ...source.yAxis, label: source.yLabel },
    series: source.frames[selected].series,
    background: source.background,
    fontFamily: source.fontFamily,
    fontSize: source.fontSize,
    exportScale: source.exportScale,
    layerOrder
  };
}

const lineBase = [
  {
    id: "cache",
    name: "缓存命中",
    type: "line",
    color: "#2367d1",
    data: [
      { x: 0, y: 32 }, { x: 1, y: 28 }, { x: 2, y: 35 }, { x: 3, y: null },
      { x: 4, y: 41 }, { x: 5, y: -14, label: "负值回补" }, { x: 6, y: -9 },
      { x: 7, y: 18 }, { x: 8, y: 61 }, { x: 9, y: 74 }, { x: 10, y: 58 }, { x: 11, y: 52 }
    ]
  },
  {
    id: "origin",
    name: "回源请求",
    type: "line",
    color: "#e1773d",
    data: [
      { x: 0, y: 18 }, { x: 1, y: 22 }, { x: 2, y: 17 }, { x: 3, y: 24 },
      { x: 4, y: 30 }, { x: 5, y: 22 }, { x: 6, y: 31 }, { x: 7, y: 190, label: "离群尖峰" },
      { x: 8, y: 42 }, { x: 9, y: 38 }, { x: 10, y: 35 }, { x: 11, y: 40 }
    ]
  },
  {
    id: "static",
    name: "静态资源",
    type: "line",
    color: "#16836f",
    data: [
      { x: 0, y: 8 }, { x: 1, y: 10 }, { x: 2, y: null }, { x: 3, y: 12 },
      { x: 4, y: 14 }, { x: 5, y: 9 }, { x: 6, y: 16 }, { x: 7, y: 21 },
      { x: 8, y: 18 }, { x: 9, y: 19 }, { x: 10, y: 15 }, { x: 11, y: 17 }
    ]
  }
];

const areaBase = [
  {
    id: "read-qps",
    name: "读取 QPS",
    type: "area",
    color: "#2367d1",
    data: [
      { x: 0, y: 42 }, { x: 1, y: 55 }, { x: 2, y: 61 }, { x: 3, y: 0 },
      { x: 4, y: 72 }, { x: 5, y: 66 }, { x: 6, y: 91 }, { x: 7, y: 88 },
      { x: 8, y: 109 }, { x: 9, y: 940, label: "离群值" }, { x: 10, y: 120 }, { x: 11, y: 132 }
    ]
  },
  {
    id: "write-qps",
    name: "写入 QPS",
    type: "area",
    color: "#16836f",
    data: [
      { x: 0, y: 11 }, { x: 1, y: 15 }, { x: 2, y: 18 }, { x: 3, y: 17 },
      { x: 4, y: null }, { x: 5, y: 22 }, { x: 6, y: 21 }, { x: 7, y: 26 },
      { x: 8, y: 29 }, { x: 9, y: 34 }, { x: 10, y: 38 }, { x: 11, y: 33 }
    ]
  },
  {
    id: "replica-qps",
    name: "复制 QPS",
    type: "area",
    color: "#8d59c7",
    data: [
      { x: 0, y: 5 }, { x: 1, y: 6 }, { x: 2, y: 7 }, { x: 3, y: 8 },
      { x: 4, y: 7 }, { x: 5, y: 9 }, { x: 6, y: null }, { x: 7, y: 11 },
      { x: 8, y: 12 }, { x: 9, y: 13 }, { x: 10, y: 12 }, { x: 11, y: 14 }
    ]
  }
];

const scatterBase = [
  {
    id: "p50",
    name: "P50",
    type: "scatter",
    color: "#2367d1",
    data: [
      { x: 8, y: 4 }, { x: 15, y: 9 }, { x: 32, y: 12 }, { x: 70, y: 18 },
      { x: 140, y: 25 }, { x: 300, y: 31 }, { x: 620, y: 44 }, { x: 1100, y: 52 },
      { x: 2400, y: 68 }, { x: 5000, y: null }, { x: 6200, y: 89 }
    ]
  },
  {
    id: "p99",
    name: "P99",
    type: "scatter",
    color: "#c84069",
    data: [
      { x: 10, y: 82 }, { x: 20, y: 91 }, { x: 45, y: 110 }, { x: 95, y: 150 },
      { x: 210, y: 205 }, { x: 430, y: 280 }, { x: 900, y: 390 }, { x: 1800, y: 510 },
      { x: 7600, y: 9800, label: "P99 离群" }
    ]
  },
  {
    id: "cold",
    name: "冷启动",
    type: "scatter",
    color: "#e1773d",
    data: [
      { x: 2, y: 520 }, { x: 5, y: 610 }, { x: 12, y: 440 }, { x: 24, y: 720 },
      { x: 48, y: null }, { x: 50, y: 880 }, { x: 110, y: 1020 }, { x: 220, y: 1300 },
      { x: 480, y: 1150 }, { x: 1200, y: 2600 }
    ]
  }
];

export const DEFAULT_SCENARIO = {
  id: "default",
  name: "默认参数",
  note: "完整布局、三类图形与离群标注",
  charts: [
    chart({
      id: "edge-flow",
      title: "01 · 边缘流量",
      subtitle: "折线 · 负值回补 · 缺失点断线 · 离群尖峰",
      xLabel: "采样窗口",
      yLabel: "净流量",
      xAxis: { type: "linear", tickCount: 7, domain: [-0.4, 11.4] },
      yAxis: { type: "linear", tickCount: 7, domain: [-35, 215] },
      frames: [
        frame("k1", "基准", lineBase),
        frame("k2", "上行", scaleSeries(lineBase, 1.12, 3)),
        frame("k3", "压力", scaleSeries(lineBase, 1.3, -2))
      ]
    }),
    chart({
      id: "request-load",
      title: "02 · 请求负载",
      subtitle: "面积 · 对数 Y 轴 · 非正值安全跳过",
      xLabel: "采样窗口",
      yLabel: "QPS（对数）",
      xAxis: { type: "linear", tickCount: 7, domain: [-0.4, 11.4] },
      yAxis: { type: "log", tickCount: 7, domain: [3, 1400] },
      frames: [
        frame("k1", "基准", areaBase),
        frame("k2", "上行", scaleSeries(areaBase, 1.18, 0)),
        frame("k3", "压力", scaleSeries(areaBase, 1.46, 0))
      ]
    }),
    chart({
      id: "tail-latency",
      title: "03 · 尾延迟分布",
      subtitle: "散点 · 对数双轴 · 离群点自动避让",
      xLabel: "请求量",
      yLabel: "延迟 ms（对数）",
      xAxis: { type: "log", tickCount: 7, domain: [1, 10000] },
      yAxis: { type: "log", tickCount: 7, domain: [1, 15000] },
      frames: [
        frame("k1", "基准", scatterBase),
        frame("k2", "上行", scaleSeries(scatterBase, 1.1, 0)),
        frame("k3", "压力", scaleSeries(scatterBase, 1.28, 0))
      ]
    })
  ]
};

const boundaryLine = [
  {
    id: "cdn-hit",
    name: "CDN 边缘缓存命中率",
    type: "line",
    color: "#2367d1",
    data: [
      { x: 0, y: -8 }, { x: 1, y: -4 }, { x: 2, y: 0 }, { x: 3, y: 7 },
      { x: 4, y: null }, { x: 5, y: 16 }, { x: 6, y: 14 }, { x: 7, y: 28 },
      { x: 8, y: 350, label: "越界尖峰" }, { x: 9, y: 31 }, { x: 10, y: 26 },
      { x: 11, y: 22 }, { x: 12, y: 18 }
    ]
  },
  {
    id: "origin-fill",
    name: "回源补齐请求量",
    type: "line",
    color: "#e1773d",
    data: [
      { x: 0, y: 12 }, { x: 1, y: 16 }, { x: 2, y: 19 }, { x: 3, y: 17 },
      { x: 4, y: 24 }, { x: 5, y: null }, { x: 6, y: 29 }, { x: 7, y: 33 },
      { x: 8, y: 41 }, { x: 9, y: 39 }, { x: 10, y: 36 }, { x: 11, y: 31 }, { x: 12, y: 34 }
    ]
  },
  {
    id: "edge-error",
    name: "边缘错误率（千分比）",
    type: "line",
    color: "#16836f",
    data: [
      { x: 0, y: 3 }, { x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: -2 },
      { x: 4, y: 1 }, { x: 5, y: 3 }, { x: 6, y: 2 }, { x: 7, y: null },
      { x: 8, y: 5 }, { x: 9, y: 4 }, { x: 10, y: 2 }, { x: 11, y: 1 }, { x: 12, y: 2 }
    ]
  },
  {
    id: "retry",
    name: "异步重试吞吐量",
    type: "line",
    color: "#8d59c7",
    data: [
      { x: 0, y: 9 }, { x: 1, y: 11 }, { x: 2, y: 15 }, { x: 3, y: 13 },
      { x: 4, y: 18 }, { x: 5, y: 21 }, { x: 6, y: 20 }, { x: 7, y: 24 },
      { x: 8, y: 27 }, { x: 9, y: 22 }, { x: 10, y: 26 }, { x: 11, y: 29 }, { x: 12, y: 25 }
    ]
  },
  {
    id: "cold-cache",
    name: "冷缓存预热任务数",
    type: "line",
    color: "#c84069",
    data: [
      { x: 0, y: null }, { x: 1, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 5 },
      { x: 4, y: 6 }, { x: 5, y: 5 }, { x: 6, y: 8 }, { x: 7, y: 7 },
      { x: 8, y: 10 }, { x: 9, y: 9 }, { x: 10, y: 12 }, { x: 11, y: 8 }, { x: 12, y: 11 }
    ]
  }
];

const boundaryArea = [
  {
    id: "read",
    name: "读取吞吐",
    type: "area",
    color: "#2367d1",
    data: [
      { x: 0, y: 0.5 }, { x: 10, y: 1.4 }, { x: 20, y: 3.2 }, { x: 30, y: 0 },
      { x: 40, y: 18 }, { x: 50, y: 31 }, { x: 60, y: 52 }, { x: 70, y: 88 },
      { x: 80, y: 120000, label: "六位数离群值" }, { x: 90, y: 160 }, { x: 100, y: 210 }
    ]
  },
  {
    id: "write",
    name: "写入吞吐",
    type: "area",
    color: "#16836f",
    data: [
      { x: 0, y: 0.8 }, { x: 10, y: 1.1 }, { x: 20, y: 2.4 }, { x: 30, y: 3.1 },
      { x: 40, y: null }, { x: 50, y: 12 }, { x: 60, y: 18 }, { x: 70, y: 25 },
      { x: 80, y: 33 }, { x: 90, y: 40 }, { x: 100, y: 48 }
    ]
  }
];

const boundaryScatter = [
  {
    id: "edge",
    name: "边缘节点",
    type: "scatter",
    color: "#e1773d",
    data: [
      { x: 1, y: 2 }, { x: 5, y: -3 }, { x: 12, y: 8 }, { x: 30, y: 0 },
      { x: 70, y: -11 }, { x: 180, y: 14 }, { x: 480, y: null },
      { x: 1200, y: 21 }, { x: 4200, y: 9 }, { x: 12000, y: 1200, label: "边界外离群" }
    ]
  },
  {
    id: "origin",
    name: "回源节点",
    type: "scatter",
    color: "#8d59c7",
    data: [
      { x: 2, y: -4 }, { x: 8, y: 2 }, { x: 22, y: -2 }, { x: 55, y: 6 },
      { x: 130, y: 0 }, { x: 310, y: -8 }, { x: 900, y: 11 }, { x: 2400, y: 7 },
      { x: 7000, y: 19 }
    ]
  }
];

export const BOUNDARY_SCENARIO = {
  id: "boundary",
  name: "边界参数",
  note: "窄画布、长图例、密集刻度与显式极值域",
  charts: [
    chart({
      id: "boundary-line",
      width: 560,
      height: 300,
      padding: 14,
      fontSize: 10,
      title: "B1 · 窄画布多系列",
      subtitle: "5 条长图例 · 12 个 X 刻度 · 负值与空档",
      xLabel: "小时",
      yLabel: "指标",
      xAxis: { type: "linear", tickCount: 12, domain: [-0.2, 12.2] },
      yAxis: { type: "linear", tickCount: 8, domain: [-20, 380] },
      frames: [
        frame("k1", "基准", boundaryLine),
        frame("k2", "上行", scaleSeries(boundaryLine, 1.08, 1)),
        frame("k3", "压力", scaleSeries(boundaryLine, 1.24, -1))
      ]
    }),
    chart({
      id: "boundary-area",
      width: 560,
      height: 300,
      padding: 14,
      fontSize: 10,
      title: "B2 · 对数极值域",
      subtitle: "0.1–200000 · 零值跳过 · 面积断段",
      xLabel: "负载阶段",
      yLabel: "QPS（对数）",
      xAxis: { type: "linear", tickCount: 7, domain: [0, 100] },
      yAxis: { type: "log", tickCount: 9, domain: [0.1, 200000] },
      frames: [
        frame("k1", "基准", boundaryArea),
        frame("k2", "上行", scaleSeries(boundaryArea, 1.2, 0)),
        frame("k3", "压力", scaleSeries(boundaryArea, 1.5, 0))
      ]
    }),
    chart({
      id: "boundary-scatter",
      width: 560,
      height: 300,
      padding: 14,
      fontSize: 10,
      title: "B3 · 负值与边界离群",
      subtitle: "对数 X 轴 · 线性 Y 轴 · 标签贴近边缘",
      xLabel: "请求量",
      yLabel: "偏差",
      xAxis: { type: "log", tickCount: 7, domain: [1, 30000] },
      yAxis: { type: "linear", tickCount: 7, domain: [-15, 1250] },
      frames: [
        frame("k1", "基准", boundaryScatter),
        frame("k2", "上行", scaleSeries(boundaryScatter, 1.12, 0)),
        frame("k3", "压力", scaleSeries(boundaryScatter, 1.3, 0))
      ]
    })
  ]
};

const abnormalLine = [
  {
    id: "dup",
    name: "超长图例名称用于验证边界截断与安全回退行为",
    type: "heatmap",
    color: "not-a-color",
    data: [
      { x: 0, y: -20 }, { x: 1, y: 0 }, { x: 2, y: null }, { x: 3, y: 18 },
      { x: 4, y: 27, label: "异常参数下的离群点" }, { x: 5, y: 9 }
    ]
  },
  {
    id: "dup",
    name: "重复 ID 系列",
    type: "line",
    color: "#16836f",
    data: [
      { x: 0, y: 6 }, { x: 1, y: Number.NaN }, { x: 2, y: 14 },
      { x: 3, y: Infinity }, { x: 4, y: 22 }, { x: 5, y: null }
    ]
  },
  {
    id: "empty",
    name: "全缺失系列",
    type: "area",
    color: "#e1773d",
    data: [{ x: 0, y: null }, { x: 1, y: null }, { x: 2, y: null }]
  }
];

const abnormalArea = [
  {
    id: "log-area",
    name: "对数面积",
    type: "area",
    color: "#2367d1",
    data: [
      { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 2, y: 0.8 }, { x: 3, y: 2.4 },
      { x: 4, y: 6.6 }, { x: 5, y: 18 }, { x: 6, y: 54 }, { x: 7, y: null },
      { x: 8, y: 410 }, { x: 9, y: 1000000, label: "百万级异常值" }, { x: 10, y: 3200 }
    ]
  },
  {
    id: "invalid-log",
    name: "非正值系列",
    type: "line",
    color: "#c84069",
    data: [
      { x: 0, y: 0 }, { x: 1, y: -2 }, { x: 2, y: -10 }, { x: 3, y: 0 },
      { x: 4, y: null }, { x: 5, y: -1 }
    ]
  }
];

const abnormalScatter = [
  {
    id: "bad-points",
    name: "脏数据散点",
    type: "scatter",
    color: "#8d59c7",
    data: [
      { x: null, y: 8 }, { x: 0, y: 0 }, { x: -3, y: 5 }, { x: 2, y: 0 },
      { x: 6, y: -4 }, { x: 14, y: 8 }, { x: 36, y: 17 },
      { x: 90, y: 24, label: "异常离群点" }, { x: 220, y: null }, { x: 800, y: 31 }
    ]
  },
  {
    id: "scatter-second",
    name: "第二条散点",
    type: "scatter",
    color: "#e1773d",
    data: [
      { x: 4, y: 2 }, { x: 9, y: 6 }, { x: 20, y: 11 }, { x: 60, y: 14 },
      { x: 140, y: 19 }, { x: 400, y: 23 }
    ]
  }
];

export const ABNORMAL_SCENARIO = {
  id: "abnormal",
  name: "异常参数",
  note: "非法尺寸、类型、范围、重复 ID 与脏数据均安全降级",
  charts: [
    chart({
      id: "abnormal-line",
      width: 180,
      height: 90,
      padding: 500,
      fontSize: 42,
      title: "A1 · 超长标题在异常参数下仍必须保持可读且不与图例重叠",
      subtitle: "非法类型、非法颜色、重复 ID、NaN 与 Infinity",
      xLabel: "时间",
      yLabel: "数值",
      xAxis: { type: "time", tickCount: 0, domain: [10, -10] },
      yAxis: { type: "log", tickCount: 99, domain: [-10, 100] },
      frames: [
        frame("k1", "基准", abnormalLine),
        frame("k2", "上行", scaleSeries(abnormalLine, 1.15, 1)),
        frame("k3", "压力", scaleSeries(abnormalLine, 1.32, 0))
      ]
    }),
    chart({
      id: "abnormal-area",
      width: 0,
      height: Number.NaN,
      padding: -20,
      fontSize: 60,
      title: "A2 · 对数面积异常值",
      subtitle: "0 与负值不可绘制 · 自动提示并跳过",
      xLabel: "阶段",
      yLabel: "对数 QPS",
      xAxis: { type: "log", tickCount: 6, domain: [-1, 0] },
      yAxis: { type: "log", tickCount: 8, domain: [0, 0] },
      frames: [
        frame("k1", "基准", abnormalArea),
        frame("k2", "上行", scaleSeries(abnormalArea, 1.2, 0)),
        frame("k3", "压力", scaleSeries(abnormalArea, 1.5, 0))
      ]
    }),
    chart({
      id: "abnormal-scatter",
      width: 2000,
      height: 12,
      padding: 300,
      fontSize: 2,
      title: "A3 · 脏数据散点回退",
      subtitle: "极端尺寸被夹取 · 空值和非有限值不进入路径",
      xLabel: "量级",
      yLabel: "延迟",
      xAxis: { type: "linear", tickCount: 4, domain: [1, 1] },
      yAxis: { type: "log", tickCount: 4, domain: [-1, -2] },
      frames: [
        frame("k1", "基准", abnormalScatter),
        frame("k2", "上行", scaleSeries(abnormalScatter, 1.1, 0)),
        frame("k3", "压力", scaleSeries(abnormalScatter, 1.25, 0))
      ]
    })
  ]
};

export const SCENARIOS = [DEFAULT_SCENARIO, BOUNDARY_SCENARIO, ABNORMAL_SCENARIO];

export function getScenario(id) {
  return SCENARIOS.find((scenario) => scenario.id === id) ?? SCENARIOS[0];
}
