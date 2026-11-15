import {
  FORMATS,
  SAMPLE_RATE,
  buildBeatPoints,
  distanceGain,
  normalizePath,
  samplePath,
  sampleSpatialFrame
} from "./model.js";
import { encodeWav, sha256 } from "./wav.js";

export class NodeRegistry {
  constructor() {
    this.nodes = new Set();
    this.labels = new Map();
  }

  adopt(node, label) {
    this.nodes.add(node);
    this.labels.set(node, label);
    return node;
  }

  release(node) {
    try {
      node.disconnect();
    } catch {
      // A node may already have been disconnected by its owner.
    }
    this.nodes.delete(node);
    this.labels.delete(node);
  }

  releaseAll() {
    for (const node of this.nodes) {
      try {
        node.disconnect();
      } catch {
        // Cleanup is best-effort for already-disposed native nodes.
      }
    }
    this.nodes.clear();
    this.labels.clear();
  }

  get size() {
    return this.nodes.size;
  }
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

export function createImpulseResponse(context, channels, seconds = 0.62, seed = 0x51a7) {
  const frames = Math.max(1, Math.floor(seconds * context.sampleRate));
  const impulse = context.createBuffer(channels, frames, context.sampleRate);
  for (let channel = 0; channel < channels; channel += 1) {
    const random = seededRandom(seed + channel * 0x9e3779b1);
    const data = impulse.getChannelData(channel);
    for (let frame = 0; frame < frames; frame += 1) {
      const progress = frame / frames;
      const decay = Math.pow(1 - progress, 2.8);
      const early = frame < 180 ? Math.sin(frame * 0.13) * 0.04 : 0;
      data[frame] = ((random() * 2 - 1) * 0.26 + early) * decay;
    }
  }
  return impulse;
}

function pulsePattern(sourceIndex, bpm, duration) {
  const interval = 60 / bpm;
  const division = [1, 2, 2, 4][sourceIndex] ?? 1;
  const offset = sourceIndex === 2 ? interval / 2 : 0;
  const pulses = [];
  for (let time = offset; time < duration; time += interval * division) {
    pulses.push(time);
  }
  return pulses;
}

function scheduleBeatEnvelope(param, state, source, sourceIndex, startTime) {
  const interval = 60 / state.bpm;
  const decay = Math.min(0.18, interval * 0.6);
  const floor = 0.012;
  const peak = 0.19 + source.gain * 0.22;
  param.setValueAtTime(floor, startTime);
  for (const pulse of pulsePattern(sourceIndex, state.bpm, state.duration)) {
    const at = startTime + pulse;
    if (at >= startTime + state.duration) {
      continue;
    }
    param.setValueAtTime(floor, at);
    param.linearRampToValueAtTime(peak, at + 0.012);
    param.exponentialRampToValueAtTime(floor, Math.min(at + decay, startTime + state.duration));
  }
}

function setAudioParam(param, value, time) {
  param.setValueAtTime(value, time);
}

function scheduleRamp(param, value, time) {
  if (typeof param.linearRampToValueAtTime === "function") {
    param.linearRampToValueAtTime(value, time);
  } else {
    param.setValueAtTime(value, time);
  }
}

function buildAutomationTimes(state) {
  const pathTimes = normalizePath(state.path, state.duration).map((point) => point.time);
  const beats = buildBeatPoints(state.duration, state.bpm).map((beat) => beat.time);
  const ticks = [];
  for (let time = 0; time <= state.duration; time += 0.08) {
    ticks.push(Number(time.toFixed(5)));
  }
  return Array.from(new Set([0, state.duration, ...pathTimes, ...beats, ...ticks]))
    .filter((time) => time >= 0 && time <= state.duration)
    .sort((a, b) => a - b);
}

function createSourceBuffer(context, source, sourceIndex) {
  const frames = context.sampleRate;
  const buffer = context.createBuffer(1, frames, context.sampleRate);
  const data = buffer.getChannelData(0);
  const phase = sourceIndex * 0.37;
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / context.sampleRate;
    const fundamental = Math.sin(2 * Math.PI * source.frequency * time + phase);
    const second = Math.sin(2 * Math.PI * source.frequency * 2 * time + phase * 0.5);
    const third = Math.sin(2 * Math.PI * source.frequency * 3 * time + phase * 0.25);
    data[frame] = fundamental * 0.62 + second * 0.2 + third * 0.09;
  }
  return buffer;
}

function scheduleListenerPath(listener, state, startTime, times) {
  const x = listener.positionX;
  const y = listener.positionY;
  const z = listener.positionZ;
  if (!x || !y || !z) {
    return;
  }
  times.forEach((time, index) => {
    const point = samplePath(state.path, state.duration, time);
    const at = startTime + time;
    if (index === 0) {
      setAudioParam(x, point.x, at);
      setAudioParam(y, 0, at);
      setAudioParam(z, -point.y, at);
    } else {
      scheduleRamp(x, point.x, at);
      scheduleRamp(y, 0, at);
      scheduleRamp(z, -point.y, at);
    }
  });
}

function setupReverb(context, state, registry, master, startTime) {
  const channels = FORMATS[state.format].channels;
  const input = registry.adopt(context.createGain(), "reverb-input");
  input.channelCount = channels;
  input.channelCountMode = "explicit";
  input.channelInterpretation = "speakers";

  const convolver = registry.adopt(context.createConvolver(), "reverb-convolver");
  convolver.buffer = createImpulseResponse(context, channels, 0.62);
  convolver.normalize = false;

  const wet = registry.adopt(context.createGain(), "reverb-return");
  wet.gain.setValueAtTime(channels === 4 ? 0.72 : 0.58, startTime);
  input.connect(convolver);
  convolver.connect(wet);
  wet.connect(master);
  return input;
}

