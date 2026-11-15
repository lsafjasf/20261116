// 离散时间仿真：车辆沿规划路径移动，支持容量排队、封路重规划与完整决策日志

import { Graph } from './graph.js';

export const SPEED = 20; // 每 tick 前进的距离单位

const r3 = (v) => Math.round(v * 1000) / 1000;

function edgeCost(graph, edge, load) {
  const penalty = edge.capacity > 0 ? Math.pow(load / edge.capacity, 2) * edge.length : 0;
  return edge.length * graph.effectiveWeight(edge) + penalty;
}

export function createSimulator(dataset, overrides = {}) {
  const graph = new Graph(dataset);
  for (const [id, w] of Object.entries(overrides.weights || {})) graph.setWeight(id, w);
  for (const c of overrides.closures || []) graph.addClosure(c.edgeId, c.from, c.to);

  const vehicles = new Map();
  for (const trip of dataset.trips) {
    vehicles.set(trip.id, {
      id: trip.id,
      origin: trip.origin,
      destination: trip.destination,
      release: trip.release,
      deadline: trip.deadline,
      state: 'pending', // pending | moving | waiting | arrived | unreachable
      node: trip.origin,
      edgeId: null,
      progress: 0,
      path: [],
      pathIndex: 0,
      distance: 0,
      travelTicks: 0,
      waitTicks: 0,
      arrivedTick: null,
      events: [],
    });
  }

  return {
    graph,
    vehicles,
    tick: 0,
    horizon: dataset.horizon,
    ticks: [],
    edgeLoadLog: [],
    debug: [],
  };
}

function currentLoad(sim) {
  const load = new Map();
  for (const v of sim.vehicles.values()) {
    if (v.edgeId) load.set(v.edgeId, (load.get(v.edgeId) || 0) + 1);
  }
  return load;
}

function plan(sim, vehicle, reason, tick) {
  const load = currentLoad(sim);
  const result = sim.graph.dijkstra(vehicle.node, vehicle.destination, tick, load);
  const edge = result.edgePath.length ? sim.graph.edgeById.get(result.edgePath[0]) : null;
  const newPath = result.edgePath.join('>');
  vehicle.events.push({
    tick,
    vehicleId: vehicle.id,
    type: reason,
    from: vehicle.node,
    to: vehicle.destination,
    edgeId: edge ? edge.id : null,
    reachable: result.reachable,
    cost: Number.isFinite(result.cost) ? r3(result.cost) : null,
    path: newPath,
    expansions: result.expansions,
    detail: reason === 'reroute-closure'
      ? `下一道路封闭，改用 ${newPath || '无可达路径'}`
      : reason === 'reroute-capacity'
        ? '下一道路达到容量，重新评估路径'
        : `初始规划 ${newPath || '无可达路径'}`,
  });
  return result;
}

function tryEnterNextEdge(sim, vehicle, tick) {
  const nextEdgeId = vehicle.path[vehicle.pathIndex];
  if (!nextEdgeId) {
    vehicle.state = vehicle.node === vehicle.destination ? 'arrived' : 'unreachable';
    if (vehicle.state === 'arrived') vehicle.arrivedTick = tick;
    return;
  }
  if (sim.graph.isClosed(nextEdgeId, tick)) {
    const result = plan(sim, vehicle, 'reroute-closure', tick);
    if (!result.reachable) {
      vehicle.state = 'unreachable';
      return;
    }
    vehicle.path = result.edgePath;
    vehicle.pathIndex = 0;
    return tryEnterNextEdge(sim, vehicle, tick);
  }
  const edge = sim.graph.edgeById.get(nextEdgeId);
  const load = currentLoad(sim);
  if ((load.get(nextEdgeId) || 0) >= edge.capacity) {
    vehicle.state = 'waiting';
    vehicle.waitTicks += 1;
    vehicle.events.push({
      tick, vehicleId: vehicle.id, type: 'wait-capacity', from: vehicle.node,
      to: vehicle.destination, edgeId: nextEdgeId, reachable: true,
      cost: null, path: vehicle.path.join('>'), expansions: 0,
      detail: `道路 ${nextEdgeId} 满载(${edge.capacity})，原地等待`,
    });
    return;
  }
  vehicle.state = 'moving';
  vehicle.edgeId = nextEdgeId;
  vehicle.progress = 0;
  vehicle.pathIndex += 1;
  vehicle.events.push({
    tick, vehicleId: vehicle.id, type: 'enter-edge', from: vehicle.node,
    to: vehicle.destination, edgeId: nextEdgeId, reachable: true,
    cost: r3(edgeCost(sim.graph, edge, load.get(nextEdgeId) || 0)),
    path: vehicle.path.join('>'), expansions: 0,
    detail: `进入 ${nextEdgeId}，长度 ${edge.length}，权重 ${sim.graph.effectiveWeight(edge)}`,
  });
}

