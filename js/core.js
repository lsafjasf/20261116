/*
 * 工厂能量流逻辑内核（零依赖，UMD）。
 * 浏览器与 Node 共用：所有数值均由当前参数实时计算，UI 不缓存计算结果。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EnergyCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.4.0';
  var EXPORT_SCHEMA = 'factory-energy-flow/v1';
  var EPS = 1e-9;
  var ROUND_DECIMALS = 3;

  // 损失率颜色阈值：<5% 绿，<12% 橙，>=12% 红；异常损失恒为红。
  var LOSS_THRESHOLDS = { warn: 0.05, danger: 0.12 };
  // 流量线容量利用率阈值。
  var FLOW_THRESHOLDS = { warn: 0.85, danger: 1.0 };

  var SHIFTS = [
    { id: 'morning', name: '早班', start: 6, end: 14 },
    { id: 'swing', name: '中班', start: 14, end: 22 },
    { id: 'night', name: '夜班', start: 22, end: 6 }
  ];

  // 固定设备节点。env 为环境损失汇点，sink 为工艺终端汇点。
  var NODES = [
    { id: 'grid', name: '外部电网', type: 'source' },
    { id: 'transformer', name: '变压器', type: 'transformer' },
    { id: 'mcc', name: '配电室 MCC', type: 'switchgear' },
    { id: 'boiler', name: '燃气锅炉', type: 'source' },
    { id: 'chiller', name: '冷水机组', type: 'equipment' },
    { id: 'pump', name: '循环水泵', type: 'equipment' },
    { id: 'hvac', name: '空调系统', type: 'equipment' },
    { id: 'sink', name: '工艺终端', type: 'sink' },
    { id: 'env', name: '环境损失', type: 'environment' }
  ];

  // 有用能量流弧线（9 条），cap 为物理容量，用于异常判定与拖动钳位。
  var EDGES = [
    { id: 'grid_transformer', from: 'grid', to: 'transformer', name: '电网进线', metric: 'supply:grid', cap: 1200 },
    { id: 'transformer_mcc', from: 'transformer', to: 'mcc', name: '变压器出线', metric: 'flow:transformer_mcc', cap: 1150 },
    { id: 'mcc_chiller', from: 'mcc', to: 'chiller', name: '制冷供电', metric: 'flow:mcc_chiller', cap: 520 },
    { id: 'mcc_pump', from: 'mcc', to: 'pump', name: '水泵供电', metric: 'flow:mcc_pump', cap: 260 },
    { id: 'mcc_hvac', from: 'mcc', to: 'hvac', name: '空调供电', metric: 'flow:mcc_hvac', cap: 320 },
    { id: 'chiller_sink', from: 'chiller', to: 'sink', name: '冷水输送', metric: 'flow:chiller_sink', cap: 560 },
    { id: 'pump_sink', from: 'pump', to: 'sink', name: '循环水输送', metric: 'flow:pump_sink', cap: 240 },
    { id: 'hvac_sink', from: 'hvac', to: 'sink', name: '空调送风', metric: 'flow:hvac_sink', cap: 300 },
    { id: 'boiler_sink', from: 'boiler', to: 'sink', name: '锅炉蒸汽', metric: 'supply:boiler', cap: 700 }
  ];

  // 参与平衡核算的过程节点（含锅炉，锅炉有燃烧损失）。
  var PROCESS_NODES = ['transformer', 'mcc', 'boiler', 'chiller', 'pump', 'hvac'];
  // 生成损失弧线的节点：过程节点有常规+异常两条，电网仅异常一条（源端越界核算）。
  var LOSS_NODES = ['grid'].concat(PROCESS_NODES);
  // 严格能量恒等式节点（电力链）；电网与锅炉为源节点，单独核算。
  var STRICT_NODES = ['transformer', 'mcc', 'chiller', 'pump', 'hvac'];
  var SOURCE_EDGES = ['grid_transformer', 'boiler_sink'];

  // 常规损失记录的合理上限，超出视为异常值。
  var LOSS_CAPS = {
    transformer: 80, mcc: 40, boiler: 120,
    chiller: 90, pump: 60, hvac: 70
  };

  function shiftOf(ts) {
    var hour = new Date(ts).getHours();
    for (var i = 0; i < SHIFTS.length; i++) {
      var s = SHIFTS[i];
      if (s.start < s.end) {
        if (hour >= s.start && hour < s.end) return s.id;
      } else if (hour >= s.start || hour < s.end) {
        return s.id;
      }
    }
    return 'night';
  }

  function metricCap(metric) {
    if (metric.indexOf('loss:') === 0) {
      var node = metric.slice(5);
      return LOSS_CAPS[node] != null ? LOSS_CAPS[node] : Infinity;
    }
    for (var i = 0; i < EDGES.length; i++) {
      if (EDGES[i].metric === metric) return EDGES[i].cap;
    }
    return Infinity;
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  // JSON 安全化：NaN/Infinity/undefined 统一为 null，保证工程可序列化与重载。
  function sanitize(value) {
    if (value === undefined) return null;
    if (Array.isArray(value)) return value.map(sanitize);
    if (value !== null && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (k) {
        var v = value[k];
        if (typeof v === 'number' && !isFinite(v)) {
          out[k] = null;
        } else {
          out[k] = sanitize(v);
        }
      });
      return out;
    }
    if (typeof value === 'number' && !isFinite(value)) return null;
    return value;
  }

  // 数据清洗：空值丢弃、同自然键去重（保留首条）、越界/负值判异常。
  // 异常记录不进入流量，其数值按“异常损失”单独核算，保证总量守恒。
  function cleanRecords(records) {
    var seen = Object.create(null);
    var accepted = [];
    var outliers = [];
    var nullIds = [];
    var duplicateIds = [];

    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (!isFiniteNumber(r.value)) {
        nullIds.push(r.id);
        continue;
      }
      var key = r.device + '|' + r.metric + '|' + r.ts;
      if (seen[key]) {
        // 同自然键重复：值一致才丢弃；值冲突视为异常记录并计入异常损失。
        if (seen[key] === r.value) {
          duplicateIds.push(r.id);
          continue;
        }
        outliers.push({
          id: r.id, device: r.device, metric: r.metric, ts: r.ts,
          value: r.value, cap: cap, reason: 'duplicate-conflict'
        });
        continue;
      }
      seen[key] = r.value;
      var cap = metricCap(r.metric);
      if (r.value < 0 || (cap !== Infinity && r.value > cap)) {
        outliers.push({
          id: r.id, device: r.device, metric: r.metric, ts: r.ts,
          value: r.value, cap: cap,
          reason: r.value < 0 ? 'negative' : 'over-cap'
        });
        continue;
      }
      accepted.push(r);
    }

    return {
      accepted: accepted,
      outliers: outliers,
      droppedNull: nullIds,
      droppedDuplicate: duplicateIds,
      counts: {
        input: records.length,
        accepted: accepted.length,
        null: nullIds.length,
        duplicate: duplicateIds.length,
        outlier: outliers.length
      }
    };
  }

  function thresholdLevel(ratio, thresholds) {
    if (ratio < thresholds.warn) return 'ok';
    if (ratio < thresholds.danger) return 'warn';
    return 'danger';
  }

  function lossColor(ratio) {
    var level = thresholdLevel(ratio, LOSS_THRESHOLDS);
    return level === 'ok' ? '#2e9e5b' : level === 'warn' ? '#e0a32e' : '#d64545';
  }

  function flowColor(utilization) {
    var level = thresholdLevel(utilization, FLOW_THRESHOLDS);
    return level === 'ok' ? '#3a7bd5' : level === 'warn' ? '#e0a32e' : '#d64545';
  }

  function round3(v) {
    return Math.round((v + EPS) * 1000) / 1000;
  }

  function filterByShift(records, shiftId) {
    if (shiftId === 'all') return records.slice();
    return records.filter(function (r) { return shiftOf(r.ts) === shiftId; });
  }

  function aggregate(records) {
    var sum = Object.create(null);
    records.forEach(function (r) {
      sum[r.metric] = (sum[r.metric] || 0) + r.value;
    });
    return sum;
  }

  // 由当前参数（班次 + 样例 + 输入缩放 + 拖动覆盖）实时构建整张图。
  function buildGraph(options) {
    options = options || {};
    var shiftId = options.shiftId || 'all';
    var records = options.records || [];
    var inputScale = options.inputScale == null ? 1 : options.inputScale;
    var overrides = options.overrides || {};

    var windowed = filterByShift(records, shiftId);
    var clean = cleanRecords(windowed);
    var sums = aggregate(clean.accepted);

    // 异常值按节点归集（数值绝对值计入异常损失），保证总量守恒。
    // loss:* 归设备本身；flow/supply 归弧线源节点，使异常能量从来源侧配平。
    var abnormalMeasured = {};
    clean.outliers.forEach(function (o) {
      var node;
      if (o.metric.indexOf('loss:') === 0) {
        node = o.metric.slice(5);
      } else {
        var meta = EDGES.filter(function (e) { return e.metric === o.metric; })[0];
        node = meta ? meta.from : (o.device || 'grid');
      }
      abnormalMeasured[node] = (abnormalMeasured[node] || 0) + Math.abs(o.value);
    });

    // 1) 有用弧线原始测量值；输入缩放先记录在源弧线上，稍后级联到下游。
    var rawEdges = EDGES.map(function (meta) {
      var measured = sums[meta.metric] || 0;
      var isGridSource = meta.id === 'grid_transformer';
      var scaled = isGridSource ? measured * inputScale : measured;
      return {
        id: meta.id, from: meta.from, to: meta.to, name: meta.name,
        kind: 'flow', metric: meta.metric, cap: meta.cap,
        measured: measured, scaledInput: scaled,
        overridden: overrides[meta.id] != null || (isGridSource && inputScale !== 1),
        value: scaled,
        utilization: 0
      };
    });

    // 输入减少仿真：电网进线缩放沿电力树级联，锅炉蒸汽支路独立、不受影响。
    if (inputScale !== 1) {
      var gridDownstream = collectDownstream('grid_transformer');
      rawEdges.forEach(function (e) {
        if (gridDownstream.indexOf(e.id) >= 0 && e.id !== 'grid_transformer') {
          e.value = e.value * inputScale;
          e.overridden = true;
        }
      });
    }

    // 拖动覆盖沿拓扑级联：调整某条弧线后，其下游所有弧线按比例缩放，
    // 使每个节点的质量平衡始终成立（值钳位到 [0, cap]）。
    var metaById = {};
    EDGES.forEach(function (m) { metaById[m.id] = m; });
    Object.keys(overrides).forEach(function (edgeId) {
      if (!metaById[edgeId]) return;
      var target = rawEdges.filter(function (e) { return e.id === edgeId; })[0];
      var wanted = clamp(overrides[edgeId], 0, target.cap);
      var base = target.value;
      if (base <= EPS) return;
      var ratio = wanted / base;
      var downstream = collectDownstream(edgeId);
      rawEdges.forEach(function (e) {
        if (downstream.indexOf(e.id) >= 0) {
          // 仅被拖动目标受 cap 钳位；下游保持同比例，损失由残差重新配平。
          e.value = e.id === edgeId ? wanted : e.value * ratio;
          e.overridden = true;
        }
      });
    });
    rawEdges.forEach(function (e) { e.utilization = e.value / e.cap; });

    var edgeById = {};
    rawEdges.forEach(function (e) { edgeById[e.id] = e; });

    // 2) 节点平衡：计算残差（未测量的正常损失）与不平衡量。
    var nodeStates = NODES.filter(function (n) { return n.id !== 'env'; }).map(function (n) {
      var inflow = 0, outflow = 0;
      rawEdges.forEach(function (e) {
        if (e.to === n.id) inflow += e.value;
        if (e.from === n.id) outflow += e.value;
      });

      var state = {
        id: n.id, name: n.name, type: n.type,
        inflow: inflow, outflow: outflow,
        measuredLoss: 0, abnormalMeasured: abnormalMeasured[n.id] || 0,
        normalLoss: 0, abnormalLoss: 0, imbalance: 0, totalLoss: 0
      };

      if (n.id === 'grid') {
        // 电网为源节点：越界/冲突进线单独列为异常，不参与严格电平衡。
        state.residual = 0;
        state.unmeasured = 0;
        state.normalLoss = 0;
        state.imbalance = 0;
        state.abnormalLoss = state.abnormalMeasured;
        state.totalLoss = state.abnormalLoss;
        state.lossRatio = 0;
      } else if (n.id === 'boiler') {
        // 锅炉为蒸汽源节点：燃料输入未入表，按测量值展示燃烧损失，不做残差配平。
        state.measuredLoss = sums['loss:boiler'] || 0;
        state.residual = 0;
        state.unmeasured = 0;
        state.normalLoss = state.measuredLoss;
        state.imbalance = 0;
        state.abnormalLoss = state.abnormalMeasured;
        state.totalLoss = state.normalLoss + state.abnormalLoss;
        state.lossRatio = outflow > EPS ? state.totalLoss / outflow : 0;
      } else if (PROCESS_NODES.indexOf(n.id) >= 0) {
        state.measuredLoss = sums['loss:' + n.id] || 0;
        state.residual = inflow - outflow;
        // 残差切分：异常损失最多占用物理残差，超额为数据质量问题（不平衡量）。
        // 恒等式恒成立：outflow + normalLoss + abnormalLoss = inflow。
        if (state.abnormalMeasured <= state.residual + EPS) {
          state.abnormalLoss = state.abnormalMeasured;
          state.normalLoss = state.residual - state.abnormalLoss;
          state.imbalance = 0;
        } else {
          state.abnormalLoss = Math.max(0, state.residual);
          state.normalLoss = 0;
          state.imbalance = state.abnormalMeasured - Math.max(0, state.residual);
        }
        state.unmeasured = Math.max(0, state.normalLoss - state.measuredLoss);
        state.totalLoss = state.normalLoss + state.abnormalLoss;
        state.lossRatio = inflow > EPS ? state.totalLoss / inflow : 0;
      } else {
        state.residual = inflow - outflow;
        state.unmeasured = 0;
        state.lossRatio = 0;
      }
      return state;
    });

    var nodeById = {};
    nodeStates.forEach(function (s) { nodeById[s.id] = s; });

    // 3) 损失弧线：每个过程节点一条常规损失、一条异常损失，固定数量便于导出比对。
    var lossEdges = [];
    LOSS_NODES.forEach(function (id) {
      var st = nodeById[id];
      if (id !== 'grid') {
        lossEdges.push({
          id: id + '_loss_normal', from: id, to: 'env', kind: 'loss-normal',
          name: st.name + '·常规损失', value: st.normalLoss,
          lossRatio: st.lossRatio
        });
      }
      lossEdges.push({
        id: id + '_loss_abnormal', from: id, to: 'env', kind: 'loss-abnormal',
        name: st.name + '·异常损失', value: st.abnormalLoss,
        detail: {
          measuredOutlier: st.abnormalMeasured,
          imbalance: st.imbalance || 0
        }
      });
    });

    var edges = rawEdges.concat(lossEdges);

    // 4) 颜色阈值（实时计算，不存死值）。
    edges.forEach(function (e) {
      if (e.kind === 'flow') {
        e.color = flowColor(e.utilization);
        e.level = thresholdLevel(e.utilization, FLOW_THRESHOLDS);
      } else if (e.kind === 'loss-normal') {
        e.color = lossColor(e.lossRatio);
        e.level = thresholdLevel(e.lossRatio, LOSS_THRESHOLDS);
      } else {
        e.color = '#b3261e';
        e.level = e.value > EPS ? 'danger' : 'ok';
      }
    });

    // 5) 守恒校验：过程节点 inflow = outflow + 常规损失 + 异常损失。
    var balanceChecks = STRICT_NODES.map(function (id) {
      var st = nodeById[id];
      var rhs = st.outflow + st.normalLoss + st.abnormalLoss;
      return {
        node: id, inflow: st.inflow,
        outflow: st.outflow, normalLoss: st.normalLoss,
        abnormalLoss: st.abnormalLoss,
        gap: Math.abs(st.inflow - rhs)
      };
    });
    var maxGap = balanceChecks.reduce(function (m, c) {
      return Math.max(m, c.gap);
    }, 0);

    var electricOutput = edgeById['chiller_sink'].value + edgeById['pump_sink'].value
      + edgeById['hvac_sink'].value;
    var totals = {
      // 电力路径与锅炉蒸汽路径独立核算，分别守恒。
      gridInput: edgeById['grid_transformer'].value,
      boilerInput: edgeById['boiler_sink'].value,
      sourceInput: edgeById['grid_transformer'].value + edgeById['boiler_sink'].value,
      electricSink: electricOutput,
      sinkOutput: electricOutput + edgeById['boiler_sink'].value,
      normalLoss: lossEdges.filter(function (e) { return e.kind === 'loss-normal'; })
        .reduce(function (a, e) { return a + e.value; }, 0),
      abnormalLoss: lossEdges.filter(function (e) { return e.kind === 'loss-abnormal'; })
        .reduce(function (a, e) { return a + e.value; }, 0)
    };
    // 电力链严格节点（变压器/MCC/三设备）的真实损失弧线求和。
    // 源节点异常与数据质量“不平衡量”不参与能量恒等式，故不在此处统计。
    var chainNormal = 0, chainAbnormal = 0;
    STRICT_NODES.forEach(function (id) {
      chainNormal += nodeById[id].normalLoss;
      chainAbnormal += nodeById[id].abnormalLoss;
    });
    totals.electricNormalLoss = chainNormal;
    totals.electricAbnormalLoss = chainAbnormal;
    totals.imbalanceTotal = STRICT_NODES.reduce(function (a, id) {
      return a + (nodeById[id].imbalance || 0);
    }, 0) + nodeById['grid'].abnormalLoss + nodeById['boiler'].abnormalLoss;
    totals.electricConservedGap = Math.abs(
      totals.gridInput - (totals.electricSink + chainNormal + chainAbnormal)
    );

    return {
      version: VERSION, shiftId: shiftId, inputScale: inputScale,
      nodes: nodeStates, edges: edges,
      totals: totals,
      cleanReport: {
        windowedCount: windowed.length,
        counts: clean.counts,
        droppedNull: clean.droppedNull,
        droppedDuplicate: clean.droppedDuplicate,
        outliers: clean.outliers
      },
      balanceChecks: balanceChecks,
      conserved: maxGap < 1e-6,
      maxGap: maxGap,
      generatedAt: new Date().toISOString()
    };
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  // 收集一条弧线及其全部下游弧线（按拓扑可达性），用于拖动级联。
  function collectDownstream(edgeId) {
    var start = EDGES.filter(function (e) { return e.id === edgeId; })[0];
    if (!start) return [edgeId];
    var visited = {};
    var result = [];
    var frontier = [edgeId];
    visited[edgeId] = 1;
    while (frontier.length) {
      var currentId = frontier.shift();
      result.push(currentId);
      var current = EDGES.filter(function (e) { return e.id === currentId; })[0];
      EDGES.forEach(function (e) {
        if (e.from === current.to && !visited[e.id]) {
          visited[e.id] = 1;
          frontier.push(e.id);
        }
      });
    }
    return result;
  }

  // FNV-1a 32 位校验和，覆盖规范化后的 JSON，保证工程可重新载入且数值一致。
  function fnv1a(str) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return '[' + value.map(stableStringify).join(',') + ']';
    }
    var keys = Object.keys(value).sort();
    return '{' + keys.map(function (k) {
      return JSON.stringify(k) + ':' + stableStringify(value[k]);
    }).join(',') + '}';
  }

  function snapshotFromGraph(graph, parameters) {
    return {
      schema: EXPORT_SCHEMA,
      version: graph.version,
      exportedAt: graph.generatedAt,
      parameters: {
        datasetId: parameters.datasetId,
        shiftId: graph.shiftId,
        inputScale: graph.inputScale,
        overrides: parameters.overrides || {}
      },
      objectCounts: { nodes: graph.nodes.length, edges: graph.edges.length },
      nodes: graph.nodes.map(function (n) {
        return {
          id: n.id, inflow: round3(n.inflow), outflow: round3(n.outflow),
          normalLoss: round3(n.normalLoss), abnormalLoss: round3(n.abnormalLoss),
          totalLoss: round3(n.totalLoss), lossRatio: round3(n.lossRatio)
        };
      }),
      edges: graph.edges.map(function (e) {
        var item = {
          id: e.id, kind: e.kind, level: e.level, value: round3(e.value)
        };
        if (e.cap != null) item.cap = e.cap;
        if (e.lossRatio != null) item.lossRatio = round3(e.lossRatio);
        return item;
      }),
      totals: {
        sourceInput: round3(graph.totals.sourceInput),
        sinkOutput: round3(graph.totals.sinkOutput),
        normalLoss: round3(graph.totals.normalLoss),
        abnormalLoss: round3(graph.totals.abnormalLoss)
      },
      cleanCounts: graph.cleanReport.counts
    };
  }

  function withChecksum(payload) {
    var copy = {};
    Object.keys(payload).forEach(function (k) { copy[k] = payload[k]; });
    copy.checksum = fnv1a(stableStringify(payload));
    return copy;
  }

  function verifyChecksum(payload) {
    if (!payload || !payload.checksum) return false;
    var copy = {};
    Object.keys(payload).forEach(function (k) {
      if (k !== 'checksum') copy[k] = payload[k];
    });
    return fnv1a(stableStringify(copy)) === payload.checksum;
  }

  // 可重新载入的工程：原始记录 + 参数 + 快照 + 校验和。
  function makeProject(dataset, parameters, graph) {
    var snapshot = withChecksum(snapshotFromGraph(graph, parameters));
    var project = {
      kind: 'factory-energy-flow-project',
      schema: 'project/v1',
      appVersion: VERSION,
      savedAt: new Date().toISOString(),
      dataset: {
        id: dataset.id, name: dataset.name,
        records: sanitize(dataset.records)
      },
      parameters: {
        shiftId: graph.shiftId,
        inputScale: graph.inputScale,
        overrides: parameters.overrides || {}
      },
      snapshot: snapshot
    };
    return withChecksum(sanitize(project));
  }

  // 重新载入：校验工程完整性，并用记录+参数重算，与快照逐项比对。
  function reloadProject(project) {
    var report = { checksumOk: verifyChecksum(project), snapshotChecksumOk: false,
      objectCountsMatch: false, keyValuesMatch: false, mismatches: [], graph: null };
    if (!report.checksumOk) return report;
    report.snapshotChecksumOk = verifyChecksum(project.snapshot);

    var graph = buildGraph({
      records: project.dataset.records,
      shiftId: project.parameters.shiftId,
      inputScale: project.parameters.inputScale,
      overrides: project.parameters.overrides
    });
    report.graph = graph;
    var rebuilt = snapshotFromGraph(graph, {
      datasetId: project.dataset.id, overrides: project.parameters.overrides
    });

    report.objectCountsMatch =
      rebuilt.objectCounts.nodes === project.snapshot.objectCounts.nodes &&
      rebuilt.objectCounts.edges === project.snapshot.objectCounts.edges;

    var compare = function (label, a, b) {
      if (Math.abs((a || 0) - (b || 0)) > 1e-6) {
        report.mismatches.push(label + ': rebuilt=' + a + ' snapshot=' + b);
      }
    };
    compare('totals.sourceInput', rebuilt.totals.sourceInput, project.snapshot.totals.sourceInput);
    compare('totals.sinkOutput', rebuilt.totals.sinkOutput, project.snapshot.totals.sinkOutput);
    compare('totals.normalLoss', rebuilt.totals.normalLoss, project.snapshot.totals.normalLoss);
    compare('totals.abnormalLoss', rebuilt.totals.abnormalLoss, project.snapshot.totals.abnormalLoss);
    rebuilt.edges.forEach(function (e, i) {
      var old = project.snapshot.edges[i];
      if (!old || e.id !== old.id) {
        report.mismatches.push('edge order/id mismatch at ' + i);
      } else {
        compare('edge[' + e.id + '].value', e.value, old.value);
      }
    });
    rebuilt.nodes.forEach(function (n, i) {
      var old = project.snapshot.nodes[i];
      if (!old || n.id !== old.id) {
        report.mismatches.push('node order/id mismatch at ' + i);
      } else {
        compare('node[' + n.id + '].inflow', n.inflow, old.inflow);
      }
    });
    report.keyValuesMatch = report.mismatches.length === 0;
    report.ok = report.checksumOk && report.snapshotChecksumOk &&
      report.objectCountsMatch && report.keyValuesMatch;
    return report;
  }

  // 输入减少仿真：缩放源输入，返回基线/缩减后两套图与守恒、阈值证据。
  function runInputReduction(dataset, shiftId, factor) {
    var params = { shiftId: shiftId || 'all', inputScale: 1, overrides: {} };
    var baseline = buildGraph({
      records: dataset.records, shiftId: params.shiftId,
      inputScale: 1, overrides: {}
    });
    var reduced = buildGraph({
      records: dataset.records, shiftId: params.shiftId,
      inputScale: factor, overrides: {}
    });

    var deltas = {
      sourceInput: round3(reduced.totals.sourceInput - baseline.totals.sourceInput),
      sinkOutput: round3(reduced.totals.sinkOutput - baseline.totals.sinkOutput),
      normalLoss: round3(reduced.totals.normalLoss - baseline.totals.normalLoss),
      abnormalLoss: round3(reduced.totals.abnormalLoss - baseline.totals.abnormalLoss)
    };

    var thresholdEvidence = reduced.edges.map(function (e) {
      return {
        id: e.id, kind: e.kind, level: e.level, color: e.color,
        ratio: round3(e.kind === 'flow' ? e.utilization : (e.lossRatio || 0))
      };
    });

    var conservationGap = Math.max(
      Math.abs(baseline.totals.electricConservedGap),
      Math.abs(reduced.totals.electricConservedGap)
    );

    return {
      factor: factor,
      baseline: baseline,
      reduced: reduced,
      deltas: deltas,
      conserved: conservationGap < 1e-6,
      maxGap: conservationGap,
      thresholdRules: {
        loss: LOSS_THRESHOLDS, flow: FLOW_THRESHOLDS
      },
      thresholdEvidence: thresholdEvidence
    };
  }

  return {
    VERSION: VERSION,
    EXPORT_SCHEMA: EXPORT_SCHEMA,
    ROUND_DECIMALS: ROUND_DECIMALS,
    SHIFTS: SHIFTS,
    NODES: NODES,
    EDGES: EDGES,
    LOSS_THRESHOLDS: LOSS_THRESHOLDS,
    FLOW_THRESHOLDS: FLOW_THRESHOLDS,
    shiftOf: shiftOf,
    cleanRecords: cleanRecords,
    buildGraph: buildGraph,
    thresholdLevel: thresholdLevel,
    lossColor: lossColor,
    flowColor: flowColor,
    round3: round3,
    fnv1a: fnv1a,
    stableStringify: stableStringify,
    snapshotFromGraph: snapshotFromGraph,
    withChecksum: withChecksum,
    verifyChecksum: verifyChecksum,
    makeProject: makeProject,
    reloadProject: reloadProject,
    runInputReduction: runInputReduction
  };
});
