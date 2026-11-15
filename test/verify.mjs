// Node verification harness. Runs without a browser against the same pure
// modules the UI imports, asserting every hard requirement in the brief.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateSample, DEFECT_MANIFEST } from '../src/engine.js';
import { cleanSeries, DEFAULT_RULES } from '../src/cleaning.js';
import {
  WINDOWS,
  splitWindows,
  evaluateWindow,
  buildDataVersion,
  buildExportScope,
  buildCleaningLog,
  buildProject,
  hashPayload
} from '../src/metrics.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('  \u2713', name);
}

function isOrdered(rows) {
  return rows.every((row, i, arr) => i === 0 || arr[i - 1].timestamp <= row.timestamp);
}

for (const sampleId of ['sampleA', 'sampleB']) {
  const sample = generateSample(sampleId);
  const manifest = DEFECT_MANIFEST[sampleId];
  const pipeline = cleanSeries(sample, { ...DEFAULT_RULES });

  test(`${sampleId}: 重复时间戳被精确去重`, () => {
    assert.equal(pipeline.dedupe.removedCount, manifest.duplicates.length);
    const timestamps = pipeline.dedupe.rows.map((row) => row.timestamp);
    assert.equal(new Set(timestamps).size, timestamps.length);
    assert.equal(pipeline.cleanedRows.length, 64);
  });

  test(`${sampleId}: 空值全部被填充且无残留 null`, () => {
    let filled = 0;
    for (const detail of Object.values(pipeline.perSeries)) {
      filled += detail.nullCount;
      assert.ok(detail.series.every((entry) => entry.clean !== null));
    }
    assert.equal(filled, manifest.nulls.length);
  });

  test(`${sampleId}: 注入尖峰全部命中、无额外误报`, () => {
    for (const seriesId of sample.seriesIds) {
      const seriesIndex = sample.seriesIds.indexOf(seriesId);
      const expected = manifest.spikes
        .filter((spike) => spike.index % 3 === seriesIndex)
        .map((spike) => spike.index)
        .sort((a, b) => a - b);
      const actual = pipeline.perSeries[seriesId].replacements
        .map((item) => item.index)
        .sort((a, b) => a - b);
      assert.deepEqual(actual, expected);
    }
  });

  test(`${sampleId}: 清洗全程不改变采样顺序`, () => {
    assert.ok(isOrdered(sample.rows));
    assert.ok(isOrdered(pipeline.dedupe.rows));
    assert.ok(isOrdered(pipeline.cleanedRows));
    const sourceOrder = pipeline.dedupe.rows.map((row) => row.index);
    const cleanOrder = pipeline.cleanedRows.map((row) => row.index);
    assert.deepEqual(cleanOrder, sourceOrder);
  });

  test(`${sampleId}: 两个时间窗口覆盖全量且不重排`, () => {
    const windows = splitWindows(pipeline.cleanedRows);
    assert.deepEqual(Object.keys(windows), ['W1', 'W2']);
    assert.equal(windows.W1.length + windows.W2.length, pipeline.cleanedRows.length);
    assert.ok(windows.W1.length > 0 && windows.W2.length > 0);
    assert.ok(isOrdered(windows.W1) && isOrdered(windows.W2));
    assert.ok(
      windows.W1.at(-1).timestamp < windows.W2[0].timestamp ||
        windows.W1.every((row) => row.timestamp <= windows.W2[0].timestamp)
    );
  });

  test(`${sampleId}: 窗口误差指标可复现`, () => {
    const windows = splitWindows(pipeline.cleanedRows);
    for (const windowId of WINDOWS.map((item) => item.id)) {
      const evaluation = evaluateWindow(
        pipeline.cleanedRows,
        windows[windowId],
        sample.seriesIds
      );
      assert.ok(evaluation.overall.mae >= 0);
      assert.ok(evaluation.overall.maxDev >= evaluation.overall.mae);
      assert.equal(evaluation.rowCount, windows[windowId].length);
    }
  });
}

