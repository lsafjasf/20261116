import { createEngine, snapshotHash } from './engine.js';
import { PHASE } from './config.js';

export function createRecorder(engine, seed, patternId) {
  const events = [];
  return {
    events,
    record(tick, action, payload = {}) {
      events.push({ t: tick, action, ...payload });
    },
    exportJson() {
      return JSON.stringify({ seed, patternId, events }, null, 2);
    },
  };
}

export function replayRecording(recordText) {
  const record = typeof recordText === 'string' ? JSON.parse(recordText) : recordText;
  const engine = createEngine({ seed: record.seed, patternId: record.patternId });
  const queue = [...record.events].sort((a, b) => a.t - b.t);
  let cursor = 0;
  const terminal = new Set([PHASE.SUCCESS, PHASE.FAILED]);
  const maxTicks = Math.max(200000, ...queue.map((e) => e.t)) + 1;

  for (let guard = 0; guard < maxTicks; guard++) {
    while (cursor < queue.length && queue[cursor].t <= engine.state.tick) {
      applyEvent(engine, queue[cursor]);
      cursor += 1;
    }
    if (cursor >= queue.length && terminal.has(engine.state.phase)) break;
    if (cursor < queue.length || engine.state.phase === PHASE.RUNNING) engine.step();
  }
  return { engine, record, snapshot: snapshotHash(engine) };
}

function applyEvent(engine, event) {
  switch (event.action) {
    case 'START':
      engine.start();
      break;
    case 'PAUSE':
      engine.pause();
      break;
    case 'RESUME':
      engine.resume();
      break;
    case 'REPAIR':
      engine.repair();
      break;
    case 'RESET':
      engine.reset();
      break;
    case 'SPEED':
      engine.setSpeed(event.value);
      break;
    default:
      throw new Error(`未知录制动作: ${event.action}`);
  }
}
