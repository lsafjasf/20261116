export const MODEL_VERSION = 1;
export const SAMPLE_RATE = 48_000;
export const FORMATS = Object.freeze({
  binaural: { channels: 2, label: "双耳 / HRTF" },
  quad: { channels: 4, label: "四声道 / Quad" }
});

const SOURCE_COLORS = ["#ff6b6b", "#f4c95d", "#61d4b3", "#6ea8fe"];

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function deepClone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

export function createDefaultState() {
  const duration = 4.8;
  const path = [
    { time: 0, x: -2.6, y: 0.2, z: 0 },
    { time: 1.2, x: -0.7, y: 0.9, z: 0 },
    { time: 2.4, x: 1.8, y: 0.3, z: 0 },
    { time: 3.6, x: 0.9, y: -1.5, z: 0 },
    { time: duration, x: -2.4, y: -0.8, z: 0 }
  ];

  return {
    version: MODEL_VERSION,
    name: "四源空间路径",
    format: "binaural",
    duration,
    sampleRate: SAMPLE_RATE,
    bpm: 120,
    path,
    sources: [
      { id: "source-1", name: "低频脉冲", frequency: 110, color: SOURCE_COLORS[0], x: -3.4, y: 2.4, z: 0, gain: 0.82 },
      { id: "source-2", name: "柔和和弦", frequency: 220, color: SOURCE_COLORS[1], x: 3.2, y: 2.1, z: 0, gain: 0.68 },
      { id: "source-3", name: "高频点缀", frequency: 440, color: SOURCE_COLORS[2], x: -2.9, y: -2.5, z: 0, gain: 0.52 },
      { id: "source-4", name: "空间泛音", frequency: 330, color: SOURCE_COLORS[3], x: 3.1, y: -2.2, z: 0, gain: 0.6 }
    ]
  };
}

export function normalizePath(path, duration) {
  const safeDuration = clamp(Number(duration) || 1, 0.5, 30);
  const points = Array.isArray(path) ? path : [];
  const cleaned = points
    .filter((point) => Number.isFinite(point?.time) && Number.isFinite(point?.x) && Number.isFinite(point?.y))
    .map((point) => ({
      time: clamp(point.time, 0, safeDuration),
      x: clamp(point.x, -6, 6),
      y: clamp(point.y, -4.5, 4.5),
      z: clamp(Number(point.z) || 0, -2, 2)
    }))
    .sort((a, b) => a.time - b.time);

  if (cleaned.length === 0) {
    cleaned.push({ time: 0, x: 0, y: 0, z: 0 });
  }
  if (cleaned.length === 1) {
    cleaned.push({ ...cleaned[0], time: safeDuration });
  }
  if (cleaned[0].time > 0) {
    cleaned.unshift({ ...cleaned[0], time: 0 });
  }
  if (cleaned.at(-1).time < safeDuration) {
    cleaned.push({ ...cleaned.at(-1), time: safeDuration });
  }
  cleaned[0].time = 0;
  cleaned.at(-1).time = safeDuration;
  return cleaned;
}

export function validateState(input) {
  if (!input || typeof input !== "object") {
    throw new Error("状态必须是对象");
  }
  if (!FORMATS[input.format]) {
    throw new Error("未知的导出格式");
  }
  if (!Array.isArray(input.sources) || input.sources.length !== 4) {
    throw new Error("必须恰好包含四个声源");
  }
  const duration = Number(input.duration);
  if (!Number.isFinite(duration) || duration < 0.5 || duration > 30) {
    throw new Error("时长必须在 0.5 到 30 秒之间");
  }
  for (const source of input.sources) {
    if (!source.id || !Number.isFinite(source.x) || !Number.isFinite(source.y)) {
      throw new Error("声源数据不完整");
    }
  }
  if (!Array.isArray(input.path) || input.path.length === 0) {
    throw new Error("监听路径不能为空");
  }
  return true;
}

