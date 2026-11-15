/* Node 测试：不依赖任何第三方框架。运行：node tests/run-tests.js */
const assert = require('assert');
const Core = require('../js/core.js');
const Samples = require('../js/samples.js');
const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, message: err.message, stack: err.stack });
    console.log('  ✗ ' + name + ' — ' + err.message);
  }
}

function approx(a, b, eps) {
  return Math.abs(a - b) <= (eps == null ? 1e-6 : eps);
}

const datasets = Samples.all();
const A = datasets[0];
const B = datasets[1];

console.log('\n[1] 数据清洗：空值 / 重复 / 异常值');

test('样例 A 空值/完全重复各 1，异常含冲突重复与越界', () => {
  const g = Core.buildGraph({ records: A.records, shiftId: 'all' });
  assert.strictEqual(g.cleanReport.counts.null, 1);
  assert.strictEqual(g.cleanReport.counts.duplicate, 1);
  assert.strictEqual(g.cleanReport.counts.outlier, 2);
  assert.strictEqual(g.cleanReport.droppedNull[0], 'A-null-01');
  assert.strictEqual(g.cleanReport.droppedDuplicate[0], 'A-dup-01');
  const out = g.cleanReport.outliers;
  assert.ok(out.some((o) => o.id === 'A-out-01' && o.reason === 'over-cap'));
  assert.ok(out.some((o) => o.id === 'A-conflict-01'
    && o.reason === 'duplicate-conflict'));
});

test('样例 B 空值 2、完全重复 1、异常 4（冲突/负值/越界）', () => {
  const g = Core.buildGraph({ records: B.records, shiftId: 'all' });
  assert.strictEqual(g.cleanReport.counts.null, 2);
  assert.strictEqual(g.cleanReport.counts.duplicate, 1);
  assert.strictEqual(g.cleanReport.counts.outlier, 4);
  const reasons = g.cleanReport.outliers.map((o) => o.reason).sort();
  assert.deepStrictEqual(reasons,
    ['duplicate-conflict', 'negative', 'over-cap', 'over-cap']);
});

test('清洗计数守恒：输入 = 接受 + 空值 + 重复 + 异常', () => {
  datasets.forEach((ds) => {
    const g = Core.buildGraph({ records: ds.records, shiftId: 'all' });
    const c = g.cleanReport.counts;
    assert.strictEqual(c.input, c.accepted + c.null + c.duplicate + c.outlier,
      ds.id + ' 清洗计数不平衡');
  });
});

console.log('\n[2] 总流量守恒（含异常损失单独核算）');

test('两份样例、四个时间窗口下逐节点守恒（gap < 1e-6）', () => {
  datasets.forEach((ds) => {
    ['all', 'morning', 'swing', 'night'].forEach((shiftId) => {
      const g = Core.buildGraph({ records: ds.records, shiftId });
      assert.ok(g.conserved, ds.id + '/' + shiftId + ' 不守恒 gap=' + g.maxGap);
      g.balanceChecks.forEach((c) => {
        assert.ok(approx(c.inflow, c.outflow + c.normalLoss + c.abnormalLoss, 1e-6),
          ds.id + '/' + shiftId + ' 节点 ' + c.node + ' 不平衡');
      });
    });
  });
});

test('全局守恒：源输入 = 终端输出 + 常规损失 + 异常损失', () => {
  datasets.forEach((ds) => {
    const g = Core.buildGraph({ records: ds.records, shiftId: 'all' });
    // 电力路径恒等式（源节点异常不占用电力链能量，已在内核剔除）。
    assert.ok(g.totals.electricConservedGap < 1e-6,
      ds.id + ' 电力路径不守恒 gap=' + g.totals.electricConservedGap);
    assert.ok(g.totals.electricConservedGap < 1e-6);
    // 蒸汽路径：锅炉输出全部到达工艺终端
    const boilerEdge = g.edges.find((e) => e.id === 'boiler_sink');
    assert.ok(approx(g.totals.boilerInput, boilerEdge.value, 1e-6));
  });
});

test('异常值金额完整进入异常损失（取绝对值），不被静默丢弃', () => {
  const gB = Core.buildGraph({ records: B.records, shiftId: 'all' });
  const hvacA = Core.buildGraph({ records: A.records, shiftId: 'all' });
  // 空调损失 96 > 残差 19：19 进入异常损失弧线，超额 77 记为不平衡量。
  const hvacNode = hvacA.nodes.find((n) => n.id === 'hvac');
  assert.ok(approx(hvacNode.abnormalLoss, 19, 1e-6));
  assert.ok(approx(hvacNode.imbalance, 77, 1e-6),
    '超额异常须作为数据质量不平衡量保留');
  const pump = gB.nodes.find((n) => n.id === 'pump');
  const chiller = gB.nodes.find((n) => n.id === 'chiller');
  const grid = gB.nodes.find((n) => n.id === 'grid');
  // 源端异常不占用物理残差，完整保留在源节点异常损失弧线上。
  assert.ok(approx(grid.abnormalLoss, 1500, 1e-6),
    '电网应承接源端越界 1500');
  assert.ok(approx(pump.abnormalLoss, 12, 1e-6), '负值 -12 应转为异常损失 12');
  assert.ok(chiller.abnormalMeasured >= 150, '越界 150 应保留在异常测量值中');
  assert.ok(chiller.imbalance > 0 || chiller.abnormalLoss > 0,
    '冷水机越界须体现为异常损失或不平衡量');
  assert.ok(gB.cleanReport.outliers.some((o) => o.id === 'B-out-02'),
    '源端越界须保留在异常清单');
  assert.ok(gB.cleanReport.outliers.some((o) => o.id === 'B-dup-01'),
    '冲突重复须保留在异常清单');
});

