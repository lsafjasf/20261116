import { SoundtrackEngine, DEFAULT_PARAMS, LAYERS } from './src/engine.js';
import { drawTrack, drawWaves } from './src/canvas-view.js';
import { encodeWav } from './src/wav.js';

const SNAP_KEY = 'soundtrack-engine-snapshot';

const els = {
  start: document.getElementById('startBtn'),
  stop: document.getElementById('stopBtn'),
  auto: document.getElementById('autoBtn'),
  save: document.getElementById('saveBtn'),
  restore: document.getElementById('restoreBtn'),
  export: document.getElementById('exportBtn'),
  intensity: document.getElementById('intensity'),
  statsGrid: document.getElementById('statsGrid'),
  log: document.getElementById('log'),
  track: document.getElementById('trackCanvas'),
  wave: document.getElementById('waveCanvas'),
};

let ctx = null;
let engine = null;
let analyser = null;
let autoTimer = null;
let rafId = null;
const history = [];
const logLines = [];

function readControlParams() {
  const density = {};
  for (const name of LAYERS) {
    density[name] = Number(document.querySelector(`[data-density="${name}"]`).value);
  }
  return {
    thresholdCalmChase: Number(document.getElementById('thresholdCalmChase').value),
    thresholdChaseDanger: Number(document.getElementById('thresholdChaseDanger').value),
    hysteresis: Number(document.getElementById('hysteresis').value),
    fadeInSeconds: Number(document.getElementById('fadeInSeconds').value),
    bpm: Number(document.getElementById('bpm').value),
    density,
  };
}

function syncControls(params) {
  for (const [key, value] of Object.entries(params)) {
    if (key === 'density') continue;
    const input = document.getElementById(key);
    if (input) input.value = value;
  }
  for (const name of LAYERS) {
    document.querySelector(`[data-density="${name}"]`).value = params.density[name];
  }
  refreshValueLabels();
}

function refreshValueLabels() {
  document.querySelectorAll('.val[data-for]').forEach((span) => {
    const input = document.getElementById(span.dataset.for);
    span.textContent = input.value;
  });
  document.querySelectorAll('[data-density-val]').forEach((span) => {
    const name = span.dataset.densityVal;
    span.textContent = document.querySelector(`[data-density="${name}"]`).value;
  });
}

function logLine(text) {
  const time = ctx ? ctx.currentTime.toFixed(2) : '0.00';
  logLines.unshift(`[${time}s] ${text}`);
  if (logLines.length > 80) logLines.pop();
  els.log.textContent = logLines.join('\n');
}

function ensureContext() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
  }
  return ctx;
}

function createEngine() {
  ensureContext();
  const params = readControlParams();
  engine = new SoundtrackEngine(ctx, params);
  engine.compressor.connect(analyser);
  engine.on('state', ({ from, to }) => logLine(`状态切换 ${from} → ${to}`));
  engine.on('stop', () => logLine('引擎已停止，节点已回收'));
  return engine;
}

function start() {
  if (!engine || engine.destroyed) createEngine();
  if (engine.stopped) {
    engine.restart();
  } else {
    engine.start();
  }
  ctx.resume();
  els.start.disabled = true;
  els.stop.disabled = false;
  logLine('启动调度，节拍网格开始');
  loop();
}

function stop() {
  if (!engine) return;
  engine.stop(0.15);
  els.start.disabled = false;
  els.stop.disabled = true;
  stopAuto();
  cancelAnimationFrame(rafId);
}

function stopAuto() {
  if (autoTimer !== null) {
    clearInterval(autoTimer);
    autoTimer = null;
    els.auto.textContent = '自动模拟';
  }
}

function toggleAuto() {
  if (autoTimer !== null) {
    stopAuto();
    return;
  }
  els.auto.textContent = '停止自动';
  autoTimer = setInterval(() => {
    const target = 0.5 + 0.45 * Math.sin(ctx.currentTime * 0.9) + (Math.random() - 0.5) * 0.2;
    const value = Math.max(0, Math.min(1, target));
    els.intensity.value = value;
    engine?.setIntensity(value);
  }, 200);
}

