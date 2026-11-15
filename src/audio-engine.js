import { clamp, lerp, seededRandom, wavBlobFromBuffer } from "./utils.js";

export const DEFAULT_PARAMS = Object.freeze({
  masterGain: 0.78,
  pingGain: 0.68,
  echoScale: 1,
  reverbMix: 0.42,
  bpm: 60,
  frontCutoff: 4700,
  backCutoff: 420,
});

const MATERIAL_REVERB = {
  crystal: { seconds: 1.4, decay: 2.9, wet: 0.32 },
  frost: { seconds: 2.2, decay: 2.1, wet: 0.52 },
  blackice: { seconds: 3.2, decay: 1.55, wet: 0.76 },
};

function makeNoiseBuffer(context, seconds, random) {
  const frameCount = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(1, frameCount, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < frameCount; index += 1) {
    data[index] = random() * 2 - 1;
  }
  return buffer;
}

function makeImpulse(context, seconds, decay, random) {
  const frameCount = Math.max(1, Math.floor(context.sampleRate * seconds));
  const impulse = context.createBuffer(2, frameCount, context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < frameCount; index += 1) {
      const envelope = (1 - index / frameCount) ** decay;
      data[index] = (random() * 2 - 1) * envelope;
    }
  }
  return impulse;
}

function beatDuration(params) {
  return 60 / clamp(params.bpm, 30, 140);
}

export function isBeaconAudible(target, beat, seed) {
  if (target.id === "entrance") return true;
  const random = seededRandom(seed, `beacon-gate-${target.index}`);
  const cycleLength = 8;
  const activeLength = 5;
  const jitter = Math.floor(random() * cycleLength);
  const phase = ((beat + target.activePhase + jitter) % cycleLength + cycleLength) % cycleLength;
  return phase < activeLength;
}

export function pingPlan(game, beat, params = DEFAULT_PARAMS) {
  const reading = game.reading();
  const material = game.currentMaterial;
  const audible = isBeaconAudible(reading.target, beat, game.level.seed);
  const front = (reading.frontness + 1) / 2;
  const distanceGain = 1 / (1 + reading.distance * 0.115);
  const gain = audible ? params.pingGain * 0.2 * distanceGain : 0;
  const filterHz = lerp(params.backCutoff, params.frontCutoff, front);
  const delay = clamp((0.028 + reading.distance * 0.031) * params.echoScale, 0.025, 0.9);
  return {
    beat,
    audible,
    targetId: reading.target.id,
    targetName: reading.target.name,
    frequency: reading.target.frequency || 220,
    pan: reading.pan,
    gain,
    filterHz,
    delay,
    distance: reading.distance,
    frontness: reading.frontness,
    material: material.id,
    materialName: material.name,
  };
}

export class AudioEngine {
  constructor(params = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.context = null;
    this.graph = null;
    this.status = "idle";
    this.beat = 0;
    this.nextBeatTime = 0;
    this.schedulerTimer = null;
    this.schedulerRunning = false;
    this.events = [];
    this.voices = new Map();
    this.nodes = new Map();
    this.timers = new Set();
    this.voiceSequence = 0;
    this.listenerCount = 0;
    this.startedAt = 0;
    this.lastError = null;
    this.lastLevels = { left: 0, right: 0, peak: 0 };
    this.analyserBuffers = new Map();
    this._stateListener = null;
    this._noiseBuffer = null;
    this._ambient = new Set();
    this._startCount = 0;
    this._lifecycle = [];
  }

  get supported() {
    return Boolean(window.AudioContext || window.webkitAudioContext);
  }

  async init() {
    if (this.context && this.context.state !== "closed") return this.context;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio API 不可用");
    const context = new AudioContextClass({ latencyHint: "interactive" });
    this.context = context;
    this._noiseBuffer = makeNoiseBuffer(context, 2.4, seededRandom("ambient", "noise-v1"));
    this.buildGraph();
    this._stateListener = () => {
      this.lifecycle(`context:${context.state}`);
      if (context.state === "interrupted") this.status = "interrupted";
      if (context.state === "running" && this.status === "interrupted") this.status = "running";
    };
    context.addEventListener("statechange", this._stateListener);
    this.listenerCount += 1;
    this.lifecycle("context:created");
    return context;
  }