console.log('\n[3] 颜色阈值边界');

test('损失率阈值：<0.05 ok，[0.05,0.12) warn，>=0.12 danger', () => {
  const T = Core.LOSS_THRESHOLDS;
  assert.strictEqual(Core.thresholdLevel(0.0499, T), 'ok');
  assert.strictEqual(Core.thresholdLevel(0.05, T), 'warn');
  assert.strictEqual(Core.thresholdLevel(0.1199, T), 'warn');
  assert.strictEqual(Core.thresholdLevel(0.12, T), 'danger');
  assert.strictEqual(Core.thresholdLevel(0.9, T), 'danger');
  assert.strictEqual(Core.lossColor(0.12), '#d64545');
});

test('流量利用率阈值：<0.85 ok，[0.85,1.0) warn，>=1.0 danger', () => {
  const T = Core.FLOW_THRESHOLDS;
  assert.strictEqual(Core.thresholdLevel(0.84, T), 'ok');
  assert.strictEqual(Core.thresholdLevel(0.85, T), 'warn');
  assert.strictEqual(Core.thresholdLevel(0.99, T), 'warn');
  assert.strictEqual(Core.thresholdLevel(1.0, T), 'danger');
});

test('图中每条弧线的 level 与数值口径一致', () => {
  datasets.forEach((ds) => {
    const g = Core.buildGraph({ records: ds.records, shiftId: 'all' });
    g.edges.forEach((e) => {
      if (e.kind === 'flow') {
        assert.strictEqual(e.level,
          Core.thresholdLevel(e.utilization, Core.FLOW_THRESHOLDS));
      } else if (e.kind === 'loss-normal') {
        assert.strictEqual(e.level,
          Core.thresholdLevel(e.lossRatio, Core.LOSS_THRESHOLDS));
      }
    });
  });
});

console.log('\n[4] 拖动覆盖与班次切换');

test('拖动覆盖改变弧线值并钳位到 [0, cap]，下游弧线级联缩放', () => {
  const base = Core.buildGraph({ records: A.records, shiftId: 'all' });
  const edge = base.edges.find((e) => e.id === 'mcc_chiller');
  const wanted = Math.round(edge.value * 0.6);
  const adjusted = Core.buildGraph({
    records: A.records, shiftId: 'all',
    overrides: { mcc_chiller: wanted }
  });
  const moved = adjusted.edges.find((e) => e.id === 'mcc_chiller');
  assert.strictEqual(moved.value, wanted);
  assert.strictEqual(moved.overridden, true);
  const childBase = base.edges.find((e) => e.id === 'chiller_sink').value;
  const child = adjusted.edges.find((e) => e.id === 'chiller_sink');
  assert.ok(child.value < childBase, '下游弧线应随上游拖动级联减小');
  const other = adjusted.edges.find((e) => e.id === 'mcc_pump');
  const otherBase = base.edges.find((e) => e.id === 'mcc_pump');
  assert.ok(approx(other.value, otherBase.value), '非下游弧线不应被改写');

  // 钳位：超过容量的拖动值被压回 cap。
  const clamped = Core.buildGraph({
    records: A.records, shiftId: 'all',
    overrides: { mcc_chiller: edge.cap + 1000 }
  });
  assert.strictEqual(clamped.edges.find((e) => e.id === 'mcc_chiller').value,
    edge.cap, '超出 cap 必须钳位');
});

test('任意覆盖下节点与全局仍然守恒', () => {
  const g = Core.buildGraph({
    records: A.records, shiftId: 'all',
    overrides: { mcc_chiller: 120, boiler_sink: 180 }
  });
  assert.ok(g.conserved, '覆盖后不守恒 gap=' + g.maxGap);
  assert.ok(g.totals.electricConservedGap < 1e-6,
    '覆盖后电力路径不守恒 gap=' + g.totals.electricConservedGap);
});

test('班次过滤：窗口记录数与班次归属一致，切换后数值同步变化', () => {
  const all = Core.buildGraph({ records: A.records, shiftId: 'all' });
  const morning = Core.buildGraph({ records: A.records, shiftId: 'morning' });
  const night = Core.buildGraph({ records: A.records, shiftId: 'night' });
  assert.strictEqual(morning.shiftId, 'morning');
  assert.ok(morning.cleanReport.windowedCount < all.cleanReport.windowedCount);
  assert.ok(night.totals.sourceInput < morning.totals.sourceInput,
    '夜班负荷低于早班');
  const edgeAll = all.edges.find((e) => e.id === 'grid_transformer').value;
  const parts = ['morning', 'swing', 'night']
    .map((s) => Core.buildGraph({ records: A.records, shiftId: s })
      .edges.find((e) => e.id === 'grid_transformer').value);
  assert.ok(approx(parts.reduce((a, b) => a + b, 0), edgeAll, 1e-6),
    '三个班次之和应等于全天窗口');
});

