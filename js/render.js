/* 视图渲染：元信息/KPI/表格/调试面板，全部由 renderAll 统一驱动 */
(function (global) {
  const APP = global.App || (global.App = {});

  function el(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
  function table(headers, rows, rowClass) {
    const head = '<tr>' + headers.map((h) =>
      '<th class="' + (h.align === 'left' ? 'txt' : '') + '">' + esc(h.label) + '</th>').join('') + '</tr>';
    const body = rows.map((r) => {
      const cls = rowClass ? rowClass(r) : '';
      return '<tr class="' + cls + '">' + headers.map((h) =>
        '<td class="' + (h.align === 'left' ? 'txt' : '') + '">' + esc(r[h.key]) + '</td>').join('') + '</tr>';
    }).join('');
    return { head, body };
  }

  const Renderer = {
    meta(state) {
      const ts = state.tickState();
      const filters = [
        '节点=' + ({ all: '全部', factory: '工厂', warehouse: '仓库', store: '商店' }[state.filters.nodeType]),
        '线路=' + state.filters.edge,
        '仅缺货=' + (state.filters.onlyShortage ? '是' : '否')
      ].join('　');
      el('metaBar').innerHTML =
        '<span>数据版本：<b>' + esc(state.cleanDataset.dataVersion) + '</b></span>' +
        '<span>样例：' + esc(state.cleanDataset.name) + '</span>' +
        '<span>当前筛选：' + filters + '</span>' +
        '<span>导出口径：full-ledger / node-tick+edge-tick 双长表</span>' +
        '<span>守恒：' + (ts.conservationOk
          ? '<span class="pill ok">通过</span>' : '<span class="pill err">失败</span>') + '</span>';
    },

    kpis(state) {
      const ts = state.tickState();
      const overcap = ts.edges.filter((e) => e.overcap).length;
      const avgUtil = ts.edges.reduce((a, e) => a + e.util, 0) / Math.max(1, ts.edges.length);
      const items = [
        ['tick', ts.tick + ' / ' + (state.tickCount - 1), false],
        ['全网库存', ts.totals.inv, false],
        ['当前缺货', ts.totals.shortage, ts.totals.shortage > 0],
        ['总在途流量', ts.totals.flow, false],
        ['平均负载', (avgUtil * 100).toFixed(0) + '%', avgUtil >= 0.8],
        ['满载线路', overcap, overcap > 0]
      ];
      el('kpiBar').innerHTML = items.map((i) =>
        '<div class="kpi ' + (i[2] ? 'alert' : '') + '"><b>' + esc(i[1]) +
        '</b><span>' + esc(i[0]) + '</span></div>').join('');
    },

    nodeTable(state) {
      const ts = state.tickState();
      const rows = state.visibleNodes(ts);
      const out = table([
        { key: 'id', label: '节点', align: 'left' }, { key: 'type', label: '类型', align: 'left' },
        { key: 'inv', label: '库存' }, { key: 'produce', label: '产出' },
        { key: 'inflow', label: '流入' }, { key: 'outflow', label: '流出' },
        { key: 'met', label: '满足' }, { key: 'demand', label: '需求' },
        { key: 'shortage', label: '缺货' }, { key: 'delta', label: '库存增量' },
        { key: 'balance', label: '平衡差' }
      ], rows, (r) => (r.shortage > 0 ? 'bad' : Math.abs(r.balance) > 1e-6 ? 'warn' : ''));
      el('nodeTable').querySelector('thead').innerHTML = out.head;
      el('nodeTable').querySelector('tbody').innerHTML = out.body;
    },

    edgeTable(state) {
      const ts = state.tickState();
      const rows = state.visibleEdges(ts);
      const out = table([
        { key: 'id', label: '线路', align: 'left' },
        { key: 'from', label: '起点', align: 'left' }, { key: 'to', label: '终点', align: 'left' },
        { key: 'flow', label: '流量' }, { key: 'cap', label: '容量' },
        { key: 'util', label: '负载率' }, { key: 'prio', label: '优先级' }
      ], rows.map((r) => Object.assign({}, r, { util: r.util.toFixed(2) })),
      (r) => (r.overcap ? 'bad' : r.util >= 0.8 ? 'warn' : ''));
      el('edgeTable').querySelector('thead').innerHTML = out.head;
      el('edgeTable').querySelector('tbody').innerHTML = out.body;
    },

    debug(state) {
      const rows = state.result.ledger.map((t) => ({
        tick: t.tick, inv: t.totals.inv, production: t.totals.production,
        met: t.totals.met, shortage: t.totals.shortage, flow: t.totals.flow,
        check: t.conservationOk ? 'OK' : 'FAIL',
        events: t.outages.concat(t.partials.map((p) => p.target + '受限')).join(',') || '-'
      }));
      const out = table([
        { key: 'tick', label: 'tick' }, { key: 'inv', label: '库存' },
        { key: 'production', label: '产量' }, { key: 'met', label: '已满足' },
        { key: 'shortage', label: '缺货' }, { key: 'flow', label: '流量' },
        { key: 'check', label: '守恒', align: 'left' }, { key: 'events', label: '事件', align: 'left' }
      ], rows, (r) => (r.check === 'FAIL' ? 'bad' : r.shortage > 0 ? 'warn' : ''));
      el('debugTable').querySelector('thead').innerHTML = out.head;
      el('debugTable').querySelector('tbody').innerHTML = out.body;

      const ts = state.tickState();
      const detail = {
        当前tick: ts.tick,
        守恒恒等式: '期末库存+累计满足 = 期初库存+累计产量',
        systemCheck: ts.systemCheck,
        断供节点: ts.outages,
        部分断供: ts.partials,
        节点中间态: ts.nodes.map((n) => ({
          id: n.id, 期初到当前delta: n.delta, 平衡差: n.balance,
          流入: n.inflow, 流出: n.outflow, 缺货: n.shortage
        })),
        满载边: ts.edges.filter((e) => e.overcap).map((e) => e.id),
        全局校验和: state.checksums
      };
      el('debugDetail').textContent = JSON.stringify(detail, null, 2);
    },

    quarantine(state) {
      const qs = state.cleanDataset.quarantine;
      const s = state.cleanDataset.stats;
      el('quarantineSummary').innerHTML =
        '<span class="pill">原始节点 ' + s.rawNodes + ' → 保留 ' + s.cleanNodes + '</span>' +
        '<span class="pill">原始边 ' + s.rawEdges + ' → 保留 ' + s.cleanEdges + '</span>' +
        '<span class="pill err">丢弃 ' + s.dropped + '</span>' +
        '<span class="pill" style="background:#fff3bf">修复 ' + s.repaired + '</span>';
      el('quarantineList').innerHTML = qs.length ? ('<table><tbody>' + qs.map((q) =>
        '<tr class="' + (q.action === 'drop' ? 'bad' : 'warn') +
        '"><td class="txt">' + esc(q.action) + '</td><td class="txt">' + esc(q.kind) +
        '</td><td class="txt">' + esc(q.id) + '</td><td class="txt">' + esc(q.reason) +
        '</td></tr>').join('') + '</tbody></table>') : '<p class="hint">该样例无需清洗。</p>';
    },

    exportSpec(state, pack) {
      const meta = pack ? pack.meta : {
        dataVersion: state.cleanDataset.dataVersion,
        tickRange: [0, state.tickCount - 1],
        nodeRows: state.checksums.nodeRowCount,
        edgeRows: state.checksums.edgeRowCount,
        filters: state.filters,
        scope: 'full-ledger',
        grain: 'node-tick / edge-tick 两张长表'
      };
      el('exportSpec').textContent = '导出口径：' + JSON.stringify(meta, null, 2);
      el('exportLog').innerHTML = state.exportLog.length
        ? state.exportLog.map((l) => '<div>' + new Date(l.at).toLocaleTimeString() +
          ' [' + l.scope + '] 节点行 ' + l.nodeRows + ' / 边行 ' + l.edgeRows +
          (l.consistent ? ' <span class="pill ok">往返一致</span>' : '<span class="pill err">不一致</span>') +
          '</div>').join('') : '<p class="hint">尚未执行导出。</p>';
    }
  };

  APP.Renderer = Renderer;
})(typeof window !== 'undefined' ? window : globalThis);
