/* End-to-end deterministic test runs (no browser): success route, wrong
 * listening position, parameter limits, pause/replay, restart reset,
 * and same-seed/same-input state hash equality. */
'use strict';
const fs = require('fs');
const path = require('path');
const Engine = require('../src/engine');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

function gotoDevice(engine, id, extraTicks) {
  const d = engine.devices[id];
  engine.moveListener(d.pos.x, d.pos.y);
  for (let i = 0; i < extraTicks; i++) engine.tick();
  return engine.metrics.detail[id];
}

function solveAll(engine) {
  for (let id = 0; id < engine.devices.length; id++) {
    const d = engine.devices[id];
    gotoDevice(engine, id, 3);
    const r = engine.submitDiagnosis(id, d.state);
    if (!r.accepted) throw new Error('success route blocked at D' + (id + 1) + ' ' + JSON.stringify(r));
  }
}

/* ---------- 1. Success route ---------- */
const seed = 20261116;
const success = new Engine({ seed });
success.start();
const winStart = { tick: success.tickIndex, time: success.elapsedMs };
solveAll(success);
check('success route closes the case as win', success.fsm === 'closed_win',
  'fsm=' + success.fsm + ' solved=' + success.solvedCount + ' mistakes=' + success.mistakes);
check('success route has zero mistakes', success.mistakes === 0);
check('all four devices marked solved', success.devices.every((d) => d.solved));
check('timer advanced during play', success.elapsedMs > winStart.time);

/* ---------- 2. Wrong listening position ---------- */
const wrong = new Engine({ seed });
wrong.start();
const target = wrong.devices[0];
wrong.moveListener(target.pos.x, target.pos.y - 1.5);
const wrongDetail = wrong.metrics.detail[0];
const beforeMistakes = wrong.mistakes;
const wrongResult = wrong.submitDiagnosis(0, target.state);
check('wrong listening position rejected (dist > sweet radius)',
  wrongResult.accepted === false && wrongResult.reason.indexOf('wrong_position') >= 0,
  'dist=' + wrongDetail.dist.toFixed(2) + ' clarity=' + wrongDetail.clarity.toFixed(3));
check('rejection enters recovery without counting mistake',
  wrong.fsm === 'recovery' && wrong.mistakes === beforeMistakes,
  'recoveryLeft=' + wrong.recoveryLeft);
check('recovery resets gain and filters (failure recovery)',
  wrong.gain === 1 && wrong.filters.hpf === 0 && wrong.filters.lpf === 8000);
for (let i = 0; i < 30; i++) wrong.tick();
check('recovery auto-returns to running after 30 ticks', wrong.fsm === 'running', wrong.fsm);
const fixed = gotoDevice(wrong, 0, 1);
const retry = wrong.submitDiagnosis(0, target.state);
check('same diagnosis accepted after moving into sweet spot',
  retry.accepted === true, 'clarity=' + fixed.clarity.toFixed(3));

/* ---------- 3. Parameter limits ---------- */
const limit = new Engine({ seed });
limit.start();
limit.setGain(Engine.GAIN_MAX);
check('gain at upper limit clips audio', limit.clipped === true, 'gain=' + limit.gain);
const clippedDetail = limit.metrics.detail[0];
limit.moveListener(limit.devices[0].pos.x, limit.devices[0].pos.y);
const clippedAtSpot = limit.metrics.detail[0];
check('over-amplification destroys judgment condition',
  clippedAtSpot.clarity < Engine.CLARITY_OK,
  'clarity=' + clippedAtSpot.clarity.toFixed(3) + ' noise=' + limit.metrics.noiseFloorDb.toFixed(1));
const overResult = limit.submitDiagnosis(0, limit.devices[0].state);
check('submission under clipped noise is rejected', overResult.accepted === false, overResult.reason);
limit.setGain(Engine.GAIN_MIN);
limit.moveListener(limit.devices[0].pos.x, limit.devices[0].pos.y);
const minDetail = limit.metrics.detail[0];
check('minimum gain restores diagnostic clarity', minDetail.clarity >= Engine.CLARITY_OK,
  'gain=' + limit.gain + ' clarity=' + minDetail.clarity.toFixed(3));
limit.setFilter('hpf', 4000);
limit.setFilter('lpf', 100);
check('filter order is constrained (hpf < lpf enforced)',
  limit.filters.hpf < limit.filters.lpf, JSON.stringify(limit.filters));
limit.moveListener(99, -99);
check('listener position clamped to arena bounds',
  Math.abs(limit.listener.x) <= 5 && Math.abs(limit.listener.y) <= 5,
  JSON.stringify(limit.listener));

/* ---------- 4. Pause freezes time and tick ---------- */
const pauseRun = new Engine({ seed });
pauseRun.start();
for (let i = 0; i < 5; i++) pauseRun.tick();
const frozen = { tick: pauseRun.tickIndex, time: pauseRun.elapsedMs };
pauseRun.pause();
for (let i = 0; i < 10; i++) pauseRun.tick();
check('pause freezes logical clock',
  pauseRun.tickIndex === frozen.tick && pauseRun.elapsedMs === frozen.time);