function saveSnapshot() {
  if (!engine) createEngine();
  const snapshot = engine.snapshot();
  localStorage.setItem(SNAP_KEY, JSON.stringify(snapshot));
  logLine(`快照已保存（step ${snapshot.stepIndex}，状态 ${snapshot.state}）`);
}

function restoreSnapshot() {
  const raw = localStorage.getItem(SNAP_KEY);
  if (!raw) {
    logLine('没有可恢复的快照');
    return;
  }
  const snapshot = JSON.parse(raw);
  if (!engine || engine.destroyed) createEngine();
  engine.restoreSnapshot(snapshot);
  syncControls(snapshot.params);
  logLine(`快照已恢复（step ${snapshot.stepIndex}，状态 ${snapshot.state}）`);
}

// Deterministic offline export of the same 20 s repeated-switching scenario.
async function exportMix() {
  const { OfflineAudioContext } = window;
  const duration = 20;
  const sr = 44100;
  const offline = new OfflineAudioContext(2, duration * sr, sr);
  let virtual = 0;
  const params = readControlParams();
  const offlineEngine = new SoundtrackEngine(offline, params, {
    clock: () => virtual,
    driver: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
  });
  offlineEngine.start();
  const events = [
    [1, 0.55], [3, 0.9], [5, 0.15], [7, 0.5], [9, 0.92],
    [11, 0.2], [13, 0.6], [15, 0.85], [17, 0.1], [18.5, 0.72],
  ];
  for (const [t, value] of events) {
    virtual = t;
    offlineEngine.setIntensity(value, t);
    offlineEngine.tick(t + 0.13);
  }
  virtual = duration;
  offlineEngine.tick(duration + 0.2);
  const rendered = await offline.startRendering();
  const wav = encodeWav(rendered, { sampleRate: sr });
  const blob = new Blob([wav], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mix-browser-20s.wav';
  a.click();
  URL.revokeObjectURL(url);
  logLine(`已导出 20s WAV（${wav.byteLength} 字节）`);
}

function loop() {
  if (!engine || engine.destroyed) return;
  rafId = requestAnimationFrame(loop);
  const stats = engine.getStats();
  history.push({ time: ctx.currentTime, intensity: engine.currentIntensity, state: stats.state });
  if (history.length > 600) history.shift();
  drawTrack(els.track, history, engine.params);
  drawWaves(els.wave, analyser, engine, history);
  renderStats(stats);
}

const STAT_KEYS = [
  ['state', '当前状态'], ['intensity', '当前强度'], ['activeNodeCount', '活动节点数'],
  ['createdNodes', '累计创建'], ['disposedNodes', '累计销毁'], ['listenerCount', '监听器数'],
  ['stepIndex', '16 分步进'], ['queuedTimers', '调度定时器'],
];

function renderStats(stats) {
  els.statsGrid.innerHTML = STAT_KEYS.map(([key, label]) => {
    const cls = key === 'state' ? `stat state-${stats.state}` : 'stat';
    const value = key === 'intensity' ? Number(stats[key]).toFixed(3) : stats[key];
    return `<div class="${cls}"><div class="k">${label}</div><div class="v">${value}</div></div>`;
  }).join('');
}

function bind() {
  syncControls(DEFAULT_PARAMS);
  document.querySelectorAll('input[type="range"]').forEach((input) => {
    input.addEventListener('input', refreshValueLabels);
  });
  document.querySelectorAll('.controls input[id], .controls input[data-density]').forEach((input) => {
    input.addEventListener('change', () => {
      if (engine && !engine.destroyed) engine.updateParams(readControlParams());
    });
  });
  els.intensity.addEventListener('input', () => {
    engine?.setIntensity(Number(els.intensity.value));
  });
  els.start.addEventListener('click', start);
  els.stop.addEventListener('click', stop);
  els.auto.addEventListener('click', toggleAuto);
  els.save.addEventListener('click', saveSnapshot);
  els.restore.addEventListener('click', restoreSnapshot);
  els.export.addEventListener('click', () => exportMix().catch((err) => logLine(`导出失败: ${err.message}`)));
  window.addEventListener('beforeunload', () => engine?.destroy());
}

bind();
