import { SAMPLE_RATE, TIMELINE_SECONDS, clamp, gainToDb } from './util.js';
import { synthesizeAll } from './synth.js';
import {
  createDefaultProject,
  getAutomation,
  getClip,
  moveClip,
  parseProject,
  serializeProject,
  setAutomationPoints,
  setClipFade,
  setClipGain,
  setClipPan,
  takeSnapshot,
} from './project.js';
import { renderTimeline, waveformPeaks } from './renderer.js';
import { encodeWav } from './wav.js';
import { BrowserHost } from './browser-host.js';
import { PlaybackEngine } from './engine.js';

const TRACK_META = [
  { id: 'rain', label: '雨声', color: '#5fb878' },
  { id: 'machine', label: '机器声', color: '#d99a4e' },
  { id: 'voice', label: '远处人声', color: '#9b7ed8' },
];

const state = {
  project: createDefaultProject(),
  sources: synthesizeAll(),
  host: null,
  engine: null,
  selectedClipId: 'rain',
  snapshot: takeSnapshot(createDefaultProject()),
};
state.snapshot = takeSnapshot(state.project);

const elements = {
  tracks: document.querySelector('#tracks'),
  rulerCanvas: document.querySelector('#rulerCanvas'),
  automationCanvas: document.querySelector('#automationCanvas'),
  inspectorFields: document.querySelector('#inspectorFields'),
  engineState: document.querySelector('#engineState'),
  activeNodes: document.querySelector('#activeNodes'),
  frameListeners: document.querySelector('#frameListeners'),
  playheadBadge: document.querySelector('#playheadBadge'),
  ioMessage: document.querySelector('#ioMessage'),
};

const trackViews = new Map();

function timeToX(time, width) {
  return (time / TIMELINE_SECONDS) * width;
}

function xToTime(x, width) {
  return clamp(x, 0, width) / width * TIMELINE_SECONDS;
}

