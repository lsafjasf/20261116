import { Recorder, hashState, restoreSession, ReplayPlayer, analyzeOrderConflicts } from '../src/core/timeline.js';
import { runSuccessSession, runFailureSession } from '../src/sim/bots.js';
import { buildConflictScenario } from '../src/sim/conflict.js';
import { WORLD, DANGERS } from '../src/core/world.js';
import { Pane } from './renderer.js';
import { SoundBoard } from './audio.js';

const STORAGE_KEY = 'disaster-collab-session-v1';
const sound = new SoundBoard();
const leftCanvas = document.querySelector('#canvas-left');
const rightCanvas = document.querySelector('#canvas-right');
const leftPane = new Pane(leftCanvas, 'left');
const rightPane = new Pane(rightCanvas, 'right');

let recorder = new Recorder();
let player = null;
let replayTimer = null;
let replaySpeed = 1;
let lastFrame = performance.now();
let lastPersistAt = 0;

const $ = (selector) => document.querySelector(selector);

function currentState() {
  return player ? player.state : recorder.state;
}

function stopReplay() {
  if (replayTimer) clearInterval(replayTimer);
  replayTimer = null;
  player = null;
}

function bindReplay() {
  $('#replay-pause').addEventListener('click', () => {
    if (replayTimer) {
      clearInterval(replayTimer);
      replayTimer = null;
    }
  });
  $('#replay-step').addEventListener('click', () => {
    if (!player) return;
    if (replayTimer) {
      clearInterval(replayTimer);
      replayTimer = null;
    }
    player.step();
    updateHud();
  });
  $('#replay-speed').addEventListener('change', (event) => {
    replaySpeed = Number(event.target.value);
    if (replayTimer) startReplayLoop();
  });
  $('#replay-play').addEventListener('click', startReplayLoop);
}

function startReplayLoop() {
  if (!player) return;
  if (replayTimer) clearInterval(replayTimer);
  replayTimer = setInterval(() => {
    const steps = replaySpeed >= 2 ? replaySpeed : 1;
    for (let i = 0; i < steps; i += 1) {
      const event = player.step();
      if (!event) break;
    }
    updateHud();
    if (player.finished) {
      clearInterval(replayTimer);
      replayTimer = null;
      $('#replay-final').textContent =
        `回放终态哈希 ${player.finalHash}；当前哈希 ${player.currentHash}；一致=${player.finalHash === player.currentHash}`;
    }
  }, 250);
}

function updateHud() {
  const state = currentState();
  $('#clock').textContent = `${(state.clock / 1000).toFixed(1)}s / ${WORLD.durationMs / 1000}s`;
  $('#score').textContent = state.score;
  $('#status').textContent = state.status;
  $('#progress').textContent = `${state.verifiedDangers.length}/${DANGERS.length}`;
  $('#left-durability').style.width = `${state.players.left.durability}%`;
  $('#right-durability').style.width = `${state.players.right.durability}%`;
  $('#left-meta').textContent =
    `得分 ${state.players.left.score} · 标记 ${state.players.left.markersPlaced} · 连路 ${state.players.left.streakRoad || '-'}×${state.players.left.streak}`;
  $('#right-meta').textContent =
    `得分 ${state.players.right.score} · 验证 ${state.players.right.verifications} · 路线 ${state.routes.filter((r) => r.accepted).length}/2`;
  $('#hash').textContent = hashState(state);
}

function restore() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const restored = restoreSession(raw);
    recorder.state = restored.state;
    $('#event-feed').innerHTML = '<div class="ok">已从本地快照恢复，校验通过</div>';
  } catch (error) {
    $('#event-feed').innerHTML = `<div class="bad">${error.message}</div>`;
  }
}

function frame(now) {
  const dt = Math.min(50, now - lastFrame);
  lastFrame = now;
  const state = currentState();
  if (!player && state.status === 'running') {
    recorder.commit({ type: 'tick', dt, t: state.clock });
    persistThrottled(state.clock);
  }
  leftPane.autoZoom(state.clock);
  rightPane.autoZoom(state.clock);
  leftPane.render(state);
  rightPane.render(state);
  updateHud();
  requestAnimationFrame(frame);
}

