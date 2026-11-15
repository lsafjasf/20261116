import { createEngine } from '../src/core/engine.js';
import { createRecorder, replayRecording } from '../src/core/recorder.js';
import { CONFIG, PHASE, FAULT } from '../src/core/config.js';
import { draw } from './renderer.js';
import { createAudio } from './audio.js';

const $ = (id) => document.getElementById(id);
const canvas = $('loom');
const ctx = canvas.getContext('2d');
const audio = createAudio();

let seed = Number($('seedInput').value) >>> 0;
let patternId = 'plain';
let engine = createEngine({ seed, patternId });
let recorder = createRecorder(engine, seed, patternId);
let lastPickCount = 0;
let lastPhase = PHASE.READY;

const els = {
  start: $('btnStart'), pause: $('btnPause'), repair: $('btnRepair'),
  reset: $('btnReset'), mute: $('btnMute'), replay: $('btnReplay'),
  export: $('btnExport'), speed: $('speedRange'), speedLabel: $('speedLabel'),
  pattern: $('patternSelect'), seedInput: $('seedInput'),
};

function act(action, fn) {
  audio.unlock();
  const tickBefore = engine.state.tick;
  fn();
  if (action === 'SPEED') recorder.record(tickBefore, action, { value: engine.state.speedTarget });
  else recorder.record(tickBefore, action);
  refreshButtons();
}

els.start.addEventListener('click', () => act('START', () => {
  audio.startHum();
  engine.start();
}));
els.pause.addEventListener('click', () => {
  if (engine.state.phase === PHASE.RUNNING) act('PAUSE', () => engine.pause());
  else act('RESUME', () => engine.resume());
});
els.repair.addEventListener('click', () => act('REPAIR', () => {
  engine.repair();
  audio.repair();
}));
els.reset.addEventListener('click', () => {
  const tickBefore = engine.state.tick;
  resetAll();
  recorder.record(tickBefore, 'RESET');
});
els.speed.addEventListener('input', () => act('SPEED', () => engine.setSpeed(Number(els.speed.value))));
els.pattern.addEventListener('change', () => {
  patternId = els.pattern.value;
  resetAll();
});
els.seedInput.addEventListener('change', () => {
  seed = Number(els.seedInput.value) >>> 0;
  resetAll();
});
els.mute.addEventListener('click', () => {
  els.mute.textContent = audio.toggleMute() ? '取消静音' : '静音';
});
els.export.addEventListener('click', () => {
  const blob = new Blob([recorder.exportJson()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `loom-recording-seed${seed}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
els.replay.addEventListener('click', () => {
  const result = replayRecording(recorder.exportJson());
  const live = engine.snapshotHash().hash;
  const same = live === result.snapshot.hash;
  $('hashText').textContent = same
    ? `回放一致 ✓ live=${live} replay=${result.snapshot.hash}`
    : `回放不一致 ✗ live=${live} replay=${result.snapshot.hash}`;
});

function resetAll() {
  engine = createEngine({ seed, patternId });
  recorder = createRecorder(engine, seed, patternId);
  lastPickCount = 0;
  lastPhase = PHASE.READY;
  audio.stopHum();
  $('hashText').textContent = '-';
  refreshButtons();
  updateHud();
}

let acc = 0;
let lastTs = performance.now();
function frame(ts) {
  const dt = Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;
  if (engine.state.phase === PHASE.RUNNING) {
    acc += dt;
    const stepDt = CONFIG.tickDt;
    let steps = 0;
    while (acc >= stepDt && steps < 8) {
      engine.step();
      acc -= stepDt;
      steps += 1;
    }
  }
  handlePhaseAudio();
  draw(ctx, engine, canvas.width, canvas.height);
  updateHud();
  requestAnimationFrame(frame);
}

function handlePhaseAudio() {
  const s = engine.state;
  audio.updateHum(s.speed, s.phase === PHASE.RUNNING);
  if (s.picks > lastPickCount) {
    audio.pick(s.speed);
    lastPickCount = s.picks;
  }
  if (s.phase === PHASE.STOPPED && lastPhase !== PHASE.STOPPED) {
    audio.stop();
  }
  if (s.phase === PHASE.SUCCESS && lastPhase !== PHASE.SUCCESS) {
    audio.success();
  }
  lastPhase = s.phase;
}

function updateHud() {
  const s = engine.state;
  $('goalPattern').textContent = `${engine.pattern.name} (seed ${s.seed})`;
  $('goalLength').textContent = `${s.clothCm.toFixed(2)} / ${CONFIG.targetLengthCm} cm`;
  const pill = $('phasePill');
  pill.textContent = s.phase;
  pill.className = `pill ${s.phase === PHASE.STOPPED || s.phase === PHASE.FAILED ? 'stop' : ''} ${s.phase === PHASE.SUCCESS ? 'ok' : ''}`;
  $('faultText').textContent = s.fault === FAULT.NONE ? '无' : `${s.fault}${s.faultThread >= 0 ? ` · 第${s.faultThread + 1}根` : ''}`;
  $('resCloth').textContent = `${s.clothCm.toFixed(2)} cm`;
  $('resPicks').textContent = String(s.picks);
  $('resWeft').textContent = String(s.weft);
  $('resBobbins').textContent = String(s.bobbins);
  $('resDefects').textContent = `${s.defects} / ${s.openDefects}`;
  $('resTime').textContent = `${(s.runningTimeMs / 1000).toFixed(1)} s`;
  $('resSpeed').textContent = `${s.speed.toFixed(2)} /s`;
  $('lastChange').textContent =
    `${s.lastTransition.phase} @tick${s.lastTransition.tick} (${s.lastTransition.reason})`;
  $('msgText').textContent = s.message;
  els.speedLabel.textContent = `${s.speedTarget.toFixed(2)} 次/秒`;
  $('eventLog').innerHTML = s.events.slice(-10).reverse()
    .map((e) => `<div class="event">t${e.tick} · ${e.type} · ${e.detail}</div>`).join('');
  if ([PHASE.SUCCESS, PHASE.FAILED].includes(s.phase)) {
    $('hashText').textContent = engine.snapshotHash().hash;
  }
}

function refreshButtons() {
  const s = engine.state;
  els.start.disabled = s.phase !== PHASE.READY;
  els.pause.disabled = ![PHASE.RUNNING, PHASE.PAUSED].includes(s.phase);
  els.pause.textContent = s.phase === PHASE.PAUSED ? '继续' : '暂停';
  els.repair.disabled = s.phase !== PHASE.STOPPED;
  els.speed.value = s.speedTarget;
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (engine.state.phase === PHASE.READY) els.start.click();
    else els.pause.click();
  }
  if (e.key.toLowerCase() === 'r' && engine.state.phase === PHASE.STOPPED) els.repair.click();
});

refreshButtons();
requestAnimationFrame(frame);
