import test from "node:test";
import assert from "node:assert/strict";
import { Game, MODES, STATE, TICK_MS, replayRecord } from "../src/engine.js";

function started(seed = "PORT-640") {
  const game = new Game(seed);
  const result = game.start();
  assert.equal(result.ok, true);
  return game;
}

function rankOrder(game) {
  return game.state.cargos.slice().sort((left, right) => left.rank - right.rank);
}

function nextMode(index) {
  return ["standard", "saver", "standard", "escort"][index] ?? "standard";
}

function runSuccess(game) {
  const roles = [];
  for (let index = 0; index < 4; index += 1) {
    const cargo = rankOrder(game).find((item) => !item.loaded);
    roles.push(game.state.activeRole);
    game.tick(12 + index * 3);
    assert.equal(game.propose(cargo.id, nextMode(index)).ok, true);
    assert.equal(game.respond("accept").ok, true);
  }
  return roles;
}

test("成功路线：调度员与货主轮流完成四票货物并保持信用", () => {
  const game = started("PORT-640");
  const roles = runSuccess(game);

  assert.deepEqual(roles, ["dispatcher", "owner", "dispatcher", "owner"]);
  assert.equal(game.state.status, STATE.WON);
  assert.equal(game.state.loaded.length, 4);
  assert.equal(game.state.stats.loads, 4);
  assert.equal(game.state.stats.wrongOrder, 0);
  assert.ok(game.state.credit > 0);
  assert.deepEqual(
    game.state.loaded,
    rankOrder(game).map((cargo) => cargo.id),
  );

  const record = game.toRecord();
  const replayed = replayRecord(record);
  assert.equal(replayed.matches, true);
  assert.equal(replayed.finalHash, record.finalHash);
  assert.equal(replayed.game.state.status, STATE.WON);
  assert.deepEqual(replayed.game.state.stats, record.result.stats);
});

test("操作失误：错序扣信用，恢复检查点后装船与随机序列复位", () => {
  const game = started("MISTAKE-640");
  const initialForecast = game.state.randomForecast.slice();
  const initialRng = game.state.rngState;
  const initialCredit = game.state.credit;
  const wrongCargo = rankOrder(game).at(-1);

  game.tick(30);
  assert.equal(game.propose(wrongCargo.id, "standard").ok, true);
  assert.equal(game.respond("accept").ok, true);
  assert.equal(game.state.stats.wrongOrder, 1);
  assert.ok(game.state.credit <= initialCredit - 12);
  assert.equal(game.state.loaded.length, 1);
  assert.equal(game.checkpointInfo().loaded, 0);

  const failedHash = game.hash();
  const restored = game.restoreCheckpoint();
  assert.equal(restored.ok, true);
  assert.equal(game.state.loaded.length, 0);
  assert.equal(game.state.credit, initialCredit);
  assert.equal(game.state.tick, 0);
  assert.equal(game.state.rngState, initialRng);
  assert.deepEqual(game.state.randomForecast, initialForecast);
  assert.deepEqual(game.randomPreview(8), new Game("MISTAKE-640").randomPreview(8));
  assert.notEqual(game.hash(), failedHash);

  runSuccess(game);
  assert.equal(game.state.status, STATE.WON);
  const record = game.toRecord();
  assert.equal(record.inputs.some((input) => input.action === "restore"), true);
  assert.equal(replayRecord(record).matches, true);
});

test("超时后果：最后 1 tick 到达后扣 10 信用，延迟成本不被误触发", () => {
  const game = started("TIMEOUT-640");
  const cargo = rankOrder(game)[0];
  assert.equal(game.propose(cargo.id, "standard").ok, true);
  assert.equal(game.tick(MODES.standard.ticks - 1), true);
  assert.equal(game.state.status, STATE.RESPONDING);
  assert.equal(game.state.credit, 60);

  assert.equal(game.tick(1), true);
  assert.equal(game.state.status, STATE.REQUESTING);
  assert.equal(game.state.current, null);
  assert.equal(game.state.stats.timeouts, 1);
  assert.equal(game.state.credit, 50);
  assert.equal(game.state.lastChange.kind, "timeout");
  assert.equal(game.respond("accept").ok, false);
  assert.equal(game.state.stats.delays, 0);
});

