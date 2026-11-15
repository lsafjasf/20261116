export const SAMPLE_RATE = 44100;
export const CHANNELS = 2;
export const DURATION_SECONDS = 10;
export const SAMPLE_COUNT = SAMPLE_RATE * DURATION_SECONDS;
export const SAFE_CEILING = 0.944;
export const SAFE_CEILING_DB = 20 * Math.log10(SAFE_CEILING);
export const POPS = Object.freeze([
  Object.freeze({ id: "P1", time: 1.8, amplitude: 0.94, pan: -0.34 }),
  Object.freeze({ id: "P2", time: 6.35, amplitude: 0.9, pan: 0.38 })
]);
export const DROPOUT = Object.freeze({ start: 4.2, end: 4.45 });
export const BEAT_POINTS = Object.freeze(POPS.map((pop) => pop.time));

export const CHAIN_DEFINITION = Object.freeze([
  Object.freeze({
    id: "highpass",
    order: 1,
    name: "高通滤波",
    type: "BIQUAD / HPF",
    control: "cutoff",
    min: 20,
    max: 180,
    step: 1,
    unit: "Hz",
    describe: (node) => `${node.cutoff} Hz · Q ${node.q.toFixed(2)}`
  }),
  Object.freeze({
    id: "lowshelf",
    order: 2,
    name: "低频搁架",
    type: "BIQUAD / LOW SHELF",
    control: "gainDb",
    min: -14,
    max: 2,
    step: 0.1,
    unit: "dB",
    describe: (node) => `${node.freq} Hz · ${signed(node.gainDb)} dB`
  }),
  Object.freeze({
    id: "lowpass",
    order: 3,
    name: "低通滤波",
    type: "BIQUAD / LPF",
    control: "cutoff",
    min: 1800,
    max: 12000,
    step: 50,
    unit: "Hz",
    describe: (node) => `${(node.cutoff / 1000).toFixed(2)} kHz · Q ${node.q.toFixed(2)}`
  }),
  Object.freeze({
    id: "gate",
    order: 4,
    name: "噪声门",
    type: "ENVELOPE / GAIN",
    control: "thresholdDb",
    min: -62,
    max: -18,
    step: 1,
    unit: "dB",
    describe: (node) => `${node.thresholdDb} dB · ${node.attackMs}/${node.releaseMs} ms`
  }),
  Object.freeze({
    id: "softclip",
    order: 5,
    name: "软削波",
    type: "WAVESHAPER / TANH",
    control: "drive",
    min: 1,
    max: 5,
    step: 0.1,
    unit: "×",
    describe: (node) => `DRIVE ${node.drive.toFixed(1)}× · 4× OS`
  })
]);

export const CHAIN_IDS = Object.freeze(CHAIN_DEFINITION.map((node) => node.id));
export const SAFETY_LABEL = "SAFETY / NON-BYPASSABLE";

export const DEFAULT_PARAMS = Object.freeze({
  schema: 1,
  masterGainDb: 2.5,
  nodes: Object.freeze({
    highpass: Object.freeze({ bypass: false, cutoff: 46, q: 0.72 }),
    lowshelf: Object.freeze({ bypass: false, freq: 135, gainDb: -5.5 }),
    lowpass: Object.freeze({ bypass: false, cutoff: 7200, q: 0.64 }),
    gate: Object.freeze({ bypass: false, thresholdDb: -39, attackMs: 6, releaseMs: 120 }),
    softclip: Object.freeze({ bypass: false, drive: 2.1 })
  })
});

