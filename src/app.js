import * as C from './config.js';
import { Simulation } from './simulation.js';
import { Recording, Replayer } from './recorder.js';
import { saveGame, loadGame } from './storage.js';
import { Renderer } from './render.js';
import { AudioEngine } from './audio.js';
import { toCSV, toSVG, download } from './export.js';
import { analyzeOrderSensitivity } from './analysis.js';
import {
  createGatePlayer,
  createPumpPlayer,
  SCENARIOS
} from './controllers.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const renderer = new Renderer(canvas);
const audio = new AudioEngine();

let sim = new Simulation(C.DEFAULT_SEED);
let recording = null;
let replayer = null;
let mode = 'live'; // 'live' | 'replay'
let autoMode = false;
let autoGate = null;
let autoPump = null;
let autoCtx = { p1GateTick: -1 };
let rafId = null;
let lastFrame = performance.now();
let accumulator = 0;
let replaySpeed = 1;
let replayPlaying = false;
let lastCollisionCount = 0;
let lastAlarmState = false;

function currentScenario() {
  return $('scenario').value;
}

function freshSimulation() {
  sim = new Simulation(C.DEFAULT_SEED);
  recording = null;
  lastCollisionCount = 0;
  lastAlarmState = false;
  return sim;
}

function issueGate(value) {
  if (mode !== 'live' || sim.ended) return;
  sim.issueCommand('P1', 'gate_set', value);
}

function issuePump(value) {
  if (mode !== 'live' || sim.ended) return;
  sim.issueCommand('P2', 'pump_set', value);
}

// Real-time loop: fixed deterministic ticks driven by a frame accumulator.
function frame(now) {
  const current = typeof performance !== 'undefined' ? performance.now() : now;
  const dtMs = current - lastFrame;
  lastFrame = current;
  if (mode === 'live') {
    if (!sim.ended) {
      accumulator += dtMs;
      const tickMs = C.TICK_SECONDS * 1000;
      while (accumulator >= tickMs) {
        accumulator -= tickMs;
        if (autoMode) runAutoControllers();
        sim.step();
        handleAudioEvents();
      }
      if (sim.ended) finalizeLive();
    }
    renderer.draw(sim, recordingOrLiveTimeline(), sim.tick);
    updateStatusPanels();
  } else if (mode === 'replay') {
    if (replayPlaying && !replayer.sim.ended) {
      accumulator += dtMs;
      const tickMs = C.TICK_SECONDS * 1000 / replaySpeed;
      while (accumulator >= tickMs && !replayer.sim.ended) {
        accumulator -= tickMs;
        replayer.step();
      }
    }
    renderer.draw(replayer.sim, replayer.recording, replayer.sim.tick);
    updateReplayPanel();
  }
  rafId = requestAnimationFrame(frame);
}

function recordingOrLiveTimeline() {
  return recording ? recording : { timeline: sim.timeline, checkpoints: [] };
}

function runAutoControllers() {
  if (!autoGate) {
    const [gateStyle, pumpStyle] = SCENARIOS[currentScenario()];
    autoGate = createGatePlayer(gateStyle);
    autoPump = createPumpPlayer(gateStyle === 'order-demo' ? 'order-demo' : pumpStyle);
  }
  autoCtx.p1GateTick = -1;
  autoGate.act(sim, autoCtx);
  autoPump.act(sim, autoCtx);
}

function handleAudioEvents() {
  audio.update(sim.pressure, sim.pump.heat);
  const collisions = sim.timeline.events.filter(
    (e) => e.type === 'structural_collision'
  ).length;
  if (collisions > lastCollisionCount) audio.collision();
  lastCollisionCount = collisions;
  const alarming = sim.pressure >= C.PRESSURE_WARN;
  if (alarming && !lastAlarmState) audio.alarm();
  lastAlarmState = alarming;
}

function finalizeLive() {
  recording = Recording.capture(sim, currentScenario());
  const analysis = analyzeOrderSensitivity(recording);
  renderConflictList(analysis);
  drawChart(recording);
  $('replay-status').textContent =
    `录制完成：${recording.timeline.inputs.length} 条输入，` +
    `${recording.timeline.conflicts.length} 个冲突，最终哈希 ${recording.finalHash}，` +
    `顺序交换分叉=${analysis.reorderDiverges}`;
}