test('不同规则产生不同数据版本，相同规则版本稳定', () => {
  const sample = generateSample('sampleA');
  const v1 = buildDataVersion(sample.sampleId, cleanSeries(sample, {}).rules, cleanSeries(sample, {}).cleanedRows);
  const v2 = buildDataVersion(
    sample.sampleId,
    cleanSeries(sample, { nullStrategy: 'zero' }).rules,
    cleanSeries(sample, { nullStrategy: 'zero' }).cleanedRows
  );
  assert.notEqual(v1, v2);
  const v1Again = buildDataVersion(sample.sampleId, cleanSeries(sample, {}).rules, cleanSeries(sample, {}).cleanedRows);
  assert.equal(v1, v1Again);
});

test('关闭去重时重复行保留，开启时移除', () => {
  const sample = generateSample('sampleA');
  const kept = cleanSeries(sample, { dedupe: false });
  assert.equal(kept.cleanedRows.length, sample.rows.length);
  const removed = cleanSeries(sample, { dedupe: true });
  assert.equal(removed.cleanedRows.length, sample.rows.length - 3);
});

test('导出载荷中的对象数量与关键数值和计算结果一致', () => {
  const sample = generateSample('sampleB');
  const pipeline = cleanSeries(sample, {});
  const windows = splitWindows(pipeline.cleanedRows);
  const state = {
    sampleId: sample.sampleId,
    windowId: 'W2',
    seriesIds: sample.seriesIds,
    rules: pipeline.rules,
    samples: { [sample.sampleId]: sample },
    rawRows: sample.rows,
    pipeline,
    cleanedRows: pipeline.cleanedRows,
    windowRows: windows.W2,
    windowEvaluation: evaluateWindow(pipeline.cleanedRows, windows.W2, sample.seriesIds),
    dataVersion: buildDataVersion(sample.sampleId, pipeline.rules, pipeline.cleanedRows)
  };
  const scope = buildExportScope(state);
  const log = buildCleaningLog(state);
  assert.equal(scope.counts.rawRows, sample.rows.length);
  assert.equal(scope.counts.cleanedRows, pipeline.cleanedRows.length);
  assert.equal(scope.counts.windowRows, windows.W2.length);
  assert.equal(scope.metrics.mae, state.windowEvaluation.overall.mae);
  assert.equal(scope.metrics.maxDev, state.windowEvaluation.overall.maxDev);
  assert.equal(log.exportScope.dataVersion, state.dataVersion);
  assert.equal(log.windowMetrics.rowCount, windows.W2.length);
});

test('工程文件可重新载入并恢复规则与版本', () => {
  const sample = generateSample('sampleA');
  const rulesByWindow = {
    W1: { ...DEFAULT_RULES, nullStrategy: 'forward' },
    W2: { ...DEFAULT_RULES, spikeStrategy: 'none' }
  };
  const pipeline = cleanSeries(sample, rulesByWindow.W1);
  const project = buildProject({
    sampleId: sample.sampleId,
    rulesByWindow,
    windowId: 'W1',
    samples: { sampleA: sample },
    dataVersion: buildDataVersion(sample.sampleId, pipeline.rules, pipeline.cleanedRows),
    rawRows: sample.rows,
    pipeline,
    cleanedRows: pipeline.cleanedRows,
    windowRows: pipeline.cleanedRows,
    windowEvaluation: evaluateWindow(pipeline.cleanedRows, pipeline.cleanedRows, sample.seriesIds)
  });
  const roundTrip = JSON.parse(JSON.stringify(project));
  assert.equal(roundTrip.format, 'ts-cleaning-monitor/project');
  assert.deepEqual(roundTrip.rulesByWindow, rulesByWindow);
  const reloadedPipeline = cleanSeries(roundTrip.samples.sampleA, roundTrip.rulesByWindow.W1);
  const reloadedVersion = buildDataVersion(
    roundTrip.sampleId,
    reloadedPipeline.rules,
    reloadedPipeline.cleanedRows
  );
  assert.equal(reloadedVersion, project.dataVersion);
});

test('工程哈希不受字段顺序影响，保证版本口径稳定', () => {
  const a = { x: 1, y: [2, 3], z: { k: 'v' } };
  const b = { z: { k: 'v' }, y: [2, 3], x: 1 };
  assert.equal(hashPayload(a), hashPayload(b));
});

test('页面引用的全部模块文件存在', () => {
  for (const file of ['index.html', 'src/app.js', 'src/chart.js', 'src/state.js', 'src/styles.css']) {
    assert.ok(readFileSync(new URL('../' + file, import.meta.url)).length > 0);
  }
});

console.log(`\n${passed} 项 Node 验证全部通过`);