function boot() {
  leftPane.resize();
  rightPane.resize();
  window.addEventListener('resize', () => {
    leftPane.resize();
    rightPane.resize();
  });
  restore();
  bindInput();
  bindReplay();
  requestAnimationFrame(frame);
}

boot();

function persist() {
  if (player) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(recorder.snapshot()));
}

function persistThrottled(clock) {
  if (clock - lastPersistAt >= 1000) {
    lastPersistAt = clock;
    persist();
  }
}

function commit(event) {
  sound.ensure();
  const result = recorder.commit(event);
  persist();
  if (result.accepted) {
    if (event.type === 'verify') result.approved ? sound.verify() : sound.reject();
    else if (event.type === 'finishRoute') sound.route();
    else if (event.type === 'undo') sound.undo();
    else sound.confirm();
  } else {
    sound.reject();
  }
  logEvent(event, result);
  updateHud();
  return result;
}

function logEvent(event, result) {
  const line = document.createElement('div');
  line.className = result.accepted ? 'ok' : 'bad';
  line.textContent = `t=${(event.t / 1000).toFixed(1)}s ${event.side || 'sys'} ${event.type} ${JSON.stringify(result)}`;
  const feed = $('#event-feed');
  feed.prepend(line);
  while (feed.children.length > 60) feed.lastChild.remove();
}

function bindInput() {
  leftCanvas.addEventListener('click', (event) => {
    if (player) return;
    const point = leftPane.toWorld(event);
    commit({ type: 'placeMarker', side: 'left', x: Math.round(point.x), y: Math.round(point.y), t: recorder.state.clock });
  });
  rightCanvas.addEventListener('click', (event) => {
    if (player) return;
    const point = rightPane.toWorld(event);
    if (event.shiftKey) {
      commit({ type: 'addWaypoint', side: 'right', x: Math.round(point.x), y: Math.round(point.y), t: recorder.state.clock });
    } else {
      const target = recorder.state.markers
        .filter((marker) => !marker.verified && !marker.rejected)
        .map((marker) => ({ marker, d: Math.hypot(marker.x - point.x, marker.y - point.y) }))
        .filter((item) => item.d <= WORLD.snapRadius * 1.4)
        .sort((a, b) => a.d - b.d)[0];
      if (!target) return logEvent({ side: 'right', type: 'verify', t: recorder.state.clock }, { accepted: false, reason: 'no_marker_near_click' });
      commit({ type: 'verify', side: 'right', markerId: target.marker.id, approve: true, t: recorder.state.clock });
    }
  });

  $('#undo-left').addEventListener('click', () =>
    commit({ type: 'undo', side: 'left', t: recorder.state.clock }));
  $('#undo-right').addEventListener('click', () =>
    commit({ type: 'undo', side: 'right', t: recorder.state.clock }));
  $('#finish-route').addEventListener('click', () =>
    commit({ type: 'finishRoute', side: 'right', name: `路线#${recorder.state.routes.length + 1}`, t: recorder.state.clock }));
  $('#reset').addEventListener('click', () => {
    stopReplay();
    localStorage.removeItem(STORAGE_KEY);
    recorder = new Recorder();
    $('#event-feed').innerHTML = '';
    $('#replay-panel').hidden = true;
    $('#conflict-panel').hidden = true;
    $('#replay-final').textContent = '';
    updateHud();
  });

  $('#demo-success').addEventListener('click', () => loadDemo(runSuccessSession().recorder));
  $('#demo-failure').addEventListener('click', () => loadDemo(runFailureSession().recorder));
  $('#demo-conflict').addEventListener('click', showConflictDemo);
}

function loadDemo(demoRecorder) {
  stopReplay();
  recorder = demoRecorder;
  player = new ReplayPlayer(recorder.state.timeline);
  $('#replay-panel').hidden = false;
  updateHud();
}

function showConflictDemo() {
  const scenario = buildConflictScenario();
  const panel = $('#conflict-panel');
  panel.hidden = false;
  panel.innerHTML = scenario.conflicts.map((c) => `
    <h3>冲突 t=${(c.t / 1000).toFixed(1)}s · 对象 ${c.position}</h3>
    <p>先发生：${c.first.side}/${c.first.type}；交换后：${c.second.side}/${c.second.type}</p>
    <pre>${JSON.stringify({ baseline: c.baseline, reordered: c.reordered }, null, 2)}</pre>
  `).join('');
}
