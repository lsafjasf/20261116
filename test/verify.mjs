import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Recorder, replay, scanOrderConflicts, restoreState } from '../src/engine/recorder.mjs';
import { SCENARIOS } from '../src/engine/scenarios.mjs';
import { createInitialState, checksum, fingerprint } from '../src/engine/state.mjs';
import { step } from '../src/engine/step.mjs';
import { saveGame, loadGame, verifyReload } from '../src/engine/storage.mjs';
import { createCanvas } from '../src/render/canvas-shim.mjs';
import { createRenderer } from '../src/render/renderer.mjs';
import { AudioEngine } from '../src/audio/audio-engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recDir = path.join(root, 'recordings');
const shotDir = path.join(root, 'screenshots');
fs.mkdirSync(recDir, { recursive: true });
fs.mkdirSync(shotDir, { recursive: true });

const report = { startedAt: new Date().toISOString(), checks: [], recordings: {} };
function check(name, ok, detail = '') {
  report.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function renderFrame(state, file, { label = '', conflict = null } = {}) {
  const canvas = createCanvas(1280, 720);
  const renderer = createRenderer(canvas.getContext('2d'));
  renderer.draw(state, { frameLabel: label, highlightConflict: conflict });
  fs.writeFileSync(path.join(shotDir, file), canvas.toBuffer());
}

const audio = new AudioEngine({});
check('Web Audio 在 Node 下降级为事件桩', audio.available === false && Array.isArray(audio.log));

const recordings = {};
for (const scenario of SCENARIOS) {
  const recorder = new Recorder(20261116, scenario.id);
  const tickInputs = [];
  let guard = 0;
  while (!recorder.finished && guard < 2000) {
    const input = scenario.input(recorder.state.tick);
    tickInputs.push(structuredClone(input));
    const result = recorder.push(input);
    audio.updateTension(recorder.state.gauges.tension, recorder.state.gauges.stress);
    for (const ev of result.events) {
      if (ev.type === 'crack') audio.crack(0.6);
      if (ev.type === 'jerk') audio.jerk(ev.side);
      if (ev.type === 'rope-snap') audio.snap();
      if (ev.type === 'rescued') audio.win();
    }
    guard += 1;
  }
  const recording = recorder.build();
  recording.finishedAt = new Date().toISOString();
  recordings[scenario.id] = { recording, tickInputs };
  fs.writeFileSync(path.join(recDir, `${scenario.id}.json`), JSON.stringify(recording));

  check(`${scenario.id} 实际结局符合预期`,
    (scenario.expect === 'success' && recording.result === 'success')
      || (scenario.expect === 'failure' && recording.result === 'failure'),
    `${recording.result}/${recording.reason} ticks=${recording.ticks}`);

  // Replay: recompute every tick from inputs and compare frame checksums.
  const replayReport = replay(recording);
  check(`${scenario.id} 回放逐帧 checksum 全部一致`, replayReport.ok,
    replayReport.mismatches.length ? `首处不一致 ${JSON.stringify(replayReport.mismatches[0])}` : `${recording.timeline.length} frames`);
  check(`${scenario.id} 回放终态指纹与录制终态一致`,
    JSON.stringify(replayReport.finalFingerprint) === JSON.stringify(recording.fingerprint));

  // Pause / single-step / 4x only change display cadence: checksums at the
  // same logical tick must be identical regardless of how frames are visited.
  const visited = visitLikePlayback(recording, { speed: 4 });
  const stepped = visitLikePlayback(recording, { singleStep: true });
  const finalChecksum = recording.timeline[recording.timeline.length - 1].checksum;
  const visitedSubsetOfStepped = visited.every((sum) => stepped.includes(sum));
  check(`${scenario.id} 倍速/单步访问的逻辑帧 checksum 一致`,
    visitedSubsetOfStepped
      && visited[visited.length - 1] === finalChecksum
      && stepped[stepped.length - 1] === finalChecksum,
    `4x 访问 ${visited.length} 帧、单步 ${stepped.length} 帧，终态同为 ${finalChecksum}`);

  // Mid-run persistence: save halfway, wipe, rebuild from inputs, compare.
  const midpoint = Math.floor(tickInputs.length / 2);
  const midState = restoreState(recording, recording.timeline[midpoint].tick);
  const memoryStore = new Map();
  const backend = {
    getItem: (k) => (memoryStore.has(k) ? memoryStore.get(k) : null),
    setItem: (k, v) => memoryStore.set(k, v),
    removeItem: (k) => memoryStore.delete(k),
  };
  const save = saveGame({
    state: midState,
    scenarioId: scenario.id,
    tickInputs: tickInputs.slice(0, midpoint),
    backend,
  });
  const loaded = loadGame(backend);
  const reloadReport = verifyReload(loaded, {
    createState: createInitialState,
    runStep: step,
    checksumOf: checksum,
  });
  check(`${scenario.id} 重载后仪表/耐久/进度完全恢复`, reloadReport.ok,
    `tick=${reloadReport.tick} progress=${reloadReport.progress.toFixed(1)} integrity=${reloadReport.integrity.toFixed(1)} tension=${reloadReport.gauges.tension}`);
  check(`${scenario.id} 存档含共享状态与两侧输入同时间线`,
    loaded.tickInputs.length === midpoint
      && typeof loaded.state.gauges.tension === 'number'
      && loaded.state.zones.length === 84);

  renderFrame(recorder.state, `${scenario.id}-final.png`, {
    label: `${scenario.id} final ${recording.result}`,
  });
  renderFrame(midState, `${scenario.id}-reload.png`, { label: `${scenario.id} reloaded tick ${midpoint}` });
}

// Ordering conflict scan on the failure run (contains same-tick two-side jerks).
const failureRecording = recordings.failure.recording;
const orderReport = scanOrderConflicts(failureRecording);
check('失败局存在顺序敏感冲突且报告具体时刻与对象位置',
  orderReport.first !== null
    && orderReport.first.tick >= 0
    && typeof orderReport.first.basePosition.x === 'number',
  orderReport.first ? `tick=${orderReport.first.tick} base=${JSON.stringify(orderReport.first.basePosition)} swapped=${JSON.stringify(orderReport.first.swappedPosition)}` : 'none');
check('失败局时间线记录了冲突对象与两侧动作顺序',
  failureRecording.conflicts.length > 0
    && failureRecording.conflicts[0].order.length === 2
    && failureRecording.conflicts[0].object === '物资箱');

// Success run must be order-insensitive (no overlapping jerks in the script).
const successOrder = scanOrderConflicts(recordings.success.recording);
check('成功局无同帧急拽，交换顺序终态一致', successOrder.sameFinal);

// Replay screenshot at a cracked frame and at the conflict frame.
const conflictFrame = failureRecording.timeline.find((f) => f.conflicts.length);
if (conflictFrame) {
  const stateAt = restoreState(failureRecording, conflictFrame.tick);
  renderFrame(stateAt, 'replay-conflict.png', {
    label: `conflict tick ${conflictFrame.tick}`,
    conflict: conflictFrame.conflicts[0],
  });
}
const crackedFrame = failureRecording.timeline.find((f) => f.events.some((e) => e.type === 'crack'));
if (crackedFrame) {
  renderFrame(restoreState(failureRecording, crackedFrame.tick), 'replay-crack.png', {
    label: `crack tick ${crackedFrame.tick}`,
  });
}
renderFrame(restoreState(recordings.success.recording, 0), 'initial.png', { label: 'initial' });

// Audio actually reacted during the runs.
check('Web Audio 收到张力/裂纹/急拽事件',
  audio.log.some((e) => e.kind === 'tension')
  && audio.log.some((e) => e.kind === 'crack')
  && audio.log.some((e) => e.kind === 'jerk'),
  `${audio.log.length} audio events`);

report.audioEvents = audio.log.length;
report.recordings = Object.fromEntries(
  Object.entries(recordings).map(([k, v]) => [k, {
    result: v.recording.result,
    reason: v.recording.reason,
    ticks: v.recording.ticks,
    conflicts: v.recording.conflicts.length,
    collisions: v.recording.collisions.length,
    fingerprint: v.recording.fingerprint,
  }]),
);
report.orderConflict = orderReport.first;
report.allPassed = report.checks.every((c) => c.ok);
fs.writeFileSync(path.join(root, 'recordings', 'verify-report.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} (${report.checks.filter((c) => c.ok).length}/${report.checks.length})`);
process.exit(report.allPassed ? 0 : 1);

// Emulate frame visitation: playback speed only decides how many recorded ticks
// are consumed per wall-clock frame; the logical sequence stays identical.
function visitLikePlayback(recording, { speed = 1, singleStep = false } = {}) {
  const seen = [];
  if (singleStep) {
    for (let i = 0; i < recording.timeline.length; i += 1) {
      const state = restoreState(recording, recording.timeline[i].tick);
      seen.push(checksum(state));
    }
    return seen;
  }
  let acc = 0;
  let cursor = 0;
  const realDt = 1 / 60;
  while (cursor < recording.timeline.length - 1) {
    acc += realDt * speed;
    let ticks = Math.floor(acc / 0.05);
    acc -= ticks * 0.05;
    while (ticks-- > 0 && cursor < recording.timeline.length - 1) cursor += 1;
    seen.push(recording.timeline[cursor].checksum);
  }
  return seen;
}
