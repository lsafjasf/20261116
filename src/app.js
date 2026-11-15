// Browser UI: canvas keyboard / waveform / note track + transport + snapshots.
import { SynthEngine, KEY_COUNT, KEY_NOTES, WAVEFORMS, defaultKeyParams } from './engine.js';
import { Recorder, MAX_RECORD_SECONDS } from './recorder.js';
import { snapshotProject, restoreProject } from './project.js';

const engine = new SynthEngine({ ctxFactory: () => new AudioContext() });
const recorder = new Recorder(engine);
let selectedKey = 0;

// AudioContext requires a user gesture; start exactly once on first input.
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  engine.start();
  if (engine.ctx.state === 'suspended') engine.ctx.resume();
}

// ---- Presets ---------------------------------------------------------------
const PRESETS = {
  '经典锯齿': Array.from({ length: KEY_COUNT }, () => ({ ...defaultKeyParams() })),
  '柔和正弦': Array.from({ length: KEY_COUNT }, (_, i) => ({
    ...defaultKeyParams(),
    waveform: 'sine', attack: 0.05, release: 0.5, filterFreq: 2500,
    pan: (i - 3.5) / 5,
  })),
  '滑音科幻': Array.from({ length: KEY_COUNT }, (_, i) => ({
    ...defaultKeyParams(),
    waveform: 'square', glide: 0.25, filterType: 'bandpass',
    filterFreq: 1200 + i * 300, filterQ: 6, release: 0.4,
  })),
};

const presetsEl = document.getElementById('presets');
for (const name of Object.keys(PRESETS)) {
  const btn = document.createElement('button');
  btn.textContent = name;
  btn.addEventListener('click', () => {
    // Recorded notes keep their per-note snapshots; only live params change.
    engine.applyPreset(PRESETS[name].map((p) => ({ ...p })));
    syncPanel();
  });
  presetsEl.appendChild(btn);
}

// ---- Parameter panel -------------------------------------------------------
const PARAM_BINDINGS = [
  ['p-waveform', 'waveform', (v) => v, (v) => v],
  ['p-pitch', 'pitchOffset', Number, (v) => v],
  ['p-attack', 'attack', Number, (v) => v.toFixed(3)],
  ['p-decay', 'decay', Number, (v) => v.toFixed(3)],
  ['p-sustain', 'sustain', Number, (v) => v.toFixed(2)],
  ['p-release', 'release', Number, (v) => v.toFixed(3)],
  ['p-filtertype', 'filterType', (v) => v, (v) => v],
  ['p-filterfreq', 'filterFreq', Number, (v) => Math.round(v)],
  ['p-filterq', 'filterQ', Number, (v) => v.toFixed(1)],
  ['p-glide', 'glide', Number, (v) => v.toFixed(2)],
  ['p-pan', 'pan', Number, (v) => v.toFixed(2)],
  ['p-gain', 'gain', Number, (v) => v.toFixed(2)],
];

const waveSel = document.getElementById('p-waveform');
for (const w of WAVEFORMS) {
  const opt = document.createElement('option');
  opt.value = w; opt.textContent = w;
  waveSel.appendChild(opt);
}

function syncPanel() {
  document.getElementById('key-label').textContent = `键 ${selectedKey + 1}`;
  const p = engine.keys[selectedKey];
  for (const [id, key, , fmt] of PARAM_BINDINGS) {
    const el = document.getElementById(id);
    el.value = p[key];
    const out = el.parentElement.querySelector('span');
    if (out) out.textContent = fmt(p[key]);
  }
}

for (const [id, key, parse, fmt] of PARAM_BINDINGS) {
  const el = document.getElementById(id);
  el.addEventListener('input', () => {
    engine.setKeyParams(selectedKey, { [key]: parse(el.value) });
    const out = el.parentElement.querySelector('span');
    if (out) out.textContent = fmt(engine.keys[selectedKey][key]);
  });
}
syncPanel();

// ---- Keyboard canvas + input ------------------------------------------------
const kbCanvas = document.getElementById('keyboard');
const kbCtx = kbCanvas.getContext('2d');
const NOTE_NAMES = ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5'];
const KEY_LETTERS = ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K'];
const pressed = new Set();