function signed(value, digits = 1) {
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}`;
}

export function cloneParams(params = DEFAULT_PARAMS) {
  return JSON.parse(JSON.stringify(params));
}

function finiteClamp(value, min, max, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
}

export function repairParams(input = DEFAULT_PARAMS) {
  const source = input && typeof input === "object" ? input : {};
  const nodes = source.nodes && typeof source.nodes === "object" ? source.nodes : {};
  const highpass = nodes.highpass || {};
  const lowshelf = nodes.lowshelf || {};
  const lowpass = nodes.lowpass || {};
  const gate = nodes.gate || {};
  const softclip = nodes.softclip || {};

  return {
    schema: 1,
    masterGainDb: finiteClamp(source.masterGainDb, -12, 6, DEFAULT_PARAMS.masterGainDb),
    nodes: {
      highpass: {
        bypass: Boolean(highpass.bypass),
        cutoff: finiteClamp(highpass.cutoff, 20, 180, DEFAULT_PARAMS.nodes.highpass.cutoff),
        q: finiteClamp(highpass.q, 0.1, 8, DEFAULT_PARAMS.nodes.highpass.q)
      },
      lowshelf: {
        bypass: Boolean(lowshelf.bypass),
        freq: finiteClamp(lowshelf.freq, 40, 400, DEFAULT_PARAMS.nodes.lowshelf.freq),
        gainDb: finiteClamp(lowshelf.gainDb, -18, 6, DEFAULT_PARAMS.nodes.lowshelf.gainDb)
      },
      lowpass: {
        bypass: Boolean(lowpass.bypass),
        cutoff: finiteClamp(lowpass.cutoff, 1800, 16000, DEFAULT_PARAMS.nodes.lowpass.cutoff),
        q: finiteClamp(lowpass.q, 0.1, 8, DEFAULT_PARAMS.nodes.lowpass.q)
      },
      gate: {
        bypass: Boolean(gate.bypass),
        thresholdDb: finiteClamp(gate.thresholdDb, -62, -18, DEFAULT_PARAMS.nodes.gate.thresholdDb),
        attackMs: finiteClamp(gate.attackMs, 0.5, 50, DEFAULT_PARAMS.nodes.gate.attackMs),
        releaseMs: finiteClamp(gate.releaseMs, 10, 800, DEFAULT_PARAMS.nodes.gate.releaseMs)
      },
      softclip: {
        bypass: Boolean(softclip.bypass),
        drive: finiteClamp(softclip.drive, 1, 5, DEFAULT_PARAMS.nodes.softclip.drive)
      }
    }
  };
}

export function validateChainOrder(params = DEFAULT_PARAMS) {
  const ids = CHAIN_IDS.filter(() => true);
  const expected = ["highpass", "lowshelf", "lowpass", "gate", "softclip"];
  const hasAll = expected.every((id) => params.nodes && params.nodes[id]);
  return {
    ok: hasAll && ids.join(">") === expected.join(">"),
    order: ids,
    safetyLast: true,
    duplicates: ids.filter((id, index) => ids.indexOf(id) !== index)
  };
}

export function nodeOrderLabel() {
  return `${CHAIN_DEFINITION.map((node) => node.name).join(" → ")} → 安全天花板`;
}

export function createFixture() {
  const left = new Float32Array(SAMPLE_COUNT);
  const right = new Float32Array(SAMPLE_COUNT);
  let state = 0x5eeda11;
  let clippedSamples = 0;
  let peak = 0;
  const clamp = 0.98;
  const preamp = 1.34;

  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };

  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const time = index / SAMPLE_RATE;
    const am = 0.975 + 0.025 * Math.sin(2 * Math.PI * 0.17 * time);
    const hum = am * (
      0.3 * Math.sin(2 * Math.PI * 50 * time) +
      0.13 * Math.sin(2 * Math.PI * 100 * time + 0.7) +
      0.045 * Math.sin(2 * Math.PI * 150 * time + 1.2)
    );
    const noiseLeft = (random() * 2 - 1) * 0.012;
    const noiseRight = (random() * 2 - 1) * 0.012;
    let sampleLeft = hum + noiseLeft;
    let sampleRight = hum * 0.985 + noiseRight;

    for (const pop of POPS) {
      const delta = time - pop.time;
      if (delta >= 0 && delta < 0.72) {
        const thump = Math.sin(2 * Math.PI * 67 * delta) * Math.exp(-delta * 18);
        const crack = (random() * 2 - 1) * Math.exp(-delta * 95);
        const transient = pop.amplitude * (0.68 * thump + 0.32 * crack);
        const angle = (pop.pan + 1) * Math.PI / 4;
        sampleLeft += transient * Math.cos(angle);
        sampleRight += transient * Math.sin(angle);
      }
    }

    if (time >= DROPOUT.start && time < DROPOUT.end) {
      sampleLeft = 0;
      sampleRight = 0;
    }

    const drivenLeft = sampleLeft * preamp;
    const drivenRight = sampleRight * preamp;
    if (Math.abs(drivenLeft) >= clamp) clippedSamples += 1;
    if (Math.abs(drivenRight) >= clamp) clippedSamples += 1;
    left[index] = Math.max(-clamp, Math.min(clamp, drivenLeft));
    right[index] = Math.max(-clamp, Math.min(clamp, drivenRight));
    peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
  }

  return {
    sampleRate: SAMPLE_RATE,
    sampleCount: SAMPLE_COUNT,
    duration: DURATION_SECONDS,
    channels: [left, right],
    metadata: {
      seed: "0x5eeda11",
      humHz: 50,
      pops: POPS.map(({ id, time, pan }) => ({ id, time, pan })),
      dropout: { ...DROPOUT },
      sourcePeak: peak,
      sourceClippedSamples: clippedSamples,
      beatPoints: [...BEAT_POINTS]
    }
  };
}

export function dbToGain(db) {
  return 10 ** (db / 20);
}

export function gainToDb(gain) {
  return 20 * Math.log10(Math.max(gain, 1e-12));
}

export function formatDb(value) {
  if (!Number.isFinite(value)) return "−∞ dB";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)} dB`;
}