  trackNode(node, label, persistent = false) {
    this.nodes.set(node, { label, persistent, type: node.constructor?.name || "AudioNode" });
    return node;
  }

  untrackNode(node) {
    this.nodes.delete(node);
  }

  lifecycle(message) {
    this._lifecycle.push({ at: performance.now(), message });
    if (this._lifecycle.length > 80) this._lifecycle.shift();
  }

  buildGraph() {
    const context = this.context;
    const master = this.trackNode(context.createGain(), "master", true);
    const compressor = this.trackNode(context.createDynamicsCompressor(), "limiter", true);
    const splitter = this.trackNode(context.createChannelSplitter(2), "splitter", true);
    const analyserLeft = this.trackNode(context.createAnalyser(), "analyser:left", true);
    const analyserRight = this.trackNode(context.createAnalyser(), "analyser:right", true);
    const silentTail = this.trackNode(context.createGain(), "analyser-sink", true);
    const ambientGain = this.trackNode(context.createGain(), "ambient", true);
    const dryGain = this.trackNode(context.createGain(), "dry", true);

    master.gain.value = this.params.masterGain;
    compressor.threshold.value = -13;
    compressor.knee.value = 24;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.008;
    compressor.release.value = 0.25;
    ambientGain.gain.value = 0.11;
    dryGain.gain.value = 1;
    silentTail.gain.value = 0;
    analyserLeft.fftSize = 512;
    analyserRight.fftSize = 512;
    analyserLeft.smoothingTimeConstant = 0.32;
    analyserRight.smoothingTimeConstant = 0.32;

    master.connect(compressor);
    compressor.connect(context.destination);
    master.connect(splitter);
    splitter.connect(analyserLeft, 0);
    splitter.connect(analyserRight, 1);
    analyserLeft.connect(silentTail);
    analyserRight.connect(silentTail);
    silentTail.connect(context.destination);
    ambientGain.connect(master);

    const reverbBuses = {};
    for (const [materialId, settings] of Object.entries(MATERIAL_REVERB)) {
      const convolver = this.trackNode(context.createConvolver(), `reverb:${materialId}`, true);
      const wetGain = this.trackNode(context.createGain(), `reverb-gain:${materialId}`, true);
      convolver.buffer = makeImpulse(
        context,
        settings.seconds,
        settings.decay,
        seededRandom(materialId, "impulse-v1"),
      );
      wetGain.gain.value = this.params.reverbMix * settings.wet;
      convolver.connect(wetGain);
      wetGain.connect(master);
      reverbBuses[materialId] = { convolver, wetGain };
    }

    this.graph = {
      master,
      compressor,
      splitter,
      analyserLeft,
      analyserRight,
      silentTail,
      ambientGain,
      dryGain,
      reverbBuses,
    };
    this.analyserBuffers.set(analyserLeft, new Float32Array(analyserLeft.fftSize));
    this.analyserBuffers.set(analyserRight, new Float32Array(analyserRight.fftSize));
  }

  setParams(partial) {
    this.params = { ...this.params, ...partial };
    if (!this.graph) return this.params;
    this.graph.master.gain.setTargetAtTime(this.params.masterGain, this.context.currentTime, 0.04);
    for (const [materialId, bus] of Object.entries(this.graph.reverbBuses)) {
      const wet = MATERIAL_REVERB[materialId].wet * this.params.reverbMix;
      bus.wetGain.gain.setTargetAtTime(wet, this.context.currentTime, 0.04);
    }
    if (this.schedulerRunning) {
      this.clearSchedulerTimer();
      this.scheduleFromNow();
    }
    return this.params;
  }

