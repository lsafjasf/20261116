// 路网图结构、数据清洗与 Dijkstra 路径规划（纯函数，无 DOM 依赖）

export const EDGE_FIELDS = ['id', 'from', 'to', 'length', 'lanes', 'capacity', 'weight', 'directed'];

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

// 将可能含脏数据的原始数据集清洗为规范化图数据，逐条返回剔除/修正原因
export function sanitizeDataset(raw) {
  const issues = [];
  const nodeIds = new Set();
  const nodes = [];
  for (const n of raw.nodes || []) {
    if (!n || typeof n.id !== 'string' || n.id.trim() === '') {
      issues.push({ level: 'drop', scope: 'node', ref: JSON.stringify(n), reason: '节点缺少有效 id' });
      continue;
    }
    if (nodeIds.has(n.id)) {
      issues.push({ level: 'drop', scope: 'node', ref: n.id, reason: '节点 id 重复，保留首条' });
      continue;
    }
    const x = num(n.x, NaN);
    const y = num(n.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      issues.push({ level: 'fix', scope: 'node', ref: n.id, reason: '坐标为空或非数值，按索引占位' });
    }
    nodeIds.add(n.id);
    nodes.push({
      id: n.id,
      x: Number.isFinite(x) ? x : nodes.length * 100,
      y: Number.isFinite(y) ? y : nodes.length * 80,
    });
  }

  const edgeIds = new Set();
  const edges = [];
  for (const e of raw.edges || []) {
    if (!e || typeof e.id !== 'string' || e.id.trim() === '') {
      issues.push({ level: 'drop', scope: 'edge', ref: JSON.stringify(e), reason: '道路缺少有效 id' });
      continue;
    }
    if (edgeIds.has(e.id)) {
      issues.push({ level: 'drop', scope: 'edge', ref: e.id, reason: '道路 id 重复，保留首条' });
      continue;
    }
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) {
      issues.push({ level: 'drop', scope: 'edge', ref: e.id, reason: '端点节点不存在' });
      continue;
    }
    if (e.from === e.to) {
      issues.push({ level: 'drop', scope: 'edge', ref: e.id, reason: '自环道路无意义' });
      continue;
    }
    const length = num(e.length, NaN);
    const cleanLength = Number.isFinite(length) && length > 0 ? length : 100;
    if (!(Number.isFinite(length) && length > 0)) {
      issues.push({ level: 'fix', scope: 'edge', ref: e.id, reason: '长度为空/非正，回退 100' });
    }
    let weight = num(e.weight, 1);
    if (!(weight > 0)) {
      issues.push({ level: 'fix', scope: 'edge', ref: e.id, reason: '权重为空/非正，回退 1' });
      weight = 1;
    }
    if (weight > 100) {
      issues.push({ level: 'fix', scope: 'edge', ref: e.id, reason: '权重异常偏大，截断为 100' });
      weight = 100;
    }
    let lanes = Math.trunc(num(e.lanes, 1));
    if (!(lanes > 0)) {
      issues.push({ level: 'fix', scope: 'edge', ref: e.id, reason: '车道数为空/非正，回退 1' });
      lanes = 1;
    }
    let capacity = Math.trunc(num(e.capacity, NaN));
    if (!(capacity > 0)) {
      capacity = lanes * 10;
      issues.push({ level: 'fix', scope: 'edge', ref: e.id, reason: '通行能力为空/非正，按车道推算' });
    }
    if (capacity > 10000) {
      issues.push({ level: 'fix', scope: 'edge', ref: e.id, reason: '通行能力异常，截断为 10000' });
      capacity = 10000;
    }
    edgeIds.add(e.id);
    edges.push({
      id: e.id, from: e.from, to: e.to,
      length: cleanLength, lanes, capacity,
      weight: round6(weight), directed: e.directed === true,
    });
  }

  const trips = [];
  const tripIds = new Set();
  const horizon = num(raw.horizon, 60);
  for (const t of raw.trips || []) {
    if (!t || typeof t.id !== 'string' || t.id.trim() === '') {
      issues.push({ level: 'drop', scope: 'trip', ref: JSON.stringify(t), reason: '车辆缺少有效 id' });
      continue;
    }
    if (tripIds.has(t.id)) {
      issues.push({ level: 'drop', scope: 'trip', ref: t.id, reason: '车辆 id 重复，保留首条' });
      continue;
    }
    if (!nodeIds.has(t.origin) || !nodeIds.has(t.destination)) {
      issues.push({ level: 'drop', scope: 'trip', ref: t.id, reason: '起终点节点不存在' });
      continue;
    }
    let release = Math.trunc(num(t.release, 0));
    if (release < 0) {
      issues.push({ level: 'fix', scope: 'trip', ref: t.id, reason: '释放时刻为负，归零' });
      release = 0;
    }
    if (release >= horizon) {
      issues.push({ level: 'fix', scope: 'trip', ref: t.id, reason: '释放时刻超出仿真窗口，截断' });
      release = horizon - 1;
    }
    let deadline = num(t.deadline, NaN);
    if (!Number.isFinite(deadline) || deadline <= release) {
      deadline = horizon;
      issues.push({ level: 'fix', scope: 'trip', ref: t.id, reason: '截止时刻为空/非法，取仿真窗口末尾' });
    }
    tripIds.add(t.id);
    trips.push({ id: t.id, origin: t.origin, destination: t.destination, release, deadline: round6(deadline) });
  }

  return {
    data: { id: raw.id || 'dataset', version: raw.version || 1, horizon, nodes, edges, trips },
    issues,
  };
}

