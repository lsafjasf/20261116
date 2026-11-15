// 前端：Canvas 渲染 + Web Audio + 输入采集 + 回放 + 本地存档
import {
  createGame, step, platePos, WORLD, serialize, deserialize,
  inputEventsOf, replayWithSnapshots,
} from './sim.js';

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const $ = (id) => document.getElementById(id);
const SAVE_KEY = 'bridge-install-save-v1';

// ---------- Web Audio：张力驱动音调 ----------
let audio = null;
function ensureAudio() {
  if (audio) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ac = new AC();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sawtooth';
  gain.gain.value = 0;
  osc.connect(gain).connect(ac.destination);
  osc.start();
  audio = { ac, osc, gain };
}
function updateAudio(tension, status) {
  if (!audio) return;
  const t = Math.min(24, tension);
  audio.osc.frequency.value = 70 + t * 14;
  audio.gain.gain.value = (status === 'playing') ? 0.015 + t * 0.004 : 0;
}
function beep(freq, dur = 0.15) {
  if (!audio) return;
  const { ac } = audio;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.12, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
  o.connect(g).connect(ac.destination);
  o.start(); o.stop(ac.currentTime + dur);
}

// ---------- 渲染 ----------
function drawScene(view) {
  // view: {pos, theta, anchor, len, stage, connected, status, vehicleX, fallY}
  ctx.clearRect(0, 0, WORLD.width, WORLD.height);
  // 背景
  ctx.fillStyle = '#16202f';
  ctx.fillRect(0, WORLD.supportY, WORLD.width, WORLD.height - WORLD.supportY);
  // 支撑墩
  for (let i = 0; i < 3; i++) {
    const x = WORLD.targets[i];
    ctx.fillStyle = '#3a4a66';
    ctx.fillRect(x - 26, WORLD.supportY, 52, WORLD.height - WORLD.supportY);
    ctx.fillStyle = '#55688c';
    ctx.fillRect(x - 34, WORLD.supportY - 8, 68, 8);
  }
  // 已安装桥段
  ctx.fillStyle = '#7f95b8';
  for (let i = 0; i < 3; i++) {
    if (view.connected[i] !== null && view.connected[i] !== undefined) {
      ctx.fillRect(WORLD.targets[i] - WORLD.plateW / 2, WORLD.supportY - WORLD.plateH,
        WORLD.plateW, WORLD.plateH);
    }
  }
  // 吊点小车
  ctx.fillStyle = '#c8d4ea';
  ctx.fillRect(view.anchor.x - 16, view.anchor.y - 12, 32, 12);
  // 吊索
  if (view.status === 'playing' && view.stage < 3) {
    ctx.strokeStyle = '#e8d27a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(view.anchor.x, view.anchor.y);
    ctx.lineTo(view.pos.x, view.pos.y - WORLD.plateH / 2);
    ctx.stroke();
  }
  // 桥板（随摆角旋转）
  if (view.status === 'playing' && view.stage < 3) {
    ctx.save();
    ctx.translate(view.pos.x, view.pos.y);
    ctx.rotate(-view.theta);
    ctx.fillStyle = '#9fb6dd';
    ctx.fillRect(-WORLD.plateW / 2, -WORLD.plateH / 2, WORLD.plateW, WORLD.plateH);
    ctx.fillStyle = '#6b82ab';
    ctx.fillRect(-WORLD.plateW / 2, -WORLD.plateH / 2, WORLD.plateW, 3);
    ctx.restore();
  }
  // 坠落动画
  if (view.status === 'failed' && view.fallY !== undefined) {
    ctx.fillStyle = '#8a4a4a';
    ctx.fillRect(view.pos.x - WORLD.plateW / 2, view.fallY, WORLD.plateW, WORLD.plateH);
  }
  // 车辆
  if (view.status === 'vehicle' || view.status === 'success') {
    const vx = view.vehicleX;
    ctx.fillStyle = '#5fd68a';
    ctx.fillRect(vx, WORLD.supportY - WORLD.plateH - 22, 46, 16);
    ctx.fillStyle = '#2c3a2f';
    ctx.beginPath();
    ctx.arc(vx + 10, WORLD.supportY - WORLD.plateH - 4, 5, 0, 7);
    ctx.arc(vx + 36, WORLD.supportY - WORLD.plateH - 4, 5, 0, 7);
    ctx.fill();
  }
}

