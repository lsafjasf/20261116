import { WORLD } from '../engine/config.mjs';
import { createRenderer } from '../render/renderer.mjs';
import { KeyboardInput } from './input.mjs';
import { GameSession } from './game-session.mjs';
import { ReplayController } from './replay-controller.mjs';
import { SCENARIOS } from '../engine/scenarios.mjs';
import { saveGame, loadGame, verifyReload, clearSave } from '../engine/storage.mjs';
import { createInitialState, checksum } from '../engine/state.mjs';
import { step } from '../engine/step.mjs';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const renderer = createRenderer(ctx);
const logEl = document.getElementById('log');
function logger(msg, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

const keyboard = new KeyboardInput();
const session = new GameSession(renderer, logger);
const replayer = new ReplayController(renderer, logger);

let autopilot = null;
let prevKeys = new Set();

function readManualInput() {
  const held = keyboard.sample();
    const edge = keyboard.consumePressed(prevKeys);
  prevKeys = edge.snapshot;
  held.leftJerk = edge.leftJerk;
  held.rightJerk = edge.rightJerk;
  return held;
}

// Fixed 20 Hz simulation clock, independent of rendering frame rate.
setInterval(() => {
  if (replayer.playing) return;
  if (session.recorder.finished) return;
  let input;
  if (autopilot) {
    input = autopilot.input(session.state.tick);
  } else {
    input = readManualInput();
  }
  session.tick(input);
  updateGauges();
}, WORLD.dt * 1000);

function updateGauges() {
  const s = session.state;
  document.getElementById('vProgress').textContent = `${s.progress.toFixed(0)}%`;
  document.getElementById('fProgress').style.width = `${s.progress}%`;
  document.getElementById('vIntegrity').textContent = s.integrity.toFixed(1);
  document.getElementById('fIntegrity').style.width = `${s.integrity}%`;
  document.getElementById('vTension').textContent = s.gauges.tension;
  document.getElementById('fTension').style.width = `${s.gauges.tension * 100}%`;
  document.getElementById('vGuide').textContent = s.gauges.guideLoad;
  document.getElementById('fGuide').style.width = `${s.gauges.guideLoad * 100}%`;
  const badge = document.getElementById('statusBadge');
  badge.textContent = `${s.status}${s.endReason ? ':' + s.endReason : ''}`;
  badge.className = `badge ${s.status === 'running' ? 'run' : s.status}`;
}
setInterval(updateGauges, 120);

document.getElementById('btnManual').addEventListener('click', () => {
  autopilot = null;
  session.start('manual', null);
  updateGauges();
});
document.getElementById('btnReset').addEventListener('click', () => {
  autopilot = null;
  session.start(session.mode, session.scenario);
  updateGauges();
});
for (const sc of SCENARIOS) {
  const id = sc.id === 'success' ? 'btnDemoSuccess' : 'btnDemoFailure';
  document.getElementById(id).addEventListener('click', () => {
    autopilot = sc;
    session.start('auto', sc);
    updateGauges();
  });
}

document.getElementById('btnSave').addEventListener('click', () => {
  const payload = saveGame({
    state: session.state,
    scenarioId: session.scenario ? session.scenario.id : 'manual',
    tickInputs: session.tickInputs,
  });
  logger(`已保存：tick ${payload.tick}，checksum ${checksum(payload.state)}`, 'ok');
});

document.getElementById('btnReload').addEventListener('click', () => {
  const save = loadGame();
  if (!save) {
    document.getElementById('reloadResult').textContent = '没有可恢复的存档';
    return;
  }
  const report = verifyReload(save, {
    createState: createInitialState,
    runStep: step,
    checksumOf: checksum,
  });
  const el = document.getElementById('reloadResult');
  el.innerHTML = `重载 ${report.ok ? '<span class="ok">一致 ✓</span>' : '<span class="bad">不一致 ✗</span>'}`
    + ` tick=${report.tick} 进度=${report.progress.toFixed(1)}% 耐久=${report.integrity.toFixed(1)}`
    + ` 张力=${report.gauges.tension} 导向=${report.gauges.guideLoad} checksum=${report.rebuiltChecksum}`;
  logger(`重载校验：${report.ok ? '通过' : '失败'}，仪表/耐久/进度已恢复`, report.ok ? 'ok' : 'bad');
  renderer.draw(save.state, { frameLabel: '已恢复存档状态' });
});

document.getElementById('btnReplay').addEventListener('click', () => {
  if (!session.lastRecording) {
    logger('还没有完成的对局可回放');
    return;
  }
  const verify = replayer.load(session.lastRecording);
  const result = replayer.play(1);
  void result;
  document.getElementById('replayResult').textContent =
    `回放校验 ${verify.ok ? '通过 ✓' : '失败 ✗'}，共 ${session.lastRecording.timeline.length} 帧逐帧 checksum 一致`;
  logger(`回放开始：逐帧 checksum 校验 ${verify.ok ? '通过' : '失败'}`, verify.ok ? 'ok' : 'bad');
});
document.getElementById('btnPause').addEventListener('click', () => replayer.pause());
document.getElementById('btnStep').addEventListener('click', () => replayer.stepOnce());
document.querySelectorAll('[data-speed]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const speed = Number(btn.dataset.speed);
    replayer.play(speed);
    logger(`回放倍速切换 ${speed}x（终态不变）`);
  });
});
document.getElementById('btnConflictScan').addEventListener('click', () => replayer.scanConflicts());
document.getElementById('btnMute').addEventListener('click', (e) => {
  session.audio.setMuted(!session.audio.muted);
  e.target.textContent = session.audio.muted ? '取消静音' : '静音';
});

window.__iceRescue = { session, replayer, saveGame, loadGame, clearSave, verifyReload, checksum, step };
updateGauges();