  setReverbWet(multiplier = 1) {
    if (!this.graph || !this.context) return;
    for (const [materialId, bus] of Object.entries(this.graph.reverbBuses)) {
      const wet = MATERIAL_REVERB[materialId].wet * this.params.reverbMix * multiplier;
      bus.wetGain.gain.cancelScheduledValues(this.context.currentTime);
      bus.wetGain.gain.setValueAtTime(wet, this.context.currentTime);
    }
  }

  async start() {
    if (this.status === "running" || this.status === "paused") {
      this.lifecycle("start:duplicate-ignored");
      return { started: false, duplicate: true, status: this.status };
    }
    await this.init();
    if (this.context.state === "suspended" || this.context.state === "interrupted") {
      await this.context.resume();
    }
    this._startCount += 1;
    this.status = "running";
    this.events = [];
    this.beat = 0;
    this.setReverbWet(1);
    this.startAmbient();
    this.scheduleFromNow();
    this.lifecycle("start");
    return { started: true, duplicate: false, status: this.status };
  }

  startAmbient() {
    if (!this.context || !this.graph) return;
    if (this._ambient.size > 0) {
      this.lifecycle("ambient:duplicate-ignored");
      return;
    }
    const context = this.context;
    const wind = this.trackNode(context.createBufferSource(), "ambient:wind", false);
    const windFilter = this.trackNode(context.createBiquadFilter(), "ambient:wind-filter", false);
    const windGain = this.trackNode(context.createGain(), "ambient:wind-gain", false);
    const drone = this.trackNode(context.createOscillator(), "ambient:drone", false);
    const droneGain = this.trackNode(context.createGain(), "ambient:drone-gain", false);
    const sub = this.trackNode(context.createOscillator(), "ambient:sub", false);
    const subGain = this.trackNode(context.createGain(), "ambient:sub-gain", false);

    wind.buffer = this._noiseBuffer;
    wind.loop = true;
    windFilter.type = "bandpass";
    windFilter.frequency.value = 760;
    windFilter.Q.value = 0.42;
    windGain.gain.value = 0.065;
    drone.type = "sine";
    drone.frequency.value = 51.5;
    droneGain.gain.value = 0.018;
    sub.type = "triangle";
    sub.frequency.value = 31.2;
    subGain.gain.value = 0.012;

    wind.connect(windFilter).connect(windGain).connect(this.graph.ambientGain);
    drone.connect(droneGain).connect(this.graph.ambientGain);
    sub.connect(subGain).connect(this.graph.ambientGain);
    wind.start();
    drone.start();
    sub.start();
    const ambient = { nodes: [wind, windFilter, windGain, drone, droneGain, sub, subGain] };
    this._ambient.add(ambient);
    this.lifecycle("ambient:started");
  }

  stopAmbient() {
    for (const ambient of this._ambient) {
      for (const node of ambient.nodes) {
        try {
          if (typeof node.stop === "function") node.stop();
        } catch {
          // Source may already have ended.
        }
      }
      for (const node of ambient.nodes) {
        try {
          node.disconnect();
        } catch {
          // Already disconnected.
        }
        this.untrackNode(node);
      }
    }
    this._ambient.clear();
  }

  scheduleFromNow() {
    if (this.status !== "running" || !this.context) return;
    this.nextBeatTime = this.context.currentTime + 0.06;
    this.schedulerRunning = true;
    this.scheduleAhead();
    this.schedulerTimer = window.setInterval(() => this.scheduleAhead(), 28);
    this.timers.add(this.schedulerTimer);
    this.lifecycle("scheduler:started");
  }

  scheduleAhead() {
    if (this.status !== "running" || !this.context || !this._game) return;
    const horizon = this.context.currentTime + 0.12;
    let guard = 0;
    while (this.nextBeatTime < horizon && guard < 4) {
      this.scheduleBeat(this.nextBeatTime, this.beat);
      this.nextBeatTime += beatDuration(this.params);
      this.beat += 1;
      guard += 1;
    }
  }

  attachGame(game) {
    this._game = game;
  }

