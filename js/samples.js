/* 两份固定样例数据：确定性生成，覆盖空值、重复记录、负值与越界异常值。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.EnergySamples = factory(root.EnergyCore);
  }
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  // 每个指标在三个班次的基准值（kWh）。
  // 电力路径在每个班次严格满足：
  //   进线 = 终端三路输出之和 + 各设备常规损失；残差作为未测量损失自动配平。
  var METRICS = [
    { metric: 'supply:grid', device: 'grid', base: [340, 380, 260] },
    { metric: 'flow:transformer_mcc', device: 'transformer', base: [328, 366, 251] },
    { metric: 'flow:mcc_chiller', device: 'mcc', base: [150, 170, 110] },
    { metric: 'flow:mcc_pump', device: 'mcc', base: [70, 80, 55] },
    { metric: 'flow:mcc_hvac', device: 'mcc', base: [90, 100, 70] },
    { metric: 'flow:chiller_sink', device: 'chiller', base: [138, 156, 101] },
    { metric: 'flow:pump_sink', device: 'pump', base: [65, 74, 51] },
    { metric: 'flow:hvac_sink', device: 'hvac', base: [83, 93, 65] },
    { metric: 'supply:boiler', device: 'boiler', base: [210, 240, 160] },
    { metric: 'loss:transformer', device: 'transformer', base: [12, 14, 9] },
    { metric: 'loss:mcc', device: 'mcc', base: [6, 7, 5] },
    { metric: 'loss:boiler', device: 'boiler', base: [26, 30, 20] },
    { metric: 'loss:chiller', device: 'chiller', base: [10, 11, 7] },
    { metric: 'loss:pump', device: 'pump', base: [4, 5, 3] },
    { metric: 'loss:hvac', device: 'hvac', base: [5, 5, 3] }
  ];

  var SHIFT_HOUR = { morning: 8, swing: 16, night: 0 };
  var SHIFTS = ['morning', 'swing', 'night'];

  function rec(id, device, metric, shiftId, hour, day, value, minute) {
    var mm = minute == null ? 0 : minute;
    var ts = '2026-11-15T' + String(hour).padStart(2, '0') + ':'
      + String(mm).padStart(2, '0') + ':00+08:00';
    return { id: id, device: device, metric: metric, shift: shiftId, ts: ts,
      day: '2026-11-15', value: value };
  }

  function buildClean(idPrefix, scale) {
    var rows = [];
    var seq = 1;
    METRICS.forEach(function (m) {
      SHIFTS.forEach(function (shiftId, si) {
        rows.push(rec(idPrefix + '-r' + String(seq).padStart(3, '0'),
          m.device, m.metric, shiftId, SHIFT_HOUR[shiftId], 1,
          Math.round(m.base[si] * scale * 10) / 10,
          (seq * 7) % 55));
        seq++;
      });
    });
    return rows;
  }

  // 样例 A：一份空值、一条重复、一条越界异常（空调损失超合理上限）。
  function datasetA() {
    var rows = buildClean('A', 1);
    rows.push({
      id: 'A-null-01', device: 'pump', metric: 'loss:pump',
      shift: 'morning', ts: '2026-11-15T08:00:00+08:00',
      day: '2026-11-15', value: null
    });
    var dupSource = rows.filter(function (r) {
      return r.metric === 'supply:grid' && r.shift === 'morning';
    })[0];
    rows.push({
      id: 'A-dup-01', device: dupSource.device, metric: dupSource.metric,
      shift: dupSource.shift, ts: dupSource.ts, day: dupSource.day,
      value: dupSource.value
    });
    var conflictSource = rows.filter(function (r) {
      return r.metric === 'flow:mcc_hvac' && r.shift === 'morning';
    })[0];
    rows.push({
      id: 'A-conflict-01', device: conflictSource.device,
      metric: conflictSource.metric, shift: conflictSource.shift,
      ts: conflictSource.ts, day: conflictSource.day,
      value: conflictSource.value + 40
    });
    rows.push(rec('A-out-01', 'hvac', 'loss:hvac', 'morning', 8, 1, 96));
    return {
      id: 'sample-a',
      name: '样例 A · 常规工况（空值 / 完全重复 / 冲突重复 / 越界）',
      records: rows
    };
  }

  // 样例 B：更高负载 + 多类脏数据（空值、重复、负值、越界、源端异常）。
  function datasetB() {
    var rows = buildClean('B', 1.18);
    rows.push({
      id: 'B-null-01', device: 'chiller', metric: 'flow:chiller_sink',
      shift: 'swing', ts: '2026-11-15T16:00:00+08:00',
      day: '2026-11-15', value: undefined
    });
    rows.push({
      id: 'B-null-02', device: 'mcc', metric: 'loss:mcc',
      shift: 'night', ts: '2026-11-15T00:00:00+08:00',
      day: '2026-11-15', value: NaN
    });
    var dup = rows.filter(function (r) {
      return r.metric === 'flow:mcc_pump' && r.shift === 'night';
    })[0];
    rows.push({
      id: 'B-dup-01', device: dup.device, metric: dup.metric,
      shift: dup.shift, ts: dup.ts, day: dup.day, value: dup.value + 9
    });
    var exactDup = rows.filter(function (r) {
      return r.metric === 'flow:chiller_sink' && r.shift === 'morning';
    })[0];
    rows.push({
      id: 'B-dup-02', device: exactDup.device, metric: exactDup.metric,
      shift: exactDup.shift, ts: exactDup.ts, day: exactDup.day,
      value: exactDup.value
    });
    rows.push(rec('B-neg-01', 'pump', 'loss:pump', 'swing', 16, 1, -12));
    rows.push(rec('B-out-01', 'chiller', 'loss:chiller', 'swing', 16, 1, 150));
    rows.push(rec('B-out-02', 'grid', 'supply:grid', 'night', 0, 1, 1500));
    return {
      id: 'sample-b',
      name: '样例 B · 高负载脏数据（空值×2 / 完全重复 / 冲突重复 / 负值 / 越界×2）',
      records: rows
    };
  }

  return {
    METRICS: METRICS,
    all: function () { return [datasetA(), datasetB()]; },
    datasetA: datasetA,
    datasetB: datasetB
  };
});