export function computePeak(channels) {
  let peak = 0;
  let clippedSamples = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) {
      const magnitude = Math.abs(channel[index]);
      if (magnitude > peak) peak = magnitude;
      if (magnitude >= 0.9999) clippedSamples += 1;
    }
  }
  return { peak, clippedSamples };
}

export function computeRms(channels) {
  let sum = 0;
  let count = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) {
      sum += channel[index] * channel[index];
      count += 1;
    }
  }
  return count ? Math.sqrt(sum / count) : 0;
}

export function computeCorrelation(channels) {
  const left = channels[0];
  const right = channels[1] || channels[0];
  let sumLeft = 0;
  let sumRight = 0;
  let sumProduct = 0;
  let sumLeftSquare = 0;
  let sumRightSquare = 0;

  for (let index = 0; index < left.length; index += 1) {
    const l = left[index];
    const r = right[index];
    sumLeft += l;
    sumRight += r;
    sumProduct += l * r;
    sumLeftSquare += l * l;
    sumRightSquare += r * r;
  }

  const count = left.length;
  const covariance = sumProduct - (sumLeft * sumRight) / count;
  const varianceLeft = sumLeftSquare - (sumLeft * sumLeft) / count;
  const varianceRight = sumRightSquare - (sumRight * sumRight) / count;
  const denominator = Math.sqrt(Math.max(varianceLeft, 0) * Math.max(varianceRight, 0));
  return denominator > 1e-12 ? Math.max(-1, Math.min(1, covariance / denominator)) : 0;
}

export function computePan(channels) {
  const rmsLeft = computeRms([channels[0]]);
  const rmsRight = computeRms([channels[1] || channels[0]]);
  const total = rmsLeft + rmsRight;
  return total > 1e-12 ? (rmsRight - rmsLeft) / total : 0;
}

export function computeMetrics(channels) {
  const { peak, clippedSamples } = computePeak(channels);
  const rms = computeRms(channels);
  return {
    peak,
    peakDb: gainToDb(peak),
    rms,
    rmsDb: gainToDb(rms),
    clippedSamples,
    correlation: computeCorrelation(channels),
    pan: computePan(channels)
  };
}

export function downsampleEnvelope(channels, buckets = 900) {
  const length = channels[0].length;
  const size = Math.max(1, Math.floor(length / buckets));
  const minimum = new Float32Array(buckets);
  const maximum = new Float32Array(buckets);
  const mono = new Float32Array(length);
  const channelCount = Math.min(channels.length, CHANNELS);

  for (let channel = 0; channel < channelCount; channel += 1) {
    for (let index = 0; index < length; index += 1) {
      mono[index] += channels[channel][index] / channelCount;
    }
  }

  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = bucket * size;
    const end = bucket === buckets - 1 ? length : Math.min(length, start + size);
    let lo = 0;
    let hi = 0;
    for (let index = start; index < end; index += 1) {
      lo = Math.min(lo, mono[index]);
      hi = Math.max(hi, mono[index]);
    }
    minimum[bucket] = lo;
    maximum[bucket] = hi;
  }

  return { minimum, maximum };
}

