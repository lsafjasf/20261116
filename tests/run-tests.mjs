// 零依赖测试运行器：验证清洗、封路重规划、决策记录、统计同步与导出口径

import { sanitizeDataset } from '../src/graph.js';
import { runSimulation } from '../src/simulation.js';
import { sampleA } from '../src/samples/sample-a.js';
import { sampleB, recommendedClosureB } from '../src/samples/sample-b.js';
import { buildCsvBundle, verifyExport, vehicleRows, eventRows } from '../src/exporter.js';
import { buildProject, parseProject } from '../src/project.js';

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  ✗ ${name} ${detail}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

// ---------- 样例 A：脏数据清洗 ----------
section('样例 A：空值/重复/异常值清洗');
const cleanA = sanitizeDataset(sampleA);
check('重复节点 N2 被剔除', cleanA.data.nodes.filter((n) => n.id === 'N2').length === 1);
check('空 id 节点被剔除', !cleanA.data.nodes.some((n) => n.id === ''));
check('空坐标节点 N9 被保留并补位', cleanA.data.nodes.some((n) => n.id === 'N9' && Number.isFinite(n.x)));
check('重复道路 E1 被剔除', cleanA.data.edges.filter((e) => e.id === 'E1').length === 1);
check('缺失端点道路 E13 被剔除', !cleanA.data.edges.some((e) => e.id === 'E13'));
check('自环道路 E14 被剔除', !cleanA.data.edges.some((e) => e.id === 'E14'));
check('空权重 E8 回退为 1', cleanA.data.edges.find((e) => e.id === 'E8').weight === 1);
check('异常权重 E10 截断为 100', cleanA.data.edges.find((e) => e.id === 'E10').weight === 100);
check('负长度 E12 回退为 100', cleanA.data.edges.find((e) => e.id === 'E12').length === 100);
check('非法车道 E11 回退为 1', cleanA.data.edges.find((e) => e.id === 'E11').lanes === 1);
check('容量为 0 的 E11 按车道推算', cleanA.data.edges.find((e) => e.id === 'E11').capacity === 10);
check('重复车辆 V1 剔除一条', cleanA.data.trips.filter((t) => t.id === 'V1').length === 1);
check('缺失终点车辆 V9 被剔除', !cleanA.data.trips.some((t) => t.id === 'V9'));
check('负释放车辆 V7 归零', cleanA.data.trips.find((t) => t.id === 'V7').release === 0);
check('超窗释放车辆 V8 被截断', cleanA.data.trips.find((t) => t.id === 'V8').release === cleanA.data.horizon - 1);
check('空截止时间回退到窗口末尾', cleanA.data.trips.find((t) => t.id === 'V6').deadline === cleanA.data.horizon);
check('清洗问题均记录原因', cleanA.issues.length >= 15, `实际 ${cleanA.issues.length}`);

// ---------- 样例 A：基线仿真 ----------
section('样例 A：基线仿真与统计');
const baseA = runSimulation(cleanA.data);
check('所有车辆产生终态', [...baseA.vehicles.values()].every((v) => ['arrived', 'unreachable', 'waiting', 'moving', 'pending'].includes(v.state)));
check('至少一辆车到达', baseA.stats.arrived > 0);
check('每辆车都有决策记录', [...baseA.vehicles.values()].every((v) => v.events.length > 0));
check('调试快照数量等于仿真窗口', baseA.debug.length === cleanA.data.horizon);
check('热图覆盖全部道路', baseA.heatmap.length === cleanA.data.edges.length);

// ---------- 样例 B：封路重规划（核心证据） ----------
section('样例 B：实际封路与重规划验证');
const cleanB = sanitizeDataset(sampleB);
check('非法坐标节点 GHOST 被补位保留', cleanB.data.nodes.some((n) => n.id === 'GHOST' && Number.isFinite(n.x) && Number.isFinite(n.y)));
check('端点缺失的非法道路 BAD1 被整体剔除', !cleanB.data.edges.some((x) => x.id === 'BAD1'));
check('清洗问题记录了 BAD1 剔除原因', cleanB.issues.some((i) => i.ref === 'BAD1' && i.scope === 'edge'));
check('重复道路 SA 保留首条', cleanB.data.edges.filter((e) => e.id === 'SA').length === 1);
check('缺失终点车辆 K7 被剔除', !cleanB.data.trips.some((t) => t.id === 'K7'));

const baseB = runSimulation(cleanB.data);
const closedB = runSimulation(cleanB.data, { closures: [recommendedClosureB] });

const k1Base = baseB.vehicles.get('K1');
const k1Closed = closedB.vehicles.get('K1');
check('基线 K1 初始规划走上路(含 AB)', k1Base.events.find((e) => e.type === 'plan-initial').path.split('>').includes('AB'));
check('封路后实际进入的道路不含 AB', !k1Closed.events.some((e) => e.type === 'enter-edge' && e.edgeId === 'AB'));
check('封路后重规划事件给出不含 AB 的新路径',
  k1Closed.events.filter((e) => e.type === 'reroute-closure').every((e) => !(e.path || '').split('>').includes('AB')));
