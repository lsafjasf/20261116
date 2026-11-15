// 场景验证: 正常流程 / 设备故障 / 参数越限 / 错误堆存导致局部疏散 / 失败回放
// 运行: node test/scenarios.js
'use strict';
var S = require('../sim.js');

var failures = 0;
function check(name, cond, detail) {
  var ok = !!cond;
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name + (detail ? '  -- ' + detail : ''));
  if (!ok) failures++;
}
function showEvents(state, fromTick) {
  state.events.filter(function (e) { return e.tick >= (fromTick || 0); }).forEach(function (e) {
    console.log('    t=' + e.tick + ' [' + e.type + '] ' + e.msg +
      (e.margin !== undefined ? ' (余量 ' + e.margin + ')' : ''));
  });
}
// 等待吊机空闲; 若任务被环境中断则自动重试(模拟玩家等待吊装窗口)
function doLift(state, op, maxTicks) {
  var deadline = state.tick + (maxTicks || 200);
  while (state.tick < deadline && state.phase === 'running') {
    var r = S.applyOp(state, op);
    if (r.ok) {
      var before = state.events.length;
      while (state.crane.mode === 'busy' && state.phase === 'running') S.step(state);
      var aborted = state.events.slice(before).some(function (e) { return e.type === 'ABORT'; });
      if (!aborted) return true;
    } else {
      S.step(state);
    }
  }
  return false;
}
function soak(state, ticks, label) {
  var base = state.events.length;
  for (var i = 0; i < ticks; i++) S.step(state);
  var hidden = state.events.slice(base).filter(function (e) {
    return e.type === 'FAULT' || e.type === 'EVAC' || e.type === 'ABORT' || e.type === 'ALARM';
  });
  check(label + ': 恢复后持续运行 ' + ticks + ' tick 无隐藏连锁错误/状态跳变', hidden.length === 0,
    hidden.map(function (e) { return e.type + '@' + e.tick; }).join(',') || '干净');
}

// ---------- 场景 1: 正常流程 ----------
console.log('== 场景1: 正常流程(水幕与吊装窗口错开) ==');
(function () {
  var s = S.createSim(20261116);
  S.applyOp(s, { type: 'curtain', on: true, duration: 12 });   // 先开水幕演练
  S.run(s, 13);                                                 // 等水幕自动关闭
  check('水幕自动关闭, 吊装窗口恢复', !s.curtain.active);
  var ok1 = doLift(s, { type: 'load', container: 'C1' });
  var ok2 = doLift(s, { type: 'load', container: 'C2' });       // 重箱 32t
  var ok3 = doLift(s, { type: 'load', container: 'C3' });
  check('三只货柜均完成装船操作', ok1 && ok2 && ok3);
  S.run(s, 5);
  check('任务成功', s.phase === 'success', 'phase=' + s.phase + ' t=' + s.tick);
  check('时限内完成', s.tick <= S.TIME_LIMIT, '用时 ' + s.tick + '/' + S.TIME_LIMIT + ' tick');
  check('无隔离违规/疏散', !s.evacuation && !s.violation);
  showEvents(s);
  // 回放一致性
  var r = S.replay(s.seed, s.ops, s.tick);
  check('操作记录可完整回放(哈希一致)', S.hashState(r) === S.hashState(s),
    S.hashState(r) + ' vs ' + S.hashState(s));
})();

