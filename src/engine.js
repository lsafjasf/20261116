import { Rng } from './rng.js';
import { StateMachine, STATES } from './state-machine.js';

export const LAYERS = Object.freeze(['ambient', 'bass', 'drums', 'melody']);

export const DEFAULT_PARAMS = Object.freeze({
  thresholdCalmChase: 0.4,
  thresholdChaseDanger: 0.7,
  hysteresis: 0.02,
  fadeInSeconds: 1.2,
  bpm: 100,
  masterGain: 0.8,
  seed: 20261116,
  density: Object.freeze({
    ambient: 0.55,
    bass: 0.65,
    drums: 0.55,
    melody: 0.45,
  }),
});

// Layer bus gain targets for each state. Drums are fully muted in calm.
const LAYER_TARGETS = Object.freeze({
  ambient: { calm: 0.46, chase: 0.3, danger: 0.24 },
  bass: { calm: 0.38, chase: 0.62, danger: 0.8 },
  drums: { calm: 0.0, chase: 0.6, danger: 0.95 },
  melody: { calm: 0.18, chase: 0.48, danger: 0.82 },
});

// Slow, fixed layer pans so the four layers occupy distinct stereo positions.
const LAYER_PAN = Object.freeze({
  ambient: -0.15,
  bass: -0.05,
  drums: 0.1,
  melody: 0.3,
});

class Emitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this._listeners.get(event)?.forEach((fn) => fn(payload));
  }

  listenerCount() {
    let total = 0;
    for (const set of this._listeners.values()) total += set.size;
    return total;
  }

  clear() {
    this._listeners.clear();
  }
}

export class SoundtrackEngine {
  constructor(ctx, params = {}, options = {}) {
    this.ctx = ctx;
    this.params = mergeParams(params);
    this.driver = options.driver ?? defaultDriver();
    this.clock = options.clock ?? (() => ctx.currentTime);
    this.rng = new Rng(this.params.seed);
    this.stateMachine = new StateMachine(this.params, STATES.CALM);
    this.emitter = new Emitter();

    this.registry = new Map();
    this.persistent = new Set();
    this.activeSources = new Set();
    this.createdNodes = 0;
    this.disposedNodes = 0;
    this.events = [];
    this.maxEvents = options.maxEvents ?? 20000;

    this.started = false;
    this.stopped = false;
    this.destroyed = false;
    this.timerId = null;
    this.stopTimeoutId = null;

    this.stepIndex = 0;
    this.nextNoteTime = 0;
    this.currentIntensity = 0;
    this.layerGain = {};
    this.layerPan = { ...LAYER_PAN };

    this._buildGraph();
  }

  get secondsPer16th() {
    return 60 / this.params.bpm / 4;
  }

  get activeNodeCount() {
    return this.registry.size;
  }

  on(event, fn) {
    return this.emitter.on(event, fn);
  }

  off(event, fn) {
    this.emitter.off(event, fn);
  }

  _log(entry) {
    if (this.events.length >= this.maxEvents) this.events.shift();
    this.events.push({ ...entry, seq: this.events.length });
  }

  _track(node, label) {
    const id = `n${++this.createdNodes}`;
    node.__nodeId = id;
    node.__label = label;
    this.registry.set(id, node);
    return node;
  }

  _untrack(node) {
    if (node?.__nodeId && this.registry.has(node.__nodeId)) {
      this.registry.delete(node.__nodeId);
      this.disposedNodes += 1;
    }
  }

  _create(label, factory) {
    return this._track(factory(this.ctx), label);
  }

  _buildGraph() {
    const ctx = this.ctx;
    this.masterGain = this._create('masterGain', (c) => c.createGain());
    this.compressor = this._create('compressor', (c) => c.createDynamicsCompressor());
    this.masterGain.gain.value = this.params.masterGain;
    this.compressor.threshold.value = -18;
    this.compressor.ratio.value = 6;
    this.masterGain.connect(this.compressor);
    this.compressor.connect(ctx.destination);
    this.persistent.add(this.masterGain).add(this.compressor);

    this.layers = {};
    for (const name of LAYERS) {
      const gain = this._create(`${name}:gain`, (c) => c.createGain());
      const pan = this._create(`${name}:pan`, (c) => c.createStereoPanner());
      gain.gain.value = LAYER_TARGETS[name].calm;
      pan.pan.value = LAYER_PAN[name];
      gain.connect(pan);
      pan.connect(this.masterGain);
      this.layers[name] = { gain, pan };
      this.layerGain[name] = LAYER_TARGETS[name].calm;
      this.persistent.add(gain).add(pan);
    }
  }