export function sanitizeState(input) {
  const fallback = createDefaultState();
  const candidate = {
    ...fallback,
    ...deepClone(input),
    version: MODEL_VERSION
  };
  candidate.duration = clamp(Number(candidate.duration) || fallback.duration, 0.5, 30);
  candidate.sampleRate = SAMPLE_RATE;
  candidate.bpm = clamp(Number(candidate.bpm) || 120, 40, 240);
  candidate.format = FORMATS[candidate.format] ? candidate.format : "binaural";
  candidate.sources = candidate.sources.slice(0, 4).map((source, index) => ({
    ...fallback.sources[index],
    ...source,
    id: `source-${index + 1}`,
    x: clamp(Number(source.x) || 0, -6, 6),
    y: clamp(Number(source.y) || 0, -4.5, 4.5),
    z: clamp(Number(source.z) || 0, -2, 2),
    gain: clamp(Number(source.gain ?? 0.7), 0.05, 1)
  }));
  while (candidate.sources.length < 4) {
    candidate.sources.push(deepClone(fallback.sources[candidate.sources.length]));
  }
  candidate.path = normalizePath(candidate.path, candidate.duration);
  validateState(candidate);
  return candidate;
}

export function samplePath(path, duration, time) {
  const points = normalizePath(path, duration);
  const t = clamp(time, 0, duration);
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    if (t <= right.time) {
      const span = Math.max(0.0001, right.time - left.time);
      const amount = clamp((t - left.time) / span, 0, 1);
      return {
        x: left.x + (right.x - left.x) * amount,
        y: left.y + (right.y - left.y) * amount,
        z: left.z + (right.z - left.z) * amount
      };
    }
  }
  return { x: points.at(-1).x, y: points.at(-1).y, z: points.at(-1).z };
}

export function distanceGain(distance, reference = 1.15, rolloff = 0.72) {
  if (distance <= reference) {
    return 1;
  }
  return reference / (reference + rolloff * (distance - reference));
}

export function quadPan(dx, dy) {
  const angle = Math.atan2(dx, Math.max(0.001, dy));
  const speakerAngles = [-Math.PI / 4, Math.PI / 4, -3 * Math.PI / 4, 3 * Math.PI / 4];
  const raw = speakerAngles.map((speakerAngle) => {
    let delta = Math.abs(angle - speakerAngle);
    if (delta > Math.PI) {
      delta = 2 * Math.PI - delta;
    }
    return Math.max(0, Math.cos(delta)) ** 2;
  });
  const total = raw.reduce((sum, value) => sum + value, 0) || 1;
  return raw.map((value) => value / total);
}

export function sampleSpatialFrame(state, time) {
  const listener = samplePath(state.path, state.duration, time);
  const sources = state.sources.map((source) => {
    const dx = source.x - listener.x;
    const dy = source.y - listener.y;
    const dz = source.z - listener.z;
    const distance = Math.max(0.001, Math.hypot(dx, dy, dz));
    const gain = distanceGain(distance) * source.gain;
    const pan = clamp(dx / Math.max(0.8, Math.hypot(dx, dy)), -1, 1);
    const send = clamp(0.08 + distance * 0.035, 0.08, 0.46);
    return {
      id: source.id,
      distance,
      gain,
      pan,
      quad: quadPan(dx, dy),
      send
    };
  });
  return { time: clamp(time, 0, state.duration), listener, sources };
}

export function buildBeatPoints(duration, bpm) {
  const interval = 60 / clamp(Number(bpm) || 120, 40, 240);
  const beats = [];
  for (let time = 0, index = 0; time < duration - 0.0001; time += interval, index += 1) {
    beats.push({ index, time: Number(time.toFixed(6)) });
  }
  return beats;
}

export function buildSpatialProbes(state, count = 7) {
  return Array.from({ length: count }, (_, index) => {
    const time = state.duration * index / (count - 1);
    return sampleSpatialFrame(state, time);
  });
}

export function summarizeSpatialProbes(state) {
  return buildSpatialProbes(state).map((frame) => ({
    time: Number(frame.time.toFixed(6)),
    sources: frame.sources.map((source) => ({
      id: source.id,
      pan: Number(source.pan.toFixed(6)),
      gain: Number(source.gain.toFixed(6))
    }))
  }));
}

export function stateForPathExport(state) {
  return {
    schema: "spatial-audio-path",
    version: MODEL_VERSION,
    name: state.name,
    format: state.format,
    channels: FORMATS[state.format].channels,
    duration: state.duration,
    sampleRate: state.sampleRate,
    bpm: state.bpm,
    beatPoints: buildBeatPoints(state.duration, state.bpm),
    sources: deepClone(state.sources),
    listenerPath: normalizePath(state.path, state.duration),
    spatialProbes: summarizeSpatialProbes(state)
  };
}