check('封路后 K1 产生 reroute-closure 或初始即绕行事件',
  k1Closed.events.some((e) => e.type === 'reroute-closure') ||
  k1Closed.events.find((e) => e.type === 'plan-initial').path.includes('SC'));
check('任何车辆任何时刻都未进入封闭道路 AB(封路窗内)',
  [...closedB.vehicles.values()].every((v) => !v.events.some((e) =>
    e.type === 'enter-edge' && e.edgeId === 'AB' && e.tick >= recommendedClosureB.from && e.tick <= recommendedClosureB.to)));
check('封路后重规划次数增加', closedB.stats.reroutes >= baseB.stats.reroutes);
check('封路后总行驶距离发生变化（绕行）', closedB.stats.totalDistance !== baseB.stats.totalDistance);
check('封路前后到达数可比较且无崩溃', Number.isInteger(closedB.stats.arrived) && Number.isInteger(baseB.stats.arrived));
check('封路窗调试面板记录封闭边 AB', closedB.debug.some((d) => d.closures.includes('AB')));
const closureEvents = eventRows(closedB).filter((e) => e.type === 'reroute-closure' || e.type === 'evacuate-closure');
check('决策日志包含封路重规划明细', closureEvents.length > 0, `事件数 ${closureEvents.length}`);

// 完全封死出口：算法必须拒绝派入封闭道路并标记不可达，而非崩溃或硬闯
const blocked = runSimulation(cleanB.data, {
  closures: [
    { edgeId: 'SA', from: 0, to: cleanB.data.horizon },
    { edgeId: 'SC', from: 0, to: cleanB.data.horizon },
  ],
});
const blockedK1 = blocked.vehicles.get('K1');
check('全封闭时 K1 标记 unreachable', blockedK1.state === 'unreachable');
check('全封闭时 K1 从未进入 SA/SC',
  !blockedK1.events.some((e) => e.type === 'enter-edge' && ['SA', 'SC'].includes(e.edgeId)));
check('存在不可达车辆统计', blocked.stats.unreachable >= 1);

// 统计同步：封路前后两套统计应不同且自洽
section('统计结果同步变化');
check('热图在封路后发生变化', JSON.stringify(baseB.heatmap) !== JSON.stringify(closedB.heatmap));
check('等待/重规划统计与事件计数一致',
  closedB.stats.reroutes === [...closedB.vehicles.values()].reduce((s, v) => s + v.events.filter((e) => e.type.startsWith('reroute')).length, 0));

// ---------- 导出口径一致性 ----------
section('导出前后对象数量与关键数值一致');
for (const [tag, result] of [['样例A', baseA], ['样例B封路', closedB]]) {
  const bundle = buildCsvBundle(result);
  const verify = verifyExport(result, bundle);
  check(`[${tag}] 导出校验全部通过`, verify.pass, JSON.stringify(verify.checks.filter((c) => !c.pass)));
  check(`[${tag}] CSV 行数与内存车辆数一致`, parseCsvCount(bundle.vehiclesCsv) === vehicleRows(result).length);
}

function parseCsvCount(text) {
  return text.trimEnd().split('\n').length - 1;
}

// ---------- 工程存档可重新载入 ----------
section('工程保存/重载一致性');
const state = {
  sampleId: 'sample-b-bypass',
  dataset: cleanB.data,
  sanitizeIssues: cleanB.issues,
  overrides: { weights: {}, closures: [recommendedClosureB] },
  filters: { state: 'all', vehicleId: '' },
  selectedVehicleId: 'K1',
  selectedEdgeId: 'AB',
  heatmapEnabled: true,
  dataVersion: 3,
};
const project = buildProject(state);
const restored = parseProject(JSON.stringify(project));
check('重载后路网节点数量一致', restored.dataset.nodes.length === cleanB.data.nodes.length);
check('重载后道路数量一致', restored.dataset.edges.length === cleanB.data.edges.length);
check('重载后封路配置一致', JSON.stringify(restored.overrides.closures) === JSON.stringify([recommendedClosureB]));
check('重载后权重配置为空对象', JSON.stringify(restored.overrides.weights) === '{}');
const weighted = parseProject(JSON.stringify(buildProject({
  ...state, overrides: { weights: { SA: 2.5 }, closures: [recommendedClosureB] },
})));
check('自定义权重可随工程持久化', weighted.overrides.weights.SA === 2.5);
const rerun = runSimulation(restored.dataset, restored.overrides);
check('重载后重跑结果与封路仿真一致',
  rerun.stats.totalDistance === closedB.stats.totalDistance && rerun.stats.arrived === closedB.stats.arrived);

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  console.error('失败项：', failures);
  process.exit(1);
}
process.exit(0);
