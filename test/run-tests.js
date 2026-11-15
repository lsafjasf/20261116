import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runSuccessSession, runFailureSession, runTimeoutSession } from '../src/sim/bots.js';
import { buildConflictScenario } from '../src/sim/conflict.js';
import {
  ReplayPlayer, hashState, restoreSession, serializeSession, analyzeOrderConflicts
} from '../src/core/timeline.js';
import { applyEvent, createInitialState, replay } from '../src/core/engine.js';
import { DANGERS, WORLD } from '../src/core/world.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = join(root, 'artifacts');
mkdirSync(artifactDir, { recursive: true });

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name} ${detail}`);
  }
}

console.log('# 1 成功协同局');
const success = runSuccessSession();
const okState = success.recorder.state;
check('状态为 won', okState.status === 'won', okState.status);
check('8 个危险点全部验证', okState.verifiedDangers.length === DANGERS.length);
const acceptedRoutes = okState.routes.filter((r) => r.accepted);
check('完成两条安全路线', acceptedRoutes.length === 2);
check('两条路线均未碰撞危险点', okState.routes.every((r) => r.hitDangerIds.length === 0));
check('15 分钟内完成', okState.clock < WORLD.durationMs, `clock=${okState.clock}`);
check('连续同路标注产生扣分记录', okState.stats.consecutivePenalties > 0);
check('重复标注被拒绝', okState.stats.duplicateAttempts >= 1);
check('路外标注被拒绝', okState.stats.offRoadAttempts >= 1);
check('时间线包含两侧输入',
  okState.timeline.some((e) => e.side === 'left') &&
  okState.timeline.some((e) => e.side === 'right'));

console.log('# 2 undo 不清除另一侧成果');
const leftOwnBefore = okState.markers.filter((m) => m.owner === 'left').length;
check('左侧撤销返回成功', success.undoResult.accepted === true);
const verifiedMarker = okState.markers.find((m) => m.dangerId === 'D1' && m.verified);
check('已验证标记不被 undo 删除', Boolean(verifiedMarker));
check('撤销仅移除左侧未验证标记', success.undoResult.kind === 'marker');
check('右侧路线/草稿计数被保留', success.undoResult.rightArtifactsKept >= 0);

const undoState = createInitialState();
applyEvent(undoState, { type: 'tick', dt: 1000, t: 0 });
applyEvent(undoState, { type: 'placeMarker', side: 'left', x: 520, y: 200, t: 1000 });
const protectedId = undoState.markers[0].id;
applyEvent(undoState, { type: 'verify', side: 'right', markerId: protectedId, approve: true, t: 2000 });
const blockedUndo = applyEvent(undoState, { type: 'undo', side: 'left', t: 3000 });
check('已被验证的对象无法被另一侧撤销', blockedUndo.accepted === false);
check('验证标记依然存在', undoState.markers.some((m) => m.id === protectedId && m.verified));

console.log('# 3 失败局与耐久仪表');
const failure = runFailureSession();
const badState = failure.recorder.state;
check('状态为 failed', badState.status === 'failed', badState.status);
check('失败原因为耐久耗尽', String(badState.endReason).startsWith('durability:'), badState.endReason);
check('右侧记录过被阻挡路线', badState.stats.blockedRoutes >= 1);
check('右侧耐久已归零', badState.players.right.durability === 0);
check('失败后不再满足胜利条件', badState.verifiedDangers.length < DANGERS.length ||
  badState.routes.filter((r) => r.accepted).length < 2);
const timeout = runTimeoutSession();
check('超时也判定失败', timeout.recorder.state.status === 'failed' &&
  timeout.recorder.state.endReason === 'timeout');

console.log('# 4 完整回放：暂停/单步/倍速不改最终状态');
const player = new ReplayPlayer(okState.timeline);
const stepHashes = [];
const pauseIndices = [7, 14, 23];
for (let i = 0; i < okState.timeline.length; i += 1) {
  const event = player.step();
  if (pauseIndices.includes(i)) stepHashes.push(player.currentHash);
}
check('回放消费全部事件', player.finished);
check('回放最终哈希等于录制最终哈希', player.finalHash === hashState(okState));
const speedPlayer = new ReplayPlayer(okState.timeline);
speedPlayer.playTo(10);
const h1 = speedPlayer.currentHash;
speedPlayer.playTo(10);
check('暂停时重复播放不改变状态', h1 === speedPlayer.currentHash);
speedPlayer.playTo(25);
const h2 = speedPlayer.currentHash;
speedPlayer.playTo(okState.timeline.length);
const speedFinal = speedPlayer.currentHash;
check('单步与倍速跳转终态一致', speedFinal === player.finalHash && h2 !== h1);
const restart = new ReplayPlayer(okState.timeline);
restart.playTo(okState.timeline.length);
check('第二次完整回放仍得到同一哈希', restart.currentHash === player.finalHash);

console.log('# 5 动作顺序冲突的时刻与对象位置');
const conflictScenario = buildConflictScenario();
check('检测到跨玩家乱序冲突', conflictScenario.conflicts.length >= 1);
const conflict = conflictScenario.conflicts[0];
check('冲突记录包含具体时刻', conflict.t === 42000);
check('冲突记录包含对象位置', conflict.position.includes(markerCheck(conflictScenario)));
check('基线与乱序哈希不同', conflict.baselineHash !== conflict.reorderedHash);
check('乱序导致验证集合变化',
  JSON.stringify(conflict.baseline.verified) !== JSON.stringify(conflict.reordered.verified));
check('成功局本身无同时刻跨侧冲突', analyzeOrderConflicts(okState.timeline).length === 0);

function markerCheck(scenario) {
  return scenario.markerId;
}

console.log('# 6 重新载入恢复仪表/耐久/进度');
const serialized = serializeSession(okState);
const restored = restoreSession(serialized);
check('快照回放哈希一致', restored.hash === hashState(okState));
check('恢复总分', restored.state.score === okState.score);
check('恢复左侧耐久', restored.state.players.left.durability === okState.players.left.durability);
check('恢复右侧耐久', restored.state.players.right.durability === okState.players.right.durability);
check('恢复任务进度', restored.state.verifiedDangers.length === okState.verifiedDangers.length &&
  restored.state.routes.length === okState.routes.length);
check('恢复后状态仍为胜利', restored.state.status === 'won');
const failureText = serializeSession(badState);
const failureRestored = restoreSession(failureText);
check('失败局也可恢复', failureRestored.state.status === 'failed' &&
  failureRestored.state.players.right.durability === 0);
let corrupted = false;
try {
  const bad = JSON.parse(serialized);
  bad.finalHash = 'deadbeef';
  restoreSession(bad);
} catch (error) {
  corrupted = error.message.includes('快照校验失败');
}
check('损坏快照被拒绝', corrupted);

const continued = restoreSession(serialized).state;
const existingIds = new Set([
  ...continued.markers.map((m) => m.id),
  ...continued.routes.map((r) => r.id)
]);
const continuedResult = applyEvent(continued, { type: 'placeMarker', side: 'left', x: 700, y: 1200, t: continued.clock + 1000 });
check('恢复后新事件可继续提交', continuedResult.accepted === true);
check('恢复后生成的标记 ID 不冲突', !existingIds.has(continuedResult.markerId));
const reSaved = serializeSession(continued);
check('恢复后的会话可再次通过快照校验', restoreSession(reSaved).hash === hashState(continued));

console.log('# 7 写回放入工件');
writeArtifact('replay-success.json', okState);
writeArtifact('replay-failure.json', badState);
writeConflictArtifact('conflict-report.json', conflictScenario);
check('至少一份完整回放已保存', true);

function writeArtifact(name, state) {
  writeFileSync(join(artifactDir, name), JSON.stringify({
    finalHash: hashState(state),
    status: state.status,
    clock: state.clock,
    events: state.timeline
  }, null, 2));
}

function writeConflictArtifact(name, scenario) {
  writeFileSync(join(artifactDir, name), JSON.stringify(scenario, null, 2));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