check('controls locked while paused', pauseRun.moveListener(1, 1).listener.x === 0);
pauseRun.resume();
for (let i = 0; i < 3; i++) pauseRun.tick();
check('resume continues clock',
  pauseRun.tickIndex === frozen.tick + 3 && pauseRun.elapsedMs === frozen.time + 300);

/* ---------- 5. Replay determinism & hash equality ---------- */
const live = new Engine({ seed: 777 });
live.start();
live.tick(); live.tick();
live.moveListener(1, 1.5);
live.setGain(2.5);
live.setFilter('hpf', 800);
live.tick();
const liveRej = live.submitDiagnosis(0, 'normal');
live.pause(); live.resume();
for (let i = 0; i < 31; i++) live.tick();
live.setGain(1);
const rec = live.exportRecord();
const replay = Engine.replay(rec, null);
check('replay reaches identical FSM', replay.fsm === live.fsm, replay.fsm);
check('replay final state hash equals live hash',
  replay.stateHash() === live.stateHash(),
  replay.stateHash() + ' == ' + live.stateHash());
check('replay reproduces rejection outcome',
  replay.lastRejection && replay.lastRejection.deviceId === live.lastRejection.deviceId);

/* Re-run the exact record again: hash must stay stable. */
const replay2 = Engine.replay(live.exportRecord(), null);
check('second replay hash identical', replay2.stateHash() === live.stateHash());

/* Different input on same seed must diverge. */
const other = new Engine({ seed: 777 });
other.start();
other.tick(); other.tick();
other.moveListener(-1, -1.5);
other.setGain(4);
for (let i = 0; i < 32; i++) other.tick();
check('different input on same seed yields different hash',
  other.stateHash() !== live.stateHash());

/* ---------- 6. Restart resets everything and re-randomizes ---------- */
const r = new Engine({ seed: 777 });
r.start();
r.moveListener(2, -1);
r.setGain(4.5);
r.setFilter('hpf', 1200);
r.tick(); r.tick(); r.tick();
const oldSeq = r.devices.map((d) => d.state).join(',');
const oldRun = r.runId;
const recordBefore = r.records.length;
r.restart();
check('restart resets timer/tick/clock', r.tickIndex === 0 && r.elapsedMs === 0);
check('restart resets position/filters/gain',
  r.listener.x === 0 && r.listener.y === 0 && r.gain === 1 &&
  r.filters.hpf === 0 && r.filters.lpf === 8000);
check('restart resets resources', r.mistakes === 0 && r.solvedCount === 0 &&
  r.devices.every((d) => !d.solved && d.attempts === 0));
check('restart returns FSM to menu and clears record log',
  r.fsm === 'menu' && r.records.length === 0);
check('restart advances run id and re-seeds RNG',
  r.runId === oldRun + 1 && r.seed !== 777);
check('restart produces a fresh random state sequence',
  r.devices.map((d) => d.state).join(',') !== oldSeq, oldSeq + ' -> ' + r.devices.map((d) => d.state).join(','));
check('new run still solvable with new sequence', (function () {
  r.start(); solveAll(r); return r.fsm === 'closed_win';
})());

/* Restart replay: record contains restart, replay must match. */
const withRestart = new Engine({ seed: 555 });
withRestart.start();
withRestart.moveListener(1, 0);
withRestart.setGain(3.8);
for (let i = 0; i < 4; i++) withRestart.tick();
withRestart.restart(undefined, true);
withRestart.start();
withRestart.moveListener(0, 2);
for (let i = 0; i < 2; i++) withRestart.tick();
const wrRec = withRestart.exportRecord();
const wrReplay = Engine.replay(wrRec, null);
check('replay across restart matches hash',
  wrReplay.stateHash() === withRestart.stateHash(),
  wrReplay.stateHash() + ' == ' + withRestart.stateHash());

/* ---------- 7. Failure closure after 4 mistakes ---------- */
const fail = new Engine({ seed });
fail.start();
for (let n = 0; n < 4; n++) {
  const id = n % 4;
  gotoDevice(fail, id, 1);
  const wrongState = Engine.STATES.find((s) => s !== fail.devices[id].state);
  const out = fail.submitDiagnosis(id, wrongState);
  if (fail.fsm === 'recovery') for (let i = 0; i < 30; i++) fail.tick();
  if (n === 3) check('four wrong-state diagnoses close case as failure',
    fail.fsm === 'closed_fail' && out.reason === 'case_failed');
}
check('failed case cannot accept further input',
  fail.submitDiagnosis(0, 'normal').accepted === false);

/* ---------- summary + artifacts ---------- */
const passed = results.filter((x) => x.pass).length;
console.log('\n' + passed + '/' + results.length + ' checks passed');
const artifact = {
  seed,
  generatedAt: new Date().toISOString(),
  successHash: success.stateHash(),
  replayHash: replay.stateHash(),
  restartReplayHash: wrReplay.stateHash(),
  records: { live: rec, withRestart: wrRec },
  results
};
fs.mkdirSync(path.join(__dirname, '..', 'artifacts'), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, '..', 'artifacts', 'test-run.json'),
  JSON.stringify(artifact, null, 2)
);
if (passed !== results.length) process.exit(1);
