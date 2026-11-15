import { N, defaultParams, orderParameter, beatTimes, snapshotOf } from './sim.js';
import { AudioEngine } from './audio.js';
import { renderOffline } from './export.js';

const engine = new AudioEngine();
const params = defaultParams();
const $ = (id) => document.getElementById(id);
const sliders = ['coupling', 'phaseOffset', 'damping', 'baseFreq'];
const diag = (msg) => { $('diag').textContent = '诊断：' + msg; };

// ---- parameter wiring (single listener per slider, guarded rebind) ----
const bound = new Set();
function bindSliders() {
  for (const id of sliders) {
    if (bound.has(id)) continue;
    bound.add(id);
    $(id).addEventListener('input', (e) => {
      params[id] = parseFloat(e.target.value);
      if (engine.sim) engine.sim.params[id] = params[id];
      refreshLabels();
    });
  }
}
function refreshLabels() {
  for (const id of sliders) {
    $(id).value = params[id];
    document.querySelector(`[data-val="${id}"]`).textContent = Number(params[id]).toFixed(2);
  }
}

// ---- transport ----
async function start() {
  const ok = await engine.start(params);
  if (!ok) diag('重复启动被忽略（幂等保护）');
  else diag('运行中');
  updateButtons();
}
async function stop() {
  await engine.stop();
  diag(`已停止：释放节点后剩余 ${engine.activeNodeCount} 个（共享 3 个保留）`);
  updateButtons();
}
async function pauseToggle() {
  if (engine.ctx && engine.ctx.state === 'running') { await engine.pause(); diag('已暂停'); }
  else { await engine.resume(); diag('已恢复'); }
  updateButtons();
}
async function reset() {
  await engine.dispose();
  Object.assign(params, defaultParams());
  refreshLabels();
  diag('已重置：AudioContext 关闭，节点与监听器全部释放');
  updateButtons();
}
function updateButtons() {
  $('btnStart').disabled = engine.running;
  $('btnStop').disabled = !engine.running && !(engine.ctx && engine.sim);
  $('btnPause').disabled = !(engine.ctx && engine.sim);
  $('btnPause').textContent = engine.ctx && engine.ctx.state === 'suspended' ? '▶ 继续' : '⏸ 暂停';
}
bindSliders();
$('btnStart').addEventListener('click', start);
$('btnStop').addEventListener('click', stop);
$('btnPause').addEventListener('click', pauseToggle);
$('btnReset').addEventListener('click', reset);

// ---- demo: stable -> complex -> stable (12s scripted sweep) ----
let demoId = null;
function runDemo() {
  if (demoId !== null) { cancelAnimationFrame(demoId); demoId = null; diag('演示已取消'); return; }
  const t0 = performance.now();
  const DUR = 12000;
  diag('演示进行中：稳定 → 复杂 → 稳定');
  const step = () => {
    const t = (performance.now() - t0) / DUR;
    if (t >= 1) {
      Object.assign(params, { coupling: 0.6, phaseOffset: 0, damping: 0.35 });
      applyParams(); demoId = null; diag('演示结束：回到稳定节拍'); return;
    }
    // Three phases: locked (low K, no lag) -> chaotic (high K, lag, low damping) -> back.
    const seg = t < 0.33 ? 0 : t < 0.66 ? 1 : 2;
    const u = seg === 0 ? t / 0.33 : seg === 1 ? (t - 0.33) / 0.33 : (t - 0.66) / 0.34;
    const lerp = (a, b, x) => a + (b - a) * x;
    if (seg === 0) {
      params.coupling = lerp(0.6, 1.2, u); params.phaseOffset = lerp(0, 0.8, u); params.damping = lerp(0.35, 0.2, u);
    } else if (seg === 1) {
      params.coupling = lerp(1.2, 1.9, u); params.phaseOffset = lerp(0.8, 2.4, u); params.damping = lerp(0.2, 0.08, u);
    } else {
      params.coupling = lerp(1.9, 0.6, u); params.phaseOffset = lerp(2.4, 0, u); params.damping = lerp(0.08, 0.35, u);
    }
    applyParams();
    demoId = requestAnimationFrame(step);
  };
  demoId = requestAnimationFrame(step);
}
function applyParams() {
  if (engine.sim) for (const id of sliders) engine.sim.params[id] = params[id];
  refreshLabels();
}
$('btnDemo').addEventListener('click', runDemo);

