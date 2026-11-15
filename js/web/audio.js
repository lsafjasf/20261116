// Web Audio metronome. The scheduler is driven by the simulation clock so
// that pausing the show suspends the AudioContext: rig motion and the beat
// stop together. A mock AudioContext can be injected for Node tests.

export class Metronome {
  constructor(ctx, { tickHz = 20, beatsPerBar = 4 } = {}) {
    this.ctx = ctx;
    this.tickHz = tickHz;
    this.beatsPerBar = beatsPerBar;
    this.running = false;
    this.nextTickTime = 0;
    this.tickIndex = 0;
    this.scheduled = []; // test observable: {tick, time, accent}
  }

  get currentTime() {
    return this.ctx.currentTime || 0;
  }

  get suspended() {
    return this.ctx.state === 'suspended';
  }

  _click(freq, time, gainValue) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(gainValue, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  // Schedule audio for one simulation tick. Called from the rAF loop only
  // while the show is running; never called while paused.
  scheduleTick() {
    if (!this.running || this.suspended) return;
    const tickInBar = this.tickIndex % this.beatsPerBar;
    const accent = tickInBar === 0;
    const time = this.nextTickTime;
    this._click(accent ? 880 : 560, time, accent ? 0.22 : 0.12);
    this.scheduled.push({ tick: this.tickIndex, time, accent });
    this.tickIndex += 1;
    this.nextTickTime += 1 / this.tickHz;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
      this.nextTickTime = this.ctx.currentTime + 0.05;
    } else if (this.nextTickTime === 0) {
      this.nextTickTime = this.ctx.currentTime + 0.05;
    }
  }

  async pause() {
    if (!this.running) return;
    this.running = false;
    await this.ctx.suspend();
  }

  async resume() {
    if (this.running) return;
    this.running = true;
    await this.ctx.resume();
    // Continue from "now" so no backlog of missed beats fires at once.
    this.nextTickTime = this.ctx.currentTime + 0.05;
  }

  async stop() {
    this.running = false;
    this.tickIndex = 0;
    this.scheduled = [];
    if (this.ctx.close) await this.ctx.close();
  }
}

// Minimal deterministic mock used by the Node test harness.
export function createMockAudioContext() {
  const nodes = [];
  return {
    state: 'suspended',
    currentTime: 0,
    destination: {},
    async resume() { this.state = 'running'; },
    async suspend() { this.state = 'suspended'; },
    async close() { this.state = 'closed'; },
    createOscillator() {
      const node = {
        frequency: { value: 0 },
        start() {},
        stop() {},
        connect() { return node; },
      };
      nodes.push(node);
      return node;
    },
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() { return this; },
      };
    },
    _nodes: nodes,
  };
}
