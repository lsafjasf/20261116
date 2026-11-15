/* 两份固定样例：A=干净基线，B=含空值/重复/异常值 + 断供改道脚本 */
(function (global) {
  const DATA_VERSION = 'fixed-2026.11.16-v3';

  const sampleA = {
    id: 'A',
    name: '样例A · 干净基线网络',
    dataVersion: DATA_VERSION,
    tickCount: 36,
    nodes: [
      { id: 'F1', type: 'factory', x: 110, y: 120, production: 26 },
      { id: 'F2', type: 'factory', x: 110, y: 430, production: 24 },
      { id: 'W1', type: 'warehouse', x: 430, y: 200, cap: 120, init: 30 },
      { id: 'W2', type: 'warehouse', x: 430, y: 430, cap: 120, init: 26 },
      { id: 'S1', type: 'store', x: 820, y: 140, demand: 18 },
      { id: 'S2', type: 'store', x: 820, y: 320, demand: 16 },
      { id: 'S3', type: 'store', x: 820, y: 490, demand: 14 }
    ],
    edges: [
      { id: 'E01', from: 'F1', to: 'W1', cap: 35, prio: 1 },
      { id: 'E02', from: 'F2', to: 'W2', cap: 30, prio: 1 },
      { id: 'E03', from: 'W1', to: 'W2', cap: 12, prio: 2 },
      { id: 'E04', from: 'W2', to: 'W1', cap: 12, prio: 2 },
      { id: 'E05', from: 'W1', to: 'S1', cap: 24, prio: 1 },
      { id: 'E06', from: 'W1', to: 'S2', cap: 14, prio: 2 },
      { id: 'E07', from: 'W2', to: 'S2', cap: 12, prio: 1 },
      { id: 'E08', from: 'W2', to: 'S3', cap: 20, prio: 1 }
    ],
    events: [],
    interventions: []
  };

  const sampleB = {
    id: 'B',
    name: '样例B · 脏数据 + W1断供改道',
    dataVersion: DATA_VERSION,
    tickCount: 36,
    nodes: [
      { id: 'F1', type: 'factory', x: 110, y: 120, production: 26 },
      { id: 'F2', type: 'factory', x: 110, y: 430, production: 24 },
      { id: 'W1', type: 'warehouse', x: 430, y: 200, cap: 120, init: 30 },
      { id: 'W2', type: 'warehouse', x: 430, y: 430, cap: 120, init: 26 },
      { id: 'S1', type: 'store', x: 820, y: 140, demand: 18 },
      { id: 'S2', type: 'store', x: 820, y: 320, demand: 16 },
      { id: 'S3', type: 'store', x: 820, y: 490, demand: 14 },
      { id: 'S3', type: 'store', x: 700, y: 50, demand: 16 },
      { id: null, type: 'store', x: 10, y: 10, demand: 5 },
      { id: 'S4', type: 'store', x: 820, y: 60, demand: -30 },
      { id: 'S5', type: 'store', x: 650, y: 60, cap: 40, init: 999999, demand: 6 },
      { id: 'S6', type: 'store', x: 650, y: 540, demand: 9999 },
      { id: 'S7', type: 'hub', x: 300, y: 300 },
      { id: 'F9', type: 'factory', x: 60, y: 260, production: -50 }
    ],
    edges: [
      { id: 'E01', from: 'F1', to: 'W1', cap: 35, prio: 1 },
      { id: 'E02', from: 'F2', to: 'W2', cap: 30, prio: 1 },
      { id: 'E03', from: 'W1', to: 'W2', cap: 12, prio: 2 },
      { id: 'E04', from: 'W2', to: 'W1', cap: 12, prio: 2 },
      { id: 'E05', from: 'W1', to: 'S1', cap: 24, prio: 1 },
      { id: 'E06', from: 'W1', to: 'S2', cap: 14, prio: 2 },
      { id: 'E07', from: 'W2', to: 'S2', cap: 12, prio: 1 },
      { id: 'E08', from: 'W2', to: 'S3', cap: 20, prio: 1 },
      { id: 'E01', from: 'F2', to: 'W2', cap: 9, prio: 5 },
      { id: null, from: 'F1', to: 'S1', cap: 10, prio: 1 },
      { id: 'E10', from: 'X1', to: 'X2', cap: 10, prio: 1 },
      { id: 'E11', from: 'F1', to: 'W1', cap: null, prio: 1 },
      { id: 'E12', from: 'F2', to: 'W2', cap: -40, prio: 1 },
      { id: 'E13', from: 'W1', to: 'S1', cap: 24, prio: -999 },
      { id: 'E14', from: 'W2', to: 'S3', cap: 999999, prio: 1 }
    ],
    events: [
      { id: 'EV1', type: 'outage', target: 'W1', atTick: 10, duration: 4 },
      { id: 'EV2', type: 'partial', target: 'W1', atTick: 14, duration: 6, edgeCap: 4 }
    ],
    interventions: [
      { id: 'IV1', atTick: 14, edgeOverrides: {
        E04: { cap: 24, prio: 1 },
        E05: { cap: 30, prio: 1 },
        E06: { cap: 20, prio: 2 },
        E01: { cap: 42, prio: 1 }
      } }
    ]
  };

  global.App = global.App || {};
  global.App.DATA_VERSION = DATA_VERSION;
  global.App.samples = { A: sampleA, B: sampleB };
})(typeof window !== 'undefined' ? window : globalThis);
