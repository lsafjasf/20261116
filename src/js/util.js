export const SAMPLE_RATE = 44100;
export const TIMELINE_SECONDS = 20;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

export function gainToDb(gain) {
  return 20 * Math.log10(Math.max(1e-7, gain));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function equalPowerFade(t) {
  const x = clamp(t, 0, 1);
  return Math.sin(x * Math.PI * 0.5);
}

export function createStereoBuffer(seconds) {
  const length = Math.round(seconds * SAMPLE_RATE);
  return {
    sampleRate: SAMPLE_RATE,
    length,
    numberOfChannels: 2,
    channels: [new Float32Array(length), new Float32Array(length)],
  };
}

export function peakAmplitude(channels) {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const magnitude = Math.abs(channel[i]);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return peak;
}

export function rms(channels) {
  let sum = 0;
  let count = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      sum += channel[i] * channel[i];
      count += 1;
    }
  }
  return Math.sqrt(sum / Math.max(1, count));
}

export function interpPoints(points, time) {
  if (points.length === 0) return 1;
  if (time <= points[0].time) return points[0].value;
  const last = points[points.length - 1];
  if (time >= last.time) return last.value;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i];
    const p1 = points[i + 1];
    if (time >= p0.time && time <= p1.time) {
      const span = p1.time - p0.time || 1;
      return lerp(p0.value, p1.value, (time - p0.time) / span);
    }
  }
  return last.value;
}