function stepVehicle(sim, vehicle, tick) {
  if (vehicle.state === 'arrived' || vehicle.state === 'unreachable') return;
  if (vehicle.state === 'pending') {
    if (tick < vehicle.release) return;
    if (vehicle.origin === vehicle.destination) {
      vehicle.state = 'arrived';
      vehicle.arrivedTick = tick;
      vehicle.events.push({ tick, vehicleId: vehicle.id, type: 'arrive', from: vehicle.origin, to: vehicle.destination, edgeId: null, reachable: true, cost: 0, path: '', expansions: 0, detail: '起点即终点' });
      return;
    }
    const result = plan(sim, vehicle, 'plan-initial', tick);
    if (!result.reachable) {
      vehicle.state = 'unreachable';
      return;
    }
    vehicle.path = result.edgePath;
    vehicle.pathIndex = 0;
  }

  if (vehicle.edgeId == null) {
    tryEnterNextEdge(sim, vehicle, tick);
    return;
  }

  const edge = sim.graph.edgeById.get(vehicle.edgeId);
  if (sim.graph.isClosed(edge.id, tick)) {
    // 已在被封道路上：掉头回到上游节点并重规划，绝不继续穿越封闭段
    vehicle.node = edge.from === vehicle.node ? edge.from : edge.to;
    vehicle.edgeId = null;
    vehicle.progress = 0;
    vehicle.pathIndex = Math.max(0, vehicle.pathIndex - 1);
    vehicle.events.push({
      tick, vehicleId: vehicle.id, type: 'evacuate-closure', from: vehicle.node,
      to: vehicle.destination, edgeId: edge.id, reachable: true, cost: null,
      path: vehicle.path.join('>'), expansions: 0,
      detail: `所在道路 ${edge.id} 封闭，撤回节点 ${vehicle.node}`,
    });
    const result = plan(sim, vehicle, 'reroute-closure', tick);
    if (!result.reachable) {
      vehicle.state = 'unreachable';
      return;
    }
    vehicle.path = result.edgePath;
    vehicle.pathIndex = 0;
    return;
  }

  vehicle.state = 'moving';
  vehicle.travelTicks += 1;
  const remaining = edge.length - vehicle.progress;
  const step = Math.min(SPEED, remaining);
  vehicle.progress += step;
  vehicle.distance += step;
  if (vehicle.progress >= edge.length) {
    vehicle.node = edge.from === vehicle.node ? edge.to : edge.from;
    vehicle.edgeId = null;
    vehicle.progress = 0;
    vehicle.events.push({
      tick, vehicleId: vehicle.id, type: 'leave-edge', from: vehicle.node,
      to: vehicle.destination, edgeId: edge.id, reachable: true, cost: null,
      path: vehicle.path.join('>'), expansions: 0,
      detail: `通过 ${edge.id} 到达节点 ${vehicle.node}`,
    });
    if (vehicle.node === vehicle.destination) {
      vehicle.state = 'arrived';
      vehicle.arrivedTick = tick;
      vehicle.events.push({ tick, vehicleId: vehicle.id, type: 'arrive', from: vehicle.node, to: vehicle.destination, edgeId: null, reachable: true, cost: null, path: vehicle.path.join('>'), expansions: 0, detail: `第 ${tick} tick 到达终点` });
      return;
    }
    tryEnterNextEdge(sim, vehicle, tick);
  }
}

