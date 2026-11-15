/* Human-readable scenario walkthrough: success, wrong position, parameter
 * limit, restart reset, deterministic replay. Emits artifacts/scenario.md. */
'use strict';
const fs = require('fs');
const path = require('path');
const Engine = require('../src/engine');

const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

log('# 双耳声场机械诊断 — 场景演练报告');
log('生成时间: ' + new Date().toISOString());

const seed = 20261116;
log('\n## 固定 seed=' + seed + ' 的设备序列');
const probe = new Engine({ seed });
probe.devices.forEach((d) => log('- ' + d.name + ' 状态=' + Engine.STATE_LABEL[d.state] +
  ' 位置=(' + d.pos.x + ',' + d.pos.y + ') 节奏=' + d.rhythm.toFixed(2) + 'Hz'));

log('\n## 路线 A：成功结案');
const win = new Engine({ seed });
win.start();
for (let id = 0; id < win.devices.length; id++) {
  const d = win.devices[id];
  win.moveListener(d.pos.x, d.pos.y);
  for (let i = 0; i < 3; i++) win.tick();
  const m = win.metrics.detail[id];
  const r = win.submitDiagnosis(id, d.state);
  log('- ' + d.name + ' 在距离 ' + m.dist.toFixed(2) + '、清晰度 ' +
    (m.clarity * 100).toFixed(0) + '% 下提交「' + Engine.STATE_LABEL[d.state] +
    '」 => ' + (r.accepted ? '接受' : '拒绝') + '，已结案 ' + win.solvedCount + '/4');
}
log('- 终态: ' + win.fsm + '，误判 ' + win.mistakes + '，用时 ' + win.elapsedMs / 1000 + 's');
const winHash = win.stateHash();

log('\n## 路线 B：错误监听位置（在设备 1.5 单位外提交）');
const wrong = new Engine({ seed });
wrong.start();
const wd = wrong.devices[0];
wrong.moveListener(wd.pos.x, wd.pos.y - 1.5);
const wm = wrong.metrics.detail[0];
log('- 监听点 (' + wrong.listener.x + ',' + wrong.listener.y + ')，距 ' +
  wm.dist.toFixed(2) + '，甜区半径 ' + Engine.SWEET_RADIUS);
const wr = wrong.submitDiagnosis(0, wd.state);
log('- 提交正确答案仍被拒绝: ' + JSON.stringify(wr));
log('- 状态机转入 ' + wrong.fsm + '，剩余恢复 ' + wrong.recoveryLeft + ' tick；增益/滤波被重置为 ' +
  wrong.gain + ' / HPF' + wrong.filters.hpf + ' / LPF' + wrong.filters.lpf);
for (let i = 0; i < 30; i++) wrong.tick();
log('- 恢复倒计时结束后状态机: ' + wrong.fsm);
wrong.moveListener(wd.pos.x, wd.pos.y);
const wr2 = wrong.submitDiagnosis(0, wd.state);
log('- 移入甜区后重新提交 => ' + JSON.stringify(wr2));

log('\n## 路线 C：参数极限（增益 6.0 过载放大）');
const lim = new Engine({ seed });
lim.start();
lim.moveListener(lim.devices[0].pos.x, lim.devices[0].pos.y);
lim.setGain(Engine.GAIN_MAX);
const lm = lim.metrics.detail[0];
log('- 增益 ' + lim.gain + '，削波=' + lim.clipped + '，噪声底 ' +
  lim.metrics.noiseFloorDb.toFixed(1) + 'dB，清晰度从正常值跌到 ' + (lm.clarity * 100).toFixed(0) + '%');
const lr = lim.submitDiagnosis(0, lim.devices[0].state);
log('- 极限增益下提交 => ' + JSON.stringify(lr));
lim.setGain(Engine.GAIN_MIN);
log('- 回到最小增益 ' + lim.gain + ' 后清晰度恢复到 ' +
  (lim.metrics.detail[0].clarity * 100).toFixed(0) + '%');

log('\n## 路线 D：暂停、回放与重开复位');
const p = new Engine({ seed: 777 });
p.start();
for (let i = 0; i < 5; i++) p.tick();
p.pause();
for (let i = 0; i < 9; i++) p.tick();
log('- 暂停后 tick=' + p.tickIndex + ' 计时=' + p.elapsedMs + 'ms（冻结）');
p.resume();
p.moveListener(1.5, -1);
p.setGain(2.2);
const record = p.exportRecord();
const replayed = Engine.replay(record, null);
const liveHashBeforeRestart = p.stateHash();
log('- 同 seed 同输入回放哈希 ' + replayed.stateHash());
log('- 实时运行哈希     ' + liveHashBeforeRestart);
log('- 哈希一致: ' + (replayed.stateHash() === liveHashBeforeRestart));
p.restart();
log('- 重开后: tick=' + p.tickIndex + ' 计时=' + p.elapsedMs + 'ms 位置=(' +
  p.listener.x + ',' + p.listener.y + ') 增益=' + p.gain + ' fsm=' + p.fsm +
  ' 输入记录=' + p.records.length + ' 条 新 seed=' + p.seed);
log('- 新随机序列: ' + p.devices.map((d) => Engine.STATE_LABEL[d.state]).join('/'));

log('\n## 最终状态哈希');
log('- 成功路线: ' + winHash);
log('- 回放一致: ' + (replayed.stateHash() === liveHashBeforeRestart ? '是' : '否'));

fs.writeFileSync(path.join(__dirname, '..', 'artifacts', 'scenario.md'), lines.join('\n') + '\n');
console.log('\n写入 artifacts/scenario.md');
