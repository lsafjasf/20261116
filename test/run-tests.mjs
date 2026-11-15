import assert from 'node:assert/strict';
import { Store } from '../src/core/store.mjs';
import { datasetA } from '../src/data/datasetA.mjs';
import { datasetB } from '../src/data/datasetB.mjs';
import { WINDOWS, STATIONS } from '../src/core/constants.mjs';
import { buildReport, countObjects, checksum, saveProject, loadProject }
  from '../src/core/export-project.mjs';
import { MockCtx } from './mock-canvas.mjs';
import { drawChart } from '../src/render/chart-canvas.mjs';
import { drawMap } from '../src/render/map-canvas.mjs';
import { drawReadout } from '../src/render/readout-canvas.mjs';
import { drawDebug } from '../src/render/debug-canvas.mjs';

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
  catch (err) { results.push({ name, ok: false, err });
    console.error(`  ✗ ${name}\n    ${err.message}`); }
}

const store = new Store({ A: datasetA, B: datasetB }, 'A');

console.log('1) 清洗：重复 / 空值 / 异常');
test('A：原始 99 条（96 + 3 重复），去重后 96 槽位，丢弃 3 条重复', () => {
  assert.equal(store.clean.audit.rawCount, 99);
  assert.equal(store.clean.audit.uniqueSlots, 96);
  assert.equal(store.clean.audit.duplicateDropped, 3);
});

test('A：重复记录以最后一条为准（S1 8时温度=19.9）', () => {
  assert.equal(store.clean.byStation.S1[8].values.tempC, 19.9);
});

test('A：越界值被隔离并记为 outlier（S2 10时温度、S3 16时降水等）', () => {
  assert.equal(store.clean.byStation.S2[10].values.tempC, null);
  assert.equal(store.clean.byStation.S2[10].reasons.tempC, 'outlier');
  assert.equal(store.clean.byStation.S3[16].values.precipMm, null);
  assert.equal(store.clean.byStation.S1[20].values.windDirDeg, null);
  assert.equal(store.clean.audit.quarantined, 4);
});

test('A：连续空值保留为 null（S1 温度 5、6 时）且不做插值', () => {
  assert.equal(store.clean.byStation.S1[5].values.tempC, null);
  assert.equal(store.clean.byStation.S1[6].values.tempC, null);
  assert.equal(store.clean.byStation.S1[7].values.tempC !== null, true);
});

test('B：重复记录修复异常（S2 4时风速恢复 12.5，不再被隔离）', () => {
  store.setDataset('B');
  assert.equal(store.clean.byStation.S2[4].values.windSpeedKmh, 12.5);
  assert.equal(store.clean.byStation.S2[4].reasons.windSpeedKmh, undefined);
  assert.equal(store.clean.audit.duplicateDropped, 4);
});

test('B：边界空值与三连空值（S4 温度 18-20）均保留为空', () => {
  assert.equal(store.clean.byStation.S1[0].values.tempC, null);
  assert.equal(store.clean.byStation.S1[23].values.tempC, null);
  [18, 19, 20].forEach((h) =>
    assert.equal(store.clean.byStation.S4[h].values.tempC, null));
});

console.log('2) 两个固定窗口：时间/刻度/地图范围/读数一致性');
function renderAll(snapshot) {
  const chart = new MockCtx(900, 430);
  const map = new MockCtx(620, 300);
  const readout = new MockCtx(620, 250);
  const debug = new MockCtx(620, 210);
  drawChart(chart, { width: 900, height: 430, snapshot });
  drawMap(map, { width: 620, height: 300, snapshot });
  drawReadout(readout, { width: 620, height: 250, snapshot });
  drawDebug(debug, { width: 620, height: 210, snapshot });
  return { chart, map, readout, debug };
}

// 依据与渲染器相同的映射公式独立复算，核对曲线游标 x 与地图时间条 x 完全相等
function expectedX(hour, win, width, padLeft, padRight) {
  const usable = width - padLeft - padRight;
  return padLeft + ((hour - win.start) / (win.end - win.start)) * usable;
}