function updateStatusPanels() {
  $('p1-status').textContent =
    `tick=${sim.tick} t=${sim.simSeconds.toFixed(1)}s\n` +
    `上游=${sim.upstreamLevel.toFixed(2)}m 渠道=${sim.channelLevel.toFixed(2)}m\n` +
    `闸门目标=${Math.round(sim.gate.target * 100)}% 实际=${Math.round(sim.gate.position * 100)}%\n` +
    `在途指令=${sim.queue.filter((c) => c.type === 'gate_set').length} 压力=${sim.pressure.toFixed(2)}kPa`;
  $('p2-status').textContent =
    `泵速=${Math.round(sim.pump.speed * 100)}% 目标=${Math.round(sim.pump.target * 100)}%\n` +
    `机温=${sim.pump.heat.toFixed(0)}℃ 耐久=${sim.pump.durability}% 跳闸=${sim.pump.tripCount}\n` +
    `街区积水=${sim.streetDepth.toFixed(3)}m 抽水=${sim.pumpFlow.toFixed(2)}m³/s\n` +
    `在途指令=${sim.queue.filter((c) => c.type === 'pump_set').length}`;
}

function updateReplayPanel() {
  const r = replayer;
  $('rp-scrub').max = r.recording.finalSnapshot.tick;
  $('rp-scrub').value = r.sim.tick;
  $('replay-status').textContent =
    `回放 tick=${r.sim.tick}/${r.recording.finalSnapshot.tick} 倍速=${replaySpeed} ` +
    `播放=${replayPlaying} 速度变化只影响播放节奏，不改变状态`;
}

function renderConflictList(analysis) {
  const host = $('conflict-list');
  host.innerHTML = '';
  if (analysis.conflicts.length === 0) {
    host.innerHTML = '<div class="conflict-row">无同对象同时刻冲突</div>';
    return;
  }
  for (const cf of analysis.conflicts.slice(0, 40)) {
    const row = document.createElement('div');
    row.className = 'conflict-row';
    row.textContent =
      `t=${cf.simTime}s tick=${cf.tick} ${cf.object} @${cf.position} ` +
      `玩家=${cf.players.join('/')} 值=[${cf.values.join(',')}] ` +
      `顺序敏感=${cf.orderSensitive}`;
    host.appendChild(row);
  }
}

function drawChart(rec) {
  const chart = $('chart');
  const ctx = chart.getContext('2d');
  const metrics = rec.timeline.metrics;
  if (!metrics || metrics.length === 0) return;
  ctx.clearRect(0, 0, chart.width, chart.height);
  ctx.fillStyle = '#0d1420';
  ctx.fillRect(0, 0, chart.width, chart.height);
  const pad = 40;
  const tMax = metrics[metrics.length - 1].t;
  const pMax = Math.max(C.PRESSURE_CRITICAL * 1.3, ...metrics.map((m) => m.pressure));
  const x = (t) => pad + (t / tMax) * (chart.width - pad * 2);
  const y = (p) => chart.height - pad - (p / pMax) * (chart.height - pad * 2);
  ctx.strokeStyle = '#36b37e';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  metrics.forEach((m, i) => {
    if (i === 0) ctx.moveTo(x(m.t), y(m.pressure));
    else ctx.lineTo(x(m.t), y(m.pressure));
  });
  ctx.stroke();
  ctx.strokeStyle = '#f5a524';
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(pad, y(C.PRESSURE_WARN));
  ctx.lineTo(chart.width - pad, y(C.PRESSURE_WARN));
  ctx.stroke();
  ctx.strokeStyle = '#e5484d';
  ctx.beginPath();
  ctx.moveTo(pad, y(C.PRESSURE_CRITICAL));
  ctx.lineTo(chart.width - pad, y(C.PRESSURE_CRITICAL));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#8aa0b8';
  ctx.font = '11px monospace';
  ctx.fillText('压力 kPa', 8, 16);
  ctx.fillText('时间 s', chart.width - 60, chart.height - 10);
}

function enterReplay(rec) {
  mode = 'replay';
  replayer = new Replayer(Recording.parse(JSON.stringify(rec)));
  replayPlaying = true;
  accumulator = 0;
  renderConflictList(analyzeOrderSensitivity(rec));
  drawChart(rec);
  updateReplayPanel();
}

