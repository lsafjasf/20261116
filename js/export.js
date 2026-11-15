/* 运行表导出（节点/边 CSV）+ 工程存档 JSON + 往返一致性自检 */
(function (global) {
  const APP = global.App || (global.App = {});

  function csvEscape(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows, headers) {
    const head = headers.map((h) => csvEscape(h.label)).join(',');
    const body = rows.map((r) => headers.map((h) => csvEscape(r[h.key])).join(','));
    return [head].concat(body).join('\n');
  }

  const NODE_HEADERS = [
    { key: 'tick', label: 'tick' }, { key: 'id', label: 'node_id' },
    { key: 'type', label: 'type' }, { key: 'inv', label: 'inventory' },
    { key: 'produce', label: 'production' }, { key: 'inflow', label: 'inflow' },
    { key: 'outflow', label: 'outflow' }, { key: 'met', label: 'demand_met' },
    { key: 'shortage', label: 'shortage' }, { key: 'demand', label: 'demand' },
    { key: 'outage', label: 'outage' }
  ];
  const EDGE_HEADERS = [
    { key: 'tick', label: 'tick' }, { key: 'id', label: 'edge_id' },
    { key: 'from', label: 'from_node' }, { key: 'to', label: 'to_node' },
    { key: 'cap', label: 'capacity' }, { key: 'prio', label: 'priority' },
    { key: 'flow', label: 'flow' }, { key: 'util', label: 'utilization' },
    { key: 'overcap', label: 'at_capacity' }
  ];

  function flatten(result) {
    const nodeRows = [];
    const edgeRows = [];
    result.ledger.forEach((t) => {
      t.nodes.forEach((n) => nodeRows.push({ tick: t.tick, ...n }));
      t.edges.forEach((e) => edgeRows.push({ tick: t.tick, ...e }));
    });
    return { nodeRows, edgeRows };
  }

  function keyTotals(rows, key) {
    return rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);
  }
  function round3(v) {
    return Math.round((v + Number.EPSILON) * 1000) / 1000;
  }

  function checksums(result) {
    const { nodeRows, edgeRows } = flatten(result);
    return {
      nodeRowCount: nodeRows.length,
      edgeRowCount: edgeRows.length,
      tickCount: result.ledger.length,
      nodeIdCount: new Set(result.ledger[0].nodes.map((n) => n.id)).size,
      edgeIdCount: new Set(result.ledger[0].edges.map((e) => e.id)).size,
      totalFlow: round3(keyTotals(edgeRows, 'flow')),
      totalShortage: round3(keyTotals(nodeRows, 'shortage')),
      totalMet: round3(keyTotals(nodeRows, 'met')),
      finalInventory: round3(result.ledger[result.ledger.length - 1].totals.inv),
      overcapEdgeTicks: edgeRows.filter((r) => r.overcap).length,
      allConservationOk: result.ledger.every((t) => t.conservationOk)
    };
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], cur = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (ch !== '\r') cur += ch;
    }
    if (cur.length || row.length) { row.push(cur); rows.push(row); }
    const headers = rows.shift();
    return rows.filter((r) => r.length === headers.length && r.some((c) => c !== ''))
      .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
  }

  function buildExport(result, filters, scope) {
    const { nodeRows, edgeRows } = flatten(result);
    const nodeCsv = toCsv(nodeRows, NODE_HEADERS);
    const edgeCsv = toCsv(edgeRows, EDGE_HEADERS);
    const before = checksums(result);
    const reNodeRows = parseCsv(nodeCsv);
    const reEdgeRows = parseCsv(edgeCsv);
    const after = {
      nodeRowCount: reNodeRows.length,
      edgeRowCount: reEdgeRows.length,
      totalFlow: round3(keyTotals(reEdgeRows, 'flow')),
      totalShortage: round3(keyTotals(reNodeRows, 'shortage')),
      totalMet: round3(keyTotals(reNodeRows, 'demand_met')),
      finalInventory: round3(Number(reNodeRows.filter((r) => r.tick === String(result.ledger.length - 1))
        .reduce((a, r) => a + (Number(r.inventory) || 0), 0))),
      overcapEdgeTicks: reEdgeRows.filter((r) => r.at_capacity === 'true').length
    };
    const consistent = Object.keys(after).every((k) => before[k] === undefined || before[k] === after[k]);
    const meta = {
      dataVersion: result.dataVersion,
      datasetId: result.datasetId,
      exportedAt: new Date().toISOString(),
      tickRange: [0, result.ledger.length - 1],
      nodeRows: before.nodeRowCount,
      edgeRows: before.edgeRowCount,
      filters: filters || {},
      scope: scope || 'full-ledger',
      grain: 'node-tick / edge-tick 两张长表',
      checksumsBefore: before,
      checksumsAfter: after,
      roundTripConsistent: consistent
    };
    return { nodeCsv, edgeCsv, meta, before, after, consistent };
  }

  function buildProject(state) {
    return {
      format: 'logistics-sim-project',
      formatVersion: 1,
      savedAt: new Date().toISOString(),
      dataVersion: state.dataset.dataVersion,
      dataset: state.dataset,
      edgeEdits: state.edgeEdits || {},
      filters: state.filters || {},
      simulationOptions: state.simulationOptions || {},
      checksums: checksums(state.result)
    };
  }

  APP.exporting = {
    flatten, toCsv, parseCsv, checksums, buildExport, buildProject,
    NODE_HEADERS, EDGE_HEADERS
  };
})(typeof window !== 'undefined' ? window : globalThis);
