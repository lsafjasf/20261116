import { createInitialState, applyEvent, replay } from './engine.js';

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fnv1a(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function hashState(state) {
  const summary = {
    clock: state.clock,
    score: state.score,
    status: state.status,
    verifiedDangers: state.verifiedDangers,
    markers: state.markers.map((m) => ({
      id: m.id, x: m.x, y: m.y, roadId: m.roadId, dangerId: m.dangerId,
      verified: m.verified, rejected: m.rejected
    })),
    routes: state.routes.map((r) => ({
      id: r.id, accepted: r.accepted, hitDangerIds: r.hitDangerIds, points: r.points
    })),
    routeDraft: state.routeDraft,
    players: state.players
  };
  return fnv1a(stableStringify(summary));
}

export class Recorder {
  constructor() {
    this.state = createInitialState();
  }

  commit(event) {
    const result = applyEvent(this.state, event);
    return result;
  }

  snapshot() {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      finalHash: hashState(this.state),
      state: this.state
    };
  }
}

export function serializeSession(state) {
  return JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    finalHash: hashState(state),
    state
  });
}

export function restoreSession(text) {
  const parsed = typeof text === 'string' ? JSON.parse(text) : text;
  const replayed = replay(parsed.state.timeline);
  const replayedHash = hashState(replayed);
  if (replayedHash !== parsed.finalHash) {
    throw new Error(`快照校验失败：期望 ${parsed.finalHash}，回放得到 ${replayedHash}`);
  }
  return { state: replayed, hash: replayedHash };
}

function objectOf(event) {
  if (event.type === 'placeMarker') return `marker@${event.x},${event.y}`;
  if (event.type === 'undo') return `undo:${event.side}`;
  if (event.type === 'verify') return `marker:${event.markerId}`;
  if (event.type === 'addWaypoint') return `waypoint@${event.x},${event.y}`;
  if (event.type === 'finishRoute') return `route:${event.name || 'draft'}`;
  return event.type;
}

function summarizeState(state) {
  return {
    score: state.score,
    status: state.status,
    markerIds: state.markers.map((m) => m.id),
    verified: state.markers.filter((m) => m.verified).map((m) => m.id),
    routes: state.routes.map((r) => `${r.id}:${r.accepted ? 'ok' : 'blocked'}`),
    draftSize: state.routeDraft.length
  };
}

export function analyzeOrderConflicts(events) {
  const actionable = events.filter((e) => e.type !== 'tick' && e.type !== 'zoom');
  const conflicts = [];
  for (let i = 0; i < actionable.length - 1; i += 1) {
    const a = actionable[i];
    for (let j = i + 1; j < actionable.length; j += 1) {
      const b = actionable[j];
      if (a.side === b.side || a.t !== b.t) continue;
      const swapped = [...actionable];
      [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
      const baseline = replay(actionable);
      const reordered = replay(swapped);
      const hashA = hashState(baseline);
      const hashB = hashState(reordered);
      if (hashA !== hashB) {
        conflicts.push({
          t: a.t,
          position: objectOf(a),
          first: { side: a.side, type: a.type, object: objectOf(a) },
          second: { side: b.side, type: b.type, object: objectOf(b) },
          baseline: summarizeState(baseline),
          reordered: summarizeState(reordered),
          baselineHash: hashA,
          reorderedHash: hashB
        });
      }
    }
  }
  return conflicts;
}

export class ReplayPlayer {
  constructor(events) {
    this.events = events;
    this.index = 0;
    this.state = createInitialState();
    this.finalHash = hashState(replay(events));
  }

 step() {
    if (this.index >= this.events.length) return null;
    const event = this.events[this.index];
    applyEvent(this.state, event);
    this.index += 1;
    return event;
  }

  playTo(index) {
    while (this.index < index) this.step();
    return this.state;
  }

  get finished() {
    return this.index >= this.events.length;
  }

  get currentHash() {
    return hashState(this.state);
  }
}