function fitCanvas(canvas) {
  const ratio = globalThis.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

function drawRuler() {
  const { context, width, height } = fitCanvas(elements.rulerCanvas);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = '#2d3540';
  context.fillStyle = '#93a0b0';
  context.font = '11px system-ui';
  for (let second = 0; second <= TIMELINE_SECONDS; second += 1) {
    const x = timeToX(second, width);
    context.beginPath();
    context.moveTo(x, height - 8);
    context.lineTo(x, height);
    context.stroke();
    context.fillText(`${second}s`, x + 3, height - 10);
  }
}

function drawTrack(meta) {
  const clip = getClip(state.project, meta.id);
  const view = trackViews.get(meta.id);
  const { context, width, height } = fitCanvas(view.canvas);
  context.clearRect(0, 0, width, height);
  const peaks = waveformPeaks(state.sources[meta.id].channels[0], Math.round(width));
  context.strokeStyle = 'rgba(255,255,255,0.18)';
  context.beginPath();
  for (let x = 0; x < width; x += 1) {
    const y = (1 - peaks[x]) * height * 0.5;
    context.moveTo(x, y);
    context.lineTo(x, height - y);
  }
  context.stroke();

  const startX = timeToX(clip.start, width);
  const endX = timeToX(clip.start + clip.duration, width);
  context.fillStyle = `${meta.color}33`;
  context.fillRect(startX, 0, endX - startX, height);
  context.strokeStyle = meta.color;
  context.lineWidth = 2;
  context.strokeRect(startX, 1, endX - startX, height - 2);
  context.fillStyle = meta.color;
  context.fillRect(timeToX(clip.start + clip.fadeIn, width), 0, 2, height);
  context.fillRect(timeToX(clip.start + clip.duration - clip.fadeOut, width), 0, 2, height);
  context.fillStyle = '#e6ebf2';
  context.font = '12px system-ui';
  context.fillText(`${meta.label} · ${clip.gainDb} dB · pan ${clip.pan}`, startX + 6, 16);
}

function drawAllTracks() {
  for (const meta of TRACK_META) drawTrack(meta);
}

function drawAutomation() {
  const canvas = elements.automationCanvas;
  const { context, width, height } = fitCanvas(canvas);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = '#2d3540';
  for (let db = -24; db <= 6; db += 6) {
    const y = height - ((db + 24) / 30) * height;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
    context.fillStyle = '#93a0b0';
    context.fillText(`${db} dB`, 6, y - 3);
  }
  const entry = getAutomation(state.project, 'rain');
  if (!entry || entry.points.length === 0) return;
  const toY = (db) => height - ((clamp(db, -24, 6) + 24) / 30) * height;
  context.strokeStyle = '#69b7ff';
  context.lineWidth = 2;
  context.beginPath();
  entry.points.forEach((point, index) => {
    const x = timeToX(point.time, width);
    const y = toY(point.value);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();
  for (const point of entry.points) {
    const x = timeToX(point.time, width);
    const y = toY(point.value);
    context.fillStyle = '#e6ebf2';
    context.beginPath();
    context.arc(x, y, 6, 0, Math.PI * 2);
    context.fill();
  }
}

function buildTracks() {
  elements.tracks.innerHTML = '';
  trackViews.clear();
  for (const meta of TRACK_META) {
    const wrap = document.createElement('div');
    wrap.className = 'track';
    const title = document.createElement('div');
    title.className = 'track-title';
    title.innerHTML = `<span>${meta.label}</span><span>${meta.id}</span>`;
    const canvas = document.createElement('canvas');
    canvas.className = 'track-canvas';
    canvas.height = 84;
    const playhead = document.createElement('div');
    playhead.className = 'playhead';
    playhead.style.left = '0px';
    wrap.append(title, canvas, playhead);
    elements.tracks.append(wrap);
    trackViews.set(meta.id, { canvas, playhead, wrap });
    bindTrackDrag(meta, canvas);
  }
}

function bindTrackDrag(meta, canvas) {
  let drag = null;
  canvas.addEventListener('pointerdown', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const time = xToTime(x, rect.width);
    const clip = getClip(state.project, meta.id);
    state.selectedClipId = clip.id;
    renderInspector();
    const fadeInX = timeToX(clip.start + clip.fadeIn, rect.width);
    const fadeOutX = timeToX(clip.start + clip.duration - clip.fadeOut, rect.width);
    if (Math.abs(x - fadeInX) < 10) drag = { kind: 'fadeIn', clipId: clip.id, width: rect.width };
    else if (Math.abs(x - fadeOutX) < 10) drag = { kind: 'fadeOut', clipId: clip.id, width: rect.width };
    else drag = { kind: 'move', clipId: clip.id, width: rect.width, grabOffset: time - clip.start };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const time = xToTime(event.clientX - rect.left, rect.width);
    const clip = getClip(state.project, drag.clipId);
    if (drag.kind === 'move') moveClip(state.project, clip.id, time - drag.grabOffset);
    if (drag.kind === 'fadeIn') setClipFade(state.project, clip.id, 'fadeIn', time - clip.start);
    if (drag.kind === 'fadeOut') {
      setClipFade(state.project, clip.id, 'fadeOut', clip.start + clip.duration - time);
    }
    redraw();
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
}

function bindAutomationDrag() {
  const canvas = elements.automationCanvas;
  let dragIndex = -1;
  const pointAt = (event) => {
    const rect = canvas.getBoundingClientRect();
    const entry = getAutomation(state.project, 'rain');
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return entry.points.findIndex((point) => {
      const px = timeToX(point.time, rect.width);
      const py = rect.height - ((clamp(point.value, -24, 6) + 24) / 30) * rect.height;
      return Math.hypot(px - x, py - y) < 10;
    });
  };
  canvas.addEventListener('pointerdown', (event) => {
    dragIndex = pointAt(event);
    if (dragIndex >= 0) canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (dragIndex < 0) return;
    const rect = canvas.getBoundingClientRect();
    const entry = getAutomation(state.project, 'rain');
    const time = xToTime(event.clientX - rect.left, rect.width);
    const value = clamp(6 - ((event.clientY - rect.top) / rect.height) * 30, -24, 6);
    entry.points[dragIndex] = { time, value };
    setAutomationPoints(state.project, 'rain', entry.points);
    redraw();
  });
  canvas.addEventListener('pointerup', () => { dragIndex = -1; });
}

function renderInspector() {
  const clip = getClip(state.project, state.selectedClipId);
  elements.inspectorFields.innerHTML = '';
  const rows = [
    { label: `起始时间（秒） ${clip.start.toFixed(2)}`, min: 0, max: TIMELINE_SECONDS - clip.duration, step: 0.1, value: clip.start, apply: (v) => moveClip(state.project, clip.id, v) },
    { label: `淡入（秒） ${clip.fadeIn.toFixed(2)}`, min: 0, max: clip.duration / 2, step: 0.1, value: clip.fadeIn, apply: (v) => setClipFade(state.project, clip.id, 'fadeIn', v) },
    { label: `淡出（秒） ${clip.fadeOut.toFixed(2)}`, min: 0, max: clip.duration / 2, step: 0.1, value: clip.fadeOut, apply: (v) => setClipFade(state.project, clip.id, 'fadeOut', v) },
    { label: `增益（dB） ${clip.gainDb.toFixed(1)}`, min: -24, max: 12, step: 0.5, value: clip.gainDb, apply: (v) => setClipGain(state.project, clip.id, v) },
    { label: `声像 ${clip.pan.toFixed(2)}`, min: -1, max: 1, step: 0.05, value: clip.pan, apply: (v) => setClipPan(state.project, clip.id, v) },
  ];
  for (const row of rows) {
    const field = document.createElement('div');
    field.className = 'field';
    field.innerHTML = `<label>${row.label}</label>`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = row.min;
    input.max = row.max;
    input.step = row.step;
    input.value = row.value;
    input.addEventListener('input', () => {
      row.apply(Number(input.value));
      renderInspector();
      redraw();
    });
    field.append(input);
    elements.inspectorFields.append(field);
  }
}

function updatePlayhead(time) {
  for (const view of trackViews.values()) {
    const width = view.canvas.clientWidth;
    view.playhead.style.left = `${timeToX(time, width)}px`;
  }
  elements.playheadBadge.textContent = `播放头：${time.toFixed(2)}s`;
}

function refreshStatus() {
  const engine = state.engine;
  elements.engineState.textContent = `状态：${engine ? engine.status : '未创建'}`;
  elements.activeNodes.textContent = `活动节点：${engine ? engine.activeNodeCount : 0}`;
  elements.frameListeners.textContent = `帧监听：${state.host ? state.host.frameSubscriptions - state.host.frameUnsubscriptions : 0}`;
}

async function ensureEngine() {
  if (state.engine && state.engine.status !== 'destroyed') return state.engine;
  state.host = new BrowserHost();
  await state.host.resume();
  state.engine = new PlaybackEngine(state.host, state.project, state.sources);
  state.engine.onStatus(refreshStatus);
  state.engine.onPlayhead(updatePlayhead);
  refreshStatus();
  return state.engine;
}

function flashMessage(text, isError = false) {
  elements.ioMessage.textContent = text;
  elements.ioMessage.classList.toggle('error', isError);
}

function bindTransport() {
  document.querySelector('#playBtn').addEventListener('click', async () => {
    const engine = await ensureEngine();
    await engine.start(engine.playhead);
    refreshStatus();
  });
  document.querySelector('#pauseBtn').addEventListener('click', () => state.engine?.pause());
  document.querySelector('#stopBtn').addEventListener('click', () => state.engine?.stop());
  document.querySelector('#restartBtn').addEventListener('click', async () => {
    const engine = await ensureEngine();
    await engine.start(0);
    await engine.start(0);
    await engine.start(5);
    refreshStatus();
    flashMessage('重复启动已合并为同一条播放链路');
  });
  document.querySelector('#destroyBtn').addEventListener('click', () => {
    state.engine?.destroy();
    state.engine = null;
    state.host = null;
    refreshStatus();
    updatePlayhead(0);
    flashMessage('引擎已销毁，节点与监听器全部释放');
  });
  document.querySelector('#masterGain').addEventListener('input', (event) => {
    state.project.masterGainDb = Number(event.target.value);
    document.querySelector('#masterGainValue').textContent = `${event.target.value} dB`;
  });
  document.querySelector('#bpm').addEventListener('input', (event) => {
    state.project.bpm = Number(event.target.value);
    drawRuler();
  });
}

function bindIo() {
  document.querySelector('#saveBtn').addEventListener('click', () => {
    state.snapshot = takeSnapshot(state.project);
    localStorage.setItem('soundscape.project', serializeProject(state.project));
    localStorage.setItem('soundscape.snapshot', JSON.stringify(state.snapshot));
    flashMessage('工程与快照已保存到 localStorage');
  });
  document.querySelector('#restoreBtn').addEventListener('click', () => {
    const text = localStorage.getItem('soundscape.project');
    const snapshotText = localStorage.getItem('soundscape.snapshot');
    if (!text || !snapshotText) {
      flashMessage('没有可恢复的快照，请先保存', true);
      return;
    }
    state.project = parseProject(text);
    const restored = takeSnapshot(state.project);
    const saved = JSON.parse(snapshotText);
    const keys = Object.keys(saved).filter((key) => JSON.stringify(saved[key]) !== JSON.stringify(restored[key]));
    redraw();
    renderInspector();
    flashMessage(keys.length ? `恢复存在差异：${keys.join(',')}` : '快照恢复一致：节拍、声像、增益全部匹配');
  });
  document.querySelector('#exportBtn').addEventListener('click', () => {
    const result = renderTimeline(state.project, state.sources);
    const bytes = encodeWav(result.channels, SAMPLE_RATE);
    const blob = new Blob([bytes], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'soundscape-20s.wav';
    link.click();
    URL.revokeObjectURL(url);
    flashMessage(`已导出 ${bytes.length} 字节，峰值 ${gainToDb(result.postPeak).toFixed(1)} dBFS（无削波）`);
  });
}

function redraw() {
  drawRuler();
  drawAllTracks();
  drawAutomation();
  refreshStatus();
}

function init() {
  buildTracks();
  bindAutomationDrag();
  bindTransport();
  bindIo();
  renderInspector();
  redraw();
  globalThis.addEventListener('resize', redraw);
}

init();
