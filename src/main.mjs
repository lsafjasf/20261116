import { WINDOWS, STATIONS } from './core/constants.mjs';
import { Store } from './core/store.mjs';
import { datasetA } from './data/datasetA.mjs';
import { datasetB } from './data/datasetB.mjs';
import { drawChart } from './render/chart-canvas.mjs';
import { drawMap } from './render/map-canvas.mjs';
import { drawReadout } from './render/readout-canvas.mjs';
import { drawDebug } from './render/debug-canvas.mjs';
import { buildReport, saveProject, loadProject } from './core/export-project.mjs';

const datasets = { A: datasetA, B: datasetB };
const store = new Store(datasets, 'A');

const els = {
  datasetSel: document.querySelector('#datasetSel'),
  windowSel: document.querySelector('#windowSel'),
  cursorRange: document.querySelector('#cursorRange'),
  cursorLabel: document.querySelector('#cursorLabel'),
  stationBox: document.querySelector('#stationBox'),
  markBtn: document.querySelector('#markBtn'),
  exportBtn: document.querySelector('#exportBtn'),
  saveBtn: document.querySelector('#saveBtn'),
  loadBtn: document.querySelector('#loadBtn'),
  loadFile: document.querySelector('#loadFile'),
  status: document.querySelector('#status')
};

const canvases = {
  chart: document.querySelector('#chartCanvas'),
  map: document.querySelector('#mapCanvas'),
  readout: document.querySelector('#readoutCanvas'),
  debug: document.querySelector('#debugCanvas')
};

for (const [id, w] of Object.entries(WINDOWS)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = w.label;
  els.windowSel.appendChild(opt);
}

for (const station of STATIONS) {
  const lab = document.createElement('label');
  lab.innerHTML = `<input type="checkbox" data-station="${station.id}" checked /> ${station.id}`;
  els.stationBox.appendChild(lab);
}

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

function render(snapshot) {
  const chart = fitCanvas(canvases.chart);
  const map = fitCanvas(canvases.map);
  const readout = fitCanvas(canvases.readout);
  const debug = fitCanvas(canvases.debug);
  drawChart(chart.ctx, { width: chart.w, height: chart.h, snapshot });
  drawMap(map.ctx, { width: map.w, height: map.h, snapshot });
  drawReadout(readout.ctx, { width: readout.w, height: readout.h, snapshot });
  drawDebug(debug.ctx, { width: debug.w, height: debug.h, snapshot });

  els.cursorRange.min = snapshot.window.start;
  els.cursorRange.max = snapshot.window.end;
  els.cursorRange.value = snapshot.cursorHour;
  els.cursorLabel.textContent = `${String(snapshot.cursorHour).padStart(2, '0')}:00`;
  els.windowSel.value = snapshot.windowId;
  els.datasetSel.value = snapshot.dataset.id;
  document.querySelectorAll('input[data-station]').forEach((cb) => {
    cb.checked = snapshot.selectedStations.includes(cb.dataset.station);
  });
  els.status.textContent =
    `${snapshot.dataset.version} · 窗口 ${snapshot.windowId} · 游标 ${snapshot.cursorHour}时`;
  window.__DEBUG__ = snapshot.debugLog;
}

store.subscribe(render);

els.datasetSel.addEventListener('change', (e) => store.setDataset(e.target.value));
els.windowSel.addEventListener('change', (e) => store.setWindow(e.target.value));
els.cursorRange.addEventListener('input', (e) => store.setCursor(Number(e.target.value)));
els.stationBox.addEventListener('change', (e) => {
  if (e.target.dataset.station) store.toggleStation(e.target.dataset.station);
});

// 在曲线或地图时间条上按下/拖动，均通过统一映射换算为游标小时
function bindDrag(canvas, hit) {
  const handler = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const hour = hit(x, rect.width);
    if (hour !== null) store.setCursor(hour);
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    handler(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons === 1) handler(e);
  });
}

bindDrag(canvases.chart, (x, width) => {
  const snap = store.snapshot();
  const padding = { left: 52, right: 16 };
  const usable = width - padding.left - padding.right;
  const span = snap.window.end - snap.window.start;
  const h = snap.window.start + ((x - padding.left) / usable) * span;
  return Math.max(snap.window.start, Math.min(snap.window.end, Math.round(h)));
});
bindDrag(canvases.map, (x, width) => {
  const snap = store.snapshot();
  const padding = { left: 40, right: 16 };
  const usable = width - padding.left - padding.right;
  const span = snap.window.end - snap.window.start;
  const h = snap.window.start + ((x - padding.left) / usable) * span;
  return Math.max(snap.window.start, Math.min(snap.window.end, Math.round(h)));
});

els.markBtn.addEventListener('click', () => {
  const sid = store.selectedStations[0];
  store.toggleManualMark(sid, 'tempC', store.cursorHour);
});

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

els.exportBtn.addEventListener('click', () => {
  const report = buildReport(store.snapshot());
  download(`meteo-report-${store.dataset.id}-${store.windowId}.json`,
    JSON.stringify(report, null, 2));
  store.pushDebug('recompute', { reason: 'export',
    cursorHour: store.cursorHour,
    gapCount: store.stats.gaps.length, peakCount: store.stats.peaks.length,
    objectCount: report.integrity.objectCount, checksum: report.integrity.checksum });
});

els.saveBtn.addEventListener('click', () => {
  download(`meteo-project-${store.dataset.id}.json`, saveProject(store.snapshot()));
});

els.loadBtn.addEventListener('click', () => els.loadFile.click());
els.loadFile.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const state = loadProject(await file.text());
  store.setDataset(state.datasetId, { silent: true });
  store.windowId = state.windowId;
  store.window = WINDOWS[state.windowId];
  store.selectedStations = state.selectedStations;
  store.manualMarks = state.manualMarks;
  store.cursorHour = Math.max(store.window.start,
    Math.min(store.window.end, state.cursorHour));
  store.recompute({ reason: 'project-load' });
});

render(store.snapshot());