  scheduleBeat(scheduledAt, beat) {
    if (!this._game || this.status !== "running") return;
    const plan = pingPlan(this._game, beat, this.params);
    const event = {
      ...plan,
      scheduledAt,
      audioClock: this.context.currentTime,
      gameTime: this._game.elapsed,
    };
    this.events.push(event);
    if (this.events.length > 160) this.events.shift();
    this.playPing(plan, scheduledAt);
    if (this._game.danger > 0.22) this.playDanger(this._game.danger, scheduledAt);
  }

  playPing(plan, scheduledAt) {
    const context = this.context;
    const graph = this.graph;
    if (!graph || !plan.audible) return;
    const duration = 0.55;
    const envelope = this.trackNode(context.createGain(), "ping:envelope");
    const filter = this.trackNode(context.createBiquadFilter(), "ping:filter");
    const panner = this.trackNode(context.createStereoPanner(), "ping:panner");
    const dry = this.trackNode(context.createGain(), "ping:dry");
    const reverbSend = this.trackNode(context.createGain(), "ping:reverb-send");
    const echoDelay = this.trackNode(context.createDelay(1.2), "ping:echo-delay");
    const echoGain = this.trackNode(context.createGain(), "ping:echo-gain");
    const osc = this.trackNode(context.createOscillator(), "ping:osc");
    const harmonic = this.trackNode(context.createOscillator(), "ping:harmonic");
    const harmonicGain = this.trackNode(context.createGain(), "ping:harmonic-gain");

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(plan.filterHz, scheduledAt);
    filter.Q.value = 0.72;
    panner.pan.setValueAtTime(plan.pan, scheduledAt);
    dry.gain.value = 1;
    echoDelay.delayTime.setValueAtTime(plan.delay, scheduledAt);
    echoGain.gain.value = 0.24 * this.params.pingGain;
    reverbSend.gain.value = clamp(this.params.reverbMix * MATERIAL_REVERB[plan.material].wet, 0, 0.8);
    harmonicGain.gain.value = 0.24;
    osc.type = "sine";
    harmonic.type = "triangle";
    osc.frequency.setValueAtTime(plan.frequency, scheduledAt);
    harmonic.frequency.setValueAtTime(plan.frequency * 2.01, scheduledAt);
    envelope.gain.setValueAtTime(0.0001, scheduledAt);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, plan.gain), scheduledAt + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, scheduledAt + duration);

    osc.connect(filter);
    harmonic.connect(harmonicGain).connect(filter);
    filter.connect(panner);
    panner.connect(envelope);
    envelope.connect(dry).connect(graph.dryGain);
    envelope.connect(echoDelay).connect(echoGain).connect(graph.dryGain);
    panner.connect(reverbSend).connect(graph.reverbBuses[plan.material].convolver);
    osc.start(scheduledAt);
    harmonic.start(scheduledAt);
    osc.stop(scheduledAt + duration + 0.04);
    harmonic.stop(scheduledAt + duration + 0.04);
    const voice = {
      id: ++this.voiceSequence,
      kind: "ping",
      sources: [osc, harmonic],
      nodes: [envelope, filter, panner, dry, reverbSend, echoDelay, echoGain, osc, harmonic, harmonicGain],
      plannedEnd: scheduledAt + duration + plan.delay + 0.2,
    };
    this.registerVoice(voice);
  }

  playFootstep(side, material, scheduledAt = this.context.currentTime) {
    if (this.status !== "running" || !this._noiseBuffer) return;
    const context = this.context;
    const source = this.trackNode(context.createBufferSource(), "step:noise");
    const filter = this.trackNode(context.createBiquadFilter(), "step:filter");
    const panner = this.trackNode(context.createStereoPanner(), "step:panner");
    const envelope = this.trackNode(context.createGain(), "step:envelope");
    const echoDelay = this.trackNode(context.createDelay(0.6), "step:echo");
    const echoGain = this.trackNode(context.createGain(), "step:echo-gain");
    const reverbSend = this.trackNode(context.createGain(), "step:reverb");
    const duration = 0.16;
    source.buffer = this._noiseBuffer;
    filter.type = "bandpass";
    filter.frequency.value = material.id === "blackice" ? 310 : 520;
    filter.Q.value = 1.1;
    panner.pan.value = side * 0.23;
    echoDelay.delayTime.value = clamp((0.055 + MATERIAL_REVERB[material.id].seconds * 0.045) * this.params.echoScale, 0.03, 0.4);
    echoGain.gain.value = 0.16;
    reverbSend.gain.value = this.params.reverbMix * 0.38;
    envelope.gain.setValueAtTime(0.0001, scheduledAt);
    envelope.gain.exponentialRampToValueAtTime(0.11, scheduledAt + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, scheduledAt + duration);
    source.connect(filter).connect(panner).connect(envelope);
    envelope.connect(this.graph.dryGain);
    envelope.connect(echoDelay).connect(echoGain).connect(this.graph.dryGain);
    panner.connect(reverbSend).connect(this.graph.reverbBuses[material.id].convolver);
    source.start(scheduledAt);
    source.stop(scheduledAt + duration + 0.02);
    this.registerVoice({
      id: ++this.voiceSequence,
      kind: "footstep",
      sources: [source],
      nodes: [source, filter, panner, envelope, echoDelay, echoGain, reverbSend],
      plannedEnd: scheduledAt + duration + 0.34,
    });
  }

  playDanger(intensity, scheduledAt = this.context.currentTime) {
    if (this.status !== "running" || !this._noiseBuffer) return;
    const context = this.context;
    const source = this.trackNode(context.createBufferSource(), "danger:noise");
    const filter = this.trackNode(context.createBiquadFilter(), "danger:filter");
    const gain = this.trackNode(context.createGain(), "danger:gain");
    source.buffer = this._noiseBuffer;
    filter.type = "lowpass";
    filter.frequency.value = 130 + intensity * 110;
    filter.Q.value = 1.8;
    gain.gain.setValueAtTime(0.0001, scheduledAt);
    gain.gain.exponentialRampToValueAtTime(0.002 + intensity * 0.055, scheduledAt + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, scheduledAt + 0.58);
    source.connect(filter).connect(gain).connect(this.graph.dryGain);
    source.start(scheduledAt);
    source.stop(scheduledAt + 0.62);
    this.registerVoice({
      id: ++this.voiceSequence,
      kind: "danger",
      sources: [source],
      nodes: [source, filter, gain],
      plannedEnd: scheduledAt + 0.65,
    });
  }

  playCollect(beaconIndex) {
    if (this.status !== "running") return;
    const context = this.context;
    const now = context.currentTime + 0.01;
    const osc = this.trackNode(context.createOscillator(), "collect:osc");
    const gain = this.trackNode(context.createGain(), "collect:gain");
    const panner = this.trackNode(context.createStereoPanner(), "collect:panner");
    osc.type = "sine";
    osc.frequency.setValueAtTime([392, 523.25, 659.25][beaconIndex] || 480, now);
    osc.frequency.exponentialRampToValueAtTime([523.25, 659.25, 783.99][beaconIndex] || 640, now + 0.18);
    panner.pan.value = 0;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.13, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    osc.connect(gain).connect(panner).connect(this.graph.dryGain);
    osc.start(now);
    osc.stop(now + 0.46);
    this.registerVoice({
      id: ++this.voiceSequence,
      kind: "collect",
      sources: [osc],
      nodes: [osc, gain, panner],
      plannedEnd: now + 0.5,
    });
  }

  registerVoice(voice) {
    for (const node of voice.nodes) this.nodes.set(node, {
      label: voice.kind,
      persistent: false,
      type: node.constructor?.name || "AudioNode",
    });
    this.voices.set(voice.id, voice);
    for (const source of voice.sources) {
      source.addEventListener?.("ended", () => this.releaseVoice(voice.id), { once: true });
    }
    const cleanupTimer = window.setTimeout(
      () => this.releaseVoice(voice.id),
      Math.max(30, (voice.plannedEnd - this.context.currentTime + 0.08) * 1000),
    );
    this.timers.add(cleanupTimer);
    voice.cleanupTimer = cleanupTimer;
  }

  releaseVoice(voiceId) {
    const voice = this.voices.get(voiceId);
    if (!voice) return;
    for (const source of voice.sources) {
      try {
        source.stop();
      } catch {
        // The source has already stopped.
      }
    }
    for (const node of voice.nodes) {
      try {
        node.disconnect();
      } catch {
        // The node was disconnected by an earlier cleanup pass.
      }
      this.nodes.delete(node);
    }
    if (voice.cleanupTimer) {
      window.clearTimeout(voice.cleanupTimer);
      this.timers.delete(voice.cleanupTimer);
    }
    this.voices.delete(voiceId);
  }

  stopAllVoices() {
    for (const voiceId of [...this.voices.keys()]) this.releaseVoice(voiceId);
    for (const timer of [...this.timers]) {
      window.clearTimeout(timer);
      this.timers.delete(timer);
    }
  }

  async pause() {
    if (this.status !== "running" || !this.context) return false;
    this.status = "paused";
    this.clearSchedulerTimer();
    this.setReverbWet(0);
    this.stopAllVoices();
    this.stopAmbient();
    if (this.context.state === "running") await this.context.suspend();
    this.lifecycle("pause");
    return true;
  }

  async resume() {
    if (this.status !== "paused" || !this.context) return false;
    if (this.context.state !== "running") await this.context.resume();
    this.status = "running";
    this.setReverbWet(1);
    this.startAmbient();
    this.scheduleFromNow();
    this.lifecycle("resume");
    return true;
  }

  clearSchedulerTimer() {
    if (this.schedulerTimer !== null) {
      window.clearInterval(this.schedulerTimer);
      this.timers.delete(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    this.schedulerRunning = false;
  }

  async stop(reason = "manual") {
    if (!this.context) {
      this.status = "stopped";
      return { stopped: false, reason: "not-initialized" };
    }
    this.status = "stopping";
    this.clearSchedulerTimer();
    this.setReverbWet(0);
    this.stopAllVoices();
    this.stopAmbient();
    if (this.graph) {
      const now = this.context.currentTime;
      this.graph.master.gain.cancelScheduledValues(now);
      this.graph.master.gain.setValueAtTime(this.graph.master.gain.value, now);
      this.graph.master.gain.exponentialRampToValueAtTime(0.0001, now + 0.025);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 35));
    if (this.graph) this.graph.master.gain.value = this.params.masterGain;
    this.status = "stopped";
    this.schedulerRunning = false;
    this.lifecycle(`stop:${reason}`);
    return { stopped: true, reason };
  }

  async destroyGraph() {
    if (!this.context) return { destroyed: true, nodes: 0 };
    try {
      await this.stop("destroy");
    } catch {
      this.clearSchedulerTimer();
      this.stopAllVoices();
      this.stopAmbient();
    }
    if (this._stateListener && this.context) {
      this.context.removeEventListener("statechange", this._stateListener);
      this.listenerCount = Math.max(0, this.listenerCount - 1);
      this._stateListener = null;
    }
    this.stopAllVoices();
    this.stopAmbient();
    for (const node of [...this.nodes.keys()]) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.nodes.clear();
    this.voices.clear();
    this.analyserBuffers.clear();
    this.graph = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") {
      try {
        await context.close();
      } catch {
        // A browser may already have closed the context.
      }
    }
    this.status = "destroyed";
    this.schedulerRunning = false;
    this.lifecycle("graph:destroyed");
    return { destroyed: true, nodes: 0, contextState: context?.state || "closed" };
  }

  getLevels() {
    if (!this.graph || !this.context || this.context.state !== "running") {
      this.lastLevels = { left: 0, right: 0, peak: 0 };
      return this.lastLevels;
    }
    const read = (analyser) => {
      const data = this.analyserBuffers.get(analyser);
      if (!data) return 0;
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      let peak = 0;
      for (const sample of data) {
        sum += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
      return { rms: Math.sqrt(sum / data.length), peak };
    };
    const left = read(this.graph.analyserLeft);
    const right = read(this.graph.analyserRight);
    this.lastLevels = {
      left: left.rms,
      right: right.rms,
      peak: Math.max(left.peak, right.peak),
    };
    return this.lastLevels;
  }

  diagnostics() {
    const voiceNodes = [...this.voices.values()].reduce((total, voice) => total + voice.nodes.length, 0);
    const graphNodes = this.nodes.size - voiceNodes;
    const levels = this.lastLevels;
    return {
      status: this.status,
      contextState: this.context?.state || "closed",
      beat: this.beat,
      clock: this.context?.currentTime || 0,
      activeNodes: this.nodes.size,
      graphNodes,
      voiceNodes,
      voices: this.voices.size,
      schedulerRunning: this.schedulerRunning,
      timerCount: this.timers.size,
      listenerCount: this.listenerCount,
      startCount: this._startCount,
      ambientSources: this._ambient.size,
      peakDb: levels.peak > 0 ? 20 * Math.log10(levels.peak) : -Infinity,
      left: levels.left,
      right: levels.right,
      events: this.events.length,
      lastEvent: this.events[this.events.length - 1] || null,
      lastError: this.lastError,
      lifecycle: [...this._lifecycle],
    };
  }
}

