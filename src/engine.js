import {
  makeNoiseBuffer,
  makeRainBuffer,
  makeWindBuffer,
  makeVoiceBuffer,
  makeReverbImpulse,
  polarGain,
} from "./dsp.js";
import { encodeWav } from "./wav.js";

export const ROOM_ASPECT = 460 / 720;

export const DEFAULT_LAYOUT = {
  mics: [
    { id: "micA", label: "A 心形指向", pattern: "cardioid", x: 0.32, y: 0.55, angle: 0, gain: 1.0 },
    { id: "micB", label: "B 全指向", pattern: "omnidirectional", x: 0.5, y: 0.42, angle: 0, gain: 1.0 },
    { id: "micC", label: "C 双指向", pattern: "figure8", x: 0.68, y: 0.55, angle: Math.PI, gain: 1.0 },
  ],
  sources: {
    rain: { x: 0.12, y: 0.2, enabled: true },
    wind: { x: 0.88, y: 0.25, enabled: true },
    voice: { x: 0.5, y: 0.82, enabled: true },
  },
  monitorGain: 0.8,
};

export class EngineError extends Error {}

class Registry {
  constructor() {
    this.nodes = new Set();
    this.listeners = new Map();
  }
  get activeNodes() {
    return this.nodes.size;
  }
  get activeListeners() {
    let n = 0;
    for (const list of this.listeners.values()) n += list.size;
    return n;
  }
  track(node) {
    this.nodes.add(node);
    return node;
  }
  addListener(target, type, handler) {
    if (!this.listeners.has(target)) this.listeners.set(target, new Map());
    this.listeners.get(target).set(type, handler);
    target.addEventListener(type, handler);
  }
  removeListener(target, type) {
    const map = this.listeners.get(target);
    const handler = map && map.get(type);
    if (handler) {
      target.removeEventListener(type, handler);
      map.delete(type);
    }
  }
  destroy(node) {
    if (!this.nodes.has(node)) return;
    if (typeof node.stop === "function" && node.context.state !== "closed") {
      try {
        node.stop();
      } catch {
        /* 已停止的源忽略 */
      }
    }
    try {
      node.disconnect();
    } catch {
      /* 离线节点可能已断开 */
    }
    this.nodes.delete(node);
  }
  async destroyAll() {
    for (const [target, map] of this.listeners) {
      for (const [type, handler] of map) target.removeEventListener(type, handler);
      map.clear();
    }
    this.listeners.clear();
    for (const node of [...this.nodes]) this.destroy(node);
  }
}

// 房间归一化坐标 -> 带纵横比的二维距离（x、y 各映射到约 14.4m × 9.2m）。
export function roomVector(a, b) {
  const dx = (a.x - b.x) * 14.4;
  const dy = (a.y - b.y) * 9.2;
  return { dx, dy, dist: Math.hypot(dx, dy) };
}

// 某布局下每支麦克风对每个声源的拾音权重：距离衰减 × 指向性响应。
export function computePickupWeights(layout) {
  const weights = layout.mics.map((mic) => {
    const row = {};
    for (const [name, src] of Object.entries(layout.sources)) {
      const v = roomVector(mic, src);
      const incidence = Math.atan2(v.dy, v.dx) - mic.angle;
      const directivity = polarGain(mic.pattern, incidence);
      const distanceGain = 1 / (1 + 0.22 * v.dist + 0.012 * v.dist * v.dist);
      row[name] = distanceGain * directivity;
    }
    return row;
  });
  return weights;
}

export class RecordingEngine {
  constructor() {
    this.registry = new Registry();
    this.ctx = null;
    this.state = "idle"; // idle | running | recording
    this.startCount = 0;
    this.layout = structuredClone(DEFAULT_LAYOUT);
    this._chains = [];
    this._sourceChains = new Map();
    this._recorder = null;
    this.beats = [];
    this._raf = 0;
    this.onMeter = null;
    this.onStateChange = null;
    this.startedAt = 0;
    this.stoppedAt = 0;
  }

  get activeNodes() {
    return this.registry.activeNodes;
  }
  get activeListeners() {
    return this.registry.activeListeners;
  }

  _setState(state) {
    this.state = state;
    if (this.onStateChange) this.onStateChange(state);
  }

  _track(node) {
    return this.registry.track(node);
  }