// ---------- 仪表 ----------
function updateGauges(g) {
  $('tensionVal').textContent = `${g.tension.toFixed(1)} kN`;
  $('tensionBar').firstElementChild.style.width = `${Math.min(100, g.tension / 24 * 100)}%`;
  $('durabilityVal').textContent = `${Math.round(g.durability)} / 100`;
  $('durabilityBar').firstElementChild.style.width = `${g.durability}%`;
  $('windVal').textContent = `${g.wind.toFixed(1)} m/s`;
  $('tempVal').textContent = `${g.temp.toFixed(1)} °C`;
  $('tolVal').textContent = `±${g.tolerance.toFixed(0)} px`;
  $('dots').textContent = [0, 1, 2].map((i) =>
    (g.connected[i] !== null && g.connected[i] !== undefined) ? '●' : '○').join(' ');
  const s = $('status');
  if (g.status === 'success') { s.textContent = '✅ 车辆安全通过，任务成功！'; s.style.color = '#7fe6a0'; }
  else if (g.status === 'failed') { s.textContent = `❌ ${g.failReason}`; s.style.color = '#ff8a8a'; }
  else if (g.status === 'vehicle') { s.textContent = '车辆通行中…'; s.style.color = '#dfe7f2'; }
  else { s.textContent = `安装第 ${g.stage + 1} / 3 个连接点`; s.style.color = '#dfe7f2'; }
  if (g.conflicts.length) {
    const c = g.conflicts[g.conflicts.length - 1];
    $('conflict').textContent =
      `⚠ 冲突 @tick ${c.tick}：${c.actions.join(' 与 ')}，桥板位置 (${c.pos.x}, ${c.pos.y})，摆角 ${c.pos.theta}`;
  }
}

// ---------- 实时模式 ----------
let game = null;
let liveEvents = [];
let fallY = null;

function newGame(clearSave = true) {
  game = createGame(1);
  liveEvents = [];
  fallY = null;
  if (clearSave) localStorage.removeItem(SAVE_KEY);
}

function pushInput(player, type) {
  if (mode !== 'live') return;
  if (game.status !== 'playing') return;
  ensureAudio();
  const ev = { tick: game.tick, player, type };
  liveEvents.push(ev);
}

const keyMap = {
  KeyS: ['L', 'lower'], KeyW: ['L', 'raise'], KeyE: ['L', 'unhook'],
  ArrowLeft: ['R', 'moveL'], ArrowRight: ['R', 'moveR'], Enter: ['R', 'unhook'],
};
const held = new Set();
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const m = keyMap[e.code];
  if (!m) return;
  e.preventDefault();
  held.add(e.code);
  pushInput(m[0], m[1]);
});
window.addEventListener('keyup', (e) => {
  const m = keyMap[e.code];
  if (!m) return;
  held.delete(e.code);
  if (e.code === 'KeyS' && !held.has('KeyW')) pushInput('L', 'hold');
  if (e.code === 'KeyW' && !held.has('KeyS')) pushInput('L', 'hold');
  if (e.code === 'ArrowLeft' && !held.has('ArrowRight')) pushInput('R', 'moveStop');
  if (e.code === 'ArrowRight' && !held.has('ArrowLeft')) pushInput('R', 'moveStop');
});

// ---------- 主循环（实时模式固定步长推进） ----------
let mode = 'live';
let acc = 0;
let lastTs = 0;
const STEP_MS = 1000 / 60;
let lastTimelineLen = 0;

