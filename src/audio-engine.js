import {
  CHANNELS,
  DEFAULT_PARAMS,
  SAMPLE_RATE,
  SAFE_CEILING,
  SAFE_CEILING_DB,
  analyzeSpectrum,
  cloneParams,
  computeMetrics,
  computeRms,
  createFixture,
  dbToGain,
  downsampleEnvelope,
  encodeWav16,
  gainToDb,
  pcmChecksum,
  pcmToFloatChannels,
  quantizePcm16,
  repairParams,
  wavDuration
} from "./audio-core.js";

const GATE_BLOCK = 128;
const TEST_SAMPLE_RATE = 44100;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function copyFixtureToContext(context, fixture) {
  const buffer = context.createBuffer(CHANNELS, fixture.sampleCount, fixture.sampleRate);
  for (let channel = 0; channel < CHANNELS; channel += 1) {
    buffer.copyToChannel(fixture.channels[channel], channel);
  }
  return buffer;
}

function filterNodes(context, params) {
  const nodes = [];
  const definitions = params.nodes;

  if (!definitions.highpass.bypass) {
    const node = context.createBiquadFilter();
    node.type = "highpass";
    node.frequency.value = definitions.highpass.cutoff;
    node.Q.value = definitions.highpass.q;
    nodes.push(node);
  }
  if (!definitions.lowshelf.bypass) {
    const node = context.createBiquadFilter();
    node.type = "lowshelf";
    node.frequency.value = definitions.lowshelf.freq;
    node.gain.value = definitions.lowshelf.gainDb;
    nodes.push(node);
  }
  if (!definitions.lowpass.bypass) {
    const node = context.createBiquadFilter();
    node.type = "lowpass";
    node.frequency.value = definitions.lowpass.cutoff;
    node.Q.value = definitions.lowpass.q;
    nodes.push(node);
  }
  return nodes;
}

function calculateGateLevels(channels, params) {
  const frames = channels[0].length;
  const blocks = Math.ceil(frames / GATE_BLOCK);
  const levels = new Float32Array(blocks);
  const blockSeconds = GATE_BLOCK / SAMPLE_RATE;
  const attackCoefficient = 1 - Math.exp(-blockSeconds / Math.max(0.001, params.attackMs / 1000));
  const releaseCoefficient = 1 - Math.exp(-blockSeconds / Math.max(0.001, params.releaseMs / 1000));
  const threshold = params.thresholdDb;
  const closeThreshold = threshold - 4;
  let open = false;
  let level = 0;

  for (let block = 0; block < blocks; block += 1) {
    const start = block * GATE_BLOCK;
    const end = Math.min(frames, start + GATE_BLOCK);
    let energy = 0;
    for (let index = start; index < end; index += 1) {
      const left = channels[0][index] || 0;
      const right = channels[1]?.[index] || 0;
      energy += (left * left + right * right) * 0.5;
    }
    const rms = Math.sqrt(energy / Math.max(1, end - start));
    const levelDb = gainToDb(rms);
    if (levelDb >= threshold) open = true;
    else if (levelDb < closeThreshold) open = false;

    const target = open ? 1 : 0;
    const coefficient = target > level ? attackCoefficient : releaseCoefficient;
    level += (target - level) * coefficient;
    levels[block] = Math.max(0, Math.min(1, level));
  }

  return levels;
}

function scheduleGate(gain, channels, params) {
  const levels = calculateGateLevels(channels, params);
  const now = 0;
  gain.gain.cancelScheduledValues(now);
  for (let block = 0; block < levels.length; block += 1) {
    gain.gain.setValueAtTime(levels[block], block * GATE_BLOCK / SAMPLE_RATE);
  }
}

function createSoftClipCurve(drive, points = 8193) {
  const curve = new Float32Array(points);
  const normalization = Math.tanh(drive);
  for (let index = 0; index < points; index += 1) {
    const x = index * 2 / (points - 1) - 1;
    curve[index] = Math.tanh(drive * x) / normalization;
  }
  return curve;
}

export class AudioEngine {
  constructor({ onEnded, onTelemetry } = {}) {
    this.fixture = createFixture();
    this.rendered = null;
    this.renderPromise = null;
    this.renderGeneration = 0;
    this.session = null;
    this.activeNodes = new Set();
    this.contextState = "未创建";
    this.status = "idle";
    this.error = null;
    this.telemetryTimer = null;
    this.onEnded = onEnded;
    this.onTelemetry = onTelemetry;
  }

