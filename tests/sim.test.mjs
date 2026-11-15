import test from "node:test";
import assert from "node:assert/strict";
import {
  DT,
  LIMITS,
  MISSION_SECONDS,
  PHASE,
  createSimulation,
  hashState,
  makeReplayRecord,
  restoreSnapshot,
  runReplay,
  setCommands,
  snapshotState,
  step,
} from "../src/sim.js";
import { runAutopilot } from "../src/autopilot.js";

const SUCCESS_SEED = "verify-success-01";
const MISTAKE_SEED = "verify-mistake-01";
const LIMIT_SEED = "verify-limit-01";

function completeSuccessRoute(seed = SUCCESS_SEED) {
  const state = createSimulation(seed);
  runAutopilot(state, MISSION_SECONDS * 60 + 10);
  return state;
}

test("成功路线：两次锁定并安全撤离，输入记录重放哈希一致", () => {
  const state = completeSuccessRoute();
  assert.equal(state.phase, PHASE.COMPLETE);
  assert.equal(state.latchCount, 2);
  assert.equal(state.resources.latchCharges, 0);
  assert.equal(state.failure, null);
  assert.ok(state.driftSerial > 0, "路线应经过 seeded 扰动序列");
  assert.ok(state.d >= LIMITS.safeRetreat);

  const record = makeReplayRecord(state);
  const serialized = JSON.stringify(record);
  const restoredRecord = JSON.parse(serialized);
  const replayed = runReplay(restoredRecord.seed, restoredRecord.inputLog, restoredRecord.endTick);
  assert.equal(hashState(replayed), hashState(state));
  assert.equal(hashState(replayed), record.finalHash);
});

test("操作失误：满推进过冲触发碰撞，失败轨迹可确定性重放", () => {
  const state = createSimulation(MISTAKE_SEED);
  let ticks = 0;
  while (state.phase !== PHASE.FAILED && ticks < 5000) {
    setCommands(state, { yaw: 0, pitch: 0, throttle: 1 });
    step(state);
    ticks += 1;
  }
  assert.equal(state.phase, PHASE.FAILED);
  assert.match(state.failure, /速度超过结构极限|过冲/);
  assert.ok(ticks < 1000);

  const record = makeReplayRecord(state);
  const replayed = runReplay(record.seed, record.inputLog, record.endTick);
  assert.equal(hashState(replayed), hashState(state));
});

test("参数极限：越界输入被钳制，物理速度不越上限并最终中止", () => {
  const state = createSimulation(LIMIT_SEED);
  setCommands(state, { yaw: 999, pitch: -999, throttle: 999 });
  assert.deepEqual(state.commands, { yaw: 1, pitch: -1, throttle: 1 });

  let ticks = 0;
  while (state.phase !== PHASE.FAILED && ticks < 6000) {
    step(state);
    ticks += 1;
    assert.ok(Math.abs(state.vx) <= LIMITS.maxLateralSpeed + 1e-12);
    assert.ok(Math.abs(state.vy) <= LIMITS.maxVerticalSpeed + 1e-12);
    assert.ok(Math.abs(state.vd) <= LIMITS.maxAxialSpeed + 1e-12);
  }
  assert.equal(state.phase, PHASE.FAILED);
  assert.match(state.failure, /安全走廊|过冲/);
  assert.ok(state.elapsed < MISSION_SECONDS);
});

test("重新开始：计时器、资源与 seed 随机序列全部复位", () => {
  const dirty = createSimulation("restart-proof");
  setCommands(dirty, { yaw: 1, pitch: -1, throttle: 1 });
  for (let index = 0; index < 400; index += 1) {
    setCommands(dirty, {
      yaw: Math.sin(index / 23),
      pitch: Math.cos(index / 31),
      throttle: Math.sin(index / 17),
    });
    step(dirty);
  }
  assert.ok(dirty.elapsed > 0);
  assert.ok(dirty.resources.propellant < 100);

  const restarted = createSimulation("restart-proof");
  assert.equal(restarted.tick, 0);
  assert.equal(restarted.elapsed, 0);
  assert.deepEqual(restarted.resources, {
    propellant: 100,
    power: 100,
    latchCharges: 2,
    hull: 100,
  });
  assert.equal(restarted.rngState, createSimulation("restart-proof").rngState);
  assert.deepEqual(restarted.portOffset, createSimulation("restart-proof").portOffset);
  assert.equal(restarted.nextDriftTick, createSimulation("restart-proof").nextDriftTick);
  assert.equal(restarted.driftSerial, 0);
  assert.equal(restarted.phase, PHASE.APPROACH);
  assert.equal(hashState(restarted), hashState(createSimulation("restart-proof")));
});

test("同 seed 的扰动序列可复现", () => {
  const first = createSimulation("sequence-proof");
  const second = createSimulation("sequence-proof");
  const events = [];
  for (let index = 0; index < 3600; index += 1) {
    step(first);
    step(second);
    if (first.lastChange?.tick === first.tick && first.lastChange?.tone === "drift") {
      events.push(snapshotState(first.lastDrift));
    }
    assert.equal(first.tick, second.tick);
    assert.equal(first.lastDrift?.serial, second.lastDrift?.serial);
  }
  assert.ok(events.length >= 6);
  assert.equal(hashState(first), hashState(second));
});

test("失败恢复：检查点快照恢复物理、资源与随机游标", () => {
  const checkpoint = createSimulation("recovery-proof");
  const checkpointSnapshot = snapshotState(checkpoint);
  let failed = checkpoint;
  while (failed.phase !== PHASE.FAILED) {
    setCommands(failed, { yaw: 0, pitch: 0, throttle: 1 });
    step(failed);
  }
  assert.ok(failed.failure);

  const restored = restoreSnapshot(checkpointSnapshot);
  assert.equal(restored.phase, PHASE.APPROACH);
  assert.equal(restored.tick, 0);
  assert.equal(restored.elapsed, 0);
  assert.deepEqual(restored.resources, checkpointSnapshot.resources);
  assert.equal(restored.rngState, checkpointSnapshot.rngState);
  assert.equal(restored.nextDriftTick, checkpointSnapshot.nextDriftTick);
  assert.equal(hashState(restored), hashState(checkpointSnapshot));
});

test("固定步长与计时器关系保持精确", () => {
  const state = createSimulation("clock-proof");
  for (let index = 0; index < 600; index += 1) {
    step(state);
  }
  assert.equal(state.tick, 600);
  assert.equal(state.elapsed, 600 * DT);
  assert.ok(Math.abs(state.elapsed - 10) < 1e-12);
});