// ---- snapshot save / restore ----
$('btnSave').addEventListener('click', () => {
  const snap = engine.sim ? engine.snapshot() : { params: { ...params }, tick: 0 };
  snap.savedAt = new Date().toISOString();
  localStorage.setItem('oscnet.snapshot', JSON.stringify(snap));
  diag(`快照已保存（tick=${snap.tick}）`);
});
$('btnLoad').addEventListener('click', async () => {
  const raw = localStorage.getItem('oscnet.snapshot');
  if (!raw) { diag('没有可恢复的快照'); return; }
  const snap = JSON.parse(raw);
  Object.assign(params, snap.params);
  refreshLabels();
  const wasRunning = engine.running;
  await engine.stop();
  await engine.start(params, snap);
  if (!wasRunning) await engine.pause();
  diag(`快照已恢复（tick=${snap.tick}），音场与保存时一致`);
  updateButtons();
});

// ---- export ----
$('btnExport').addEventListener('click', async () => {
  const snap = engine.sim ? engine.snapshot() : { params: { ...params }, tick: 0 };
  const { wav, duration } = await renderOffline(snap, 2.0);
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'oscnet-2s.wav'; a.click();
  URL.revokeObjectURL(url);
  diag(`已导出 WAV，时长 ${duration.toFixed(3)}s`);
});

// ---- canvas: network view ----
const netC = $('netCanvas'), netX = netC.getContext('2d');
function drawNetwork() {
  const W = netC.width, H = netC.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 40;
  netX.clearRect(0, 0, W, H);
  const sim = engine.sim;
  const pos = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2;
    pos.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  if (sim) {
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const w = Math.max(sim.topo[i][j], sim.topo[j][i]);
      if (!w) continue;
      netX.strokeStyle = `rgba(88,166,255,${0.15 + 0.5 * w * sim.params.coupling / 2})`;
      netX.lineWidth = 1 + 3 * w * sim.params.coupling / 2;
      netX.beginPath(); netX.moveTo(...pos[i]); netX.lineTo(...pos[j]); netX.stroke();
    }
  }
  for (let i = 0; i < N; i++) {
    const amp = sim ? sim.amps[i] : 0.4;
    const r = 8 + 14 * amp;
    netX.fillStyle = sim ? `hsl(${210 - 160 * amp},80%,60%)` : '#30363d';
    netX.beginPath(); netX.arc(pos[i][0], pos[i][1], r, 0, Math.PI * 2); netX.fill();
    if (sim) {
      const pa = sim.phases[i];
      netX.strokeStyle = '#e6edf3'; netX.lineWidth = 2;
      netX.beginPath(); netX.moveTo(pos[i][0], pos[i][1]);
      netX.lineTo(pos[i][0] + r * Math.cos(pa), pos[i][1] + r * Math.sin(pa)); netX.stroke();
    }
    netX.fillStyle = '#8b949e'; netX.font = '10px sans-serif';
    netX.fillText(String(i), pos[i][0] - 3, pos[i][1] - r - 4);
  }
}

// ---- canvas: waveform ----
const wavC = $('waveCanvas'), wavX = wavC.getContext('2d');
function drawWave() {
  const W = wavC.width, H = wavC.height;
  wavX.clearRect(0, 0, W, H);
  wavX.strokeStyle = '#30363d'; wavX.beginPath(); wavX.moveTo(0, H / 2); wavX.lineTo(W, H / 2); wavX.stroke();
  const data = engine.waveform();
  if (!data.length) return;
  wavX.strokeStyle = '#3fb950'; wavX.lineWidth = 1.5; wavX.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i / data.length) * W, y = H / 2 - data[i] * H * 0.9;
    i === 0 ? wavX.moveTo(x, y) : wavX.lineTo(x, y);
  }
  wavX.stroke();
}

// ---- status loop ----
function refreshStatus() {
  $('stCtx').textContent = engine.ctx ? engine.ctx.state : 'closed';
  $('stSched').textContent = engine.running ? 'running' : 'stopped';
  $('stNodes').textContent = engine.activeNodeCount;
  $('stListeners').textContent = engine.activeListenerCount;
  $('stTick').textContent = engine.sim ? engine.sim.tick : 0;
  $('stOrder').textContent = engine.sim ? orderParameter(engine.sim).toFixed(3) : '—';
  $('stRms').textContent = engine.ctx ? engine.rms().toFixed(4) : '—';
  $('stCycles').textContent = `${engine.stats.starts} / ${engine.stats.stops}`;
  drawNetwork(); drawWave();
  requestAnimationFrame(refreshStatus);
}
refreshLabels(); refreshStatus(); updateButtons();

// ---- test hook (used by automated verification) ----
window.__app = { engine, params, start, stop, pauseToggle, reset, runDemo, orderParameter, beatTimes, snapshotOf, renderOffline };
