export class MockParam {
  constructor(value) {
    this.value = value;
    this.events = [];
  }

  cancelScheduledValues() {
    this.events = [];
  }

  setValueAtTime(value) {
    this.events.push({ type: 'set', time: this.host.time, value });
    this.value = value;
  }

  linearRampToValueAtTime(value, endTime) {
    this.events.push({ type: 'ramp', time: this.host.time, endTime, value });
    this.value = value;
  }

  setTargetAtTime(value, startTime) {
    this.events.push({ type: 'target', time: startTime, value });
    this.value = value;
  }

  valueAt(time) {
    let current = this.events.length ? this.events[0].value : this.value;
    for (const event of this.events) {
      if (event.type === 'set' || event.type === 'target') {
        if (time >= event.time) current = event.value;
      } else if (event.type === 'ramp') {
        if (time >= event.time && time <= event.endTime) {
          const span = event.endTime - event.time || 1;
          const previous = current;
          return previous + ((event.value - previous) * (time - event.time)) / span;
        }
        if (time > event.endTime) current = event.value;
      }
    }
    return current;
  }
}

export class MockNode {
  constructor(host, kind) {
    this.host = host;
    this.kind = kind;
    this.connections = [];
    this.onended = null;
    this.closed = false;
    this.params = {};
  }

  connect(target) {
    this.connections.push(target);
  }

 disconnect() {
    this.connections = [];
  }

  start(when) {
    this.startTime = when;
    this.host._registerSource(this);
  }

  stop(when) {
    this.stopTime = when;
  }

  async close() {
    this.closed = true;
    this.disconnect();
  }
}

export class MockHost {
  constructor() {
    this._time = 0;
    this.nodes = new Map();
    this._sourceEnds = [];
    this._frameCallbacks = new Set();
    this.listenerCounts = new Map();
    this.frameSubscriptions = 0;
    this.frameUnsubscriptions = 0;
  }

  get time() {
    return this._time;
  }

  get currentTime() {
    return this._time;
  }

  get sampleRate() {
    return 44100;
  }

  get state() {
    return this._state || 'running';
  }

  addEventListener(type) {
    this.listenerCounts.set(type, (this.listenerCounts.get(type) || 0) + 1);
  }

  removeEventListener(type) {
    const count = this.listenerCounts.get(type) || 0;
    this.listenerCounts.set(type, Math.max(0, count - 1));
  }

  createGain(kind = 'gain') {
    const node = new MockNode(this, kind);
    node.gain = new MockParam(1);
    node.gain.host = this;
    this.nodes.set(node, true);
    return node;
  }

  createStereoPanner(kind = 'panner') {
    const node = new MockNode(this, kind);
    node.pan = new MockParam(0);
    node.pan.host = this;
    this.nodes.set(node, true);
    return node;
  }

  createBufferSource(kind = 'source') {
    const node = new MockNode(this, kind);
    this.nodes.set(node, true);
    return node;
  }

  createDynamicsCompressor(kind = 'compressor') {
    const node = new MockNode(this, kind);
    node.threshold = new MockParam(-18);
    node.knee = new MockParam(24);
    node.ratio = new MockParam(12);
    node.attack = new MockParam(0.003);
    node.release = new MockParam(0.25);
    for (const param of Object.values(node.params || {})) param.host = this;
    this.nodes.set(node, true);
    return node;
  }

  requestFrame(callback) {
    this.frameSubscriptions += 1;
    this._frameCallbacks.add(callback);
    return () => {
      this.frameUnsubscriptions += 1;
      this._frameCallbacks.delete(callback);
    };
  }

  _registerSource(node) {
    if (typeof node.stopTime === 'number') {
      this._sourceEnds.push({ time: node.stopTime, node });
    }
  }

  advance(seconds) {
    const target = this._time + seconds;
    while (this._time < target - 1e-9) {
      this._time = Math.min(target, this._time + 0.02);
      for (const entry of this._sourceEnds) {
        if (!entry.fired && this._time >= entry.time) {
          entry.fired = true;
          if (typeof entry.node.onended === 'function') entry.node.onended();
        }
      }
      for (const callback of [...this._frameCallbacks]) {
        callback(this._time);
      }
    }
    this._sourceEnds = this._sourceEnds.filter((entry) => !entry.fired);
  }

  activeNodeCount() {
    let count = 0;
    for (const node of this.nodes.keys()) {
      if (!node.closed) count += 1;
    }
    return count;
  }

  activeNodesByKind() {
    const summary = {};
    for (const node of this.nodes.keys()) {
      if (!node.closed) summary[node.kind] = (summary[node.kind] || 0) + 1;
    }
    return summary;
  }

  async close() {
    for (const node of [...this.nodes.keys()]) {
      node.closed = true;
      node.disconnect();
    }
    this._frameCallbacks.clear();
    this._sourceEnds = [];
    this._state = 'closed';
  }
}