function snapshot(sim, tick) {
  const positions = [];
  for (const v of sim.vehicles.values()) {
    if (v.state === 'arrived' || v.state === 'unreachable' || v.state === 'pending') {
      const node = sim.graph.nodeById.get(v.node);
      positions.push({ id: v.id, x: node.x, y: node.y, state: v.state, edgeId: null, node: v.node });
      continue;
    }
    if (v.edgeId == null) {
      const node = sim.graph.nodeById.get(v.node);
      positions.push({ id: v.id, x: node.x, y: node.y, state: v.state, edgeId: null, node: v.node });
      continue;
    }
    const edge = sim.graph.edgeById.get(v.edgeId);
    const a = sim.graph.nodeById.get(edge.from);
    const b = sim.graph.nodeById.get(edge.to);
    const ratio = Math.min(1, v.progress / edge.length);
    positions.push({
      id: v.id,
      x: a.x + (b.x - a.x) * ratio,
      y: a.y + (b.y - a.y) * ratio,
      state: v.state, edgeId: edge.id, node: v.node,
    });
  }
  return { tick, positions, load: currentLoad(sim) };
}

export function runSimulation(dataset, overrides = {}) {
  const sim = createSimulator(dataset, overrides);
  for (let tick = 0; tick < dataset.horizon; tick += 1) {
    sim.tick = tick;
    for (const vehicle of sim.vehicles.values()) stepVehicle(sim, vehicle, tick);
    const snap = snapshot(sim, tick);
    sim.ticks.push(snap);
    sim.edgeLoadLog.push({ tick, load: [...snap.load.entries()].map(([id, count]) => ({ id, count })) });
    sim.debug.push({
      tick,
      activeEdges: snap.load.size,
      moving: [...sim.vehicles.values()].filter((v) => v.state === 'moving').length,
      waiting: [...sim.vehicles.values()].filter((v) => v.state === 'waiting').length,
      arrived: [...sim.vehicles.values()].filter((v) => v.state === 'arrived').length,
      unreachable: [...sim.vehicles.values()].filter((v) => v.state === 'unreachable').length,
      closures: sim.graph.closures
        .filter((c) => tick >= c.from && tick <= c.to)
        .map((c) => c.edgeId),
    });
  }
  return buildResult(sim);
}

export function summarize(result) {
  const rows = [...result.vehicles.values()];
  const arrived = rows.filter((v) => v.state === 'arrived');
  const waiting = rows.filter((v) => v.state === 'waiting' || v.state === 'moving' || v.state === 'pending');
  const unreachable = rows.filter((v) => v.state === 'unreachable');
  const late = arrived.filter((v) => v.arrivedTick > v.deadline);
  const totalWait = rows.reduce((s, v) => s + v.waitTicks, 0);
  const totalTravel = rows.reduce((s, v) => s + v.travelTicks, 0);
  const totalDistance = rows.reduce((s, v) => s + v.distance, 0);
  return {
    vehicles: rows.length,
    arrived: arrived.length,
    inProgress: waiting.length,
    unreachable: unreachable.length,
    late: late.length,
    totalWait,
    totalTravel,
    avgWait: rows.length ? r3(totalWait / rows.length) : 0,
    avgTravel: rows.length ? r3(totalTravel / rows.length) : 0,
    totalDistance: r3(totalDistance),
    reroutes: rows.reduce((s, v) => s + v.events.filter((e) => e.type.startsWith('reroute')).length, 0),
  };
}

// 热图强度：每条边的平均占用率
export function edgeHeatmap(result) {
  const acc = new Map();
  for (const entry of result.edgeLoadLog) {
    for (const { id, count } of entry.load) {
      acc.set(id, (acc.get(id) || 0) + count);
    }
  }
  return [...result.graph.edgeById.values()].map((edge) => {
    const avgLoad = (acc.get(edge.id) || 0) / Math.max(1, result.horizon);
    return { id: edge.id, avgLoad: r3(avgLoad), ratio: r3(avgLoad / edge.capacity), capacity: edge.capacity };
  });
}

function buildResult(sim) {
  const result = {
    horizon: sim.horizon,
    graph: sim.graph,
    vehicles: sim.vehicles,
    ticks: sim.ticks,
    edgeLoadLog: sim.edgeLoadLog,
    debug: sim.debug,
  };
  result.stats = summarize(result);
  result.heatmap = edgeHeatmap(result);
  return result;
}
