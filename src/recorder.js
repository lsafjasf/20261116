import * as C from './config.js';
import { Simulation, hashObject } from './simulation.js';

// A Recording bundles every player input, shared-state metric row, conflict
// and event on one tick-indexed timeline, plus periodic full snapshots.
export class Recording {
  constructor(seed = C.DEFAULT_SEED) {
    this.seed = seed;
    this.checkpoints = [];
    this.finalSnapshot = null;
    this.finalHash = null;
    this.scenario = '';
  }

  static capture(sim, scenario = '') {
    const rec = new Recording(sim.seed);
    rec.scenario = scenario;
    rec.timeline = sim.timeline;
    const light = rec.captureLight(sim);
    const replayer = new Replayer(light);
    while (!replayer.sim.ended) {
      if (replayer.sim.tick % C.CHECKPOINT_EVERY === 0) {
        rec.checkpoints.push({
          tick: replayer.sim.tick,
          snapshot: replayer.sim.snapshot(),
          hash: hashObject(replayer.sim.snapshot())
        });
      }
      replayer.step();
    }
    rec.finalSnapshot = sim.snapshot();
    rec.finalHash = hashObject(rec.finalSnapshot);
    if (rec.checkpoints[rec.checkpoints.length - 1].tick !== sim.tick) {
      rec.checkpoints.push({
        tick: sim.tick,
        snapshot: rec.finalSnapshot,
        hash: rec.finalHash
      });
    }
    return rec;
  }

  captureLight(sim) {
    return {
      seed: this.seed,
      scenario: this.scenario,
      timeline: sim.timeline,
      checkpoints: [],
      finalSnapshot: null,
      finalHash: null
    };
  }

  serialize() {
    return JSON.stringify(this);
  }

  static parse(text) {
    const data = typeof text === 'string' ? JSON.parse(text) : text;
    const rec = new Recording(data.seed);
    rec.scenario = data.scenario || '';
    rec.timeline = data.timeline;
    rec.checkpoints = data.checkpoints || [];
    rec.finalSnapshot = data.finalSnapshot || null;
    rec.finalHash = data.finalHash || null;
    return rec;
  }
}

// Replays a recorded timeline deterministically. Pause, single step and speed
// changes only schedule when ticks run; they never change the state itself.
export class Replayer {
  constructor(recording) {
    this.recording = recording;
    this.sim = new Simulation(recording.seed);
    this.inputs = recording.timeline.inputs
      .sort((a, b) => a.issuedTick - b.issuedTick || a.id.localeCompare(b.id));
    this.inputIndex = 0;
    this.playing = false;
    this.speed = 1;
    this.sim.cmdSeq = this.inputs.length;
  }

  issueDueInputs() {
    while (
      this.inputIndex < this.inputs.length &&
      this.inputs[this.inputIndex].issuedTick <= this.sim.tick
    ) {
      const src = this.inputs[this.inputIndex++];
      // Re-enqueue with the exact original latency, bypassing fresh RNG draws.
      this.sim.queue.push({ ...src });
    }
    this.sim.queue.sort(
      (a, b) => a.dueTick - b.dueTick || a.id.localeCompare(b.id)
    );
  }

  step() {
    if (this.sim.ended) return this.sim.ended;
    while (
      this.inputIndex < this.inputs.length &&
      this.inputs[this.inputIndex].issuedTick <= this.sim.tick
    ) {
      const src = this.inputs[this.inputIndex++];
      // Re-enqueue with the exact recorded latency; no fresh RNG draws.
      this.sim.queue.push({ ...src });
      this.sim.netRand.next();
    }
    this.sim.queue.sort(
      (a, b) => a.dueTick - b.dueTick || a.id.localeCompare(b.id)
    );
    return this.sim.step();
  }

  seek(targetTick) {
    while (this.sim.tick < targetTick && !this.sim.ended) {
      this.step();
    }
    return this.sim.snapshot();
  }

  // Fast restore from the nearest checkpoint, then step the remaining ticks.
  seekFromCheckpoint(targetTick) {
    const eligible = this.recording.checkpoints
      .filter((cp) => cp.tick <= targetTick)
      .sort((a, b) => b.tick - a.tick);
    const cp = eligible[0];
    if (cp) this.sim.restore(cp.snapshot);
    // Checkpoints capture pre-step state: re-enqueue inputs issued at or after
    // the checkpoint tick, since none of them have been applied yet.
    this.inputs = this.recording.timeline.inputs
      .filter((cmd) => cmd.issuedTick >= cp.tick)
      .sort((a, b) => a.issuedTick - b.issuedTick || a.id.localeCompare(b.id));
    this.inputIndex = 0;
    this.sim.cmdSeq = this.recording.timeline.inputs.length;
    return this.seek(targetTick);
  }

  runToEnd() {
    while (!this.sim.ended) this.step();
    return this.sim;
  }

  verifyHash() {
    this.runToEnd();
    const actual = hashObject(this.sim.snapshot());
    return {
      expected: this.recording.finalHash,
      actual,
      match: actual === this.recording.finalHash
    };
  }
}
