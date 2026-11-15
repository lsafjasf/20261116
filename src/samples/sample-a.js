// 固定样例 A：8 节点网格，含空值/重复记录/异常值等脏数据

export const sampleA = {
  id: 'sample-a-grid',
  version: 1,
  horizon: 48,
  nodes: [
    { id: 'N1', x: 60, y: 60 },
    { id: 'N2', x: 240, y: 60 },
    { id: 'N3', x: 420, y: 60 },
    { id: 'N4', x: 600, y: 60 },
    { id: 'N5', x: 60, y: 300 },
    { id: 'N6', x: 240, y: 300 },
    { id: 'N7', x: 420, y: 300 },
    { id: 'N8', x: 600, y: 300 },
    { id: 'N2', x: 999, y: 999 },            // 重复节点，应被剔除
    { id: 'N9', x: null, y: 200 },           // 空坐标，应修正
    { id: '', x: 1, y: 1 },                  // 缺 id，应被剔除
  ],
  edges: [
    { id: 'E1', from: 'N1', to: 'N2', length: 180, lanes: 2, capacity: 4, weight: 1 },
    { id: 'E2', from: 'N2', to: 'N3', length: 180, lanes: 2, capacity: 4, weight: 1 },
    { id: 'E3', from: 'N3', to: 'N4', length: 180, lanes: 2, capacity: 2, weight: 1 },
    { id: 'E4', from: 'N1', to: 'N5', length: 240, lanes: 1, capacity: 3, weight: 1.2 },
    { id: 'E5', from: 'N2', to: 'N6', length: 240, lanes: 1, capacity: 3, weight: 1 },
    { id: 'E6', from: 'N3', to: 'N7', length: 240, lanes: 1, capacity: 2, weight: 1 },
    { id: 'E7', from: 'N4', to: 'N8', length: 240, lanes: 1, capacity: 3, weight: 1 },
    { id: 'E8', from: 'N5', to: 'N6', length: 180, lanes: 2, capacity: 4, weight: null }, // 空权重 -> 1
    { id: 'E9', from: 'N6', to: 'N7', length: 180, lanes: 2, capacity: 4, weight: 1 },
    { id: 'E10', from: 'N7', to: 'N8', length: 180, lanes: 2, capacity: 4, weight: 9999 }, // 异常权重 -> 截断 100
    { id: 'E11', from: 'N2', to: 'N7', length: 300, lanes: -1, capacity: 0, weight: 1 },   // 车道/容量非法
    { id: 'E12', from: 'N6', to: 'N3', length: -50, lanes: 1, capacity: 3, weight: 1 },    // 负长度 -> 100
    { id: 'E13', from: 'N1', to: 'NX', length: 100, lanes: 1, capacity: 3, weight: 1 },    // 端点缺失 -> 剔除
    { id: 'E1', from: 'N5', to: 'N7', length: 100, lanes: 1, capacity: 3, weight: 1 },     // 重复 id -> 剔除
    { id: 'E14', from: 'N6', to: 'N6', length: 100, lanes: 1, capacity: 3, weight: 1 },    // 自环 -> 剔除
  ],
  trips: [
    { id: 'V1', origin: 'N1', destination: 'N8', release: 0, deadline: 40 },
    { id: 'V2', origin: 'N1', destination: 'N8', release: 2, deadline: 40 },
    { id: 'V3', origin: 'N2', destination: 'N7', release: 1, deadline: 30 },
    { id: 'V4', origin: 'N5', destination: 'N4', release: 4, deadline: 36 },
    { id: 'V5', origin: 'N6', destination: 'N3', release: 6, deadline: 20 },
    { id: 'V6', origin: 'N5', destination: 'N2', release: 3, deadline: null },   // 空截止
    { id: 'V7', origin: 'N9', destination: 'N1', release: -5, deadline: 40 },    // 负释放
    { id: 'V8', origin: 'N9', destination: 'N1', release: 999, deadline: 40 },   // 释放超窗
    { id: 'V1', origin: 'N3', destination: 'N5', release: 0, deadline: 40 },     // 重复车辆 -> 剔除
    { id: 'V9', origin: 'N3', destination: 'NZ', release: 0, deadline: 40 },     // 终点缺失 -> 剔除
    { id: '', origin: 'N1', destination: 'N2', release: 0, deadline: 40 },       // 缺 id -> 剔除
  ],
};
