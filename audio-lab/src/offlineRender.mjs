// Renders one scene graph through OfflineAudioContext and returns a compact
// perceptual fingerprint plus raw PCM stats. The same graph-building code runs
// under both managers, so identical fingerprints prove the optimization did
// not change the rendered audio semantics.

import { ResourceManager, NaiveResourceManager } from './resourceManager.mjs';
import { SceneConfigCache, resolveConfig } from './sceneConfig.mjs';
import { SceneController } from './sceneController.mjs';
import { perceptualStats } from './wav.mjs';

const RENDER_SECONDS = 0.5;

export async function renderScene(rawConfig, mode) {
  const sampleRate = 48000;
  const frameCount = sampleRate * RENDER_SECONDS;
  const context = new OfflineAudioContext(1, frameCount, sampleRate);
  const manager = mode === 'managed'
    ? new ResourceManager(context)
    : new NaiveResourceManager(context);
  const cache = new SceneConfigCache(8);
  const controller = new SceneController(context, manager, cache);
  const manifest = controller.enterScene(rawConfig);

  const renderedAt = context.currentTime;
  const buffer = await context.startRendering();
  const channel = buffer.getChannelData(0);
  const stats = analyzePcm(channel);
  const perceptual = perceptualStats(channel, sampleRate);
  controller.exitScene();

  return {
    mode,
    sceneId: rawConfig.id,
    manifest,
    renderedAt,
    pcm: stats,
    perceptual,
    channel: Array.from(channel),
    sampleRate,
    fingerprint: [
      rawConfig.id,
      stats.nonZero,
      stats.peak.toFixed(6),
      stats.rms.toFixed(6),
      stats.zeroCrossings,
      stats.checksum,
    ].join('|'),
  };
}

function analyzePcm(channel) {
  let peak = 0;
  let sumSquares = 0;
  let nonZero = 0;
  let zeroCrossings = 0;
  let checksum = 0;
  for (let index = 0; index < channel.length; index += 1) {
    const sample = channel[index];
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    if (magnitude > 1e-9) nonZero += 1;
    sumSquares += sample * sample;
    checksum = (checksum + sample * 1000) % 2147483647;
    if (index > 0 && ((channel[index - 1] >= 0) !== (sample >= 0))) {
      zeroCrossings += 1;
    }
  }
  return {
    peak,
    rms: Math.sqrt(sumSquares / channel.length),
    nonZero,
    zeroCrossings,
    checksum: Math.abs(Math.round(checksum)),
  };
}

export async function compareOfflineOutput(library) {
  const rows = [];
  let allEqual = true;
  for (const raw of library) {
    const naive = await renderScene(raw, 'naive');
    const managed = await renderScene(raw, 'managed');
    const equal = naive.fingerprint === managed.fingerprint
      && JSON.stringify(naive.manifest) === JSON.stringify(managed.manifest);
    allEqual = allEqual && equal;
    rows.push({
      sceneId: raw.id,
      equal,
      naiveFingerprint: naive.fingerprint,
      managedFingerprint: managed.fingerprint,
      rms: naive.pcm.rms,
      peak: naive.pcm.peak,
      perceptualEqual: closePerceptual(naive.perceptual, managed.perceptual),
      perceptual: naive.perceptual,
    });
  }
  return { allEqual, rows };
}

function closePerceptual(a, b) {
  return Object.keys(a).every((key) => {
    const delta = Math.abs(a[key] - b[key]);
    const scale = Math.max(Math.abs(a[key]), Math.abs(b[key]), 1e-12);
    // Relative tolerance for large values (Hz, centroid bins), absolute floor
    // for near-zero amplitudes; both sit at the floating-point noise floor.
    return delta <= Math.max(1e-9, scale * 1e-6);
  });
}