function fft(real, imaginary) {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }

  for (let width = 2; width <= size; width <<= 1) {
    const angle = -2 * Math.PI / width;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    for (let start = 0; start < size; start += width) {
      let wr = 1;
      let wi = 0;
      for (let offset = 0; offset < width / 2; offset += 1) {
        const even = start + offset;
        const odd = even + width / 2;
        const tr = wr * real[odd] - wi * imaginary[odd];
        const ti = wr * imaginary[odd] + wi * real[odd];
        real[odd] = real[even] - tr;
        imaginary[odd] = imaginary[even] - ti;
        real[even] += tr;
        imaginary[even] += ti;
        const nextWr = wr * cosine - wi * sine;
        wi = wr * sine + wi * cosine;
        wr = nextWr;
      }
    }
  }
}

export function analyzeSpectrum(channels, sampleRate = SAMPLE_RATE, fftSize = 4096) {
  const length = channels[0].length;
  const windowCount = Math.min(18, Math.max(1, Math.floor(length / fftSize)));
  const power = new Float64Array(fftSize / 2);
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  const mono = new Float32Array(length);
  const divisor = channels.length || 1;

  for (const channel of channels) {
    for (let index = 0; index < length; index += 1) {
      mono[index] += channel[index] / divisor;
    }
  }

  for (let window = 0; window < windowCount; window += 1) {
    const start = Math.floor((length - fftSize) * (window / Math.max(1, windowCount - 1)));
    for (let index = 0; index < fftSize; index += 1) {
      const hann = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (fftSize - 1));
      real[index] = (mono[start + index] || 0) * hann;
      imaginary[index] = 0;
    }
    fft(real, imaginary);
    for (let bin = 0; bin < fftSize / 2; bin += 1) {
      power[bin] += (real[bin] * real[bin] + imaginary[bin] * imaginary[bin]) / windowCount;
    }
  }

  const frequencies = new Float32Array(fftSize / 2);
  const magnitudesDb = new Float32Array(fftSize / 2);
  let max = -Infinity;
  let peakBin = 1;
  for (let bin = 1; bin < fftSize / 2; bin += 1) {
    frequencies[bin] = bin * sampleRate / fftSize;
    magnitudesDb[bin] = 10 * Math.log10(power[bin] + 1e-15);
    if (frequencies[bin] >= 20 && magnitudesDb[bin] > max) {
      max = magnitudesDb[bin];
      peakBin = bin;
    }
  }

  return {
    frequencies,
    magnitudesDb,
    maxDb: max,
    peakHz: peakBin * sampleRate / fftSize,
    nyquist: sampleRate / 2
  };
}

export function quantizePcm16(channels) {
  return channels.map((channel) => {
    const pcm = new Int16Array(channel.length);
    for (let index = 0; index < channel.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, channel[index]));
      pcm[index] = Math.max(-32767, Math.min(32767, Math.round(sample * 32767)));
    }
    return pcm;
  });
}

export function pcmToFloatChannels(pcmChannels) {
  return pcmChannels.map((channel) => {
    const floats = new Float32Array(channel.length);
    for (let index = 0; index < channel.length; index += 1) {
      floats[index] = channel[index] / 32767;
    }
    return floats;
  });
}

export function pcmChecksum(pcmChannels) {
  let hash = 0x811c9dc5;
  for (const channel of pcmChannels) {
    for (let index = 0; index < channel.length; index += 1) {
      const value = channel[index] & 0xffff;
      hash ^= value & 0xff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= value >>> 8;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function encodeWav16(pcmChannels, sampleRate = SAMPLE_RATE) {
  const channelCount = pcmChannels.length;
  const frames = pcmChannels[0].length;
  const bytesPerSample = 2;
  const dataSize = frames * channelCount * bytesPerSample;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);

  const writeText = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      view.setInt16(offset, pcmChannels[channel][frame], true);
      offset += bytesPerSample;
    }
  }

  return new Uint8Array(output);
}

export function wavDuration(bytes) {
  if (!bytes || bytes.byteLength < 44) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteRate = view.getUint32(28, true);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const size = view.getUint32(offset + 4, true);
    if (id === "data") return byteRate ? size / byteRate : 0;
    offset += 8 + size + (size % 2);
  }
  return 0;
}