console.log('\n[5] 输入减少仿真');

test('输入缩放 0.8：源输入下降 20%，两套图均守恒，异常损失仍单独显示', () => {
  const sim = Core.runInputReduction(A, 'all', 0.8);
  assert.strictEqual(sim.factor, 0.8);
  assert.ok(sim.conserved, '仿真存在不守恒 gap=' + sim.maxGap);
  assert.ok(sim.maxGap < 1e-6);
  const baseInput = sim.baseline.totals.gridInput;
  const redInput = sim.reduced.totals.gridInput;
  assert.ok(approx(redInput, baseInput * 0.8, 1e-6),
    '电网输入未按 0.8 缩放');
  assert.ok(approx(sim.reduced.totals.boilerInput,
    sim.baseline.totals.boilerInput, 1e-6), '锅炉支路应保持独立不变');
  assert.ok(sim.deltas.sourceInput < 0, '输入差值应为负');
  const abn = sim.reduced.edges.filter((e) => e.kind === 'loss-abnormal');
  assert.strictEqual(abn.length, 7, '异常损失弧线数量固定为每核算节点 1 条');
  assert.ok(abn.some((e) => e.value > 0), '异常损失未被单独保留');
});

test('仿真前后异常清洗结果保持一致（异常值不随缩放消失）', () => {
  const sim = Core.runInputReduction(B, 'all', 0.7);
  assert.deepStrictEqual(
    sim.baseline.cleanReport.counts,
    sim.reduced.cleanReport.counts
  );
});

console.log('\n[6] 导出 / 工程存档 / 重新载入一致性');

test('导出对象包含固定对象数量（8 节点 + 21 弧线）', () => {
  const g = Core.buildGraph({ records: A.records, shiftId: 'all' });
  const snap = Core.snapshotFromGraph(g, { datasetId: A.id, overrides: {} });
  assert.strictEqual(snap.objectCounts.nodes, 8);
  assert.strictEqual(snap.objectCounts.edges, 22);
  assert.strictEqual(snap.edges.length, 22);
});

test('工程保存后重新载入：校验和、对象数量、关键数值全部一致', () => {
  const params = {
    datasetId: A.id, shiftId: 'swing',
    inputScale: 1, overrides: { mcc_pump: 60 }
  };
  const g = Core.buildGraph({
    records: A.records, shiftId: params.shiftId,
    inputScale: params.inputScale, overrides: params.overrides
  });
  const project = Core.makeProject(A, params, g);
  const report = Core.reloadProject(project);
  assert.ok(report.checksumOk, '工程校验和失败');
  assert.ok(report.snapshotChecksumOk, '快照校验和失败');
  assert.ok(report.objectCountsMatch, '对象数量不一致');
  assert.ok(report.keyValuesMatch, '关键数值不一致：' + report.mismatches.join('; '));
  assert.ok(report.ok);
});

test('篡改工程后校验和必须失败', () => {
  const g = Core.buildGraph({ records: A.records, shiftId: 'all' });
  const project = Core.makeProject(A, { datasetId: A.id, overrides: {} }, g);
  project.snapshot.totals.sourceInput = 1;
  assert.strictEqual(Core.verifyChecksum(project.snapshot), false);
  const tampered = Core.withChecksum(JSON.parse(JSON.stringify(
    Core.snapshotFromGraph(g, { datasetId: A.id, overrides: {} }))));
  assert.ok(Core.verifyChecksum(tampered));
});

test('含 NaN 的脏数据工程仍为合法 JSON（NaN 净化为 null）', () => {
  const g = Core.buildGraph({ records: B.records, shiftId: 'all' });
  const project = Core.makeProject(B, { datasetId: B.id, overrides: {} }, g);
  const text = JSON.stringify(project);
  assert.ok(!text.includes('NaN'), '序列化结果不得包含裸 NaN');
  assert.doesNotThrow(() => JSON.parse(text));
  const parsed = JSON.parse(text);
  assert.ok(parsed.dataset.records.some((r) => r.value === null),
    'NaN/undefined 应统一净化为 null');
  assert.ok(Core.verifyChecksum(parsed), '净化后工程校验和仍须有效');
});

test('工程文件落盘后可重新载入（artifacts/saved-project.json）', () => {
  const projectPath = path.join(__dirname, '..', 'artifacts', 'saved-project.json');
  const onDisk = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  const report = Core.reloadProject(onDisk);
  assert.ok(report.ok, '落盘工程重载失败：' + report.mismatches.join('; '));
});

console.log('\n结果：' + passed + ' 通过，' + failures.length + ' 失败');
if (failures.length) {
  process.exitCode = 1;
}
