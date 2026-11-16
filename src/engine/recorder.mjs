import { WORLD } from './config.mjs';
import { createInitialState, checksum, fingerprint, cloneState } from './state.mjs';
import { step } from './step.mjs';

function serializeState(state) {
  return {
    status: state.status,
    tick: state.tick,
    elapsed: state.elapsed,
    progress: +state.progress.toFixed(2),
    integrity: state.integrity,
    tension: state.gauges.tension,
    winchInput: state.gauges.winchInput,
    spoolSpeed: +state.gauges.spoolSpeed.toFixed(3),
    steerX: state.gauges.steerX,
    steerY: state.gauges.steerY,
    guideLoad: +state.gauges.guideLoad.toFixed(3),
    stress: state.gauges.stress,
    singleSide: state.gauges.singleSide,
    safe: state.gauges.safe,
    crate: {
      x: +state.crate.x.toFixed(2), y: +state.crate.y.toFixed(2),
      vx: +state.crate.vx.toFixed(2), vy: +state.crate.vy.toFixed(2),
      angle: +state.crate.angle.toFixed(4),
    },
    players: {
      left: { x: state.players.left.x, y: +state.players.left.y.toFixed(2), brace: state.players.left.brace },
      right: { x: state.players.right.x, y: +state.players.right.y.toFixed(2), brace: state.players.right.brace },
    },
    ropes: {
      left: { rest: +state.ropes.left.rest.toFixed(2), tension: +state.ropes.left.tension.toFixed(3), snapped: state.ropes.left.snapped },
      right: { rest: +state.ropes.right.rest.toFixed(2), tension: +state.ropes.right.tension.toFixed(3), snapped: state.ropes.right.snapped },
    },
    zones: state.zones.map((z) => ({ id: z.id, strength: +z.strength.toFixed(4), crackTick: z.crackTick })),
    cracks: state.cracks.map((c) => ({ id: c.id, tick: c.tick })),
    endReason: state.endReason,
  };
}

export class Recorder {
  constructor(seed, scenarioId) {
    this.scenarioId = scenarioId;
    this.seed = seed;
    this.state = createInitialState(seed);
    this.timeline = [];
    this.collisions = [];
    this.conflictsAll = [];
    this.events = [];
    this.checksums = [checksum(this.state)];
    this.recordFrame(-1, null, [], []);
  }

  recordFrame(index, input, events, conflicts) {
    const frame = {
      index: this.timeline.length,
      tick: this.state.tick,
      t: +(this.state.tick * WORLD.dt).toFixed(2),
      actions: input ? describeActions(input) : [],
      inputs: input ? {
        winch: input.winch || 0,
        leftY: input.leftY || 0,
        steerX: input.steerX || 0,
        steerY: input.steerY || 0,
        rightY: input.rightY || 0,
        leftJerk: !!input.leftJerk,
        rightJerk: !!input.rightJerk,
        order: input.order || ['left', 'right'],
      } : null,
      state: serializeState(this.state),
      checksum: checksum(this.state),
      conflicts: conflicts.map((c) => ({ ...c, position: { ...c.position } })),
      collisions: events.filter((e) => e.type === 'collision').map((e) => ({ ...e })),
      events: events.map((e) => ({ ...e })),
    };
    this.timeline.push(frame);
    for (const c of frame.conflicts) this.conflictsAll.push(c);
    for (const c of frame.collisions) this.collisions.push(c);
    for (const e of events) this.events.push(e);
  }

  push(input) {
    const result = step(this.state, input);
    this.checksums.push(result.checksum);
    this.recordFrame(this.timeline.length, input, result.events, result.conflicts);
    return result;
  }

  get finished() {
    return this.state.status !== 'running';
  }

  build() {
    return {
      id: `run-${this.scenarioId}-${this.seed}`,
      scenarioId: this.scenarioId,
      seed: this.seed,
      dt: WORLD.dt,
      result: this.state.status === 'won' ? 'success' : 'failure',
      reason: this.state.endReason,
      duration: this.state.elapsed,
      ticks: this.state.tick,
      finishedAt: new Date(0).toISOString(),
      timeline: this.timeline,
      conflicts: this.conflictsAll,
      collisions: this.collisions,
      events: this.events,
      finalState: serializeState(this.state),
      fingerprint: fingerprint(this.state),
      frameFingerprint: this.checksums.join(':'),
    };
  }
}

function describeActions(input) {
  const out = [];
  if (input.winch > 0) out.push({ side: 'left', action: 'winch-in', amount: input.winch });
  if (input.winch < 0) out.push({ side: 'left', action: 'winch-out', amount: -input.winch });
  if (input.leftY) out.push({ side: 'left', action: 'rail-move', amount: input.leftY });
  if (input.steerX || input.steerY) out.push({ side: 'right', action: 'steer', x: input.steerX, y: input.steerY });
  if (input.rightY) out.push({ side: 'right', action: 'rail-move', amount: input.rightY });
  if (input.leftJerk) out.push({ side: 'left', action: 'jerk' });
  if (input.rightJerk) out.push({ side: 'right', action: 'jerk' });
  return out;
}

// Deterministic replay from a recording. Playback speed / stepping only change
// which frame is shown; the recomputed checksums must match frame by frame.
export function replay(recording, { onFrame = null } = {}) {
  const state = createInitialState(recording.seed);
  const mismatches = [];
  if (checksum(state) !== recording.timeline[0].checksum) {
    mismatches.push({ tick: 0, expected: recording.timeline[0].checksum, actual: checksum(state) });
  }
  for (let i = 1; i < recording.timeline.length; i += 1) {
    const frame = recording.timeline[i];
    step(state, frame.inputs);
    const actual = checksum(state);
    if (actual !== frame.checksum) {
      mismatches.push({ tick: frame.tick, expected: frame.checksum, actual });
    }
    if (onFrame) onFrame(i, frame, state);
  }
  return {
    ok: mismatches.length === 0,
    mismatches,
    finalChecksum: checksum(state),
    finalFingerprint: fingerprint(state),
    state,
  };
}

export function snapshotState(recording, tick) {
  const frame = recording.timeline.find((f) => f.tick === tick);
  return frame ? cloneState(restoreState(recording, tick)) : null;
}

export function restoreState(recording, tick) {
  const state = createInitialState(recording.seed);
  for (let i = 1; i < recording.timeline.length; i += 1) {
    const frame = recording.timeline[i];
    if (frame.tick > tick) break;
    step(state, frame.inputs);
  }
  return state;
}

// Re-run the same recorded inputs with the two players' same-tick actions
// processed in the opposite order and report the first diverging moment.
export function scanOrderConflicts(recording) {
  const base = createInitialState(recording.seed);
  const swapped = createInitialState(recording.seed);
  const divergences = [];
  for (let i = 1; i < recording.timeline.length; i += 1) {
    const frame = recording.timeline[i];
    const input = frame.inputs;
    step(base, input);
    const swappedInput = { ...input, order: [...(input.order || ['left', 'right'])].reverse() };
    step(swapped, swappedInput);
    const a = checksum(base);
    const b = checksum(swapped);
    if (a !== b) {
      divergences.push({
        tick: frame.tick,
        time: frame.t,
        object: '物资箱',
        basePosition: { x: +base.crate.x.toFixed(1), y: +base.crate.y.toFixed(1) },
        swappedPosition: { x: +swapped.crate.x.toFixed(1), y: +swapped.crate.y.toFixed(1) },
        baseChecksum: a,
        swappedChecksum: b,
        inputs: input,
      });
    }
  }
  return { divergences, first: divergences[0] || null, sameFinal: divergences.length === 0 };
}