function drawKeyboard() {
  const w = kbCanvas.width / KEY_COUNT;
  for (let i = 0; i < KEY_COUNT; i++) {
    const isDown = pressed.has(i);
    kbCtx.fillStyle = isDown ? '#4a90e2' : i === selectedKey ? '#e8e2c8' : '#f2f2f2';
    kbCtx.fillRect(i * w + 2, 2, w - 4, kbCanvas.height - 4);
    kbCtx.fillStyle = '#222';
    kbCtx.font = '14px sans-serif';
    kbCtx.fillText(NOTE_NAMES[i], i * w + 10, kbCanvas.height - 34);
    kbCtx.fillText(KEY_LETTERS[i], i * w + 10, kbCanvas.height - 14);
    if (engine.keys[i].glide > 0) {
      kbCtx.fillStyle = '#a05ad0';
      kbCtx.fillText('~', i * w + w - 20, 20);
    }
  }
}

function keyDown(i) {
  if (pressed.has(i)) return;
  boot();
  pressed.add(i);
  if (recorder.isRecording) recorder.recordNoteOn(i);
  else engine.noteOn(i);
}
function keyUp(i) {
  if (!pressed.has(i)) return;
  pressed.delete(i);
  if (recorder.isRecording) recorder.recordNoteOff(i);
  else engine.noteOff(i);
}

kbCanvas.addEventListener('mousedown', (e) => {
  const w = kbCanvas.width / KEY_COUNT;
  const i = Math.min(KEY_COUNT - 1, Math.floor(e.offsetX / w));
  keyDown(i);
  const up = () => { keyUp(i); window.removeEventListener('mouseup', up); };
  window.addEventListener('mouseup', up);
});
kbCanvas.addEventListener('click', (e) => {
  const w = kbCanvas.width / KEY_COUNT;
  selectedKey = Math.min(KEY_COUNT - 1, Math.floor(e.offsetX / w));
  syncPanel();
});

// Managed listeners: removed on destroy, never duplicated by re-boot.
engine.addManagedListener(window, 'keydown', (e) => {
  if (e.repeat) return;
  const li = KEY_LETTERS.indexOf(e.key.toUpperCase());
  if (li >= 0) keyDown(li);
  const num = parseInt(e.key, 10);
  if (num >= 1 && num <= 8) { selectedKey = num - 1; syncPanel(); }
});
engine.addManagedListener(window, 'keyup', (e) => {
  const li = KEY_LETTERS.indexOf(e.key.toUpperCase());
  if (li >= 0) keyUp(li);
});
// Input interruption: page hidden / focus lost -> silence, no tails.
engine.addManagedListener(document, 'visibilitychange', () => {
  if (document.hidden && booted) {
    pressed.clear();
    engine.handleInterrupt().then(() => engine.ctx.resume());
  }
});
engine.addManagedListener(window, 'blur', () => {
  if (!booted) return;
  pressed.clear();
  engine.stopAll(0.003);
});

// ---- Waveform + note track + status loop ------------------------------------
const waveCanvas = document.getElementById('waveform');
const waveCtx = waveCanvas.getContext('2d');
const trackCanvas = document.getElementById('track');
const trackCtx = trackCanvas.getContext('2d');
const statusEl = document.getElementById('status');
const transportInfo = document.getElementById('transport-info');
const waveData = new Uint8Array(2048);

function drawWaveform() {
  waveCtx.fillStyle = '#10131a';
  waveCtx.fillRect(0, 0, waveCanvas.width, waveCanvas.height);
  if (!booted) return;
  engine.analyser.getByteTimeDomainData(waveData);
  waveCtx.strokeStyle = '#6fe3a5';
  waveCtx.beginPath();
  const step = waveCanvas.width / waveData.length;
  for (let i = 0; i < waveData.length; i++) {
    const y = (waveData[i] / 255) * waveCanvas.height;
    if (i === 0) waveCtx.moveTo(0, y);
    else waveCtx.lineTo(i * step, y);
  }
  waveCtx.stroke();
}

function drawTrack() {
  trackCtx.fillStyle = '#10131a';
  trackCtx.fillRect(0, 0, trackCanvas.width, trackCanvas.height);
  const rowH = trackCanvas.height / KEY_COUNT;
  trackCtx.strokeStyle = '#232a35';
  for (let i = 0; i <= KEY_COUNT; i++) {
    trackCtx.beginPath();
    trackCtx.moveTo(0, i * rowH);
    trackCtx.lineTo(trackCanvas.width, i * rowH);
    trackCtx.stroke();
  }
  const rec = recorder.recording;
  if (rec) {
    const x = (t) => (t / MAX_RECORD_SECONDS) * trackCanvas.width;
    const open = new Map();
    for (const ev of rec.events) {
      const row = KEY_COUNT - 1 - ev.key;
      if (ev.type === 'on') open.set(ev.key, ev.t);
      else if (open.has(ev.key)) {
        const t0 = open.get(ev.key);
        open.delete(ev.key);
        trackCtx.fillStyle = `hsl(${200 + ev.key * 18}, 70%, 55%)`;
        trackCtx.fillRect(x(t0), row * rowH + 2, Math.max(2, x(ev.t) - x(t0)), rowH - 4);
      }
    }
    for (const [key, t0] of open) {
      const row = KEY_COUNT - 1 - key;
      trackCtx.fillStyle = `hsl(${200 + key * 18}, 70%, 55%)`;
      trackCtx.fillRect(x(t0), row * rowH + 2, trackCanvas.width - x(t0), rowH - 4);
    }
    if (recorder.isPlaying || recorder.playhead > 0) {
      const px = x(recorder.isPlaying
        ? recorder.playhead + (engine.ctx.currentTime - recorder._playStartCtxTime)
        : recorder.playhead);
      trackCtx.strokeStyle = '#ff5f5f';
      trackCtx.beginPath();
      trackCtx.moveTo(px, 0);
      trackCtx.lineTo(px, trackCanvas.height);
      trackCtx.stroke();
    }
  }
}

