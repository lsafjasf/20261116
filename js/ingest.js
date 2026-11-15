/* 数据清洗：空值 / 重复 / 异常值，输出干净网络 + 隔离台账 */
(function (global) {
  const APP = global.App || (global.App = {});
  const LIMITS = {
    coord: 2000,
    inv: 100000,
    demand: 500,
    production: 500,
    capMax: 1000
  };
  const DEFAULT_CAP = 20;
  const DEFAULT_PRIO = 100;

  function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function clean(raw) {
    const quarantine = [];
    const q = (action, kind, id, reason, original) =>
      quarantine.push({ action, kind, id: id == null ? '(空ID)' : String(id), reason, original });

    const seen = new Map();
    const nodes = [];
    (raw.nodes || []).forEach((n) => {
      const id = n.id == null ? null : String(n.id);
      if (!id) return q('drop', 'node', n.id, '节点ID为空', n);
      if (seen.has(id)) return q('drop', 'node', id, '重复节点ID，保留首条', n);
      if (!['factory', 'warehouse', 'store'].includes(n.type))
        return q('drop', 'node', id, `未知节点类型:${n.type}`, n);
      if (!isNum(n.x) || !isNum(n.y) || Math.abs(n.x) > LIMITS.coord || Math.abs(n.y) > LIMITS.coord)
        return q('drop', 'node', id, '坐标为空或越界', n);

      const node = { id, type: n.type, x: n.x, y: n.y };
      if (n.type === 'factory') {
        node.production = isNum(n.production) ? n.production : 0;
        if (!isNum(n.production)) q('repair', 'node', id, '产量空值，置0', n);
        if (node.production < 0) { q('repair', 'node', id, '产量为负，置0', n); node.production = 0; }
        if (node.production > LIMITS.production)
          return q('drop', 'node', id, `产量异常值>${LIMITS.production}`, n);
      }
      if (n.type === 'warehouse') {
        node.cap = isNum(n.cap) && n.cap > 0 ? n.cap : LIMITS.inv;
        if (!isNum(n.cap) || n.cap <= 0) q('repair', 'node', id, '仓库容量非法，置默认上限', n);
        node.init = isNum(n.init) ? n.init : 0;
        if (!isNum(n.init)) q('repair', 'node', id, '初始库存空值，置0', n);
        if (node.init < 0) { q('repair', 'node', id, '初始库存为负，置0', n); node.init = 0; }
        if (node.init > node.cap) { q('repair', 'node', id, '初始库存超容量，钳制到容量', n); node.init = node.cap; }
        if (node.init > LIMITS.inv) return q('drop', 'node', id, `初始库存异常值>${LIMITS.inv}`, n);
      }
      if (n.type === 'store') {
        node.demand = isNum(n.demand) ? n.demand : 0;
        if (!isNum(n.demand)) q('repair', 'node', id, '需求空值，置0', n);
        if (node.demand < 0) { q('repair', 'node', id, '需求为负，置0', n); node.demand = 0; }
        if (node.demand > LIMITS.demand) return q('drop', 'node', id, `需求异常值>${LIMITS.demand}`, n);
      }
      seen.set(id, true);
      nodes.push(node);
    });

    const ids = new Set(nodes.map((n) => n.id));
    const edgeSeen = new Set();
    const edges = [];
    (raw.edges || []).forEach((e) => {
      const id = e.id == null ? null : String(e.id);
      if (!id) return q('drop', 'edge', e.id, '边ID为空', e);
      if (edgeSeen.has(id)) return q('drop', 'edge', id, '重复边ID，保留首条', e);
      if (!ids.has(e.from) || !ids.has(e.to))
        return q('drop', 'edge', id, `端点不存在:${e.from}->${e.to}`, e);
      let cap = e.cap;
      let prio = e.prio;
      if (!isNum(cap)) { q('repair', 'edge', id, '容量空值，置默认20', e); cap = DEFAULT_CAP; }
      if (isNum(cap) && cap <= 0) { q('repair', 'edge', id, '容量非正数，置默认20', e); cap = DEFAULT_CAP; }
      if (cap > LIMITS.capMax) return q('drop', 'edge', id, `容量异常值>${LIMITS.capMax}`, e);
      if (!isNum(prio)) { q('repair', 'edge', id, '优先级空值，置100', e); prio = DEFAULT_PRIO; }
      if (prio <= 0 || prio > 99) { q('repair', 'edge', id, '优先级越界，置100', e); prio = DEFAULT_PRIO; }
      edgeSeen.add(id);
      edges.push({ id, from: e.from, to: e.to, cap, prio });
    });

    const stats = {
      rawNodes: (raw.nodes || []).length,
      cleanNodes: nodes.length,
      rawEdges: (raw.edges || []).length,
      cleanEdges: edges.length,
      dropped: quarantine.filter((x) => x.action === 'drop').length,
      repaired: quarantine.filter((x) => x.action === 'repair').length
    };
    return {
      id: raw.id,
      name: raw.name,
      dataVersion: raw.dataVersion,
      tickCount: raw.tickCount,
      nodes,
      edges,
      events: raw.events || [],
      interventions: raw.interventions || [],
      quarantine,
      stats
    };
  }

  APP.ingest = { clean, LIMITS };
})(typeof window !== 'undefined' ? window : globalThis);