  getStats() {
    return {
      started: this.started,
      stopped: this.stopped,
      destroyed: this.destroyed,
      state: this.stateMachine.state,
      lastStateChangeTime: this.stateMachine.lastChangeTime,
      intensity: this.currentIntensity,
      activeNodeCount: this.activeNodeCount,
      createdNodes: this.createdNodes,
      disposedNodes: this.disposedNodes,
      listenerCount: this.emitter.listenerCount(),
      stepIndex: this.stepIndex,
      nextNoteTime: Number(this.nextNoteTime.toFixed(6)),
      rngState: this.rng.state,
      queuedTimers: this.timerId === null ? 0 : 1,
    };
  }

  updateParams(partial) {
    if (this.destroyed) throw new Error('engine destroyed');
    this.params = mergeParams({ ...this.params, ...partial, density: { ...this.params.density, ...(partial.density ?? {}) } });
    this.stateMachine.update(this.params);
    const t = this.clock();
    this._rampParam(this.masterGain.gain, this.params.masterGain, t, 0.2);
    this._log({ kind: 'params', time: t, params: structuredClone(this.params) });
  }

  // Cancel scheduled ramps without cancelAndHoldAtTime (missing in some
  // offline implementations) by re-asserting the current value first.
  _rampParam(param, target, time, duration) {
    const now = time;
    const current = param.value;
    try {
      param.cancelScheduledValues(now);
    } catch {
      /* noop */
    }
    param.setValueAtTime(current, now);
    if (duration <= 0) {
      param.setValueAtTime(target, now);
    } else {
      param.linearRampToValueAtTime(target, now + duration);
    }
  }

  // External intensity feed, e.g. driven by gameplay metrics.
  setIntensity(intensity, atTime = this.clock()) {
    const value = Math.max(0, Math.min(1, intensity));
    this.currentIntensity = value;
    if (this.stopped || this.destroyed) return;
    const previous = this.stateMachine.state;
    const next = this.stateMachine.evaluate(value, atTime);
    if (next !== previous) this._transition(previous, next, atTime);
    this.emitter.emit('intensity', { time: atTime, intensity: value, state: next });
  }

  _transition(previous, next, time) {
    this._log({ kind: 'state', time, from: previous, to: next });
    this.emitter.emit('state', { time, from: previous, to: next });
    const fade = Math.max(0.02, this.params.fadeInSeconds);
    for (const name of LAYERS) {
      const target = LAYER_TARGETS[name][next];
      const { gain, pan } = this.layers[name];
      this._rampParam(gain.gain, target, time, fade);
      this.layerGain[name] = target;
      this._rampParam(pan.pan, LAYER_PAN[name] + (next === STATES.DANGER ? 0.08 : 0), time, fade);
      this.layerPan[name] = pan.pan.value;
      this._log({ kind: 'ramp', time, layer: name, target, pan: pan.pan.value, fadeSeconds: fade });
    }
  }

  start() {
    if (this.destroyed) throw new Error('engine destroyed');
    if (this.started) {
      this._log({ kind: 'start-blocked', time: this.clock(), reason: 'already-started' });
      return false;
    }
    this.started = true;
    this.stopped = false;
    const t0 = this.clock() + 0.05;
    this.nextNoteTime = t0;
    this.stepIndex = 0;
    this._log({ kind: 'start', time: this.clock(), t0 });
    this.emitter.emit('start', { time: this.clock() });
    this._scheduleLoop();
    return true;
  }

  _scheduleLoop() {
    const lookahead = 0.12;
    this.timerId = this.driver.setInterval(() => {
      if (this.stopped || this.destroyed) return;
      const horizon = this.clock() + lookahead;
      while (this.nextNoteTime < horizon) {
        this._scheduleStep(this.stepIndex, this.nextNoteTime);
        this.nextNoteTime += this.secondsPer16th;
        this.stepIndex += 1;
      }
    }, 25);
  }

