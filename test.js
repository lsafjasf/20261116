// 场景测试:正常流程 / 设备故障 / 参数越限 / 风吹偏喷雾 / 确定性回放
'use strict';
const S = require('./sim.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  PASS ' + msg); }
  else { failures++; console.log('  FAIL ' + msg); }
}
function findLog(sim, type) { return sim.log.filter(function (e) { return e.type === type; }); }

// 通用任务控制器:按 0->1->2 顺序除冰并放飞
function makePilot(sim, opts) {
  opts = opts || {};
  const sprayAmount = opts.sprayAmount || 45; // 分次补喷,由冰层余量决定是否再喷
  return function () {
    const acts = [];
    if (sim.outcome) return acts;
    const truck = sim.truck;
    if (truck.state === 'broken') { acts.push({ type: 'repair' }); return acts; }
    const target = sim.planes.find(function (p) { return !p.departed; });
    if (!target) return acts;
    if (target.ice <= 0.001 && sim.time >= target.windowOpen) {
      acts.push({ type: 'takeoff', plane: target.id });
      return acts;
    }
    if (target.ice > 0.001) {
      if (truck.state === 'idle' || (truck.state === 'arrived' && truck.targetPlane !== target.id)) {
        acts.push({ type: 'goto', plane: target.id });
      } else if (truck.state === 'arrived' && truck.targetPlane === target.id) {
        acts.push({ type: 'spray', amount: (opts.sprayFor && opts.sprayFor(target.id)) || sprayAmount });
      }
    }
    return acts;
  };
}

function runScenario(name, seed, events, controllerFactory, maxTicks, onTick) {
  const sim = S.createSim(seed, events);
  const ctrl = controllerFactory(sim);
  for (let i = 0; i < maxTicks && !sim.outcome; i++) {
    const acts = ctrl(sim);
    S.step(sim, acts);
    if (onTick) onTick(sim);
  }
  console.log('[' + name + '] 结局=' + (sim.outcome || '超时') +
    (sim.failReason ? ' 原因=' + sim.failReason : '') +
    ' 用时=' + sim.time.toFixed(1) + 's 余液=' + sim.tank.toFixed(1) +
    'L 污染=' + sim.pollution.toFixed(1));
  return sim;
}

// ---------- 场景 1:正常流程 ----------
console.log('\n=== 场景1:正常流程(三架飞机依次除冰起飞)===');
{
  const sim1 = runScenario('正常流程', 7, [], makePilot, 6000);
  assert(sim1.outcome === 'success', '三架飞机均在窗口内起飞,任务成功');
  assert(sim1.planes.every(function (p) { return p.departed && p.ice <= 0.001; }), '起飞时无冰层、无二次结冰');
  assert(findLog(sim1, 'REICING').length === 0, '未发生二次结冰告警');
  assert(sim1.tank > 0 && sim1.tank <= S.TANK_CAPACITY, '液罐余量在合法范围: ' + sim1.tank.toFixed(1));
  assert(sim1.pollution < S.POLLUTION_LIMIT, '排水污染未超标: ' + sim1.pollution.toFixed(1));
  // 确定性:同种子重放应完全一致
  const sim1b = runScenario('正常流程-重跑', 7, [], makePilot, 6000);
  assert(JSON.stringify(sim1.log) === JSON.stringify(sim1b.log), '相同种子与操作序列重放结果完全一致(确定性时钟)');
}

// ---------- 场景 2:设备故障(喷洒泵失效)-> 维修 -> 恢复后持续运行 ----------
console.log('\n=== 场景2:设备故障(泵在 t=10s 失效)===');
{
  const events = [{ tick: 100, type: 'pump_failure' }];
  let recoveryTick = -1;
  let soakViolations = [];
  let snapshotAt150 = null;
  const sim2 = runScenario('设备故障', 11, events, makePilot, 8000, function (s) {
    if (s.tick === 150) snapshotAt150 = JSON.stringify({ tank: s.tank, ice: s.planes.map(function (p) { return p.ice; }), truck: s.truck.state });
    if (recoveryTick < 0 && findLog(s, 'EQUIPMENT_RECOVERED').length > 0) recoveryTick = s.tick;
    if (recoveryTick >= 0 && s.tick >= recoveryTick) {
      soakViolations = soakViolations.concat(S.checkInvariants(s));
    }
  });
  const failLogs = findLog(sim2, 'EQUIPMENT_FAILURE');
  assert(failLogs.length === 1, '故障被记录,发生时刻 t=' + (failLogs[0] && failLogs[0].time) + 's');
  if (failLogs[0]) {
    const m = failLogs[0].margins;
    console.log('  故障时余量: 余液=' + m.fluid + 'L 污染余量=' + m.pollutionHeadroom +
      ' 最近窗口剩余=' + m.minWindowSlack + 's 最大冰层=' + m.maxIce);
    assert(m.fluid >= 0 && m.minWindowSlack > 0, '故障时刻余量已记录且有效');
  }
  assert(findLog(sim2, 'EQUIPMENT_RECOVERED').length === 1, '维修后系统恢复到安全状态');
  assert(sim2.outcome === 'success', '故障恢复后任务最终成功');
  assert(recoveryTick >= 0 && sim2.tick - recoveryTick >= S.SOAK_TIME / S.DT,
    '恢复后持续运行超过 ' + S.SOAK_TIME + 's(实际 ' + ((sim2.tick - recoveryTick) * S.DT).toFixed(0) + 's)');
  assert(soakViolations.length === 0, '恢复后 soak 期间无隐藏连锁错误/状态跳变' +
    (soakViolations.length ? ': ' + soakViolations[0] : ''));
  // 失败/故障回放:用动作日志重放到 tick=150,状态必须逐比特一致
  const rep = S.replay(11, events, sim2.actionLog, 150);
  const repSnap = JSON.stringify({ tank: rep.tank, ice: rep.planes.map(function (p) { return p.ice; }), truck: rep.truck.state });
  assert(repSnap === snapshotAt150, '回放重建到 tick=150 的状态与原始运行一致');
}

