// Browser application: two-player keyboard input on one shared timeline,
// fixed-tick simulation loop, Canvas rendering, Web Audio beat, replay with
// pause / single-step / 2x, conflict log and reload persistence.

import {
  TICK_HZ,
  COLORS,
  SCRIPT,
  SHOW_END_TICK,
  createInitialState,
  step,
  emptyInput,
} from '../core/engine.js';
import { Recorder, verifyReplay, saveState, loadState, clearSave } from '../core/timeline.js';
import { successBot, failureBot } from '../core/bots.js';
import { Metronome } from './audio.js';
import { render, currentCueAt } from './render.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const ctx = canvas.getContext('2d');

const app = {
  mode: 'live', // live | replay
  state: createInitialState(),
  recorder: new Recorder({ mode: 'live' }),
  replay: null, // { frames, index, speed, verify, paused }
  paused: false,
  speed: 1,
  controller: null, // null = human; otherwise a bot function
  conflictMarkers: [],
  accumulator: 0,
  lastTime: performance.now(),
  metronome: null,
};

// Held-key state; edges are detected when a key transitions to pressed.
const held = new Set();
const edgeQueue = [];

const KEYMAP = {
  // Player 1 — master light + brightness.
  KeyW: ['p1', 'up'],
  KeyS: ['p1', 'down'],
  ShiftLeft: ['p1', 'flash'],
  KeyE: ['p1', 'power'],
  // Player 2 — gel + rig rotation.
  ArrowLeft: ['p2', 'left'],
  ArrowRight: ['p2', 'right'],
  ArrowUp: ['p2', 'color'],
  KeyL: ['p2', 'cut'],
};

window.addEventListener('keydown', (e) => {
  if (KEYMAP[e.code]) {
    e.preventDefault();
    if (!held.has(e.code)) edgeQueue.push(e.code);
    held.add(e.code);
  }
});
window.addEventListener('keyup', (e) => {
  if (KEYMAP[e.code]) {
    e.preventDefault();
    held.delete(e.code);
  }
});

function consumeEdge(code) {
  const i = edgeQueue.indexOf(code);
  if (i >= 0) {
    edgeQueue.splice(i, 1);
    return true;
  }
  return false;
}

function humanInput() {
  const input = emptyInput();
  if (held.has('KeyW')) input.p1.brightDeltaHold = 3;
  if (held.has('KeyS')) input.p1.brightDeltaHold = -3;
  input.p1.flashHold = held.has('ShiftLeft');
  input.p1.powerEdge = consumeEdge('KeyE');
  input.p2.leftHold = held.has('ArrowLeft');
  input.p2.rightHold = held.has('ArrowRight');
  input.p2.colorEdge = consumeEdge('ArrowUp');
  input.p2.cutEdge = consumeEdge('KeyL');
  return input;
}

async function ensureAudio() {
  if (app.metronome) return app.metronome;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  app.metronome = new Metronome(new AudioCtx(), { tickHz: TICK_HZ });
  return app.metronome;
}

function advanceLive() {
  const input = app.controller ? app.controller(app.state) : humanInput();
  const events = step(app.state, input);
  app.recorder.record(app.state.tick - 1, input, app.state, events);
  for (const ev of events) {
    if (ev.type === 'conflict') {
      app.conflictMarkers.push(ev);
      renderConflict(ev);
    }
  }
  if (app.state.status !== 'running') finishShow();
  saveState(localStorage, app.state);
}

function finishShow() {
  const banner = app.state.status === 'success' ? 'SHOW COMPLETE' : `FAILED: ${app.state.failReason}`;
  $('banner').textContent = banner;
  if (app.metronome) app.metronome.pause();
  $('download').disabled = false;
}