  // Drive the scheduler manually with a virtual clock (offline renderer).
  tick(horizonTime) {
    if (this.stopped || this.destroyed) return;
    while (this.nextNoteTime < horizonTime) {
      this._scheduleStep(this.stepIndex, this.nextNoteTime);
      this.nextNoteTime += this.secondsPer16th;
      this.stepIndex += 1;
    }
  }

  _scheduleStep(step, time) {
    const state = this.stateMachine.state;
    const isBeat = step % 4 === 0;
    const isBar = step % 16 === 0;
    if (isBeat) {
      this._log({ kind: 'beat', time, step, bpm: this.params.bpm, state, intensity: this.currentIntensity });
    }

    // Ambient and bass are persistent: returning to calm never restarts them
    // from zero, their long-lived voices keep running and only the bus gain
    // ramps. New ambient pads are scheduled only at bar boundaries.
    if (isBar) this._voiceAmbient(step, time, state);
    if (isBeat) this._voiceBass(step, time, state);

    const d = this.params.density;
    if (LAYER_TARGETS.drums[state] > 0 && this.rng.chance(d.drums * drumsGate(state, step))) {
      this._voiceDrum(step, time, state);
    }
    if (this.rng.chance(d.melody * melodyGate(state))) {
      this._voiceMelody(step, time, state);
    }
  }