// 运行期路网：支持权重覆盖与按时间窗封路
export class Graph {
  constructor(data) {
    this.data = data;
    this.nodeById = new Map(data.nodes.map((n) => [n.id, n]));
    this.edgeById = new Map(data.edges.map((e) => [e.id, { ...e }]));
    this.adj = new Map(data.nodes.map((n) => [n.id, []]));
    for (const e of this.edgeById.values()) {
      this.adj.get(e.from).push(e);
      if (!e.directed) this.adj.get(e.to).push(e);
    }
    this.weightOverrides = new Map(); // edgeId -> 权重
    this.closures = []; // {edgeId, from, to}
  }

  setWeight(edgeId, weight) {
    const w = Number(weight);
    if (Number.isFinite(w) && w > 0) this.weightOverrides.set(edgeId, Math.min(w, 100));
  }

  resetWeight(edgeId) {
    this.weightOverrides.delete(edgeId);
  }

  effectiveWeight(edge) {
    return this.weightOverrides.has(edge.id) ? this.weightOverrides.get(edge.id) : edge.weight;
  }

  addClosure(edgeId, from, to) {
    this.closures = this.closures.filter((c) => c.edgeId !== edgeId);
    this.closures.push({ edgeId, from: Math.max(0, Math.trunc(from)), to: Math.trunc(to) });
  }

  removeClosure(edgeId) {
    this.closures = this.closures.filter((c) => c.edgeId !== edgeId);
  }

  isClosed(edgeId, tick) {
    return this.closures.some((c) => c.edgeId === edgeId && tick >= c.from && tick <= c.to);
  }

  // 路径代价 = 长度 * 权重，closedAt 时刻封闭的边完全不参与规划
  dijkstra(origin, destination, closedAt = -1, congestion = new Map()) {
    const dist = new Map();
    const prev = new Map();
    const visited = new Set();
    for (const id of this.adj.keys()) dist.set(id, Infinity);
    dist.set(origin, 0);
    const queue = [origin];
    const relax = () => {
      let bestIdx = 0;
      for (let i = 1; i < queue.length; i += 1) {
        if (dist.get(queue[i]) < dist.get(queue[bestIdx])) bestIdx = i;
      }
      return queue.splice(bestIdx, 1)[0];
    };
    let expansions = 0;
    while (queue.length) {
      const current = relax();
      if (visited.has(current)) continue;
      visited.add(current);
      expansions += 1;
      if (current === destination) break;
      for (const edge of this.adj.get(current)) {
        if (this.isClosed(edge.id, closedAt)) continue;
        const neighbor = edge.from === current ? edge.to : edge.from;
        if (visited.has(neighbor)) continue;
        const load = congestion.get(edge.id) || 0;
        const congestionPenalty = edge.capacity > 0 ? Math.pow(load / edge.capacity, 2) * edge.length : 0;
        const cost = edge.length * this.effectiveWeight(edge) + congestionPenalty;
        const candidate = dist.get(current) + cost;
        if (candidate < dist.get(neighbor)) {
          dist.set(neighbor, candidate);
          prev.set(neighbor, { node: current, edgeId: edge.id });
          if (!queue.includes(neighbor)) queue.push(neighbor);
        }
      }
    }
    const edges = [];
    const nodes = [];
    let cursor = destination;
    if (cursor !== origin && !prev.has(cursor)) {
      return { reachable: false, nodePath: [], edgePath: [], cost: Infinity, expansions, dist };
    }
    while (cursor !== origin) {
      const step = prev.get(cursor);
      if (!step) break;
      edges.unshift(step.edgeId);
      nodes.unshift(cursor);
      cursor = step.node;
    }
    nodes.unshift(origin);
    return { reachable: true, nodePath: nodes, edgePath: edges, cost: dist.get(destination), expansions, dist };
  }
}