function fmtTick(tick) {
  const total = tick / TICK_HZ;
  const m = Math.floor(total / 60);
  const s = (total % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function updateGauges() {
  const s = app.state;
  $('p1-bright').value = s.brightness;
  $('p1-bright-val').textContent = Math.round(s.brightness);
  $('p1-power').textContent = s.power ? 'ON' : 'OFF';
  $('p1-dur').value = s.durabilityP1;
  $('p1-dur-val').textContent = Math.round(s.durabilityP1);
  $('p2-angle').value = s.angle + 70;
  $('p2-angle-val').textContent = `${Math.round(s.angle)}°`;
  $('p2-color').textContent = COLORS[s.colorIndex];
  $('p2-heat').value = s.heat;
  $('p2-heat-val').textContent = `${Math.round(s.heat)}%${s.overheated ? ' LOCKED' : ''}`;
  $('p2-dur').value = s.durabilityP2;
  $('p2-dur-val').textContent = Math.round(s.durabilityP2);
  const cue = currentCueAt(s.tick);
  $('cue-info').textContent = cue
    ? `Cue ${cue.index + 1}/10 · zone ${cue.targetZone + 1} · ${cue.targetColor}`
    : 'transition gap';
  $('progress').value = s.passed.filter(Boolean).length;
  $('clock').textContent = `${fmtTick(s.tick)} / ${fmtTick(SHOW_END_TICK)}`;
  $('status').textContent = s.status;
}

function draw() {
  const banner = app.paused ? 'PAUSED' : null;
  render(ctx, app.state, {
    markers: app.conflictMarkers,
    banner,
    bannerColor: '#ffd24a',
  });
  updateGauges();
}

function loop(now) {
  const frameMs = 1000 / TICK_HZ;
  app.accumulator += Math.min(now - app.lastTime, 250);
  app.lastTime = now;

  if (app.mode === 'live' && !app.paused && app.state.status === 'running') {
    while (app.accumulator >= frameMs) {
      app.accumulator -= frameMs;
      advanceLive();
      if (app.metronome) app.metronome.scheduleTick();
      if (app.state.status !== 'running') break;
    }
  } else if (app.mode === 'replay' && !app.replay.paused && app.replay.index < app.replay.frames.length) {
    // 2x consumes two recorded ticks per wall-clock batch; 1x consumes one.
    const batch = app.speed === 2 ? 2 : 1;
    while (app.accumulator >= frameMs && app.replay.index < app.replay.frames.length) {
      app.accumulator -= frameMs;
      let advanced = 0;
      for (let b = 0; b < batch && app.replay.index < app.replay.frames.length; b++) {
        app.replay.index += 1;
        advanced += 1;
      }
      // One beat per simulated tick, so 2x emits two beats per wall-clock tick.
      if (app.metronome) for (let k = 0; k < advanced; k++) app.metronome.scheduleTick();
    }
    syncReplayFrame();
  } else {
    app.accumulator = 0;
  }
  draw();
  requestAnimationFrame(loop);
}

function snapshotFromFrame(frame) {
  // Replay is visualised from recorded immutable frame data; the authoritative
  // state re-execution (and hash comparison) happens in verifyReplay().
  return {
    tick: frame.tick + 1,
    brightness: frame.brightness,
    power: frame.power,
    colorIndex: frame.colorIndex,
    angle: frame.angle,
    heat: frame.heat,
    overheated: frame.overheated,
    actor: { ...frame.actor },
    durabilityP1: frame.durabilityP1,
    durabilityP2: frame.durabilityP2,
    passed: [...frame.passed],
    lastEval: frame.lastEval ? { ...frame.lastEval } : null,
    status: frame.status,
  };
}

function syncReplayFrame() {
  const r = app.replay;
  if (!r || r.index === 0) return;
  const frame = r.frames[Math.min(r.index - 1, r.frames.length - 1)];
  app.state = { ...app.state, ...snapshotFromFrame(frame) };
  app.conflictMarkers = r.frames
    .slice(0, r.index)
    .flatMap((f) => f.events)
    .filter((e) => e.type === 'conflict');
  $('replay-pos').textContent = `${r.index}/${r.frames.length}`;
  if (r.index >= r.frames.length) {
    r.paused = true;
    $('replay-result').textContent =
      `final hash ${r.verify[r.speed === 2 ? '2x' : '1x'].finalHash} · ` +
      `1x/step/2x identical: ${r.verify.match}`;
  }
}

function startReplay(recorder) {
  app.mode = 'replay';
  app.replay = {
    frames: recorder.frames,
    index: 0,
    paused: true,
    verify: verifyReplay(recorder),
  };
  app.state = createInitialState();
  app.conflictMarkers = [];
  app.paused = false;
  $('replay-panel').hidden = false;
  $('replay-result').textContent =
    `hash check 1x:${app.replay.verify['1x'].match} step:${app.replay.verify.step.match} 2x:${app.replay.verify['2x'].match}`;
  renderAllConflicts(recorder);
}

function renderConflict(ev) {
  const li = document.createElement('li');
  li.textContent =
    `t=${fmtTick(ev.tick)} (tick ${ev.tick}) @ (${ev.object.x}, ${ev.object.y}) ` +
    `${ev.p1Action} vs ${ev.p2Action} — P1-first=>${ev.resultIfP1First}, ` +
    `P2-first=>${ev.resultIfP2First}, resolved: ${ev.resolution}`;
  $('conflict-log').appendChild(li);
}

function renderAllConflicts(recorder) {
  $('conflict-log').innerHTML = '';
  recorder.conflicts().forEach((c) => renderConflict(c));
}

async function setPaused(paused) {
  app.paused = paused;
  const m = app.metronome;
  if (m) {
    // Pause must freeze rig motion (loop gate) and suspend audio together.
    if (paused) await m.pause();
    else await m.resume();
  }
  $('pause').textContent = paused ? 'Resume' : 'Pause';
}

function resetLive(controller) {
  app.mode = 'live';
  app.state = createInitialState();
  app.recorder = new Recorder({ mode: controller ? (controller.name || 'bot') : 'human' });
  app.controller = controller;
  app.conflictMarkers = [];
  app.accumulator = 0;
  app.paused = false;
  $('banner').textContent = '';
  $('conflict-log').innerHTML = '';
  $('replay-panel').hidden = true;
  $('download').disabled = true;
  clearSave(localStorage);
}

function wire() {
  $('pause').addEventListener('click', async () => {
    if (app.mode === 'replay') {
      app.replay.paused = !app.replay.paused;
      if (app.metronome) app.replay.paused ? app.metronome.pause() : app.metronome.resume();
    } else {
      await setPaused(!app.paused);
    }
  });

  $('step').addEventListener('click', async () => {
    await ensureAudio();
    if (app.mode === 'live') {
      await setPaused(true);
      advanceLive();
      if (app.metronome) app.metronome.scheduleTick();
    } else if (app.replay && app.replay.index < app.replay.frames.length) {
      app.replay.paused = true;
      if (app.metronome) app.metronome.pause();
      app.replay.index += 1;
      syncReplayFrame();
    }
  });

  $('speed').addEventListener('click', () => {
    app.speed = app.speed === 1 ? 2 : 1;
    $('speed').textContent = `Speed ${app.speed}x`;
  });

  $('demo-success').addEventListener('click', async () => {
    await ensureAudio();
    resetLive(successBot);
    app.metronome.start();
  });
  $('demo-fail').addEventListener('click', async () => {
    await ensureAudio();
    resetLive(failureBot);
    app.metronome.start();
  });
  $('human').addEventListener('click', async () => {
    await ensureAudio();
    resetLive(null);
    app.metronome.start();
  });

  $('replay-live').addEventListener('click', () => startReplay(app.recorder));
  $('download').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(app.recorder.toJSON())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `show-${app.recorder.meta.mode}-${Date.now()}.json`;
    a.click();
  });

  // Load a complete replay artifact produced by the Node harness.
  $('replay-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const parsed = JSON.parse(await file.text());
    const recorder = new Recorder(parsed.meta);
    recorder.frames = parsed.frames;
    await ensureAudio();
    startReplay(recorder);
  });
}

function restoreOnLoad() {
  const saved = loadState(localStorage);
  if (saved && saved.status === 'running') {
    app.state = saved;
    $('restore-banner').textContent =
      `Restored at ${fmtTick(saved.tick)} — durability P1 ${saved.durabilityP1}/P2 ${saved.durabilityP2}, ` +
      `cues passed ${saved.passed.filter(Boolean).length}/10`;
  }
}

restoreOnLoad();
wire();
requestAnimationFrame((t) => {
  app.lastTime = t;
  requestAnimationFrame(loop);
});