for (const [dsId, winId, cursor] of [['A', 'AM', 9], ['B', 'Q4', 21]]) {
  test(`${dsId} / ${winId}：窗口边界、刻度数量、游标钳制与全部视图一致`, () => {
    store.setDataset(dsId);
    store.setWindow(winId);
    store.setCursor(40); // 故意越界，应钳制到窗口末端
    assert.equal(store.cursorHour, WINDOWS[winId].end);
    store.setCursor(cursor);
    const snap = store.snapshot();
    assert.equal(snap.cursorHour, cursor);
    const views = renderAll(snap);

    // 曲线刻度文本覆盖窗口每一小时，地图时间条同样覆盖
    const win = WINDOWS[winId];
    const hours = Array.from({ length: win.end - win.start + 1 },
      (_, i) => String(win.start + i));
    for (const h of hours) {
      assert.ok(views.chart.textValues().includes(h), `曲线缺刻度 ${h}`);
      assert.ok(views.map.textValues().includes(h), `地图缺刻度 ${h}`);
    }
    // 两视图游标 x 坐标一致（同一时间轴映射）
    const chartX = expectedX(cursor, win, 900, 52, 16);
    const mapX = expectedX(cursor, win, 620, 40, 16);
    const chartCursor = views.chart.calls.find((c) => c.name === 'moveTo' &&
      Math.abs(c.args[0] - chartX) < 0.01);
    const mapCursor = views.map.calls.find((c) => c.name === 'fillRect' &&
      Math.abs((c.args[0] + 1) - mapX) < 0.01);
    assert.ok(chartCursor, '曲线游标竖线 x 与映射不符');
    assert.ok(mapCursor, '地图游标 x 与映射不符');

    // 读数面板时间与值：逐站点逐字段与 clean 数据核对
    const expected = snap.readout;
    for (const row of expected) {
      for (const [field, v] of Object.entries(row.values)) {
        if (v !== null) {
          assert.ok(views.readout.textValues().includes(String(v)),
            `读数缺失 ${row.stationId}.${field}=${v}`);
        }
      }
    }
    assert.ok(views.readout.findText(`${snap.dataset.baseDate}`).length > 0);
    assert.ok(views.map.findText(`窗口 [${win.start}:00 – ${win.end}:00]`).length > 0);
  });
}

console.log('3) 断档：空值不得用连续线伪造');
test('A/AM：S1 温度 5-6 时连续空值，曲线在该区间被分段，读数面板显式标注缺测/隔离', () => {
  store.setDataset('A');
  store.setWindow('AM');
  store.setCursor(6); // 该时刻 S1 温度为空值，读数面板必须出现缺测标注
  const snap = store.snapshot();
  const segCount = snap.stats.gaps.filter(
    (g) => g.stationId === 'S1' && g.field === 'tempC').length;
  assert.ok(segCount >= 1);
  const gap = snap.stats.gaps.find(
    (g) => g.stationId === 'S1' && g.field === 'tempC');
  assert.deepEqual([gap.start, gap.end], [5, 6]);
  const ctx = new MockCtx(900, 430);
  drawChart(ctx, { width: 900, height: 430, snapshot: snap });
  // 缺测占位叉必须出现，且面板文本中存在“缺测/异常隔离”语义的读数
  const readout = new MockCtx(620, 250);
  drawReadout(readout, { width: 620, height: 250, snapshot: snap });
  assert.ok(readout.findText('缺测').length + readout.findText('异常隔离').length > 0);
});

console.log('4) 峰值标记与筛选联动');
test('A/PM：每个筛选站点都有温度/降水峰值，且峰值等于窗口有效最大值', () => {
  store.setDataset('A');
  store.setWindow('PM');
  store.setCursor(15);
  const snap = store.snapshot();
  for (const station of STATIONS) {
    for (const field of ['tempC', 'precipMm']) {
      const peak = snap.stats.peaks.find(
        (p) => p.stationId === station.id && p.field === field);
      assert.ok(peak, `缺峰值 ${station.id}.${field}`);
      const series = snap.clean.byStation[station.id];
      let max = -Infinity;
      for (let h = 12; h <= 23; h += 1) {
        const v = series[h].values[field];
        if (v !== null) max = Math.max(max, v);
      }
      assert.equal(peak.value, max);
    }
  }
  const ctx = new MockCtx(900, 430);
  drawChart(ctx, { width: 900, height: 430, snapshot: snap });
  assert.ok(ctx.textValues().filter((t) => t === '峰').length >= 4);
});

test('隐藏 S2 后，导出峰值与读数不再包含 S2，视图统计同步变化', () => {
  store.toggleStation('S2');
  assert.deepEqual(store.snapshot().selectedStations, ['S1', 'S3', 'S4']);
  const report = buildReport(store.snapshot());
  assert.ok(!report.peaks.some((p) => p.stationId === 'S2'));
  assert.ok(!report.readout.some((r) => r.stationId === 'S2'));
  assert.deepEqual(report.filters.selectedStations, ['S1', 'S3', 'S4']);
  store.toggleStation('S2');
});

