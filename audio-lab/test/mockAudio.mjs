// Minimal, deterministic Web Audio API subset used by the shared engine.
// It mirrors the real lifecycle (start/stop, connect/disconnect, ended events)
// so the same ResourceManager/SceneController code runs in Node and browsers.

let nextId = 1;

class AudioParam {
  constructor(value) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(value, time) {
    this.events.push(['setValueAtTime', value, time]);
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value, time) {
    this.events.push(['linearRampToValueAtTime', value, time]);
    return this;
  }
  exponentialRampToValueAtTime(value, time) {
    this.events.push(['exponentialRampToValueAtTime', value, time]);
    return this;
  }
}

class EventTargetLite {
  constructor() {
    this._listeners = new Map();
    this.onended = null;
  }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) {
    this._listeners.get(type)?.delete(handler);
  }
  dispatchEvent(event) {
    const set = this._listeners.get(event.type);
    if (set) for (const handler of [...set]) handler.call(this, event);
    if (event.type === 'ended' && typeof this.onended === 'function') {
      this.onended.call(this, event);
    }
    return true;
  }
}

class AudioNode extends EventTargetLite {
  constructor(ctx, type) {
    super();
    this.context = ctx;
    this.nodeType = type;
    this.nodeId = nextId++;
    this.connectedTo = new Set();
    this._released = false;
  }
  connect(dest) {
    this.connectedTo.add(dest);
    this.context._edges.add(edgeKey(this, dest));
    return dest;
  }
  disconnect(dest) {
    if (dest) {
      this.connectedTo.delete(dest);
      this.context._edges.delete(edgeKey(this, dest));
    } else {
      for (const d of this.connectedTo) {
        this.context._edges.delete(edgeKey(this, d));
      }
      this.connectedTo.clear();
    }
  }
}

class DestinationNode extends AudioNode {
  constructor(ctx) {
    super(ctx, 'destination');
  }
}

class OscillatorNode extends AudioNode {
  constructor(ctx, type = 'sine') {
    super(ctx, 'oscillator');
    this.type = type;
    this.frequency = new AudioParam(440);
    this.detune = new AudioParam(0);
    this.started = false;
    this.stopped = false;
  }
  start(when = 0) {
    if (this.started) throw new Error('Oscillator already started');
    this.started = true;
    this.startTime = when;
  }
  stop(when = 0) {
    if (this.stopped) throw new Error('Oscillator already stopped');
    this.stopped = true;
    this.stopTime = when;
    this.context._pendingEnded.push(this);
  }
}

class GainNode extends AudioNode {
  constructor(ctx) {
    super(ctx, 'gain');
    this.gain = new AudioParam(1);
  }
}

class DelayNode extends AudioNode {
  constructor(ctx, delayTime = 0) {
    super(ctx, 'delay');
    this.delayTime = new AudioParam(delayTime);
  }
}

function edgeKey(src, dest) {
  return `${src.nodeId}->${dest.nodeId}`;
}

export class MockAudioContext {
 constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.sampleRate = 48000;
    this._edges = new Set();
    this._pendingEnded = [];
    this.destination = new DestinationNode(this);
  }
  createOscillator() {
    return new OscillatorNode(this);
  }
  createGain() {
    return new GainNode(this);
  }
  createDelay(max = 1) {
    return new DelayNode(this, max);
  }
  // Flush queued ended events asynchronously, like the real event loop.
  flushEndedEvents() {
    const pending = this._pendingEnded.splice(0);
    for (const node of pending) {
      node.dispatchEvent({ type: 'ended', target: node });
    }
  }
  edgeCount() {
    return this._edges.size;
  }
}

export { AudioNode };