// ----- Controls -----
$('btn-start').addEventListener('click', () => {
  freshSimulation();
  mode = 'live';
  autoMode = false;
  autoGate = autoPump = null;
  accumulator = 0;
  lastFrame = performance.now();
});

$('btn-auto').addEventListener('click', () => {
  if (mode !== 'live') return;
  autoMode = !autoMode;
  autoGate = autoPump = null;
});

$('btn-audio').addEventListener('click', async () => {
  if (audio.enabled) {
    audio.stop();
    $('btn-audio').textContent = '开启音频';
  } else {
    await audio.start();
    $('btn-audio').textContent = '关闭音频';
  }
});

$('p1-gate').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('p1-gate-val').textContent = Math.round(v * 100) + '%';
  issueGate(v);
});

$('p2-pump').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('p2-pump-val').textContent = Math.round(v * 100) + '%';
  issuePump(v);
});

document.addEventListener('keydown', (e) => {
  const gateSlider = $('p1-gate');
  const pumpSlider = $('p2-pump');
  const bump = (slider, delta, apply) => {
    const v = Math.max(0, Math.min(1, Number(slider.value) + delta));
    slider.value = v;
    slider.dispatchEvent(new Event('input'));
    apply(v);
  };
  switch (e.key) {
    case 'q': bump(gateSlider, -0.1, issueGate); break;
    case 'e': bump(gateSlider, 0.1, issueGate); break;
    case '1': gateSlider.value = 0; gateSlider.dispatchEvent(new Event('input')); break;
    case '2': gateSlider.value = 1; gateSlider.dispatchEvent(new Event('input')); break;
    case ',': bump(pumpSlider, -0.1, issuePump); break;
    case '.': bump(pumpSlider, 0.1, issuePump); break;
    case 'o': pumpSlider.value = 0; pumpSlider.dispatchEvent(new Event('input')); break;
    case 'p': pumpSlider.value = 1; pumpSlider.dispatchEvent(new Event('input')); break;
  }
});

$('btn-save').addEventListener('click', () => {
  if (mode !== 'live') return;
  const payload = saveGame(sim, currentScenario());
  $('replay-status').textContent =
    `已保存：tick=${payload.progress.tick} 进度=${payload.progress.percent}% 哈希=${payload.snapshotHash}`;
});

$('btn-load').addEventListener('click', () => {
  const loaded = loadGame();
  if (!loaded) {
    $('replay-status').textContent = '没有可恢复的存档';
    return;
  }
  sim = loaded.sim;
  recording = loaded.recording;
  mode = 'live';
  autoMode = false;
  autoGate = autoPump = null;
  $('scenario').value = loaded.payload.scenario;
  $('replay-status').textContent =
    `已恢复：tick=${sim.tick} 耐久=${sim.pump.durability}% 进度=${loaded.payload.progress.percent}% ` +
    `渠道=${sim.channelLevel.toFixed(2)}m 机温=${sim.pump.heat.toFixed(0)}℃`;
  drawChart(recording);
});

$('rp-play').addEventListener('click', () => {
  if (!recording) {
    $('replay-status').textContent = '模拟尚未结束，结束后才能进入完整回放';
    return;
  }
  if (mode !== 'replay') enterReplay(recording);
  replayPlaying = !replayPlaying;
});

$('rp-step').addEventListener('click', () => {
  if (!recording) {
    $('replay-status').textContent = '模拟尚未结束，结束后才能单步回放';
    return;
  }
  if (mode !== 'replay') enterReplay(recording);
  replayPlaying = false;
  replayer.step();
});

$('rp-restart').addEventListener('click', () => {
  if (!recording) return;
  enterReplay(recording);
});

$('rp-speed').addEventListener('change', (e) => {
  replaySpeed = Number(e.target.value);
});

$('rp-scrub').addEventListener('input', (e) => {
  if (!recording) return;
  if (mode !== 'replay') enterReplay(recording);
  replayPlaying = false;
  replayer.seekFromCheckpoint(Number(e.target.value));
});

$('btn-csv').addEventListener('click', () => {
  if (!recording) return;
  download(`${currentScenario()}.pressure.csv`, toCSV(recording), 'text/csv');
});

$('btn-svg').addEventListener('click', () => {
  if (!recording) return;
  download(`${currentScenario()}.pressure.svg`, toSVG(recording), 'image/svg+xml');
});

rafId = requestAnimationFrame((t) => {
  lastFrame = t;
  frame(t);
});