function updateStatus() {
  const s = booted
    ? engine.getStatus()
    : { started: false, contextState: 'idle', activeNodes: 0, activeVoices: 0, managedListeners: engine.managedListeners.length, collectorRunning: false };
  const r = recorder.getStatus();
  statusEl.textContent =
    `ctx:${s.contextState} 节点:${s.activeNodes} 声部:${s.activeVoices} ` +
    `监听:${s.managedListeners} 回收:${s.collectorRunning ? 'on' : 'off'} ` +
    `调度:${r.schedulerRunning ? 'on' : 'off'} 录音:${r.isRecording ? 'REC' : '-'} ` +
    `播放:${r.isPlaying ? 'PLAY' : '-'} 事件:${r.eventCount}`;
  transportInfo.textContent = r.recorded
    ? `已录 ${r.eventCount} 事件 / ${MAX_RECORD_SECONDS}s，播放点 ${r.playhead.toFixed(2)}s`
    : '尚未录音';
}

function loop() {
  drawKeyboard();
  drawWaveform();
  drawTrack();
  updateStatus();
  requestAnimationFrame(loop);
}
loop();

// ---- Transport ---------------------------------------------------------------
const btnRecord = document.getElementById('btn-record');
const btnPlay = document.getElementById('btn-play');
const btnPause = document.getElementById('btn-pause');
const btnStop = document.getElementById('btn-stop');

btnRecord.addEventListener('click', () => {
  boot();
  if (recorder.isRecording) {
    recorder.stopRecording();
    btnRecord.classList.remove('active');
    btnRecord.textContent = '● 录音';
  } else {
    recorder.startRecording();
    btnRecord.classList.add('active');
    btnRecord.textContent = '■ 停止录音';
  }
});
btnPlay.addEventListener('click', () => { boot(); recorder.play(); });
btnPause.addEventListener('click', () => recorder.pause());
btnStop.addEventListener('click', () => {
  recorder.stopPlayback();
  if (recorder.isRecording) {
    recorder.stopRecording();
    btnRecord.classList.remove('active');
    btnRecord.textContent = '● 录音';
  }
});

document.getElementById('btn-export').addEventListener('click', async () => {
  boot();
  if (!recorder.recording) { transportInfo.textContent = '没有可导出的录音'; return; }
  transportInfo.textContent = '渲染中…';
  const { wav, duration } = await recorder.exportWav(OfflineAudioContext);
  const blob = new Blob([wav], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `synth-${duration}s.wav`;
  a.click();
  URL.revokeObjectURL(a.href);
  transportInfo.textContent = `已导出 ${duration}s WAV`;
});

// ---- Snapshots ---------------------------------------------------------------
const snapInfo = document.getElementById('snap-info');
document.getElementById('btn-snap-save').addEventListener('click', () => {
  localStorage.setItem('synth-project', JSON.stringify(snapshotProject(engine, recorder)));
  snapInfo.textContent = `快照已保存 ${new Date().toLocaleTimeString()}`;
});
document.getElementById('btn-snap-load').addEventListener('click', () => {
  const raw = localStorage.getItem('synth-project');
  if (!raw) { snapInfo.textContent = '没有已保存的快照'; return; }
  restoreProject(engine, recorder, JSON.parse(raw));
  syncPanel();
  snapInfo.textContent = '快照已恢复';
});
document.getElementById('btn-snap-file').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(snapshotProject(engine, recorder), null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'synth-project.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
document.getElementById('file-project').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  restoreProject(engine, recorder, JSON.parse(await file.text()));
  syncPanel();
  snapInfo.textContent = `已载入 ${file.name}`;
});