function liveFrame(ts) {
  if (mode !== 'live') return;
  acc += Math.min(100, ts - lastTs);
  lastTs = ts;
  while (acc >= STEP_MS) {
    acc -= STEP_MS;
    if (game.status === 'playing' || game.status === 'vehicle') {
      step(game, liveEvents);
    } else if (game.status === 'failed' && game.fall) {
      fallY = (fallY ?? platePos(game).y) + game.fall.vy * (1 / 60);
      game.fall.vy += WORLD.g * (1 / 60);
    }
  }
  // 新系统事件音效
  for (let i = lastTimelineLen; i < game.timeline.length; i++) {
    const ev = game.timeline[i];
    if (ev.type === 'connect') beep(660, 0.2);
    if (ev.type === 'collision') beep(140, 0.3);
    if (ev.type === 'fall') beep(90, 0.6);
    if (ev.type === 'vehiclePass') beep(880, 0.4);
  }
  lastTimelineLen = game.timeline.length;

  const p = platePos(game);
  drawScene({
    pos: p, theta: game.theta, anchor: game.anchor, len: game.len,
    stage: game.stage, connected: game.connected, status: game.status,
    vehicleX: game.vehicle.x, fallY: fallY ?? undefined,
  });
  updateGauges(game);
  updateAudio(game.tension, game.status);
  // 定期存档
  if (game.tick % 60 === 0) saveGame();
}

function saveGame() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      ...JSON.parse(serialize(game)),
    }));
  } catch { /* 存储不可用时忽略 */ }
}
window.addEventListener('beforeunload', saveGame);

function restoreGame() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return false;
  try {
    game = deserialize(raw); // 确定性重放到存档 tick，仪表/耐久/进度全部恢复
    liveEvents = inputEventsOf(game);
    return true;
  } catch { return false; }
}

// ---------- 回放模式：暂停 / 单步 / 倍速均不改变最终状态 ----------
const replay = { snaps: [], idx: 0, playing: true, speed: 1, acc: 0, final: null };

function enterReplay() {
  const events = inputEventsOf(game);
  const { snaps, final } = replayWithSnapshots(game.seed, events);
  replay.snaps = snaps;
  replay.final = final;
  replay.idx = 0;
  replay.playing = true;
  replay.speed = 1;
  replay.acc = 0;
  mode = 'replay';
  $('replayBar').style.display = 'block';
  $('btnPlayPause').textContent = '暂停';
}

function exitReplay() {
  mode = 'live';
  $('replayBar').style.display = 'none';
  lastTs = performance.now();
}

function replayFrame(ts) {
  if (mode !== 'replay') return;
  if (replay.playing) {
    replay.acc += Math.min(100, ts - lastTs) * replay.speed;
    lastTs = ts;
    while (replay.acc >= STEP_MS && replay.idx < replay.snaps.length - 1) {
      replay.acc -= STEP_MS;
      replay.idx++;
    }
  } else {
    lastTs = ts;
  }
  const s = replay.snaps[replay.idx];
  if (!s) return;
  drawScene({
    pos: s.pos, theta: s.theta, anchor: s.anchor, len: s.len,
    stage: s.stage, connected: s.connected, status: s.status,
    vehicleX: s.vehicleX, fallY: s.status === 'failed' ? s.pos.y : undefined,
  });
  updateGauges({
    ...s, conflicts: game.conflicts,
  });
  $('replayInfo').textContent =
    `回放 tick ${s.tick} / ${replay.snaps.length} · 倍速 ${replay.speed}x` +
    (replay.final ? ` · 终局：${replay.final.status}` : '');
}

// ---------- 按钮与启动 ----------
$('btnReset').addEventListener('click', () => { exitReplay(); newGame(); });
$('btnReplay').addEventListener('click', () => { ensureAudio(); enterReplay(); });
$('btnExitReplay').addEventListener('click', exitReplay);
$('btnPlayPause').addEventListener('click', () => {
  replay.playing = !replay.playing;
  $('btnPlayPause').textContent = replay.playing ? '暂停' : '播放';
});
$('btnStep').addEventListener('click', () => {
  replay.playing = false;
  $('btnPlayPause').textContent = '播放';
  if (replay.idx < replay.snaps.length - 1) replay.idx++;
});
$('btnSpeed').addEventListener('click', () => {
  const speeds = [0.5, 1, 2, 4];
  replay.speed = speeds[(speeds.indexOf(replay.speed) + 1) % speeds.length];
  $('btnSpeed').textContent = `倍速 ${replay.speed}x`;
});

if (!restoreGame()) newGame(false);

function frame(ts) {
  if (!lastTs) lastTs = ts;
  liveFrame(ts);
  replayFrame(ts);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
