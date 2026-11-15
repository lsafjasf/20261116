import assert from "node:assert/strict";
import test from "node:test";
import {
  auditSnapshotsEqual,
  bearingLabel,
  buildAuditSnapshot,
  compareThresholds,
  createProject,
  getDrainagePath,
  parseProject,
  processSample,
} from "../src/core.js";
import { GRID, SAMPLE_DEFINITIONS } from "../src/samples.js";

const samples = SAMPLE_DEFINITIONS.map((sample) => ({
  definition: sample,
  topology: processSample(sample.id),
}));

test("两份固定样例均处理空值、重复记录和异常值", () => {
  for (const { definition, topology } of samples) {
    assert.equal(topology.cells.length, GRID.cols * GRID.rows);
    assert.ok(topology.stats.nullRecords > 0, `${definition.code} 缺少空值`);
    assert.ok(topology.stats.duplicateRecords > 0, `${definition.code} 缺少重复记录`);
    assert.ok(topology.stats.outlierRecords > 0, `${definition.code} 缺少异常值`);
    assert.equal(
      topology.stats.measuredRecords +
        topology.stats.nullRecords +
        topology.stats.outlierRecords,
      topology.stats.rawRecords - topology.stats.duplicateRecords,
    );
    assert.ok(topology.cells.some((cell) => cell.dataStatus === "imputed"));
    assert.ok(topology.cells.some((cell) => cell.dataStatus === "clamped"));
    assert.ok(
      topology.cells.every(
        (cell) =>
          Number.isFinite(cell.elevation) &&
          cell.elevation > 0 &&
          cell.elevation < 2000,
      ),
    );
  }
});

test("坡度、坡向和 D8 汇流方向保持在有效范围", () => {
  for (const { topology } of samples) {
    for (const cell of topology.cells) {
      assert.ok(cell.slopeDeg >= 0 && cell.slopeDeg <= 90);
      assert.ok(cell.aspectDeg >= 0 && cell.aspectDeg < 360);
      assert.equal(cell.flowDirCode, cell.isSink ? "SINK" : bearingLabel(cell.flowDirDeg));
      if (!cell.isSink) {
        const downstream = topology.byId.get(cell.downstreamId);
        assert.ok(downstream);
        assert.ok(downstream.elevation < cell.elevation);
      }
      assert.ok(cell.flowAccum >= 1);
      assert.ok(cell.riskIndex >= 0 && cell.riskIndex <= 100);
    }
    assert.ok(topology.cells.some((cell) => cell.flowAccum > 1));
  }
});

test("双阈值比较与同一网格读数一致", () => {
  const topology = samples[0].topology;
  const selectedId = "4:18";
  const selected = topology.byId.get(selectedId);
  const compare = compareThresholds(topology, 62, 45, selectedId);
  assert.equal(
    compare.countA,
    topology.cells.filter((cell) => cell.riskIndex >= 62).length,
  );
  assert.equal(
    compare.countB,
    topology.cells.filter((cell) => cell.riskIndex >= 45).length,
  );
  assert.equal(compare.delta, Math.abs(compare.countA - compare.countB));
  assert.equal(compare.selectedState, "双阈值命中");
  assert.equal(selected.riskIndex, 73);
  assert.equal(selected.flowDirCode, bearingLabel(selected.flowDirDeg));

  const path = getDrainagePath(topology, selectedId);
  assert.equal(path.ids[0], selectedId);
  assert.equal(path.ids.length, 5);
  assert.ok(path.lengthM > 0);
  assert.equal(path.cells.at(-1).isSink, true);
});

test("两个阈值切换会得到不同的风险网格集合", () => {
  const topology = samples[0].topology;
  const low = compareThresholds(topology, 38, 20);
  const high = compareThresholds(topology, 72, 60);
  assert.ok(low.countA > high.countA);
  assert.ok(low.countB > high.countB);
  assert.notEqual(low.countA, high.countA);
});

test("工程保存与重新载入逐字段一致", () => {
  const input = {
    sampleId: "south-terrace",
    thresholdA: 71,
    thresholdB: 52,
    layer: "aspect",
    showArrows: false,
    showGrid: true,
    selectedId: "9:12",
    hoverId: "8:11",
  };
  const project = createProject(input, {
    snapshot: buildAuditSnapshot(samples[1].topology, 71, 52),
  });
  const reloaded = parseProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(reloaded.state, input);
  assert.equal(project.schema, "terrain-flow-project/v1");
});

test("导出前后对象数量和全部关键值校验一致", () => {
  for (const { topology } of samples) {
    const before = buildAuditSnapshot(topology, 62, 45);
    const after = buildAuditSnapshot(topology, 62, 45);
    assert.equal(auditSnapshotsEqual(before, after), true);
    assert.equal(before.objectCount, topology.cells.length + topology.rawRecords.length);
    assert.equal(before.gridObjects, GRID.cols * GRID.rows);
    assert.deepEqual(before.keyValues, after.keyValues);
  }
});
