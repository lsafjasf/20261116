/* 生成可重新载入工程与输入减少仿真报告：node scripts/generate-artifacts.js */
const fs = require('fs');
const path = require('path');
const Core = require('../js/core.js');
const Samples = require('../js/samples.js');

const outDir = path.join(__dirname, '..', 'artifacts');
const datasets = Samples.all();
const datasetA = datasets[0];

const params = {
  datasetId: datasetA.id,
  shiftId: 'all',
  inputScale: 1,
  overrides: { mcc_pump: 60 }
};

const graph = Core.buildGraph({
  records: datasetA.records,
  shiftId: params.shiftId,
  inputScale: params.inputScale,
  overrides: params.overrides
});

const project = Core.makeProject(datasetA, params, graph);
fs.writeFileSync(
  path.join(outDir, 'saved-project.json'),
  JSON.stringify(project, null, 2)
);

const reload = Core.reloadProject(project);

const simulations = datasets.map((ds) => {
  const sim = Core.runInputReduction(ds, 'all', 0.8);
  return {
    datasetId: ds.id,
    datasetName: ds.name,
    factor: sim.factor,
    conserved: sim.conserved,
    maxGap: sim.maxGap,
    baseline: sim.baseline.totals,
    reduced: sim.reduced.totals,
    deltas: sim.deltas,
    thresholdRules: sim.thresholdRules,
    thresholdEvidence: sim.thresholdEvidence,
    abnormalEdges: sim.reduced.edges
      .filter((e) => e.kind === 'loss-abnormal')
      .map((e) => ({ id: e.id, value: Core.round3(e.value), color: e.color })),
    cleanCounts: sim.reduced.cleanReport.counts
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  appVersion: Core.VERSION,
  reloadCheck: {
    checksumOk: reload.checksumOk,
    snapshotChecksumOk: reload.snapshotChecksumOk,
    objectCountsMatch: reload.objectCountsMatch,
    keyValuesMatch: reload.keyValuesMatch,
    mismatches: reload.mismatches
  },
  objectCounts: project.snapshot.objectCounts,
  simulations: simulations
};

fs.writeFileSync(
  path.join(outDir, 'simulation-report.json'),
  JSON.stringify(report, null, 2)
);

console.log('已生成 artifacts/saved-project.json 与 artifacts/simulation-report.json');
console.log('工程重载：' + (reload.ok ? '通过' : '失败 ' + reload.mismatches.join(';')));
simulations.forEach((s) => {
  console.log('  ' + s.datasetId + ' 守恒=' + s.conserved +
    ' 源输入 ' + s.baseline.sourceInput + ' -> ' + s.reduced.sourceInput +
    ' 异常损失=' + s.reduced.abnormalLoss);
});
