import { createInitialState, step, hashState } from './sim.js';
import { allTargetPositions } from './scene.js';

// One timeline binds both players' inputs, the shared rig state snapshot and
// the collision/verdict result to the same tick index. Nothing is stored on
// separate per-player logs, so replay is a single ordered stream.
export function createTimeline() {
  const initial = createInitialState();
  return {
    frames: [],          // per-tick { tick, left, right, snapshotHash, verdict }
    state: initial,
    initial,
  };
}

export function recordFrame(timeline, input, order = 'lr') {
  const tick = timeline.state.tick + 1;
  const out = step(timeline.state, input, order);
  timeline.state = out.state;
  timeline.frames.push({
    tick,
    left: { ...input.left },
    right: { ...input.right },
    snapshotHash: timeline.state.hash,
    verdict: out.verdict
      ? {
          ok: out.verdict.ok,
          target: out.verdict.target,
          reasons: [...out.verdict.reasons],
          metrics: { ...out.verdict.metrics },
        }
      : null,
  });
  return out;
}

// Replay from the initial state. Pause / single-step / 2x/4x speed only change
// how many frames are consumed per wall-clock moment; the final hash must equal
// the recorded one.
export function replayFrames(timeline, order = 'lr', limit = null) {
  let state = timeline.initial;
  const conflicts = [];
  for (let i = 0; i < timeline.frames.length; i += 1) {
    if (limit !== null && i >= limit) break;
    const frame = timeline.frames[i];
    const out = step(state, { left: frame.left, right: frame.right }, order);
    state = out.state;
    if (state.hash !== frame.snapshotHash) {
      conflicts.push({
        tick: frame.tick,
        recordedHash: frame.snapshotHash,
        replayHash: state.hash,
      });
    }
  }
  return { state, conflicts };
}

// Re-run the same inputs with the opposite player order and report the first
// tick where the shared state diverges, including where each target was.
export function findOrderConflicts(timeline, recordedOrder = 'lr') {
  const altOrder = recordedOrder === 'lr' ? 'rl' : 'lr';
  let stateA = timeline.initial;
  let stateB = timeline.initial;
  const divergences = [];
  for (const frame of timeline.frames) {
    const outA = step(stateA, frame, recordedOrder);
    const outB = step(stateB, frame, altOrder);
    stateA = outA.state;
    stateB = outB.state;
    if (stateA.hash !== stateB.hash) {
      divergences.push({
        tick: frame.tick,
        recordedOrder,
        altOrder,
        input: { left: { ...frame.left }, right: { ...frame.right } },
        targetPositions: allTargetPositions(frame.tick).map((pos) => ({
          id: pos.id,
          x: Number(pos.x.toFixed(2)),
          y: Number(pos.y.toFixed(2)),
          z: Number(pos.z.toFixed(2)),
        })),
        stateA: summarize(stateA),
        stateB: summarize(stateB),
      });
      if (divergences.length >= 5) break;
    }
  }
  return divergences;
}

function summarize(state) {
  return {
    yaw: Number(state.yaw.toFixed(4)),
    pitch: Number(state.pitch.toFixed(4)),
    focus: Number(state.focus.toFixed(3)),
    film: state.film,
    lastShot: state.shots.length
      ? { tick: state.shots.at(-1).tick, ok: state.shots.at(-1).ok, target: state.shots.at(-1).target }
      : null,
    hash: hashState(state),
  };
}
