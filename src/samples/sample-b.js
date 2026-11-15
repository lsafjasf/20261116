// 固定样例 B：双通道拓扑，用于确定性验证封路重规划；同样含脏数据

export const sampleB = {
  id: 'sample-b-bypass',
  version: 1,
  horizon: 40,
  nodes: [
    { id: 'S', x: 60, y: 180 },
    { id: 'A', x: 240, y: 80 },
    { id: 'B', x: 440, y: 80 },
    { id: 'C', x: 240, y: 300 },
    { id: 'D', x: 440, y: 300 },
    { id: 'T', x: 640, y: 180 },
    { id: 'X', x: 340, y: 180 },
    { id: 'X', x: 0, y: 0 },                 // 重复节点
    { id: 'GHOST', x: undefined, y: NaN },   // 坐标非法
  ],
  edges: [
    // 上路通道（短，优先选择）
    { id: 'SA', from: 'S', to: 'A', length: 120, lanes: 1, capacity: 2, weight: 1 },
    { id: 'AB', from: 'A', to: 'B', length: 200, lanes: 1, capacity: 2, weight: 1 },
    { id: 'BT', from: 'B', to: 'T', length: 120, lanes: 1, capacity: 2, weight: 1 },
    // 下路绕行通道（长）
    { id: 'SC', from: 'S', to: 'C', length: 160, lanes: 1, capacity: 2, weight: 1 },
    { id: 'CD', from: 'C', to: 'D', length: 200, lanes: 1, capacity: 2, weight: 1 },
    { id: 'DT', from: 'D', to: 'T', length: 160, lanes: 1, capacity: 2, weight: 1 },
    // 中部联络线
    { id: 'AX', from: 'A', to: 'X', length: 120, lanes: 1, capacity: 2, weight: 1 },
    { id: 'CX', from: 'C', to: 'X', length: 120, lanes: 1, capacity: 2, weight: 1 },
    { id: 'XT', from: 'X', to: 'T', length: 320, lanes: 1, capacity: 2, weight: 1 },
    { id: 'BAD1', from: 'S', to: 'ZZ', length: 'abc', lanes: 1, capacity: 2, weight: 0 }, // 端点缺失被剔除，且长度/权重非法
    { id: 'BAD2', from: 'A', to: 'GHOST', length: 100, lanes: 1, capacity: 2, weight: 1 }, // 端点节点非法坐标但存在
    { id: 'SA', from: 'S', to: 'B', length: 10, lanes: 1, capacity: 2, weight: 1 }, // 重复 id
  ],
  trips: [
    { id: 'K1', origin: 'S', destination: 'T', release: 0, deadline: 40 },
    { id: 'K2', origin: 'S', destination: 'T', release: 5, deadline: 40 },
    { id: 'K3', origin: 'A', destination: 'D', release: 2, deadline: 30 },
    { id: 'K4', origin: 'C', destination: 'B', release: 8, deadline: 30 },
    { id: 'K5', origin: 'X', destination: 'T', release: 1, deadline: 10 }, // 可能超时
    { id: 'K6', origin: 'GHOST', destination: 'S', release: 0, deadline: 40 },
    { id: 'K7', origin: 'S', destination: 'MISSING', release: 0, deadline: 40 }, // 剔除
    { id: 'K1', origin: 'A', destination: 'B', release: 0, deadline: 40 }, // 重复剔除
  ],
};

// 推荐封路方案：封掉上路中段 AB，验证车辆绕行下路
export const recommendedClosureB = { edgeId: 'AB', from: 4, to: 12 };
