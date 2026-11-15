// Shared timeline: both players' inputs, shared state hashes and collision
// results are recorded on one tick-aligned timeline. Replays re-execute the
// same input stream and compare hashes, so pause/step/2x cannot alter state.

import { createInitialState, step, hashState, SHOW_END_TICK } from './engine.js';

export class Recorder {
  constructor(meta = {}) {
    this.meta = {
      version: 1,
      tickHz: 20,
      createdAt: new Date().toISOString(),
      ...meta,
    };
    this.frames = [];
  }

  record(tick, input, state, events) {
    this.frames.push({
      tick,
      input: {
        p1: { ...input.p1 },
        p2: { ...input.p2 },
      },
      hash: hashState(state),
      events,
      status: state.status,
      power: state.power,
      brightness: state.brightness,
      angle: state.angle,
      heat: state.heat,
      overheated: state.overheated,
      colorIndex: state.colorIndex,
      durabilityP1: state.durabilityP1,
      durabilityP2: state.durabilityP2,
      passed: [...state.passed],
      actor: { ...state.actor },
      lastEval: state.lastEval ? { ...state.lastEval } : null,
    });
  }

  conflicts() {
    return this.frames
      .flatMap((f) => f.events.map((e) => ({ ...e, frame: f })))
      .filter((e) => e.type === 'conflict');
  }

  toJSON() {
    return { meta: this.meta, frames: this.frames };
  }
}

// Run a controller to completion (or failure) and return the full timeline.
export function runRecorded(controller, { maxTicks = SHOW_END_TICK + 5 } = {}) {
  const state = createInitialState();
  const rec = new Recorder({ mode: controller.name || 'recorded' });
  let guard = 0;
  while (state.status === 'running' && guard < maxTicks) {
    const input = controller(state);
    const events = step(state, input);
    rec.record(state.tick - 1, input, state, events);
    guard += 1;
  }
  return { state, recorder: rec };
}

function replayAll(frames, mode) {
  const state = createInitialState();
  const hashes = [];
  if (mode === 'step') {
    // Explicit one-tick-at-a-time stepping (UI single-step button).
    for (const frame of frames) {
      step(state, frame.input);
      hashes.push(hashState(state));
    }
  } else {
    // Normal (1x) and 2x modes execute identical tick work; 2x simply
    // consumes two frames per wall-clock batch.
    const batch = mode === '2x' ? 2 : 1;
    for (let i = 0; i < frames.length; i += batch) {
      for (let j = 0; j < batch && i + j < frames.length; j++) {
        step(state, frames[i + j].input);
        hashes.push(hashState(state));
      }
    }
  }
  return { state, hashes };
}

export function verifyReplay(recorder) {
  const expected = recorder.frames.map((f) => f.hash);
  const results = {};
  for (const mode of ['1x', 'step', '2x']) {
    const { hashes, state } = replayAll(recorder.frames, mode);
    const mismatches = hashes
      .map((h, i) => (h !== expected[i] ? { tick: i, expected: expected[i], got: h } : null))
      .filter(Boolean);
    results[mode] = {
      match: mismatches.length === 0 && hashes.length === expected.length,
      mismatches,
      finalHash: hashes[hashes.length - 1],
      finalStatus: state.status,
    };
  }
  results.match = ['1x', 'step', '2x'].every((mode) => results[mode].match);
  return results;
}

// ----- Persistence (localStorage in the browser, injectable for Node tests) -----
const SAVE_KEY = 'stage-light-show-v1';

export function serializeSave(state) {
  return JSON.stringify({ version: 1, savedAt: Date.now(), state });
}

export function saveState(store, state) {
  store.setItem(SAVE_KEY, serializeSave(state));
}

export function loadState(store) {
  const raw = store.getItem(SAVE_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  return parsed.state;
}

export function clearSave(store) {
  store.removeItem(SAVE_KEY);
}

export function statesEqual(a, b) {
  return hashState(a) === hashState(b);
}
