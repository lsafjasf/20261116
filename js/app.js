/* 应用主控：所有数值由 EnergyCore 依据当前参数实时计算，UI 仅负责呈现。 */
(function () {
  'use strict';

  var Core = window.EnergyCore;
  var Samples = window.EnergySamples;
  var datasets = Samples.all();
  var STORAGE_KEY = 'factory-energy-flow-project-v1';

  var state = {
    datasetId: datasets[0].id,
    shiftId: 'all',
    inputScale: 1,
    overrides: {},
    selectedEdgeId: null,
    graph: null,
    debugSteps: []
  };

  var els = {};
  var renderer;
  var dragging = null;

  function currentDataset() {
    return datasets.filter(function (d) { return d.id === state.datasetId; })[0] || datasets[0];
  }

  function fmt(n) {
    return (Math.round((n + 1e-9) * 100) / 100).toLocaleString('zh-CN');
  }

  function pct(r) {
    return (r * 100).toFixed(1) + '%';
  }

  // 单一数据源：参数变化 -> 重新构建图 -> 同步全部视图。
  function recompute(stepLabel) {
    var ds = currentDataset();
    var graph = Core.buildGraph({
      records: ds.records,
      shiftId: state.shiftId,
      inputScale: state.inputScale,
      overrides: state.overrides
    });
    state.graph = graph;
    state.debugSteps.unshift({
      at: new Date().toLocaleTimeString('zh-CN'),
      label: stepLabel || 'recompute',
      shift: state.shiftId,
      scale: state.inputScale,
      overrides: Object.keys(state.overrides).length,
      conserved: graph.conserved,
      maxGap: graph.maxGap,
      gridInput: graph.totals.gridInput
    });
    if (state.debugSteps.length > 12) state.debugSteps.pop();
    syncAllViews();
    autosave();
  }

  function syncAllViews() {
    syncHeader();
    syncSummary();
    syncNodeTable();
    syncEdgeTable();
    syncDebug();
    syncDetailPopover();
    renderer.hoverEdge = null;
    renderer.draw(state.graph);
  }

  function syncHeader() {
    var g = state.graph;
    var ds = currentDataset();
    var shiftName = state.shiftId === 'all' ? '全天'
      : Core.SHIFTS.filter(function (s) { return s.id === state.shiftId; })[0].name;
    els.filterChip.innerHTML = '当前筛选：<b>' + ds.name.split('·')[0].trim() +
      ' / ' + shiftName + '</b>';
    els.versionChip.innerHTML = '数据版本：<b>v' + Core.VERSION + '</b>';
    els.exportChip.innerHTML = '导出口径：<b>' + Core.EXPORT_SCHEMA +
      ' · 单位 kWh · 保留 ' + Core.ROUND_DECIMALS + ' 位小数</b>';
    els.conservedChip.className = 'chip ' + (g.conserved ? 'ok' : 'bad');
    els.conservedChip.innerHTML = '守恒校验：<b>' +
      (g.conserved ? '通过' : '失败') + '</b> <span class="muted">gap=' +
      g.maxGap.toExponential(1) + '</span>';
  }

  function syncSummary() {
    var t = state.graph.totals;
    els.summary.innerHTML =
      row('电网输入', fmt(t.gridInput)) +
      row('电力终端输出', fmt(t.electricSink)) +
      row('电力常规损失', fmt(t.electricNormalLoss)) +
      row('电力异常损失', fmt(t.electricAbnormalLoss)) +
      row('数据质量不平衡量', fmt(t.imbalanceTotal)) +
      row('锅炉蒸汽（独立路径）', fmt(t.boilerInput)) +
      row('电力守恒缺口', t.electricConservedGap.toExponential(1));
  }

  function row(k, v) {
    return '<div class="k">' + k + '</div><div class="v">' + v + '</div>';
  }

  function levelPill(level) {
    var text = { ok: '正常', warn: '预警', danger: '告警' }[level] || level;
    return '<span class="pill ' + level + '">' + text + '</span>';
  }

  function syncNodeTable() {
    var rows = state.graph.nodes.map(function (n) {
      return '<tr><td>' + n.name + '</td>' +
        '<td>' + fmt(n.inflow) + '</td>' +
        '<td>' + fmt(n.outflow) + '</td>' +
        '<td>' + fmt(n.normalLoss) + '</td>' +
        '<td>' + fmt(n.abnormalLoss) + '</td>' +
        '<td>' + (n.lossRatio != null ? pct(n.lossRatio) : '—') + '</td></tr>';
    }).join('');
    els.nodeTable.innerHTML =
      '<tr><th>节点</th><th>流入</th><th>流出</th><th>常规损失</th>' +
      '<th>异常损失</th><th>损失率</th></tr>' + rows;
  }

  function syncEdgeTable() {
    var kindName = {
      flow: '能量流', 'loss-normal': '常规损失', 'loss-abnormal': '异常损失'
    };
    var rows = state.graph.edges.map(function (e) {
      return '<tr data-edge="' + e.id + '" style="cursor:pointer">' +
        '<td>' + e.name + '</td>' +
        '<td>' + kindName[e.kind] + '</td>' +
        '<td>' + fmt(e.value) + '</td>' +
        '<td>' + levelPill(e.level) + '</td></tr>';
    }).join('');
    els.edgeTable.innerHTML =
      '<tr><th>弧线</th><th>类型</th><th>数值(kWh)</th><th>阈值</th></tr>' + rows;
  }

  function syncDebug() {
    var g = state.graph;
    var c = g.cleanReport;
    var balanceLines = g.balanceChecks.map(function (b) {
      return '  ' + b.node.padEnd(12) +
        'in=' + fmt(b.inflow).padStart(9) +
        ' out=' + fmt(b.outflow).padStart(9) +
        ' nLoss=' + fmt(b.normalLoss).padStart(7) +
        ' aLoss=' + fmt(b.abnormalLoss).padStart(7) +
        ' gap=' + b.gap.toExponential(1);
    }).join('\n');
    var steps = state.debugSteps.map(function (s) {
      return '[' + s.at + '] ' + s.label + ' shift=' + s.shift +
        ' scale=' + s.scale + ' overrides=' + s.overrides +
        ' gridIn=' + fmt(s.gridInput) + ' conserved=' + s.conserved;
    }).join('\n');
    els.debugPanel.innerHTML =
      '== 计算流水线（实时中间状态）==\n' +
      '窗口记录数: ' + c.windowedCount +
      '  接受: ' + c.counts.accepted +
      '  空值: ' + c.counts.null +
      '  重复: ' + c.counts.duplicate +
      '  异常: ' + c.counts.outlier + '\n' +
      '空值ID: ' + (c.droppedNull.join(', ') || '无') + '\n' +
      '重复ID: ' + (c.droppedDuplicate.join(', ') || '无') + '\n' +
      '异常清单:\n' + c.outliers.map(function (o) {
        return '  ' + o.id + ' ' + o.metric + ' value=' + o.value +
          ' reason=' + o.reason;
      }).join('\n') + '\n\n' +
      '== 节点平衡（in = out + 常规损失 + 异常损失）==\n' +
      balanceLines + '\n\n' +
      '== 重算轨迹 ==\n' + steps;
  }

  function findEdge(id) {
    return state.graph.edges.filter(function (e) { return e.id === id; })[0] || null;
  }

  function edgeSourceInfo(edge) {
    var ds = currentDataset();
    var related = ds.records.filter(function (r) {
      if (edge.kind === 'flow') return r.metric === edge.metric;
      var node = edge.from;
      return r.metric === 'loss:' + node;
    });
    return related;
  }

  function syncDetailPopover() {
    if (!state.selectedEdgeId) {
      els.detailPop.innerHTML =
        '<span class="muted">尚未选择弧线，点击任意弧线查看来源与构成。</span>';
      return;
    }
    var edge = findEdge(state.selectedEdgeId);
    if (!edge) return;
    var records = edgeSourceInfo(edge);
    var extra = '';
    if (edge.kind === 'loss-abnormal' && edge.detail) {
      extra = '<div class="kv"><div class="k">测量异常值</div>' +
        '<div class="v">' + fmt(edge.detail.measuredOutlier) + '</div>' +
        '<div class="k">不平衡量</div>' +
        '<div class="v">' + fmt(edge.detail.imbalance) + '</div></div>';
    }
    var srcRows = records.slice(0, 6).map(function (r) {
      return '<tr><td>' + r.ts.slice(11, 16) + '</td>' +
        '<td>' + (r.value == null ? '空值' : r.value) + '</td></tr>';
    }).join('');
    els.detailPop.innerHTML = '<h4>' + edge.name + ' · 来源明细</h4>' +
      '<div class="kv">' +
      '<div class="k">弧线 ID</div><div class="v mono">' + edge.id + '</div>' +
      '<div class="k">当前数值</div><div class="v">' + fmt(edge.value) + ' kWh</div>' +
      '<div class="k">阈值级别</div><div class="v">' + levelPill(edge.level) + '</div>' +
      '<div class="k">可拖动</div><div class="v">' +
      (edge.kind === 'flow' ? '是（下游级联）' : '否（损失自动配平）') + '</div>' +
      '</div>' + extra +
      '<table style="margin-top:8px"><tr><th>时间</th><th>原始值</th></tr>' +
      (srcRows || '<tr><td colspan="2" class="muted">无原始记录</td></tr>') +
      '</table>';
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      els.toast.classList.remove('show');
    }, 2200);
  }

  function download(filename, content) {
    var blob = new Blob([JSON.stringify(content, null, 2)],
      { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function autosave() {
    try {
      var ds = currentDataset();
      var project = Core.makeProject(ds, {
        datasetId: state.datasetId,
        overrides: state.overrides
      }, state.graph);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    } catch (err) {
      console.warn('自动存档失败', err);
    }
  }

  function bindControls() {
    els.datasetSelect.addEventListener('change', function () {
      state.datasetId = this.value;
      state.overrides = {};
      state.selectedEdgeId = null;
      recompute('切换数据集');
    });

    els.shiftSelect.addEventListener('change', function () {
      state.shiftId = this.value;
      state.selectedEdgeId = null;
      recompute('切换班次窗口');
    });

    els.scaleRange.addEventListener('input', function () {
      state.inputScale = parseFloat(this.value);
      els.scaleValue.textContent = state.inputScale.toFixed(2);
      recompute('输入缩放（仿真）');
    });

    els.simBtn.addEventListener('click', function () {
      state.inputScale = 0.8;
      els.scaleRange.value = 0.8;
      els.scaleValue.textContent = '0.80';
      recompute('输入减少仿真 ×0.8');
      var sim = Core.runInputReduction(currentDataset(), state.shiftId, 0.8);
      toast('仿真完成：电网输入 ' + fmt(sim.baseline.totals.gridInput) +
        ' → ' + fmt(sim.reduced.totals.gridInput) +
        ' kWh，守恒=' + (sim.conserved ? '通过' : '失败'));
    });

    els.resetBtn.addEventListener('click', function () {
      state.overrides = {};
      state.inputScale = 1;
      els.scaleRange.value = 1;
      els.scaleValue.textContent = '1.00';
      state.selectedEdgeId = null;
      recompute('重置参数');
      toast('已重置拖动覆盖与输入缩放');
    });

    els.exportBtn.addEventListener('click', function () {
      var project = Core.makeProject(currentDataset(), {
        datasetId: state.datasetId,
        overrides: state.overrides
      }, state.graph);
      download('energy-project-' + state.datasetId + '.json', project);
      toast('已导出工程：' + project.snapshot.objectCounts.edges +
        ' 条弧线 / ' + project.snapshot.objectCounts.nodes + ' 个节点');
    });

    els.importInput.addEventListener('change', function () {
      var file = this.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (event) {
        try {
          var raw = (event && event.target && event.target.result) != null
            ? event.target.result : reader.result;
          var project = JSON.parse(raw);
          var report = Core.reloadProject(project);
          if (!report.checksumOk) throw new Error('工程校验和不匹配');
          state.datasetId = project.dataset.id;
          state.shiftId = project.parameters.shiftId;
          state.inputScale = project.parameters.inputScale;
          state.overrides = project.parameters.overrides || {};
          els.datasetSelect.value = state.datasetId;
          els.shiftSelect.value = state.shiftId;
          els.scaleRange.value = state.inputScale;
          els.scaleValue.textContent = state.inputScale.toFixed(2);
          recompute('重新载入工程');
          toast('工程载入成功，对象数量/关键数值一致=' +
            (report.keyValuesMatch && report.objectCountsMatch ? '是' : '否'));
        } catch (err) {
          toast('载入失败：' + err.message);
        }
      };
      reader.readAsText(file);
      this.value = '';
    });

    bindCanvas();
  }

  function bindCanvas() {
    var canvas = renderer.canvas;

    function point(evt) {
      var rect = canvas.getBoundingClientRect();
      return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
    }

    canvas.addEventListener('mousedown', function (evt) {
      var p = point(evt);
      var id = renderer.hitTest(p.x, p.y);
      if (!id) return;
      var edge = findEdge(id);
      if (!edge || edge.kind !== 'flow') {
        state.selectedEdgeId = id;
        syncDetailPopover();
        return;
      }
      dragging = { id: id, startY: p.y, baseValue: edge.value, moved: false };
      canvas.style.cursor = 'ns-resize';
    });

    canvas.addEventListener('mousemove', function (evt) {
      var p = point(evt);
      if (dragging) {
        var edge = findEdge(dragging.id);
        var wanted = renderer.dragEdgeValue(edge, dragging.startY, p.y);
        if (Math.abs(wanted - dragging.baseValue) > 0.5) dragging.moved = true;
        state.overrides[dragging.id] = Math.max(0, wanted);
        recompute('拖动弧线 ' + dragging.id);
      } else {
        var id = renderer.hitTest(p.x, p.y);
        renderer.hoverEdge = id;
        canvas.style.cursor = id ? 'pointer' : 'default';
        renderer.draw(state.graph);
      }
    });

    window.addEventListener('mouseup', function () {
      if (dragging) {
        if (!dragging.moved) {
          state.selectedEdgeId = dragging.id;
          syncDetailPopover();
        } else {
          toast('已调整弧线，下游按比例级联且守恒保持');
        }
        dragging = null;
        renderer.canvas.style.cursor = 'default';
      }
    });

    els.edgeTable.addEventListener('click', function (evt) {
      var tr = evt.target.closest('tr[data-edge]');
      if (!tr) return;
      state.selectedEdgeId = tr.dataset.edge;
      syncDetailPopover();
    });
  }

  function init() {
    [
      'filterChip', 'versionChip', 'exportChip', 'conservedChip',
      'summary', 'nodeTable', 'edgeTable', 'debugPanel', 'detailPop',
      'toast', 'datasetSelect', 'shiftSelect', 'scaleRange', 'scaleValue',
      'simBtn', 'resetBtn', 'exportBtn', 'importInput'
    ].forEach(function (id) { els[id] = document.getElementById(id); });

    datasets.forEach(function (d) {
      var opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      els.datasetSelect.appendChild(opt);
    });
    Core.SHIFTS.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name + '（' +
        String(s.start).padStart(2, '0') + ':00-' + s.end + ':00）';
      els.shiftSelect.appendChild(opt);
    });

    renderer = new window.FlowRenderer(document.getElementById('flowCanvas'));
    renderer.resize();
    window.addEventListener('resize', function () {
      renderer.resize();
      renderer.draw(state.graph);
    });

    bindControls();
    recompute('初始化');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
