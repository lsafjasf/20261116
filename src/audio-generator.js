import { hashSeed, sineSample } from "./prng.js";

/**
 * Deterministic synthetic audio source.
 *
 * The signal is a mix of slow amplitude LFO, three harmonic tones, shaped
 * noise and periodic transients. Noise is reseeded per chunk from the chunk
 * index so generation is fully streamable: any chunk can be regenerated
 * independently and no full-sample array ever has to live in memory.
 */

export const DEFAULT_AUDIO_OPTIONS = Object.freeze({
  sampleRate: 44100,
  durationSec: 600,
  seed: "uid634-ten-minutes",
  chunkSamples: 132300
});

export function totalSampleCount(options = {}) {
  const settings = { ...DEFAULT_AUDIO_OPTIONS, ...options };
  return Math.round(settings.sampleRate * settings.durationSec);
}

/** Value of one deterministic sample at an absolute sample index. */
export function sampleAt(index, sampleRate, seed) {
  const time = index / sampleRate;
  const envelope = 0.55 + 0.4 * sineSample(time, 0.07);
  const tones =
    0.5 * sineSample(time, 220) +
    0.3 * sineSample(time, 331, 1.3) +
    0.2 * sineSample(time, 442, 2.1);
  const noise = noiseAt(index, seed) * 0.18;
  const transient = isTransient(index, sampleRate) ? 0.85 * noiseAt(index ^ 0x9e3779b9, seed) : 0;
  const raw = envelope * tones + noise + transient;
  return Math.max(-1, Math.min(1, raw));
}

function noiseAt(index, seed) {
  const seedInt = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
  let mixed = (index ^ seedInt) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  mixed ^= mixed >>> 16;
  return (mixed >>> 0) / 2147483648 - 1;
}

function isTransient(index, sampleRate) {
  const transientEvery = sampleRate * 4;
  const windowSize = Math.max(8, Math.floor(sampleRate * 0.002));
  return index % transientEvery < windowSize;
}

/**
 * Generate the audio in bounded-memory chunks.
 * @returns {Promise<number>} total sample count produced.
 */
export async function generateChunks(options = {}, onChunk) {
  const settings = { ...DEFAULT_AUDIO_OPTIONS, ...options };
  const total = totalSampleCount(settings);
  const chunkSize = settings.chunkSamples;
  for (let offset = 0; offset < total; offset += chunkSize) {
    const length = Math.min(chunkSize, total - offset);
    const buffer = new Float32Array(length);
    for (let local = 0; local < length; local += 1) {
      buffer[local] = sampleAt(offset + local, settings.sampleRate, settings.seed);
    }
    await onChunk(buffer, offset, total);
  }
  return total;
}

/** Synchronous variant for small/boundary test fixtures. */
export function generateAll(options = {}) {
  const settings = { ...DEFAULT_AUDIO_OPTIONS, ...options };
  const total = totalSampleCount(settings);
  const all = new Float32Array(total);
  for (let index = 0; index < total; index += 1) {
    all[index] = sampleAt(index, settings.sampleRate, settings.seed);
  }
  return all;
}
