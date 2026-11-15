/* 守恒模拟引擎：优先级配货 + 容量约束 + 断供/干预事件，可在 Node 与浏览器运行 */
(function (global) {
  const APP = global.App || (global.App = {});

  function cloneOverrides(list) {
    const map = {};
    (list || []).forEach((iv) => {
      Object.keys(iv.edgeOverrides || {}).forEach((eid) => {
        map[eid] = Object.assign({}, iv.edgeOverrides[eid]);
      });
    });
    return map;
  }

  function run(dataset, options) {
    options = options || {};
    const nodeMap = {};
    dataset.nodes.forEach((n) => {
      nodeMap[n.id] = Object.assign({}, n, {
        inv: n.type === 'warehouse' ? n.init : 0,
        produce: 0,
        inflow: 0,
        outflow: 0,
        demandQty: n.type === 'store' ? n.demand : 0,
        met: 0,
        shortage: 0,
        outage: false
      });
    });

    const edges = dataset.edges.map((e) => Object.assign({}, e));
    const edgeById = {};
    edges.forEach((e) => { edgeById[e.id] = e; });
    const outEdges = {};
    edges.forEach((e) => { (outEdges[e.from] = outEdges[e.from] || []).push(e); });
    const interventionMap = cloneOverrides(
      dataset.interventions.filter((iv) => options.applyInterventions !== false)
    );
    const outages = (dataset.events || [])
      .filter((ev) => ev.type === 'outage')
      .map((ev) => ({ target: ev.target, start: ev.atTick, end: ev.atTick + (ev.duration || 0) - 1 }));
    const partials = (dataset.events || [])
      .filter((ev) => ev.type === 'partial')
      .map((ev) => ({ target: ev.target, start: ev.atTick, end: ev.atTick + (ev.duration || 0) - 1, edgeCap: ev.edgeCap || 0 }));

    const ledger = [];

    for (let tick = 0; tick < dataset.tickCount; tick++) {
      Object.keys(interventionMap).forEach((eid) => {
        const ov = interventionMap[eid];
        const iv = (dataset.interventions || []).find((x) =>
          Object.prototype.hasOwnProperty.call(x.edgeOverrides || {}, eid));
        if (iv && tick >= iv.atTick && edgeById[eid]) {
          if (isFinite(ov.cap)) edgeById[eid].cap = ov.cap;
          if (isFinite(ov.prio)) edgeById[eid].prio = ov.prio;
        }
      });

      outages.forEach((o) => {
        nodeMap[o.target].outage = tick >= o.start && tick <= o.end;
      });
      const partialNow = partials
        .filter((p) => tick >= p.start && tick <= p.end)
        .map((p) => ({ target: p.target, edgeCap: p.edgeCap }));
      const partialSet = new Set(partialNow.map((p) => p.target));
      Object.keys(nodeMap).forEach((id) => { nodeMap[id].partial = partialSet.has(id); });
      const overriddenNow = new Set();
      (dataset.interventions || []).forEach((iv) => {
        if (options.applyInterventions !== false && tick >= iv.atTick) {
          Object.keys(iv.edgeOverrides || {}).forEach((eid) => overriddenNow.add(eid));
        }
      });

      Object.keys(nodeMap).forEach((id) => {
        const node = nodeMap[id];
        node.inflow = 0;
        node.outflow = 0;
        node.met = 0;
        node.shortage = 0;
        node.produce = node.type === 'factory' && !node.outage ? node.production : 0;
        node.inv += node.produce;
      });

      const edgeFlow = {};
      edges.forEach((e) => { edgeFlow[e.id] = 0; });
      Object.keys(outEdges).sort().forEach((fromId) => {
        const src = nodeMap[fromId];
        outEdges[fromId].slice().sort((a, b) => a.prio - b.prio || a.id.localeCompare(b.id))
          .forEach((e) => {
            const dst = nodeMap[e.to];
            if (src.outage || dst.outage) return;
            let effectiveCap = e.cap;
            if (!overriddenNow.has(e.id)) {
              partialNow.forEach((p) => {
                if (e.from === p.target || e.to === p.target) effectiveCap = Math.min(effectiveCap, p.edgeCap);
              });
            }
            let want;
            if (dst.type === 'store') {
              want = dst.demandQty + Math.max(0, -dst.inv) - dst.inflow;
            } else {
              want = dst.cap - dst.inv;
            }
            want = Math.max(0, want);
            const room = Math.max(0, dst.type === 'warehouse' ? dst.cap - dst.inv : Infinity);
            const qty = Math.min(src.inv, effectiveCap, want, room);
            if (qty <= 0) return;
            src.inv -= qty;
            src.outflow += qty;
            dst.inv += qty;
            dst.inflow += qty;
            edgeFlow[e.id] += qty;
          });
      });

      Object.keys(nodeMap).forEach((id) => {
        const node = nodeMap[id];
        if (node.type === 'store') {
          node.met = Math.min(node.inv, node.demandQty);
          node.shortage = Math.max(0, node.demandQty - node.met);
          node.inv -= node.met;
        }
      });

      const prevStates = ledger.length ? ledger[ledger.length - 1].nodes : null;
      const nodeStates = Object.keys(nodeMap).sort().map((id) => {
        const n = nodeMap[id];
        const prevInv = prevStates ? prevStates.find((x) => x.id === id).inv : (n.init || 0);
        const delta = round(n.inv - prevInv);
        const balance = round(n.produce + n.inflow - n.outflow - n.met - delta);
        return {
          id, type: n.type, inv: round(n.inv), produce: round(n.produce),
          inflow: round(n.inflow), outflow: round(n.outflow), met: round(n.met),
          shortage: round(n.shortage), demand: n.demandQty, outage: n.outage,
          partial: n.partial || false, delta, balance
        };
      });

      const edgeStates = edges.map((e) => ({
        id: e.id, from: e.from, to: e.to, cap: e.cap, prio: e.prio,
        flow: round(edgeFlow[e.id]),
        requested: round(edgeFlow[e.id]),
        util: e.cap > 0 ? round(edgeFlow[e.id] / e.cap) : 0,
        overcap: edgeFlow[e.id] >= e.cap && e.cap > 0
      }));

      const totalInv = sum(nodeStates, 'inv');
      const totalShortage = sum(nodeStates, 'shortage');
      const totalFlow = sum(edgeStates, 'flow');
      const cumulativeMet = ledger.reduce((acc, t) => acc + t.totals.met, 0) + sum(nodeStates, 'met');
      const cumulativeProduction = ledger.reduce((acc, t) => acc + t.totals.production, 0) + sum(nodeStates, 'produce');
      const initialInv = dataset.nodes
        .filter((n) => n.type === 'warehouse').reduce((a, n) => a + (n.init || 0), 0);
      const conservationOk = Math.abs(
        totalInv + cumulativeMet - (initialInv + cumulativeProduction)) < 1e-6;
      const nodeBalanceOk = nodeStates.every((n) => Math.abs(n.balance) < 1e-6);
      ledger.push({
        tick,
        nodes: nodeStates,
        edges: edgeStates,
        totals: {
          inv: totalInv, shortage: totalShortage, flow: totalFlow,
          production: sum(nodeStates, 'produce'), met: sum(nodeStates, 'met')
        },
        conservationOk: conservationOk && nodeBalanceOk,
        systemCheck: round(totalInv + cumulativeMet),
        outages: outages.filter((o) => tick >= o.start && tick <= o.end).map((o) => o.target),
        partials: partialNow.map((p) => ({ target: p.target, edgeCap: p.edgeCap }))
      });
    }

    return {
      datasetId: dataset.id,
      dataVersion: dataset.dataVersion,
      interventionsApplied: options.applyInterventions !== false,
      tickCount: ledger.length,
      ledger,
      nodeMap,
      edges
    };

  }

  function sum(list, key) {
    return round(list.reduce((a, x) => a + (x[key] || 0), 0));
  }
  function round(v) {
    return Math.round((v + Number.EPSILON) * 1000) / 1000;
  }

  APP.engine = { run };
})(typeof window !== 'undefined' ? window : globalThis);