  _registerSource(source, time, stopTime) {
    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      this._disposeChain(source);
    };
    source.start(time);
    if (stopTime !== undefined) source.stop(stopTime);
  }

  _disposeChain(source) {
    let node = source;
    const seen = new Set();
    while (node && !seen.has(node) && !this.persistent.has(node) && node !== this.ctx.destination) {
      seen.add(node);
      const next = node.__voiceNext ?? null;
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
      this._untrack(node);
      node = next;
    }
    this._untrack(source);
  }

  _voiceAmbient(step, time, state) {
    const ctx = this.ctx;
    const barSeconds = this.secondsPer16th * 16;
    const freq = 110 * Math.pow(2, (this.rng.chance(0.5) ? 0 : 3) / 12);
    const osc = this._create('ambient:osc', (c) => c.createOscillator());
    const filter = this._create('ambient:filter', (c) => c.createBiquadFilter());
    const gain = this._create('ambient:voiceGain', (c) => c.createGain());
    osc.type = 'sine';
    osc.frequency.value = freq;
    filter.type = 'lowpass';
    filter.frequency.value = state === STATES.DANGER ? 1400 : 700;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.18, time + Math.min(1.5, barSeconds * 0.8));
    gain.gain.linearRampToValueAtTime(0.0001, time + barSeconds);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.layers.ambient.gain);
    osc.__voiceNext = filter;
    filter.__voiceNext = gain;
    gain.__voiceNext = this.layers.ambient.gain;
    this._registerSource(osc, time, time + barSeconds + 0.05);
  }

  _voiceBass(step, time, state) {
    const ctx = this.ctx;
    const root = state === STATES.DANGER ? 49 : state === STATES.CHASE ? 55 : 65.41;
    const osc = this._create('bass:osc', (c) => c.createOscillator());
    const gain = this._create('bass:voiceGain', (c) => c.createGain());
    osc.type = 'triangle';
    osc.frequency.value = root;
    const dur = this.secondsPer16th * 4;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.5, time + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(gain);
    gain.connect(this.layers.bass.gain);
    osc.__voiceNext = gain;
    gain.__voiceNext = this.layers.bass.gain;
    this._registerSource(osc, time, time + dur + 0.03);
  }

  _voiceDrum(step, time, state) {
    const ctx = this.ctx;
    const isKick = step % 8 === 0;
    if (isKick) {
      const osc = this._create('drums:kick', (c) => c.createOscillator());
      const gain = this._create('drums:kickGain', (c) => c.createGain());
      osc.type = 'sine';
      osc.frequency.setValueAtTime(140, time);
      osc.frequency.exponentialRampToValueAtTime(45, time + 0.12);
      gain.gain.setValueAtTime(0.9, time);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.22);
      osc.connect(gain);
      gain.connect(this.layers.drums.gain);
      osc.__voiceNext = gain;
      gain.__voiceNext = this.layers.drums.gain;
      this._registerSource(osc, time, time + 0.26);
    } else {
      const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.12), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (this.rng.next() * 2 - 1) * (1 - i / data.length);
      const src = this._create('drums:hat', (c) => c.createBufferSource());
      const filter = this._create('drums:hatFilter', (c) => c.createBiquadFilter());
      const gain = this._create('drums:hatGain', (c) => c.createGain());
      src.buffer = buffer;
      filter.type = 'highpass';
      filter.frequency.value = 6000;
      gain.gain.setValueAtTime(state === STATES.DANGER ? 0.4 : 0.25, time);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.1);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.layers.drums.gain);
      src.__voiceNext = filter;
      filter.__voiceNext = gain;
      gain.__voiceNext = this.layers.drums.gain;
      this._registerSource(src, time, time + 0.14);
    }
  }

  _voiceMelody(step, time, state) {
    const scale = state === STATES.DANGER
      ? [220, 233.08, 261.63, 277.18, 311.13, 349.23]
      : [261.63, 293.66, 329.63, 392, 440, 523.25];
    const freq = scale[Math.floor(this.rng.next() * scale.length)];
    const osc = this._create('melody:osc', (c) => c.createOscillator());
    const pan = this._create('melody:voicePan', (c) => c.createStereoPanner());
    const gain = this._create('melody:voiceGain', (c) => c.createGain());
    osc.type = state === STATES.CALM ? 'sine' : 'square';
    osc.frequency.value = freq;
    pan.pan.value = (this.rng.next() * 2 - 1) * 0.7;
    const dur = this.secondsPer16th * (this.rng.chance(0.5) ? 1 : 2);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.3, time + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(pan);
    pan.connect(gain);
    gain.connect(this.layers.melody.gain);
    osc.__voiceNext = pan;
    pan.__voiceNext = gain;
    gain.__voiceNext = this.layers.melody.gain;
    this._log({ kind: 'note', time, step, layer: 'melody', freq, pan: pan.pan.value, gain: 0.3 });
    this._registerSource(osc, time, time + dur + 0.03);
  }

  // Stop all sound. fadeSeconds > 0 ramps the master down first; 0 silences
  // instantly. Every scheduled source is stopped and every node is closed.
  stop(fadeSeconds = 0.15) {
    // Instant stop can tear the graph down immediately with no audible tail.
    if (fadeSeconds === 0) {
      this.stopAt(this.clock(), 0, false);
      this._disposeVoices(this.clock());
      this._log({ kind: 'stop-complete', time: this.clock(), activeNodeCount: this.activeNodeCount });
      this.emitter.emit('stop', { time: this.clock() });
      return;
    }
    this.stopAt(this.clock(), fadeSeconds, true);
  }

  // Close only short-lived voice nodes; persistent bus nodes stay connected so
  // the engine can restart without rebuilding the graph or leaking nodes.
  _disposeVoices(at) {
    for (const node of new Set(this.registry.values())) {
      if (this.persistent.has(node)) continue;
      try {
        if (typeof node.stop === 'function' && this.activeSources.has(node)) node.stop(at);
        node.disconnect();
      } catch {
        /* already disconnected */
      }
      this._untrack(node);
    }
    this.activeSources.clear();
  }

  // Schedule a stop at an explicit audio-timeline position (offline rendering).
  stopAt(time, fadeSeconds = 0.15, useTimer = false) {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    if (this.timerId !== null) {
      this.driver.clearInterval(this.timerId);
      this.timerId = null;
    }
    this._log({ kind: 'stop-request', time, fadeSeconds });

    if (fadeSeconds > 0) {
      this._rampParam(this.masterGain.gain, 0.0001, time, fadeSeconds);
    } else {
      try {
        this.masterGain.gain.cancelScheduledValues(time);
        this.masterGain.gain.setValueAtTime(0, time);
      } catch {
        /* noop */
      }
    }

    const silenceAt = time + Math.max(0, fadeSeconds) + 0.02;
    for (const source of new Set(this.activeSources)) {
      try {
        source.stop(silenceAt);
      } catch {
        /* source already ended */
      }
    }

    if (useTimer) {
      this.stopTimeoutId = this.driver.setTimeout(() => {
        if (this.destroyed) return;
        this._teardownGraph(this.clock());
        this._log({ kind: 'stop-complete', time: this.clock(), activeNodeCount: this.activeNodeCount });
        this.emitter.emit('stop', { time: this.clock() });
      }, Math.ceil(Math.max(fadeSeconds, 0) * 1000));
    }
  }

  // Restart after stop on the same graph: no duplicate listeners or nodes,
  // and no new persistent bus nodes are allocated.
  restart() {
    if (this.destroyed) throw new Error('engine destroyed');
    if (this.started && !this.stopped) return false;
    if (this.stopTimeoutId !== null) {
      this.driver.clearTimeout(this.stopTimeoutId);
      this.stopTimeoutId = null;
    }
    this.stopped = false;
    this.started = false;
    this.currentIntensity = 0;
    this.stateMachine = new StateMachine(this.params, STATES.CALM);
    this.rng = new Rng(this.params.seed);
    this.masterGain.gain.setValueAtTime(this.params.masterGain, this.clock());
    for (const name of LAYERS) {
      this.layers[name].gain.gain.setValueAtTime(LAYER_TARGETS[name].calm, this.clock());
      this.layerGain[name] = LAYER_TARGETS[name].calm;
    }
    return this.start();
  }

  _teardownGraph(at) {
    for (const node of new Set(this.registry.values())) {
      try {
        if (typeof node.stop === 'function' && this.activeSources.has(node)) node.stop(at);
        node.disconnect();
      } catch {
        /* already disconnected */
      }
      this._untrack(node);
    }
    this.activeSources.clear();
  }

  // Full disposal: removes timers, listeners and nodes. Reusable-safe because
  // listeners are unregistered rather than stacked across start/stop cycles.
  destroy() {
    if (this.destroyed) return;
    const time = this.clock();
    if (!this.stopped) this.stop(0);
    if (this.stopTimeoutId !== null) {
      this.driver.clearTimeout(this.stopTimeoutId);
      this.stopTimeoutId = null;
    }
    for (const node of new Set(this.registry.values())) {
      try {
        node.disconnect();
      } catch {
        /* noop */
      }
      this._untrack(node);
    }
    this.activeSources.clear();
    this.emitter.clear();
    this.destroyed = true;
    this._log?.({ kind: 'destroy', time, activeNodeCount: this.activeNodeCount });
  }

  snapshot() {
    return {
      version: 1,
      capturedAt: this.clock(),
      params: structuredClone(this.params),
      state: this.stateMachine.state,
      intensity: this.currentIntensity,
      stepIndex: this.stepIndex,
      nextNoteTime: this.nextNoteTime,
      rngState: this.rng.state,
      layerGain: { ...this.layerGain },
      layerPan: { ...this.layerPan },
      stats: this.getStats(),
      events: structuredClone(this.events),
    };
  }

  // Restore deterministic scheduling state (a new context renders fresh audio
  // but reproduces identical beat points, pans and gains).
  restoreSnapshot(snap) {
    if (this.destroyed) throw new Error('engine destroyed');
    this.params = mergeParams(snap.params);
    this.stateMachine = new StateMachine(this.params, snap.state);
    this.stateMachine.lastChangeTime = snap.lastStateChangeTime ?? 0;
    this.rng.state = snap.rngState >>> 0;
    this.stepIndex = snap.stepIndex;
    this.nextNoteTime = snap.nextNoteTime;
    this.currentIntensity = snap.intensity;
    this.layerGain = { ...snap.layerGain };
    this.layerPan = { ...snap.layerPan };
    for (const name of LAYERS) {
      const t = this.clock();
      this.layers[name].gain.gain.setValueAtTime(this.layerGain[name], t);
      this.layers[name].pan.pan.setValueAtTime(this.layerPan[name], t);
    }
    this._log({ kind: 'snapshot-restore', time: this.clock(), stepIndex: this.stepIndex });
  }
}

function drumsGate(state, step) {
  if (state === STATES.DANGER) return 1;
  return step % 8 === 0 ? 0.9 : 0.5;
}

function melodyGate(state) {
  return state === STATES.CALM ? 0.45 : state === STATES.CHASE ? 0.8 : 1;
}

export function mergeParams(partial = {}) {
  const base = structuredClone(DEFAULT_PARAMS);
  const merged = { ...base, ...partial };
  merged.density = { ...base.density, ...(partial.density ?? {}) };
  return Object.freeze(merged);
}

export function defaultDriver() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
}