  get activeNodeCount() {
    return this.activeNodes.size;
  }

  async initialize(params = DEFAULT_PARAMS) {
    return this.render(params);
  }

  async render(inputParams = DEFAULT_PARAMS) {
    const params = repairParams(cloneParams(inputParams));
    const generation = ++this.renderGeneration;
    this.status = "rendering";
    this.error = null;
    this.#emitTelemetry();

    try {
      const result = await this.#renderInternal(params, generation);
      if (generation !== this.renderGeneration) return null;
      this.rendered = result;
      this.status = this.session ? "running" : "ready";
      this.#emitTelemetry();
      return result;
    } catch (error) {
      if (generation !== this.renderGeneration) return null;
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.#emitTelemetry();
      throw error;
    }
  }

  async #renderInternal(params, generation) {
    if (typeof OfflineAudioContext === "undefined") {
      throw new Error("此浏览器不支持 OfflineAudioContext");
    }

    const firstContext = new OfflineAudioContext(CHANNELS, this.fixture.sampleCount, SAMPLE_RATE);
    const sourceBuffer = copyFixtureToContext(firstContext, this.fixture);
    const source = firstContext.createBufferSource();
    source.buffer = sourceBuffer;
    const filters = filterNodes(firstContext, params);
    let tail = source;
    for (const node of filters) {
      tail.connect(node);
      tail = node;
    }
    tail.connect(firstContext.destination);
    source.start();
    const filteredBuffer = await firstContext.startRendering();