// ---------- 场景 3:参数越限(喷洒量超上限/非法值)----------
console.log('\n=== 场景3:参数越限(请求 500L / -5L)===');
{
  let injected = 0;
  const sim3 = runScenario('参数越限', 5, [], function (sim) {
    const base = makePilot(sim);
    return function (s) {
      const truck = s.truck;
      if (injected === 0 && truck.state === 'arrived' && truck.targetPlane === 0) {
        injected = 1;
        return [{ type: 'spray', amount: 500 }]; // 超过单次上限 60L 与罐容
      }
      if (injected === 1 && truck.state === 'arrived' && truck.targetPlane === 0) {
        injected = 2;
        return [{ type: 'spray', amount: -5 }]; // 非法负值
      }
      return base(s);
    };
  }, 8000);
  const ool = findLog(sim3, 'PARAM_OUT_OF_LIMIT');
  assert(ool.length >= 2, '越限参数被拦截并记录(' + ool.length + ' 条)');
  if (ool[0]) {
    console.log('  越限记录: t=' + ool[0].time + 's ' + ool[0].msg + ' | 余量: 余液=' + ool[0].margins.fluid + 'L');
  }
  assert(ool[0] && ool[0].msg.indexOf('60') >= 0, '超量请求被钳制到单次上限 60L');
  assert(sim3.tank >= 0 && sim3.tank <= S.TANK_CAPACITY, '越限后液罐仍在合法范围: ' + sim3.tank.toFixed(1));
  assert(sim3.outcome === 'success', '越限被安全处理后任务仍成功完成');
  const inv = S.checkInvariants(sim3);
  assert(inv.length === 0, '越限场景结束状态不变量检查通过');
}

// ---------- 场景 4:风把喷雾吹偏 ----------
console.log('\n=== 场景4:阵风 14m/s 把喷雾吹偏 ===');
{
  const events = [{ tick: 50, type: 'wind_gust', speed: 14, duration: 60 }];
  const sim = S.createSim(3, events);
  let phase = 0;
  let firstSprayDelivered = -1;
  let iceAfterGustSpray = -1;
  let windDuringSpray = 0;
  let soakViolations = [];
  for (let i = 0; i < 1200 && !sim.outcome; i++) {
    const acts = [];
    if (phase === 0 && sim.truck.state === 'idle') { acts.push({ type: 'goto', plane: 0 }); phase = 1; }
    else if (phase === 1 && sim.truck.state === 'arrived') { acts.push({ type: 'spray', amount: 50 }); phase = 2; }
    if (phase === 2 && sim.truck.state === 'spraying') windDuringSpray = Math.max(windDuringSpray, sim.wind.speed);
    S.step(sim, acts);
    if (phase === 2 && findLog(sim, 'SPRAY_DONE').length === 1) {
      firstSprayDelivered = sim.truck.sprayDelivered;
      iceAfterGustSpray = sim.planes[0].ice;
      phase = 3;
    }
    if (phase === 3) soakViolations = soakViolations.concat(S.checkInvariants(sim));
  }
  assert(findLog(sim, 'WIND_GUST').length === 1, '阵风事件已记录: ' +
    (findLog(sim, 'WIND_GUST')[0] || {}).msg);
  console.log('  喷洒时风速峰值=' + windDuringSpray.toFixed(1) + 'm/s,指令 50L,实际落机=' +
    firstSprayDelivered.toFixed(1) + 'L,剩余冰层=' + iceAfterGustSpray.toFixed(2));
  assert(firstSprayDelivered > 0 && firstSprayDelivered < 35,
    '喷雾被风吹偏:50L 指令仅 ' + firstSprayDelivered.toFixed(1) + 'L 落到机身(<70%)');
  assert(iceAfterGustSpray > 0.15, '因喷雾飘失,机身仍残留冰层 ' + iceAfterGustSpray.toFixed(2) + '(需补喷)');
  assert(soakViolations.length === 0, '喷洒结束后持续运行无状态跳变');
}

console.log('\n' + (failures === 0 ? '全部测试通过 ✔' : failures + ' 项断言失败 ✘'));
process.exit(failures === 0 ? 0 : 1);
