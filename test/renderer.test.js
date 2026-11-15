import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_RATE, TIMELINE_SECONDS } from '../src/js/util.js';
import { createDefaultProject, moveClip, setClipGain } from '../src/js/project.js';
import { renderTimeline, waveformPeaks } from '../src/js/renderer.js';
import { encodeWav, decodeWav } from '../src/js/wav.js';
import { synthesizeAll } from '../src/js/synth.js';

const sources = synthesizeAll();

test('three procedural sources are deterministic and full-length', () => {
  const second = synthesizeAll();
  for (const id of ['rain', 'machine', 'voice']) {
    assert.equal(sources[id].length, TIMELINE_SECONDS * SAMPLE_RATE);
    assert.deepEqual(sources[id].channels[0], second[id].channels[0]);
  }
});

test('rendered mix is twenty seconds and never clips', () => {
  const project = createDefaultProject();
  const result = renderTimeline(project, sources);
  assert.equal(result.buffer.length, TIMELINE_SECONDS * SAMPLE_RATE);
  assert.ok(result.prePeak > 0.5, `mix should contain substantial overlap energy, got ${result.prePeak}`);
  assert.ok(result.postPeak <= 0.95 + 1e-9);
  for (const channel of result.channels) {
    for (const sample of channel) assert.ok(Math.abs(sample) <= 0.95 + 1e-9);
  }
});

test('fully overlapping clips are scaled so the exported mix cannot clip', () => {
  const project = createDefaultProject();
  for (const clip of project.clips) {
    clip.start = 0;
    clip.duration = TIMELINE_SECONDS;
    clip.gainDb = 6;
  }
  const result = renderTimeline(project, sources);
  assert.ok(result.prePeak > 1, `raw overlap must exceed full scale, got ${result.prePeak}`);
  assert.ok(result.postPeak <= 0.95 + 1e-9);
  assert.ok(result.limiterScale < 1);
});

test('moving a clip changes where its energy appears', () => {
  const projectA = createDefaultProject();
  const projectB = createDefaultProject();
  moveClip(projectB, 'machine', 12);
  const mixA = renderTimeline(projectA, sources).channels[0];
  const mixB = renderTimeline(projectB, sources).channels[0];
  const bandA = mixA.subarray(6 * SAMPLE_RATE, 8 * SAMPLE_RATE);
  const bandB = mixB.subarray(6 * SAMPLE_RATE, 8 * SAMPLE_RATE);
  const energy = (array) => array.reduce((sum, v) => sum + v * v, 0);
  assert.ok(energy(bandA) > energy(bandB));
});

test('lowering gain reduces output energy', () => {
  const quiet = createDefaultProject();
  setClipGain(quiet, 'rain', -24);
  const baseEnergy = renderTimeline(createDefaultProject(), sources).channels[0]
    .reduce((sum, v) => sum + v * v, 0);
  const quietEnergy = renderTimeline(quiet, sources).channels[0]
    .reduce((sum, v) => sum + v * v, 0);
  assert.ok(quietEnergy < baseEnergy * 0.5);
});

test('WAV round-trip keeps duration, channels and approximate samples', () => {
  const result = renderTimeline(createDefaultProject(), sources);
  const bytes = encodeWav(result.channels, SAMPLE_RATE);
  const decoded = decodeWav(bytes);
  assert.equal(decoded.sampleRate, SAMPLE_RATE);
  assert.equal(decoded.numberOfChannels, 2);
  assert.equal(decoded.length, TIMELINE_SECONDS * SAMPLE_RATE);
  let maxError = 0;
  for (let i = 0; i < decoded.length; i += 97) {
    maxError = Math.max(maxError, Math.abs(decoded.channels[0][i] - result.channels[0][i]));
  }
  assert.ok(maxError < 1 / 0x8000 + 1e-9);
});

test('waveform buckets are produced for UI drawing', () => {
  const peaks = waveformPeaks(sources.rain.channels[0], 200);
  assert.equal(peaks.length, 200);
  assert.ok(peaks.some((v) => v > 0));
});
