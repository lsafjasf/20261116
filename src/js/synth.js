import { SAMPLE_RATE, TIMELINE_SECONDS, createStereoBuffer, mulberry32 } from './util.js';

function onePoleFilter() {
  let previous = 0;
  return (input, cutoff) => {
    const coefficient = Math.min(0.999, Math.max(0, cutoff));
    previous = previous + coefficient * (input - previous);
    return previous;
  };
}

function normalize(buffer, targetPeak) {
  let peak = 0;
  for (const channel of buffer.channels) {
    for (const sample of channel) {
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
    }
  }
  const scale = peak > 0 ? targetPeak / peak : 1;
  for (const channel of buffer.channels) {
    for (let i = 0; i < channel.length; i += 1) channel[i] *= scale;
  }
  return buffer;
}

export function synthesizeRain(seed = 11) {
  const random = mulberry32(seed);
  const buffer = createStereoBuffer(TIMELINE_SECONDS);
  const [left, right] = buffer.channels;
  const lowpassL = onePoleFilter();
  const lowpassR = onePoleFilter();
  const drops = [];
  for (let i = 0; i < 90; i += 1) {
    drops.push({
      time: random() * TIMELINE_SECONDS,
      freq: 900 + random() * 1600,
      decay: 0.012 + random() * 0.03,
      gain: 0.05 + random() * 0.12,
      side: random() > 0.5 ? 1 : -1,
    });
  }
  for (let i = 0; i < buffer.length; i += 1) {
    const time = i / SAMPLE_RATE;
    const shimmer = 0.22 + 0.1 * Math.sin(2 * Math.PI * 0.17 * time);
    const noiseL = random() * 2 - 1;
    const noiseR = random() * 2 - 1;
    let sampleL = lowpassL(noiseL, shimmer);
    let sampleR = lowpassR(noiseR, shimmer);
    sampleL += (noiseL - sampleL) * 0.35;
    sampleR += (noiseR - sampleR) * 0.35;
    for (const drop of drops) {
      const dt = time - drop.time;
      if (dt >= 0 && dt < drop.decay) {
        const env = Math.exp(-dt / drop.decay * 4);
        const tone = Math.sin(2 * Math.PI * drop.freq * dt);
        const ping = drop.gain * env * tone;
        if (drop.side > 0) sampleR += ping;
        else sampleL += ping;
      }
    }
    left[i] = sampleL;
    right[i] = sampleR;
  }
  return normalize(buffer, 0.7);
}

export function synthesizeMachine(seed = 23) {
  const random = mulberry32(seed);
  const buffer = createStereoBuffer(TIMELINE_SECONDS);
  const [left, right] = buffer.channels;
  const lowpass = onePoleFilter();
  const hum = 58 + random() * 4;
  const phase = [0, 0, 0, 0];
  for (let i = 0; i < buffer.length; i += 1) {
    const time = i / SAMPLE_RATE;
    const pulse = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3.1 * time - 0.6);
    const wobble = 1 + 0.004 * Math.sin(2 * Math.PI * 0.7 * time);
    const frequencies = [hum * wobble, hum * 2 * wobble, hum * 3.01 * wobble, 147 * wobble];
    const weights = [0.5, 0.28, 0.16, 0.08];
    let drone = 0;
    for (let k = 0; k < frequencies.length; k += 1) {
      phase[k] += 2 * Math.PI * frequencies[k] / SAMPLE_RATE;
      drone += weights[k] * Math.sin(phase[k]);
    }
    const grit = (random() * 2 - 1) * 0.12;
    const sample = lowpass(drone * 0.5 + grit, 0.08) * (0.6 + 0.4 * pulse);
    const stereoWidth = 0.06 * Math.sin(2 * Math.PI * 0.9 * time);
    left[i] = sample * (1 - stereoWidth);
    right[i] = sample * (1 + stereoWidth);
  }
  return normalize(buffer, 0.7);
}

export function synthesizeVoice(seed = 37) {
  const random = mulberry32(seed);
  const buffer = createStereoBuffer(TIMELINE_SECONDS);
  const [left, right] = buffer.channels;
  const lowpass = onePoleFilter();
  const utterances = [];
  let cursor = 0.4;
  while (cursor < TIMELINE_SECONDS - 1) {
    const duration = 0.7 + random() * 1.4;
    utterances.push({
      start: cursor,
      duration,
      fundamental: 115 + random() * 70,
      pan: (random() * 2 - 1) * 0.7,
    });
    cursor += duration + 1.1 + random() * 1.8;
  }
  let phase = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const time = i / SAMPLE_RATE;
    let source = 0;
    for (const utterance of utterances) {
      const local = (time - utterance.start) / utterance.duration;
      if (local >= 0 && local <= 1) {
        const envelope = Math.sin(Math.PI * local) ** 2;
        const vibrato = 1 + 0.012 * Math.sin(2 * Math.PI * 5.2 * time);
        phase += 2 * Math.PI * utterance.fundamental * vibrato / SAMPLE_RATE;
        const partials =
          Math.sin(phase) * 0.55 +
          Math.sin(phase * 2.03) * 0.28 +
          Math.sin(phase * 2.97) * 0.17;
        source += partials * envelope * 0.5;
      }
    }
    const sample = lowpass(source, 0.05) * 0.9;
    const panGain = 0.7;
    left[i] = sample * (1 - panGain * 0.5);
    right[i] = sample * (1 + panGain * 0.5);
  }
  return normalize(buffer, 0.6);
}

export function synthesizeAll() {
  return {
    rain: synthesizeRain(),
    machine: synthesizeMachine(),
    voice: synthesizeVoice(),
  };
}