test("暂停：冻结状态机时间、倒计时和超时，恢复后继续", () => {
  const game = started("PAUSE-640");
  const cargo = rankOrder(game)[0];
  game.propose(cargo.id, "escort");
  const tickAtPause = game.state.tick;
  assert.equal(game.setPaused(true), true);
  assert.equal(game.tick(10000), false);
  assert.equal(game.state.tick, tickAtPause);
  assert.equal(game.state.status, STATE.RESPONDING);
  assert.equal(game.respond("accept").ok, false);
  assert.equal(game.setPaused(false), true);
  assert.equal(game.tick(100), true);
  assert.equal(game.state.stats.timeouts, 1);
  const record = game.toRecord();
  assert.equal(record.inputs.filter((input) => input.action === "pause").length, 2);
  assert.equal(replayRecord(record).matches, true);
});

test("参数极限：最大 seed、非法 tick、超大步长与信用触底仍可复算", () => {
  const game = started("4294967295");
  assert.equal(game.tick(Number.NaN), false);
  assert.equal(game.tick(Number.POSITIVE_INFINITY), false);
  assert.equal(game.tick(-100), false);
  assert.equal(game.tick(0), false);
  assert.equal(game.state.tick, 0);

  const cargo = rankOrder(game)[0];
  let proposals = 0;
  while (game.state.status === STATE.REQUESTING && proposals < 12) {
    assert.equal(game.propose(cargo.id, "saver").ok, true);
    game.tick(Number.MAX_SAFE_INTEGER);
    proposals += 1;
  }
  assert.equal(game.state.status, STATE.LOST);
  assert.equal(game.state.stats.timeouts, 6);
  assert.equal(game.state.credit, 0);
  assert.ok(game.state.tick >= 100000);

  const record = game.toRecord();
  const replayed = replayRecord(record);
  assert.equal(replayed.matches, true);
  assert.equal(replayed.game.state.credit, 0);
  assert.equal(replayed.game.state.status, STATE.LOST);
});

test("重开复位：计时器、资源、货物、随机序列与检查点逐项归零", () => {
  const game = started("RESET-640");
  runSuccess(game);
  const fresh = started("RESET-640");
  const beforeRestart = {
    tick: game.state.tick,
    credit: game.state.credit,
    loaded: game.state.loaded.length,
  };
  assert.ok(beforeRestart.tick > 0);
  assert.equal(beforeRestart.loaded, 4);

  game.restart();
  assert.equal(game.state.tick, 0);
  assert.equal(game.state.credit, 60);
  assert.equal(game.state.negotiation, 14);
  assert.equal(game.state.loaded.length, 0);
  assert.equal(game.state.stats.loads, 0);
  assert.equal(game.state.inputs.length, 0);
  assert.equal(game.state.status, STATE.REQUESTING);
  assert.equal(game.hash(), fresh.hash());
  assert.deepEqual(game.state.randomForecast, fresh.state.randomForecast);
  assert.deepEqual(game.randomPreview(16), fresh.randomPreview(16));
  assert.deepEqual(game.checkpointInfo(), fresh.checkpointInfo());
});

test("确定性：同 seed 与相同输入逐步同哈希，不同 seed 产生不同序列", () => {
  const left = started("DETERMINISTIC-640");
  const right = started("DETERMINISTIC-640");
  for (let index = 0; index < 4; index += 1) {
    const cargo = rankOrder(left)[index];
    const other = rankOrder(right)[index];
    assert.equal(cargo.id, other.id);
    left.tick(7 + index);
    right.tick(7 + index);
    left.propose(cargo.id, "standard");
    right.propose(other.id, "standard");
    assert.equal(left.hash(), right.hash());
    left.respond("accept");
    right.respond("accept");
    assert.equal(left.hash(), right.hash());
  }
  assert.equal(left.state.status, STATE.WON);
  assert.equal(left.hash(), right.hash());

  const different = started("DETERMINISTIC-641");
  assert.deepEqual(different.randomPreview(8), [8, 2, 5, 7, 6, 2, 2, 2]);
  assert.notDeepEqual(different.state.randomForecast, left.state.randomForecast);
});

test("定时参数：10 Hz tick 与模式窗口一致", () => {
  assert.equal(TICK_MS, 100);
  assert.equal(MODES.escort.ticks * TICK_MS, 10000);
  assert.equal(MODES.standard.ticks * TICK_MS, 15000);
  assert.equal(MODES.saver.ticks * TICK_MS, 22000);
});
