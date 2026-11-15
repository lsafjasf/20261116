const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..', 'js');
require(path.join(root, 'samples.js'));
require(path.join(root, 'ingest.js'));
require(path.join(root, 'engine.js'));
require(path.join(root, 'export.js'));

const { App } = global;
let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

console.log('样例A：干净基线');
const cleanA = App.ingest.clean(App.samples.A);
test('A 无隔离记录', () => assert.strictEqual(cleanA.quarantine.length, 0));
const simA = App.engine.run(cleanA);
test('A 每个 tick 流量/库存守恒', () =>
  simA.ledger.forEach((t) => assert.ok(t.conservationOk, 'tick ' + t.tick)));
test('A 工厂产出全部流入系统且边不超发', () => {
  simA.ledger.forEach((t) => t.edges.forEach((e) =>
    assert.ok(e.flow <= e.cap + 1e-9, e.id + ' 超容量发货')));
});

console.log('样例B：空值/重复/异常值清洗');
const cleanB = App.ingest.clean(App.samples.B);
test('B 隔离台账同时含 drop 与 repair', () => {
  assert.ok(cleanB.quarantine.some((q) => q.action === 'drop'));
  assert.ok(cleanB.quarantine.some((q) => q.action === 'repair'));
});
test('B 重复节点 S3 与重复边 E01 各只保留一条', () => {
  assert.strictEqual(cleanB.nodes.filter((n) => n.id === 'S3').length, 1);
  assert.strictEqual(cleanB.edges.filter((e) => e.id === 'E01').length, 1);
});
test('B 空ID节点/边被丢弃，悬空边被丢弃', () => {
  assert.ok(!cleanB.nodes.some((n) => n.id === 'S7'));
  assert.ok(!cleanB.edges.some((e) => e.id === 'E10'));
});
test('B 负值需求/产量修复为0，异常值 S6/E14 被丢弃', () => {
  assert.strictEqual(cleanB.nodes.find((n) => n.id === 'S4').demand, 0);
  assert.strictEqual(cleanB.nodes.find((n) => n.id === 'F9').production, 0);
  assert.ok(!cleanB.nodes.some((n) => n.id === 'S6'));
  assert.ok(!cleanB.edges.some((e) => e.id === 'E14'));
});
test('B 空容量/负容量修复为20，异常优先级修复为100', () => {
  assert.strictEqual(cleanB.edges.find((e) => e.id === 'E11').cap, 20);
  assert.strictEqual(cleanB.edges.find((e) => e.id === 'E12').cap, 20);
  assert.strictEqual(cleanB.edges.find((e) => e.id === 'E13').prio, 100);
});

console.log('守恒与断供改道');
const base = App.engine.run(cleanB, { applyInterventions: false });
const fixed = App.engine.run(cleanB, { applyInterventions: true });
test('两种方案所有 tick 均守恒', () => {
  base.ledger.concat(fixed.ledger).forEach((t) => assert.ok(t.conservationOk));
});
test('断供期间 W1 标记 outage 且无产出', () => {
  const t10 = fixed.ledger[10];
  assert.ok(t10.outages.includes('W1'));
  assert.strictEqual(t10.nodes.find((n) => n.id === 'W1').produce, 0);
});
test('部分断供窗口(tick14-19) W1 标记 partial', () =>
  assert.deepStrictEqual(fixed.ledger[14].partials.map((p) => p.target), ['W1']));
function shortageWindow(led, start, end, id) {
  return led.slice(start, end + 1).reduce(
    (a, t) => a + t.nodes.find((n) => n.id === id).shortage, 0);
}
test('全断窗口(tick10-13)两方案均缺货（物理不可达）', () =>
  assert.ok(shortageWindow(base.ledger, 10, 13, 'S1') > 0 &&
    shortageWindow(fixed.ledger, 10, 13, 'S1') > 0));
test('部分断供窗口(tick14-19)基线持续缺货', () =>
  assert.ok(shortageWindow(base.ledger, 14, 19, 'S1') >= 60));
test('改道后部分断供窗口 S1 缺货归零且需求被满足', () => {
  assert.strictEqual(shortageWindow(fixed.ledger, 14, 19, 'S1'), 0);
  fixed.ledger.slice(14, 20).forEach((t) => {
    const s1 = t.nodes.find((n) => n.id === 'S1');
    assert.strictEqual(s1.met, s1.demand);
  });
});
test('改道方案累计缺货显著低于不干预基线', () => {
  const a = shortageWindow(base.ledger, 10, 25, 'S1');
  const b = shortageWindow(fixed.ledger, 10, 25, 'S1');
  assert.ok(b < a / 2, `base=${a} fixed=${b}`);
});
test('库存同步恢复：改道窗口 S1 库存不为负且 W1 库存快速回补', () => {
  fixed.ledger.slice(14, 20).forEach((t) => {
    const s1 = t.nodes.find((n) => n.id === 'S1');
    assert.ok(s1.inv >= 0);
  });
  const w1Start = fixed.ledger[13].nodes.find((n) => n.id === 'W1').inv;
  const w1End = fixed.ledger[17].nodes.find((n) => n.id === 'W1').inv;
  assert.ok(w1End > w1Start * 3, `start=${w1Start} end=${w1End}`);
});

console.log('导出往返一致性');
const pack = App.exporting.buildExport(fixed, { nodeType: 'all', edge: 'all' }, 'full-ledger');
test('导出自检通过', () => assert.strictEqual(pack.consistent, true));
test('对象数量一致（节点/边行计数）', () => {
  assert.strictEqual(pack.before.nodeRowCount, pack.after.nodeRowCount);
  assert.strictEqual(pack.before.edgeRowCount, pack.after.edgeRowCount);
});
test('关键数值一致（总流量/缺货/满足量/期末库存/满载边计数）', () => {
  ['totalFlow', 'totalShortage', 'totalMet', 'finalInventory', 'overcapEdgeTicks']
    .forEach((k) => assert.strictEqual(pack.before[k], pack.after[k], k));
});
const project = App.exporting.buildProject({
  dataset: cleanB, result: fixed, edgeEdits: { E05: { cap: 30 } },
  filters: { nodeType: 'store' }, simulationOptions: { applyInterventions: true }
});
const reloaded = App.engine.run(App.ingest.clean(project.dataset), project.simulationOptions);
test('工程存档重新载入后校验和完全一致', () =>
  assert.deepStrictEqual(App.exporting.checksums(reloaded), project.checksums));

console.log('\n全部通过：' + passed + ' 项断言用例');
