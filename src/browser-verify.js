// 浏览器内置验证：与 tests/run-tests.mjs 同构的断言，输出完整中间证据而非单张截图

import { sanitizeDataset } from './graph.js';
import { runSimulation } from './simulation.js';
import { sampleA } from './samples/sample-a.js';
import { sampleB, recommendedClosureB } from './samples/sample-b.js';
import { buildCsvBundle, verifyExport, vehicleRows, eventRows } from './exporter.js';
import { buildProject, parseProject } from './project.js';

export async function runInBrowser() {
  const lines = [];
  let passed = 0;
  let failed = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { passed += 1; lines.push(`  ✓ ${name}`); }
    else { failed += 1; lines.push(`  ✗ ${name} ${detail}`); }
  };

  lines.push('== 1. 两份固定样例脏数据清洗 ==');
  const cleanA = sanitizeDataset(sampleA);
  const cleanB = sanitizeDataset(sampleB);
  check('样例A 重复节点/道路/车辆被剔除',
    cleanA.data.nodes.filter((n) => n.id === 'N2').length === 1 &&
    cleanA.data.edges.filter((e) => e.id === 'E1').length === 1 &&
    cleanA.data.trips.filter((t) => t.id === 'V1').length === 1);
  check('样例A 空值/异常值被修正',
    cleanA.data.edges.find((e) => e.id === 'E8').weight === 1 &&
    cleanA.data.edges.find((e) => e.id === 'E10').weight === 100 &&
    cleanA.data.trips.find((t) => t.id === 'V7').release === 0);
  check('样例B 非法坐标补位、缺端点道路剔除',
    cleanB.data.nodes.some((n) => n.id === 'GHOST') &&
    !cleanB.data.edges.some((e) => e.id === 'BAD1'));
  lines.push(`  清洗问题计数：样例A=${cleanA.issues.length} 样例B=${cleanB.issues.length}`);

  lines.push('');
  lines.push('== 2. 实际封路与重规划（样例B，封 AB tick 4-12）==');
  const base = runSimulation(cleanB.data);
  const closed = runSimulation(cleanB.data, { closures: [recommendedClosureB] });
  const k1Base = base.vehicles.get('K1');
  const k1Closed = closed.vehicles.get('K1');
  lines.push(`  基线 K1 初始路径: ${k1Base.events.find((e) => e.type === 'plan-initial').path}`);
  lines.push(`  封路 K1 初始路径: ${k1Closed.events.find((e) => e.type === 'plan-initial').path}`);
  const rerouteEvents = k1Closed.events.filter((e) => e.type === 'reroute-closure');
  rerouteEvents.forEach((e) => lines.push(`  t${e.tick} 重规划: ${e.detail} | 新路径=${e.path}`));
  check('基线 K1 走上路含 AB', k1Base.events.find((e) => e.type === 'plan-initial').path.includes('AB'));
  check('封路后 K1 实际未进入 AB', !k1Closed.events.some((e) => e.type === 'enter-edge' && e.edgeId === 'AB'));
  check('封路后产生 reroute-closure 明细', rerouteEvents.length > 0);
  check('封路窗内无任何车辆进入 AB',
    [...closed.vehicles.values()].every((v) => !v.events.some((e) =>
      e.type === 'enter-edge' && e.edgeId === 'AB' &&
      e.tick >= recommendedClosureB.from && e.tick <= recommendedClosureB.to)));

  lines.push('');
  lines.push('== 3. 车辆记录与统计同步变化 ==');
  lines.push(`  基线统计: 到达${base.stats.arrived} 重规划${base.stats.reroutes} 总距离${base.stats.totalDistance} 等待${base.stats.totalWait}`);
  lines.push(`  封路统计: 到达${closed.stats.arrived} 重规划${closed.stats.reroutes} 总距离${closed.stats.totalDistance} 等待${closed.stats.totalWait}`);
  check('总距离因绕行改变', base.stats.totalDistance !== closed.stats.totalDistance);
  check('重规划次数增加', closed.stats.reroutes > base.stats.reroutes);
  check('热图随封路变化', JSON.stringify(base.heatmap) !== JSON.stringify(closed.heatmap));
  check('每辆车保留完整决策链', [...closed.vehicles.values()].every((v) => v.events.length > 0));
  lines.push(`  决策事件总数: ${eventRows(closed).length}`);

  lines.push('');
  lines.push('== 4. 导出口径：对象数量与关键数值一致 ==');
  for (const [tag, result] of [['样例A', runSimulation(cleanA.data)], ['样例B封路', closed]]) {
    const verify = verifyExport(result, buildCsvBundle(result));
    lines.push(`  [${tag}] 对象: ${verify.scope.vehicles}车 ${verify.scope.events}事件 ${verify.scope.heatEdges}边`);
    verify.checks.forEach((c) => lines.push(`    ${c.pass ? '✓' : '✗'} ${c.name}: ${c.expected} === ${c.actual}`));
    check(`[${tag}] 导出一致`, verify.pass);
  }

  lines.push('');
  lines.push('== 5. 工程保存/重载复现 ==');
  const project = buildProject({
    sampleId: cleanB.data.id, dataset: cleanB.data, sanitizeIssues: cleanB.issues,
    overrides: { weights: {}, closures: [recommendedClosureB] },
    filters: { state: 'all', vehicleId: '' }, selectedVehicleId: 'K1',
    selectedEdgeId: 'AB', heatmapEnabled: true, dataVersion: 3,
  });
  const restored = parseProject(JSON.stringify(JSON.parse(JSON.stringify(project))));
  const rerun = runSimulation(restored.dataset, restored.overrides);
  check('重载工程重跑结果与封路仿真一致',
    rerun.stats.totalDistance === closed.stats.totalDistance &&
    rerun.stats.arrived === closed.stats.arrived &&
    vehicleRows(rerun).length === vehicleRows(closed).length);

  lines.push('');
  lines.push(`验证结论：${passed} 通过 / ${failed} 失败`);
  return lines.join('\n');
}
