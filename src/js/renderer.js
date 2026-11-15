import {
  SAMPLE_RATE,
  TIMELINE_SECONDS,
  createStereoBuffer,
  dbToGain,
  equalPowerFade,
  interpPoints,
  peakAmplitude,
} from './util.js';
import { getAutomation } from './project.js';

function fadeEnvelope(clip, localTime) {
  if (localTime < 0 || localTime > clip.duration) return 0;
  let envelope = 1;
  if (clip.fadeIn > 0 && localTime < clip.fadeIn) {
    envelope *= equalPowerFade(localTime / clip.fadeIn);
  }
  const fadeStart = clip.duration - clip.fadeOut;
  if (clip.fadeOut > 0 && localTime > fadeStart) {
    envelope *= equalPowerFade((clip.duration - localTime) / clip.fadeOut);
  }
  return envelope;
}

export function renderTimeline(project, sources, targetPeak = 0.95) {
  const output = createStereoBuffer(TIMELINE_SECONDS);
  const [mixLeft, mixRight] = output.channels;

  for (const clip of project.clips) {
    const source = sources[clip.sourceId];
    if (!source) throw new Error(`Missing source ${clip.sourceId}`);
    const automation = getAutomation(project, clip.id);
    const points = automation ? automation.points : [];
    const startFrame = Math.round(clip.start * SAMPLE_RATE);
    const endFrame = Math.min(
      mixLeft.length,
      Math.round((clip.start + clip.duration) * SAMPLE_RATE),
    );
    const clipGain = dbToGain(clip.gainDb);
    const panLeft = Math.cos(((clip.pan + 1) / 2) * (Math.PI / 2));
    const panRight = Math.sin(((clip.pan + 1) / 2) * (Math.PI / 2));

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const timelineTime = frame / SAMPLE_RATE;
      const localTime = timelineTime - clip.start;
      const sourceFrame = Math.round((clip.offset + localTime) * SAMPLE_RATE);
      if (sourceFrame < 0 || sourceFrame >= source.length) continue;
      const envelope = fadeEnvelope(clip, localTime);
      if (envelope === 0) continue;
      const automationDb = points.length
        ? interpPoints(points, timelineTime)
        : 0;
      const gain = envelope * clipGain * dbToGain(automationDb);
      mixLeft[frame] += source.channels[0][sourceFrame] * gain * panLeft;
      mixRight[frame] += source.channels[1][sourceFrame] * gain * panRight;
    }
  }

  const masterGain = dbToGain(project.masterGainDb || 0);
  if (masterGain !== 1) {
    for (const channel of output.channels) {
      for (let i = 0; i < channel.length; i += 1) channel[i] *= masterGain;
    }
  }

  const prePeak = peakAmplitude(output.channels);
  const scale = prePeak > targetPeak ? targetPeak / prePeak : 1;
  if (scale !== 1) {
    for (const channel of output.channels) {
      for (let i = 0; i < channel.length; i += 1) channel[i] *= scale;
    }
  }
  return {
    buffer: output,
    channels: output.channels,
    prePeak,
    postPeak: peakAmplitude(output.channels),
    limiterScale: scale,
  };
}

export function waveformPeaks(channel, buckets) {
  const peaks = new Float32Array(buckets);
  const bucketSize = channel.length / buckets;
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = Math.floor(bucket * bucketSize);
    const end = Math.min(channel.length, Math.ceil((bucket + 1) * bucketSize));
    let peak = 0;
    for (let i = start; i < end; i += 1) {
      const magnitude = Math.abs(channel[i]);
      if (magnitude > peak) peak = magnitude;
    }
    peaks[bucket] = peak;
  }
  return peaks;
}