export function previewPlan(game, params = DEFAULT_PARAMS, beats = 6) {
  const interval = beatDuration(params);
  return {
    interval,
    duration: beats * interval + 0.9,
    events: Array.from({ length: beats }, (_, beat) => ({
      ...pingPlan(game, beat, params),
      at: 0.08 + beat * interval,
    })),
  };
}

export async function renderPreview(game, params = DEFAULT_PARAMS, beats = 6) {
  const AudioContextClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AudioContextClass) throw new Error("OfflineAudioContext 不可用");
  const plan = previewPlan(game, params, beats);
  const frameCount = Math.ceil(plan.duration * 48000);
  const context = new AudioContextClass(2, frameCount, 48000);
  const master = context.createGain();
  const compressor = context.createDynamicsCompressor();
  master.gain.value = params.masterGain;
  compressor.threshold.value = -13;
  compressor.ratio.value = 8;
  master.connect(compressor).connect(context.destination);

  for (const event of plan.events) {
    if (!event.audible) continue;
    const osc = context.createOscillator();
    const filter = context.createBiquadFilter();
    const panner = context.createStereoPanner();
    const envelope = context.createGain();
    const echo = context.createDelay(1.2);
    const echoGain = context.createGain();
    const end = event.at + 0.52;
    osc.type = "sine";
    osc.frequency.setValueAtTime(event.frequency, event.at);
    filter.type = "lowpass";
    filter.frequency.value = event.filterHz;
    panner.pan.value = event.pan;
    echo.delayTime.value = event.delay;
    echoGain.gain.value = 0.24 * params.pingGain;
    envelope.gain.setValueAtTime(0.0001, event.at);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, event.gain), event.at + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(filter).connect(panner).connect(envelope);
    envelope.connect(master);
    envelope.connect(echo).connect(echoGain).connect(master);
    osc.start(event.at);
    osc.stop(end + 0.02);
  }

  const buffer = await context.startRendering();
  const signature = plan.events.map((event) => ({
    beat: event.beat,
    at: Number(event.at.toFixed(4)),
    pan: Number(event.pan.toFixed(4)),
    gain: Number(event.gain.toFixed(5)),
    delay: Number(event.delay.toFixed(4)),
    filterHz: Math.round(event.filterHz),
    targetId: event.targetId,
  }));
  return {
    signature,
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    wav: wavBlobFromBuffer(buffer),
    plan,
  };
}
