// Deterministic Web Audio mock for headless verification.
// - Manual clock: tests advance `currentTime` explicitly.
// - Every AudioParam records its automation history for assertions.
// - Nodes track connect/disconnect so leaks are detectable.
class MockParam {
  constructor(value) {
    this.value = value;
    this.history = [];
  }
  setValueAtTime(v, t) { this.value = v; this.history.push({ m: 'set', v, t }); }
  linearRampToValueAtTime(v, t) { this.value = v; this.history.push({ m: 'lin', v, t }); }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.history.push({ m: 'exp', v, t }); }
  setTargetAtTime(v, t, tc) { this.value = v; this.history.push({ m: 'target', v, t, tc }); }
  cancelScheduledValues(t) { this.history.push({ m: 'cancel', t }); }
}

class MockNode {
  constructor(ctx, kind) {
    this.context = ctx;
    this.kind = kind;
    this.connectCount = 0;
    this.disconnectCount = 0;
    ctx._nodes.push(this);
  }
  connect(dest) { this.connectCount++; return dest; }
  disconnect() { this.disconnectCount++; }
}

class MockOscillator extends MockNode {
  constructor(ctx) {
    super(ctx, 'oscillator');
    this.type = 'sine';
    this.frequency = new MockParam(440);
    this.startedAt = null;
    this.stoppedAt = null;
  }
  start(t = 0) { this.startedAt = t; }
  stop(t = 0) {
    this.stoppedAt = t;
    if (this.onended) queueMicrotask(() => this.onended());
  }
}

export class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.sampleRate = 44100;
    this.destination = { kind: 'destination' };
    this._nodes = [];
    this.suspendCount = 0;
    this.resumeCount = 0;
    this.closeCount = 0;
  }
  advance(seconds) { this.currentTime += seconds; }
  createOscillator() { return new MockOscillator(this); }
  createGain() {
    const n = new MockNode(this, 'gain');
    n.gain = new MockParam(1);
    return n;
  }
  createBiquadFilter() {
    const n = new MockNode(this, 'filter');
    n.type = 'lowpass';
    n.frequency = new MockParam(350);
    n.Q = new MockParam(1);
    return n;
  }
  createStereoPanner() {
    const n = new MockNode(this, 'panner');
    n.pan = new MockParam(0);
    return n;
  }
  createAnalyser() {
    const n = new MockNode(this, 'analyser');
    n.fftSize = 2048;
    n.getByteTimeDomainData = (arr) => arr.fill(128);
    return n;
  }
  async suspend() { this.suspendCount++; this.state = 'suspended'; }
  async resume() { this.resumeCount++; this.state = 'running'; }
  async close() { this.closeCount++; this.state = 'closed'; }
  liveNodes() {
    return this._nodes.filter((n) => n.connectCount > n.disconnectCount);
  }
}
