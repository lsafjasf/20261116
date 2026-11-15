// 确定性随机与基础 DSP 工具：保证离线渲染可复现。

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 三种指向性的极坐标响应，theta 为声源相对麦克风主轴的夹角（弧度）。
export function polarGain(pattern, theta) {
  const c = Math.cos(theta);
  switch (pattern) {
    case "omnidirectional":
      return 1;
    case "cardioid":
      return 0.5 * (1 + c);
    case "figure8":
      return c; // 双指向：背面反相
    default:
      return 1;
  }
}

export function makeNoiseBuffer(ctx, seconds, seed) {
  const rng = mulberry32(seed);
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = rng() * 2 - 1;
  return buf;
}

// 雨声：白噪声经带通后的高频嘶声，叠一层较慢的强度起伏。
export function makeRainBuffer(ctx, seconds, seed) {
  const rng = mulberry32(seed);
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const out = buf.getChannelData(0);
  let hp = 0;
  for (let i = 0; i < len; i++) {
    const white = rng() * 2 - 1;
    hp = 0.82 * hp + 0.18 * white; // 一阶高通趋势
    const shimmer = 0.75 + 0.25 * Math.sin((i / ctx.sampleRate) * 2.1 + seed);
    out[i] = hp * 1.6 * shimmer;
  }
  return buf;
}

// 风声：低通噪声 + 缓慢 LFO 起伏（阵风）。
export function makeWindBuffer(ctx, seconds, seed) {
  const rng = mulberry32(seed);
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const out = buf.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const white = rng() * 2 - 1;
    lp += 0.012 * (white - lp); // 强低通
    const t = i / ctx.sampleRate;
    const gust = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.9 + 1.3) * Math.sin(t * 0.37));
    out[i] = lp * 3.2 * gust;
  }
  return buf;
}

// 人声：带共振峰的元音脉冲，节拍点在缓冲内的起始时间由 beats 返回（秒）。
export function makeVoiceBuffer(ctx, seconds, seed) {
  const rng = mulberry32(seed);
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  const beats = [];
  const period = 0.8; // 每 0.8 秒一个音节
  for (let onset = 0.4; onset < seconds - 0.25; onset += period) {
    beats.push(Number(onset.toFixed(4)));
    const start = Math.floor(onset * sr);
    const vowelLen = Math.floor(0.32 * sr);
    const f0 = 110 + rng() * 30;
    const formant = [730, 1090, 2440][Math.floor(rng() * 3)];
    for (let n = 0; n < vowelLen && start + n < len; n++) {
      const t = n / sr;
      const env = Math.exp(-9 * (n / vowelLen)) * Math.min(1, n / (0.012 * sr));
      const phase = 2 * Math.PI * f0 * t;
      const wave = Math.sin(phase) + 0.45 * Math.sin(2 * phase) + 0.25 * Math.sin(2 * Math.PI * formant * t);
      out[start + n] += 0.5 * env * wave;
    }
  }
  return { buffer: buf, beats };
}

// 指数衰减的立体声混响脉冲（程序生成，无需外部资源）。
export function makeReverbImpulse(ctx, seconds = 1.4, decay = 2.6, seed = 42) {
  const rng = mulberry32(seed);
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const impulse = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = impulse.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (rng() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return impulse;
}