// ---------- 场景 2: 设备故障 + 恢复 + 持续运行 ----------
console.log('== 场景2: 吊机制动故障(重箱吊运中) ==');
(function () {
  var s = S.createSim(777);
  S.applyOp(s, { type: 'load', container: 'C2' });              // 32t 重箱起吊
  S.step(s); S.step(s);
  var t0 = s.tick;
  S.applyOp(s, { type: 'injectFault', fault: 'brake' });        // 注入制动故障
  S.run(s, 3);
  var faultEv = s.events.filter(function (e) { return e.type === 'FAULT' || e.type === 'ABORT'; });
  check('故障发生时刻已记录', faultEv.length > 0 && faultEv[0].tick >= t0,
    faultEv.length ? 't=' + faultEv[0].tick : '无');
  check('故障时稳定余量已记录', faultEv.length > 0 && faultEv[0].margin !== undefined,
    faultEv.length ? '余量=' + faultEv[0].margin + '%' : '无');
  check('系统响应: 任务中止且吊机进入故障态', s.crane.mode === 'fault' && !s.crane.task);
  check('故障期间吊装被禁止', s.crane.inhibited);
  var r1 = S.applyOp(s, { type: 'load', container: 'C1' });
  check('故障期间新吊装指令被拒绝', !r1.ok);
  showEvents(s, t0);
  S.applyOp(s, { type: 'repair' });
  check('修复后恢复安全状态', s.crane.mode === 'idle' && !s.crane.fault && !s.crane.inhibited);
  check('修复时刻已记录', s.events.some(function (e) { return e.type === 'RECOVER'; }));
  soak(s, 60, '场景2');
  var r = S.replay(s.seed, s.ops, s.tick);
  check('故障全程可回放(哈希一致)', S.hashState(r) === S.hashState(s));
})();
// ---------- 场景 3: 参数越限(风速超限 + 载荷裕量) ----------
console.log('== 场景3: 参数越限(强风下吊装被联锁) ==');
(function () {
  var s = S.createSim(999);
  S.applyOp(s, { type: 'forceWind', dirDeg: 90, speed: 20 });   // 越限: >15 m/s
  S.step(s);
  var margin = S.WIND_TRAVEL_LIMIT - s.wind.speed;
  check('越限参数已记录(风速 20 > 上限 15)', s.events.some(function (e) { return e.type === 'ENV'; }));
  check('当前余量 = ' + margin + ' m/s (负值即越限)', margin < 0);
  S.applyOp(s, { type: 'load', container: 'C2' });              // 尝试强风吊装
  S.run(s, 2);
  var abort = s.events.filter(function (e) { return e.type === 'ABORT'; });
  check('系统响应: 联锁中断吊装并安全落回', abort.length > 0 && s.crane.mode !== 'busy',
    abort.length ? abort[0].msg : '无');
  check('货柜未丢失, 回到原槽位', s.containers[1].loc.type === 'slot' && s.containers[1].loc.i === 3);
  showEvents(s);
  S.applyOp(s, { type: 'forceWind', dirDeg: 90, speed: 8 });    // 参数回到限值内
  S.step(s);
  check('恢复安全状态: 吊装联锁解除', !s.crane.inhibited);
  var ok = doLift(s, { type: 'load', container: 'C2' });
  check('恢复后重箱装船成功', ok && s.stats.loaded === 1);
  soak(s, 60, '场景3');
  var r = S.replay(s.seed, s.ops, s.tick);
  check('越限全程可回放(哈希一致)', S.hashState(r) === S.hashState(s));
})();

// ---------- 场景 4: 错误堆存导致局部疏散 ----------
console.log('== 场景4: 错误堆存 -> 隔离违规 -> 局部疏散 ==');
(function () {
  var s = S.createSim(555);
  // C2(等级2)在槽位3, 把 C1(等级1)堆到相邻槽位2: 距离1 < 要求2
  var ok = doLift(s, { type: 'move', container: 'C1', target: 2 });
  check('错误堆存操作被执行(C1->槽位2, 紧邻C2)', ok);
  var alarm = s.events.find(function (e) { return e.type === 'ALARM'; });
  check('隔离违规报警已触发并记录时刻', !!alarm, alarm ? 't=' + alarm.tick : '无');
  S.run(s, S.EVAC_GRACE + 2);                                   // 不纠正, 等待宽限耗尽
  var evac = s.events.find(function (e) { return e.type === 'EVAC'; });
  check('局部疏散已触发', !!evac, evac ? 't=' + evac.tick + ' ' + evac.msg : '无');
  check('任务判定失败', s.phase === 'failed', s.failReason || '');
  check('疏散区域已记录', !!s.evacuation && s.evacuation.zone.length > 0, s.evacuation ? s.evacuation.zone : '');
  showEvents(s);
  // 失败回放: 从种子+操作记录精确重现疏散时刻
  var r = S.replay(s.seed, s.ops);
  check('失败回放: 疏散时刻一致', r.evacuation && s.evacuation && r.evacuation.tick === s.evacuation.tick,
    '回放 t=' + (r.evacuation && r.evacuation.tick) + ' 原始 t=' + (s.evacuation && s.evacuation.tick));
  check('失败回放: 终态哈希一致', S.hashState(r) === S.hashState(s));
})();

// ---------- 场景 5: 泄漏顺风扩散 + 水幕抑制 ----------
console.log('== 场景5: 泄漏扩散与防火水幕 ==');
(function () {
  var s = S.createSim(31337);
  S.applyOp(s, { type: 'forceWind', dirDeg: 90, speed: 8 });    // 东风 -> 向 +x 扩散
  S.applyOp(s, { type: 'triggerLeak', container: 'C3' });       // C3 在槽位4(0,1)
  S.run(s, 4);
  check('泄漏危害区顺风扩散到相邻货区', s.plume.indexOf(5) >= 0, 'plume=' + s.plume.join(','));
  S.applyOp(s, { type: 'curtain', on: true, duration: 10 });
  S.run(s, 4);
  check('水幕开启后扩散停止', s.plume.indexOf(6) < 0, 'plume=' + s.plume.join(','));
  check('水幕期间吊装窗口关闭(错开)', s.crane.inhibited);
  S.run(s, 8);
  check('水幕关闭后吊装窗口恢复', !s.crane.inhibited);
  soak(s, 30, '场景5');
})();

console.log('');
console.log(failures === 0 ? '全部场景验证通过 ✔' : '存在 ' + failures + ' 项失败 �’');
process.exit(failures === 0 ? 0 : 1);