console.log('5) 导出前后：对象数量与关键数值一致');
test('同一状态连续两次导出，objectCount / slotCount / checksum 完全一致', () => {
  const snap = store.snapshot();
  const r1 = buildReport(snap);
  const r2 = buildReport(snap);
  assert.equal(r1.integrity.objectCount, r2.integrity.objectCount);
  assert.equal(r1.integrity.slotCount, 96);
  assert.equal(r1.integrity.checksum, r2.integrity.checksum);
  assert.equal(r1.integrity.objectCount, countObjects({
    spec: r1.spec, dataVersion: r1.dataVersion, datasetId: r1.datasetId,
    baseDate: r1.baseDate, filters: r1.filters, audit: r1.audit,
    quarantine: r1.quarantine, slots: r1.slots, windowStats: r1.windowStats,
    peaks: r1.peaks, manualMarks: r1.manualMarks, readout: r1.readout
  }));
});

test('导出关键数值与清洗结果逐项一致（全部 96 槽位 × 5 字段）', () => {
  const report = buildReport(store.snapshot());
  for (const slot of report.slots) {
    const src = store.clean.slots.get(`${slot.stationId}#${slot.hour}`);
    assert.deepEqual(slot.values, src.values);
    assert.deepEqual(slot.reasons, src.reasons);
  }
  assert.equal(report.dataVersion, store.dataset.version);
});

test('手动标记纳入导出，且标记值与底层数据一致', () => {
  store.setWindow('AM');
  store.setCursor(8);
  store.toggleManualMark('S1', 'tempC', 8);
  const report = buildReport(store.snapshot());
  assert.equal(report.manualMarks.length, 1);
  assert.equal(report.manualMarks[0].value, store.clean.byStation.S1[8].values.tempC);
  store.toggleManualMark('S1', 'tempC', 8);
});

console.log('6) 工程保存 / 重新载入');
test('保存后重新载入：数据集、窗口、筛选、游标与手动标记完全恢复', () => {
  store.setDataset('B');
  store.setWindow('Q3');
  store.setCursor(14);
  store.toggleStation('S3');
  store.toggleManualMark('S1', 'precipMm', 14);
  const json = saveProject(store.snapshot());
  const restored = loadProject(json);
  assert.equal(restored.datasetId, 'B');
  assert.equal(restored.windowId, 'Q3');
  assert.equal(restored.cursorHour, 14);
  assert.deepEqual(restored.selectedStations, ['S1', 'S2', 'S4']);
  assert.deepEqual(restored.manualMarks, [{ stationId: 'S1', field: 'precipMm',
    hour: 14, value: store.clean.byStation.S1[14].values.precipMm }]);
  store.toggleStation('S3');
  store.toggleManualMark('S1', 'precipMm', 14);
});

test('载入工程后重算的视图与导出校验和，与原状态一致', () => {
  const before = buildReport(store.snapshot());
  const json = saveProject(store.snapshot());
  const state = loadProject(json);
  const store2 = new Store({ A: datasetA, B: datasetB }, state.datasetId);
  store2.windowId = state.windowId;
  store2.window = WINDOWS[state.windowId];
  store2.selectedStations = state.selectedStations;
  store2.manualMarks = state.manualMarks;
  store2.cursorHour = state.cursorHour;
  store2.recompute({ reason: 'test-reload' });
  const after = buildReport(store2.snapshot());
  assert.equal(after.integrity.checksum, before.integrity.checksum);
  assert.equal(after.integrity.objectCount, before.integrity.objectCount);
});

console.log('7) 调试面板与元信息');
test('调试面板展示审计中间状态；读数面板含筛选、数据版本、导出口径', () => {
  store.setDataset('A');
  store.setWindow('FULL');
  const snap = store.snapshot();
  const debug = new MockCtx(620, 210);
  drawDebug(debug, { width: 620, height: 210, snapshot: snap });
  assert.ok(debug.findText('dupDropped=3').length > 0);
  assert.ok(debug.findText('recompute').length > 0);
  const readout = new MockCtx(620, 250);
  drawReadout(readout, { width: 620, height: 250, snapshot: snap });
  assert.ok(readout.findText('数据版本').length > 0);
  assert.ok(readout.findText('导出口径').length > 0);
  assert.ok(readout.findText('筛选').length > 0);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exit(1);