export function buildGraph(context, state, options = {}) {
  const registry = options.registry ?? new NodeRegistry();
  const startTime = options.startTime ?? 0;
  const channels = FORMATS[state.format].channels;
  const times = buildAutomationTimes(state);
  const oscillators = [];

  const master = registry.adopt(context.createGain(), "master");
  master.channelCount = channels;
  master.channelCountMode = "explicit";
  master.channelInterpretation = "speakers";
  master.gain.setValueAtTime(0.52, startTime);

  const reverbInput = setupReverb(context, state, registry, master, startTime);
  if (state.format === "binaural") {
    scheduleListenerPath(context.listener, state, startTime, times);
  }

  state.sources.forEach((source, sourceIndex) => {
    const oscillator = registry.adopt(context.createBufferSource(), `${source.id}-voice`);
    oscillator.buffer = createSourceBuffer(context, source, sourceIndex);
    oscillator.loop = true;
    const envelope = registry.adopt(context.createGain(), `${source.id}-envelope`);
    scheduleBeatEnvelope(envelope.gain, state, source, sourceIndex, startTime);
    const dry = registry.adopt(context.createGain(), `${source.id}-dry`);
    dry.gain.setValueAtTime(1, startTime);
    const send = registry.adopt(context.createGain(), `${source.id}-send`);
    const spatial = createSpatializer(context, state, source, sourceIndex, registry, times, startTime);

    oscillator.connect(envelope);
    envelope.connect(spatial.input);
    spatial.output.connect(dry);
    dry.connect(master);
    spatial.output.connect(send);
    send.connect(reverbInput);

    times.forEach((time, index) => {
      const value = sampleSpatialFrame(state, time).sources[sourceIndex].send;
      if (index === 0) {
        setAudioParam(send.gain, value, startTime + time);
      } else {
        scheduleRamp(send.gain, value, startTime + time);
      }
    });

    oscillator.start(startTime);
    oscillator.stop(startTime + state.duration + 0.03);
    oscillators.push(oscillator);
  });

  return {
    master,
    registry,
    oscillators,
    times,
    startTime,
    endTime: startTime + state.duration,
    dispose() {
      for (const oscillator of oscillators) {
        try {
          oscillator.stop();
        } catch {
          // Oscillator was already stopped by its scheduled end time.
        }
      }
      registry.releaseAll();
    }
  };
}

function createSpatializer(context, state, source, sourceIndex, registry, times, startTime) {
  const input = registry.adopt(context.createGain(), `${source.id}-spatial-input`);
  input.channelCount = 1;
  input.channelCountMode = "explicit";

  if (state.format === "binaural") {
    const panner = registry.adopt(context.createPanner(), `${source.id}-hrtf`);
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 1.15;
    panner.maxDistance = 40;
    panner.rolloffFactor = 0.72;
    if (panner.positionX) {
      panner.positionX.setValueAtTime(source.x, startTime);
      panner.positionY.setValueAtTime(source.z, startTime);
      panner.positionZ.setValueAtTime(-source.y, startTime);
    } else {
      panner.setPosition(source.x, source.z, -source.y);
    }
    input.connect(panner);
    return { input, output: panner };
  }

  const merger = registry.adopt(context.createChannelMerger(4), `${source.id}-quad-merger`);
  merger.channelInterpretation = "speakers";
  const gains = Array.from({ length: 4 }, (_, channel) => {
    const gain = registry.adopt(context.createGain(), `${source.id}-quad-${channel}`);
    gain.channelCount = 1;
    gain.channelCountMode = "explicit";
    input.connect(gain);
    gain.connect(merger, 0, channel);
    return gain;
  });

  times.forEach((time, timeIndex) => {
    const frame = sampleSpatialFrame(state, time).sources[sourceIndex];
    const attenuation = distanceGain(frame.distance);
    frame.quad.forEach((panGain, channel) => {
      const value = panGain * attenuation;
      if (timeIndex === 0) {
        setAudioParam(gains[channel].gain, value, startTime + time);
      } else {
        scheduleRamp(gains[channel].gain, value, startTime + time);
      }
    });
  });
  return { input, output: merger };
}

export async function renderOffline(state, options = {}) {
  const format = options.format ?? state.format;
  const renderState = { ...state, format };
  const channels = FORMATS[format]?.channels;
  if (!channels) {
    throw new Error("离线渲染格式无效");
  }
  const sampleRate = options.sampleRate ?? state.sampleRate ?? SAMPLE_RATE;
  const duration = Number(state.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("离线渲染时长无效");
  }

  const length = Math.round(duration * sampleRate);
  const context = new OfflineAudioContext({
    numberOfChannels: channels,
    length,
    sampleRate
  });
  const registry = new NodeRegistry();
  const graph = buildGraph(context, renderState, { registry, startTime: 0 });
  const nodesCreated = graph.registry.size;
  graph.master.connect(context.destination);

  let rendered;
  try {
    rendered = await context.startRendering();
  } finally {
    graph.dispose();
  }

  const wav = encodeWav(rendered);
  const checksum = await sha256(wav);
  return {
    wav,
    checksum,
    format,
    channels: rendered.numberOfChannels,
    sampleRate: rendered.sampleRate,
    frames: rendered.length,
    duration: rendered.length / rendered.sampleRate,
    nodesCreated,
    renderEngine: "OfflineAudioContext",
    renderedAt: new Date().toISOString()
  };
}
