import { OfflineAudioContext } from 'web-audio-engine';
import { SoundtrackEngine } from './engine.js';
import { encodeWav } from './wav.js';

const noopDriver = () => ({
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
});

// Render a deterministic scenario offline.
// events: [{ t, type:'intensity'|'stop'|'params', ... }], times in seconds.
export async function renderScenario({
  durationSeconds,
  params,
  events = [],
  sampleRate = 44100,
  channels = 2,
  engineFactory,
}) {
  const frames = Math.ceil(durationSeconds * sampleRate);
  const ctx = new OfflineAudioContext(channels, frames, sampleRate);
  let virtualTime = 0;
  const clock = () => virtualTime;

  const engine = engineFactory
    ? engineFactory(ctx, { clock })
    : new SoundtrackEngine(ctx, params, { clock, driver: noopDriver() });

  engine.start();
  const sorted = [...events].sort((a, b) => a.t - b.t);

  for (const ev of sorted) {
    if (ev.t > durationSeconds) continue;
    virtualTime = Math.max(virtualTime, ev.t);
    if (ev.type === 'intensity') engine.setIntensity(ev.value, ev.t);
    if (ev.type === 'params') engine.updateParams(ev.params);
    if (ev.type === 'stop') engine.stopAt(ev.t, ev.fadeSeconds ?? 0.15, false);
    engine.tick(ev.t + 0.13);
  }

  virtualTime = durationSeconds;
  engine.tick(durationSeconds + 0.2);

  const rendered = await ctx.startRendering();
  const wav = encodeWav(rendered, { sampleRate });
  return { ctx, engine, rendered, wav };
}

export function measurePeak(audioBuffer, fromSecond = 0, toSecond = audioBuffer.duration) {
  const start = Math.floor(fromSecond * audioBuffer.sampleRate);
  const end = Math.floor(toSecond * audioBuffer.sampleRate);
  let peak = 0;
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = start; i < Math.min(end, data.length); i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

export function isSilent(audioBuffer, fromSecond, toSecond, floor = 1e-4) {
  return measurePeak(audioBuffer, fromSecond, toSecond) < floor;
}