  // 启动实时音频图。重复启动会被显式拒绝，避免重复监听器/重复图。
  async start() {
    if (this.state !== "idle") {
      throw new EngineError(`引擎已处于 ${this.state} 状态，禁止重复启动`);
    }
    if (this.ctx && this.ctx.state !== "closed") {
      throw new EngineError("旧 AudioContext 尚未关闭，拒绝创建重复图");
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    await this.ctx.resume();
    this._buildGraph({ record: true });
    this.startCount += 1;
    this.startedAt = this.ctx.currentTime;
    this._setState("recording");
    this._pumpMeters();
  }

  _buildGraph({ record }) {
    const ctx = this.ctx;
    const reg = this.registry;
    const master = this._track(ctx.createGain());
    master.gain.value = this.layout.monitorGain;
    // 硬切断门：停止时在淡出末端归零，阻断卷积器浮点尾音。
    const cutoff = this._track(ctx.createGain());
    cutoff.gain.value = 1;
    master.connect(cutoff);
    const convolver = this._track(ctx.createConvolver());
    convolver.buffer = makeReverbImpulse(ctx);
    const wet = this._track(ctx.createGain());
    wet.gain.value = 0.18;
    convolver.connect(wet).connect(master);

    this._buildSources();
    const weights = computePickupWeights(this.layout);
    this._chains = this.layout.mics.map((mic, idx) => {
      const micGain = this._track(ctx.createGain());
      micGain.gain.value = mic.gain;
      const pan = this._track(ctx.createStereoPanner());
      // 声像由房间内左右位置决定，位置在录音期间锁定。
      pan.pan.value = Math.max(-1, Math.min(1, (mic.x - 0.5) * 2));
      micGain.connect(pan).connect(master);
      micGain.connect(convolver);
      for (const [name, chain] of this._sourceChains) {
        const send = this._track(ctx.createGain());
        send.gain.value = weights[idx][name];
        chain.output.connect(send).connect(micGain);
      }
      return { mic, micGain, pan };
    });

    if (record) {
      this._recorder = this._createRecorder(master);
    }
    if (ctx instanceof AudioContext) {
      cutoff.connect(ctx.destination);
    }
    this.master = master;
    this.cutoff = cutoff;
  }

  _buildSources() {
    const ctx = this.ctx;
    const duration = 12;
    const rainBuf = makeRainBuffer(ctx, duration, 101);
    const windBuf = makeWindBuffer(ctx, duration, 202);
    const voice = makeVoiceBuffer(ctx, duration, 303);
    this.beats = voice.beats.map((t) => Number((t).toFixed(4)));

    const defs = [
      ["rain", rainBuf, true],
      ["wind", windBuf, true],
      ["voice", voice.buffer, false],
    ];
    for (const [name, buffer, loop] of defs) {
      if (!this.layout.sources[name].enabled) continue;
      const src = this._track(ctx.createBufferSource());
      src.buffer = buffer;
      src.loop = loop;
      const out = this._track(ctx.createGain());
      out.gain.value = name === "voice" ? 0.9 : 0.5;
      src.connect(out);
      src.start();
      this._sourceChains.set(name, { source: src, output: out });
    }
  }

  _createRecorder(master) {
    const ctx = this.ctx;
    const processor = this._track(ctx.createScriptProcessor(2048, 2, 2));
    const chunks = [];
    const reg = this.registry;
    let hardStopFrame = Infinity;
    let frameCounter = 0;
    const handler = (event) => {
      const left = event.inputBuffer.getChannelData(0);
      const right = event.inputBuffer.getChannelData(1);
      const blockStartFrame = frameCounter;
      frameCounter += left.length;
      if (Number.isFinite(hardStopFrame)) {
        const stopOffset = hardStopFrame - blockStartFrame;
        for (let i = Math.max(0, stopOffset); i < left.length; i++) {
          left[i] = 0;
          right[i] = 0;
        }
      }
      chunks.push([Float32Array.from(left), Float32Array.from(right)]);
      this._lastLevels = [peak(left), peak(right)];
    };
    reg.addListener(processor, "audioprocess", handler);
    master.connect(processor);
    // ScriptProcessor 需要连接 destination 才会在实时上下文持续触发。
    const silent = this._track(ctx.createGain());
    silent.gain.value = 0;
    processor.connect(silent).connect(ctx.destination);
    return {
      processor,
      chunks,
      armHardStop: (delaySeconds) => {
        // 用已处理样本数定位，避免 playbackTime 时间轴差异。
        hardStopFrame = frameCounter + Math.ceil(delaySeconds * ctx.sampleRate);
      },
      get hardStopFrame() {
        return hardStopFrame;
      },
      stop: () => {
        reg.removeListener(processor, "audioprocess");
        return this._mergeChunks(chunks);
      },
    };
  }

  _mergeChunks(chunks) {
    const frames = chunks.reduce((n, pair) => n + pair[0].length, 0);
    const buffer = this.ctx.createBuffer(2, frames, this.ctx.sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    let offset = 0;
    for (const [l, r] of chunks) {
      left.set(l, offset);
      right.set(r, offset);
      offset += l.length;
    }
    return buffer;
  }

  _pumpMeters() {
    const tick = () => {
      if (this.state === "idle") return;
      if (this.onMeter) this.onMeter(this._lastLevels || [0, 0]);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  // 输入中断：运行中关闭某声源，中断后该支路立即静音且节点被销毁。
  interruptInput(name) {
    if (this.state === "idle") throw new EngineError("空闲状态无法中断输入");
    const chain = this._sourceChains.get(name);
    if (!chain) return;
    const now = this.ctx.currentTime;
    chain.output.gain.cancelScheduledValues(now);
    chain.output.gain.setTargetAtTime(0, now, 0.015);
    window.setTimeout(() => {
      this.registry.destroy(chain.source);
      this.registry.destroy(chain.output);
      this._sourceChains.delete(name);
    }, 120);
  }

  // 停止：先在 50ms 内把主输出拉到零（混响尾音也被切断），再销毁全部节点。
  async stop() {
    if (this.state === "idle") throw new EngineError("引擎未在运行");
    cancelAnimationFrame(this._raf);
    const now = this.ctx.currentTime;
    this._stopAt = now;
    const master = this.master;
    const cutoff = this.cutoff;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + 0.05);
    cutoff.gain.cancelScheduledValues(now);
    cutoff.gain.setValueAtTime(1, now + 0.05 - 1 / this.ctx.sampleRate);
    cutoff.gain.setValueAtTime(0, now + 0.05);
    if (this._recorder) this._recorder.armHardStop(0.05);

    await new Promise((resolve) => window.setTimeout(resolve, 160));
    let recording = null;
    if (this._recorder) {
      recording = this._recorder.stop();
      const hardFrame = this._recorder.hardStopFrame;
      if (Number.isFinite(hardFrame) && hardFrame < recording.length) {
        // 保留硬切断点之后一个块并置零，使缓冲尾部存在可断言的纯静音区。
        const keep = Math.min(recording.length, hardFrame + 2048);
        const trimmed = this.ctx.createBuffer(2, keep, recording.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
          trimmed.getChannelData(ch).set(recording.getChannelData(ch).subarray(0, keep));
        }
        recording = trimmed;
      }
      this._recorder = null;
    }
    this.stoppedAt = this.ctx.currentTime;
    await this.teardown();
    this.recording = recording;
    this.recordingMeta = {
      duration: recording ? recording.duration : 0,
      beats: [...this.beats],
      layout: structuredClone(this.layout),
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
    };
    return recording;
  }

  async teardown() {
    cancelAnimationFrame(this._raf);
    await this.registry.destroyAll();
    if (this.ctx && this.ctx.state !== "closed") {
      try {
        await this.ctx.close();
      } catch {
        /* 离线上下文没有 close 也无妨 */
      }
    }
    this.ctx = null;
    this._chains = [];
    this._sourceChains = new Map();
    this.master = null;
    this._lastLevels = [0, 0];
    this._setState("idle");
  }

  clearBuffer() {
    if (this.state !== "idle") throw new EngineError("必须先停止才能清空缓冲");
    this.recording = null;
    this.recordingMeta = null;
  }

  get hasBuffer() {
    return Boolean(this.recording);
  }

  exportWav() {
    if (!this.recording) throw new EngineError("缓冲为空，无法导出");
    const blob = encodeWav(this.recording);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${Date.now()}.wav`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    return blob;
  }

  updateLayout(patch) {
    if (this.state !== "idle") {
      throw new EngineError("录音进行中布局已锁定，停止并清空后才能调整");
    }
    this.layout = structuredPatch(this.layout, patch);
  }
}

function structuredPatch(base, patch) {
  const next = structuredClone(base);
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      next[key] = structuredPatch(base[key] || {}, value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function peak(channels) {
  let p = 0;
  for (let i = 0; i < channels.length; i++) p = Math.max(p, Math.abs(channels[i]));
  return p;
}

// 确定性离线渲染：测试与无浏览器音频设备环境下复现整套图。
// options:
//   interruptAt  在该秒切断某声源（输入中断验证）
//   soloMic      只保留指定索引的麦克风（逐麦克风差异分析）
//   stopAt       主输出在该秒淡出到零（尾音验证）
export async function renderOffline(layout, options = {}) {
  const seconds = options.seconds || 4;
  const sampleRate = 48000;
  const ctx = new OfflineAudioContext(2, Math.floor(seconds * sampleRate), sampleRate);
  const reg = new Registry();
  const track = (node) => reg.track(node);

  const master = track(ctx.createGain());
  master.gain.value = layout.monitorGain;
  master.connect(ctx.destination);
  const convolver = track(ctx.createConvolver());
  convolver.buffer = makeReverbImpulse(ctx);
  const wet = track(ctx.createGain());
  wet.gain.value = 0.18;
  convolver.connect(wet).connect(master);

  const duration = seconds + 2;
  const sources = new Map();
  const defs = [
    ["rain", makeRainBuffer(ctx, duration, 101), true],
    ["wind", makeWindBuffer(ctx, duration, 202), true],
    ["voice", makeVoiceBuffer(ctx, duration, 303).buffer, false],
  ];
  const voiceBeats = makeVoiceBuffer(ctx, duration, 303).beats;
  for (const [name, buffer, loop] of defs) {
    if (!layout.sources[name].enabled) continue;
    const src = track(ctx.createBufferSource());
    src.buffer = buffer;
    src.loop = loop;
    const out = track(ctx.createGain());
    out.gain.value = name === "voice" ? 0.9 : 0.5;
    src.connect(out);
    src.start(0);
    sources.set(name, { source: src, output: out });
  }

  if (options.interruptAt != null && sources.has(options.interruptName || "voice")) {
    const chain = sources.get(options.interruptName || "voice");
    chain.output.gain.setValueAtTime(chain.output.gain.value, options.interruptAt);
    chain.output.gain.linearRampToValueAtTime(0, options.interruptAt + 0.03);
    chain.source.stop(options.interruptAt + 0.05);
  }

  const weights = computePickupWeights(layout);
  const panValues = [];
  layout.mics.forEach((mic, idx) => {
    if (options.soloMic != null && options.soloMic !== idx) return;
    const micGain = track(ctx.createGain());
    micGain.gain.value = mic.gain;
    const pan = track(ctx.createStereoPanner());
    pan.pan.value = Math.max(-1, Math.min(1, (mic.x - 0.5) * 2));
    panValues.push({ id: mic.id, pan: pan.pan.value });
    micGain.connect(pan).connect(master);
    micGain.connect(convolver);
    for (const [name, chain] of sources) {
      const send = track(ctx.createGain());
      send.gain.value = weights[idx][name];
      chain.output.connect(send).connect(micGain);
    }
  });

  if (options.stopAt != null) {
    master.gain.setValueAtTime(layout.monitorGain, options.stopAt);
    master.gain.linearRampToValueAtTime(0, options.stopAt + 0.05);
    // 淡出后硬切断，保证停止点之后不残留卷积器浮点尾音。
    const cutoff = track(ctx.createGain());
    const endTime = options.stopAt + 0.05;
    cutoff.gain.setValueAtTime(1, endTime - 1 / sampleRate);
    cutoff.gain.setValueAtTime(0, endTime);
    master.disconnect();
    master.connect(cutoff).connect(ctx.destination);
  }

  const rendered = await ctx.startRendering();
  await reg.destroyAll();
  return {
    buffer: rendered,
    beats: voiceBeats.filter((t) => t < seconds),
    panValues,
    weights,
    activeNodesAtEnd: reg.activeNodes,
  };
}