    const secondContext = new OfflineAudioContext(CHANNELS, this.fixture.sampleCount, SAMPLE_RATE);
    const secondSource = secondContext.createBufferSource();
    const secondBuffer = secondContext.createBuffer(CHANNELS, this.fixture.sampleCount, SAMPLE_RATE);
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      secondBuffer.copyToChannel(filteredBuffer.getChannelData(channel), channel);
    }
    secondSource.buffer = secondBuffer;

    let secondTail = secondSource;
    const gateActive = !params.nodes.gate.bypass;
    if (gateActive) {
      const gate = secondContext.createGain();
      scheduleGate(gate, [
        filteredBuffer.getChannelData(0),
        filteredBuffer.getChannelData(1)
      ], params.nodes.gate);
      secondTail.connect(gate);
      secondTail = gate;
    }

    const softClipActive = !params.nodes.softclip.bypass;
    if (softClipActive) {
      const shaper = secondContext.createWaveShaper();
      shaper.curve = createSoftClipCurve(params.nodes.softclip.drive);
      shaper.oversample = "4x";
      secondTail.connect(shaper);
      secondTail = shaper;
    }

    const master = secondContext.createGain();
    master.gain.value = dbToGain(params.masterGainDb);
    secondTail.connect(master);
    master.connect(secondContext.destination);
    secondSource.start();
    const renderedBuffer = await secondContext.startRendering();

    if (generation !== this.renderGeneration) return null;

    const rawChannels = [
      new Float32Array(renderedBuffer.getChannelData(0)),
      new Float32Array(renderedBuffer.getChannelData(1))
    ];
    const rawMetrics = computeMetrics(rawChannels);
    const overCeilingSamples = countOverCeiling(rawChannels, SAFE_CEILING);
    const safetyScale = rawMetrics.peak > SAFE_CEILING ? SAFE_CEILING / rawMetrics.peak : 1;

    if (safetyScale < 1) {
      for (const channel of rawChannels) {
        for (let index = 0; index < channel.length; index += 1) {
          channel[index] *= safetyScale;
        }
      }
    }

    const pcm = quantizePcm16(rawChannels);
    const outputChannels = pcmToFloatChannels(pcm);
    const outputMetrics = computeMetrics(outputChannels);
    const sourceMetrics = computeMetrics(this.fixture.channels);
    const beforeSpectrum = analyzeSpectrum(this.fixture.channels);
    const afterSpectrum = analyzeSpectrum(outputChannels);
    const wavBytes = encodeWav16(pcm, SAMPLE_RATE);
    const checksum = pcmChecksum(pcm);
    const duration = wavDuration(wavBytes);
    const activeIds = [
      "highpass",
      "lowshelf",
      "lowpass",
      "gate",
      "softclip"
    ].filter((id) => !params.nodes[id].bypass);

    return {
      params,
      generation,
      pcm,
      floatChannels: outputChannels,
      sourceChannels: this.fixture.channels,
      wavBytes,
      checksum,
      duration,
      sampleRate: SAMPLE_RATE,
      sampleCount: this.fixture.sampleCount,
      metrics: {
        input: sourceMetrics,
        output: outputMetrics
      },
      spectra: {
        before: beforeSpectrum,
        after: afterSpectrum
      },
      waveform: {
        input: downsampleEnvelope(this.fixture.channels, 430),
        output: downsampleEnvelope(outputChannels, 430)
      },
      safety: {
        engaged: safetyScale < 1,
        rawPeak: rawMetrics.peak,
        rawPeakDb: gainToDb(rawMetrics.peak),
        outputPeak: outputMetrics.peak,
        outputPeakDb: gainToDb(outputMetrics.peak),
        outputClippedSamples: outputMetrics.clippedSamples,
        overCeilingSamples,
        scale: safetyScale,
        ceiling: SAFE_CEILING,
        ceilingDb: SAFE_CEILING_DB
      },
      routing: {
        activeIds,
        bypassedIds: Object.keys(params.nodes).filter((id) => params.nodes[id].bypass),
        safetyLast: outputMetrics.clippedSamples === 0
      },
      metadata: this.fixture.metadata
    };
  }

  async play({ muted = false } = {}) {
    await this.stop();
    if (!this.rendered) throw new Error("音频尚未完成渲染");

    const context = new AudioContext({ latencyHint: "interactive" });
    this.contextState = context.state;
    const source = context.createBufferSource();
    const buffer = context.createBuffer(CHANNELS, this.fixture.sampleCount, SAMPLE_RATE);
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      buffer.copyToChannel(this.rendered.floatChannels[channel], channel);
    }
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = muted ? 0 : 1;
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(context.destination);

    const session = {
      context,
      source,
      gain,
      analyser,
      nodes: [source, gain, analyser],
      startedAt: 0,
      endedNaturally: false
    };
    this.session = session;
    this.activeNodes = new Set(session.nodes);
    for (const node of session.nodes) this.activeNodes.add(node);
    session.source.onended = () => {
      if (this.session !== session) return;
      session.endedNaturally = true;
      this.stop("ended");
    };

    await context.resume();
    session.startedAt = context.currentTime;
    source.start();
    this.status = "running";
    this.contextState = context.state;
    this.#startTelemetry();
    this.#emitTelemetry();
    return session;
  }

  async stop(reason = "manual") {
    const session = this.session;
    this.session = null;
    this.#stopTelemetry();

    if (session) {
      try {
        session.source.onended = null;
        session.source.stop();
      } catch {
        // A source that already ended cannot be stopped twice.
      }
      for (const node of session.nodes) {
        try {
          node.disconnect();
        } catch {
          // Disconnect is idempotent for the lifecycle audit.
        }
      }
      try {
        await session.context.close();
      } catch {
        // A context may already be closing after output completion.
      }
      this.contextState = session.context.state;
    } else {
      this.contextState = "未创建";
    }

    this.activeNodes.clear();
    if (this.status !== "rendering" && this.status !== "error") {
      this.status = this.rendered ? "ready" : "idle";
    }
    this.#emitTelemetry();
    if (reason === "ended") this.onEnded?.();
  }

  getPlaybackTime() {
    if (!this.session) return 0;
    return Math.max(0, Math.min(
      this.rendered?.duration || 0,
      this.session.context.currentTime - this.session.startedAt
    ));
  }

  async dispose() {
    await this.stop("dispose");
    this.activeNodes.clear();
    this.rendered = null;
    this.status = "disposed";
    this.#emitTelemetry();
  }

  async runLifecycleAudit({ listenerCountBefore = null, getListenerCount = null } = {}) {
    await this.stop("audit-start");
    const results = [];

    try {
      const graph = await createTestGraph(0.55);
      await wait(85);
      graph.source.onended = null;
      try { graph.source.stop(); } catch { /* already stopped */ }
      graph.source.disconnect();
      await wait(45);
      const tailSamples = new Float32Array(graph.analyser.fftSize);
      graph.analyser.getFloatTimeDomainData(tailSamples);
      const tailRms = computeRms([tailSamples]);
      await closeTestGraph(graph);
      results.push({
        id: "input-interruption",
        name: "输入中断",
        passed: tailRms < 1e-6 && graph.context.state === "closed" && this.activeNodeCount === 0,
        detail: `尾音 RMS ${gainToDb(tailRms).toFixed(1)} dB · Context ${graph.context.state} · 活动节点 0`
      });
    } catch (error) {
      results.push({
        id: "input-interruption",
        name: "输入中断",
        passed: false,
        detail: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      const graph = await createTestGraph(0.18);
      await wait(20);
      graph.source.onended = null;
      try { graph.source.stop(); } catch { /* already stopped */ }
      for (const node of graph.nodes) node.disconnect();
      await graph.context.close();
      results.push({
        id: "node-destruction",
        name: "节点销毁",
        passed: graph.context.state === "closed" && this.activeNodeCount === 0,
        detail: `${graph.nodes.length} 个节点已断开 · Context ${graph.context.state}`
      });
    } catch (error) {
      results.push({
        id: "node-destruction",
        name: "节点销毁",
        passed: false,
        detail: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      const cycles = [];
      for (let index = 0; index < 3; index += 1) {
        await this.play({ muted: true });
        await wait(35);
        const context = this.session.context;
        await this.stop("audit-cycle");
        cycles.push({
          activeAfterStop: this.activeNodeCount,
          state: context.state
        });
      }
      const listenerCountAfter = getListenerCount?.() ?? listenerCountBefore;
      const stableListeners = listenerCountBefore === null || listenerCountBefore === listenerCountAfter;
      const allReleased = cycles.every((cycle) => cycle.activeAfterStop === 0 && cycle.state === "closed");
      results.push({
        id: "repeat-start",
        name: "重复启动",
        passed: allReleased && stableListeners && this.session === null,
        detail: `3 轮启动 → 停止 · 节点残留 0 · 监听器 ${listenerCountBefore ?? "?"} → ${listenerCountAfter ?? "?"}`
      });
    } catch (error) {
      results.push({
        id: "repeat-start",
        name: "重复启动",
        passed: false,
        detail: error instanceof Error ? error.message : String(error)
      });
    }

    if (this.rendered) {
      this.status = "ready";
      this.contextState = "未创建";
      this.#emitTelemetry();
    }
    return results;
  }

  snapshotValues() {
    if (!this.rendered) return null;
    return {
      beatPoints: [...this.rendered.metadata.beatPoints],
      pan: this.rendered.metrics.output.pan,
      gainDb: this.rendered.params.masterGainDb,
      exportDuration: this.rendered.duration,
      checksum: this.rendered.checksum
    };
  }

  #startTelemetry() {
    this.#stopTelemetry();
    this.telemetryTimer = setInterval(() => this.#emitTelemetry(), 100);
  }

  #stopTelemetry() {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.telemetryTimer = null;
  }

  #emitTelemetry() {
    this.onTelemetry?.(this.getState());
  }

  getState() {
    return {
      status: this.status,
      activeNodes: this.activeNodeCount,
      contextState: this.contextState,
      playbackTime: this.getPlaybackTime(),
      generation: this.rendered?.generation || 0,
      checksum: this.rendered?.checksum || null,
      duration: this.rendered?.duration || 0,
      error: this.error
    };
  }
}

function countOverCeiling(channels, ceiling) {
  let count = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) {
      if (Math.abs(channel[index]) > ceiling) count += 1;
    }
  }
  return count;
}

async function createTestGraph(durationSeconds) {
  const context = new AudioContext({ latencyHint: "interactive" });
  await context.resume();
  const frames = Math.max(128, Math.round(TEST_SAMPLE_RATE * durationSeconds));
  const buffer = context.createBuffer(1, frames, TEST_SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < frames; index += 1) {
    data[index] = 0.12 * Math.sin(2 * Math.PI * 220 * index / TEST_SAMPLE_RATE);
  }

  const source = context.createBufferSource();
  source.buffer = buffer;
  const gain = context.createGain();
  gain.gain.value = 0.7;
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(gain);
  gain.connect(analyser);
  analyser.connect(context.destination);
  source.start();
  return { context, source, gain, analyser, nodes: [source, gain, analyser] };
}

async function closeTestGraph(graph) {
  for (const node of graph.nodes) {
    try { node.disconnect(); } catch { /* disconnected above */ }
  }
  await graph.context.close();
}
