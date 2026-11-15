import assert from "node:assert/strict";
import test from "node:test";
import {
  BEAT_POINTS,
  CHAIN_IDS,
  DEFAULT_PARAMS,
  DURATION_SECONDS,
  SAMPLE_COUNT,
  SAMPLE_RATE,
  cloneParams,
  computeMetrics,
  createFixture,
  downsampleEnvelope,
  encodeWav16,
  nodeOrderLabel,
  pcmChecksum,
  quantizePcm16,
  repairParams,
  validateChainOrder,
  wavDuration
} from "../src/audio-core.js";

test("fixture is deterministic, stereo, and exactly ten seconds", () => {
  const first = createFixture();
  const second = createFixture();
  assert.equal(first.sampleRate, SAMPLE_RATE);
  assert.equal(first.sampleCount, SAMPLE_COUNT);
  assert.equal(first.duration, DURATION_SECONDS);
  assert.equal(first.channels.length, 2);
  assert.equal(first.channels[0].length, SAMPLE_COUNT);
  assert.deepEqual(first.metadata.beatPoints, [...BEAT_POINTS]);
  assert.deepEqual(Array.from(first.channels[0].slice(1234, 1240)),
    Array.from(second.channels[0].slice(1234, 1240)));
});

test("fixture includes two transients, a dropout, and source clipping", () => {
  const fixture = createFixture();
  assert.deepEqual(fixture.metadata.pops.map((pop) => pop.time), [1.8, 6.35]);
  assert.deepEqual(fixture.metadata.dropout, { start: 4.2, end: 4.45 });
  assert.ok(fixture.metadata.sourceClippedSamples > 0);
  const dropoutStart = Math.round(4.25 * SAMPLE_RATE);
  assert.equal(fixture.channels[0][dropoutStart], 0);
  assert.equal(fixture.channels[1][dropoutStart], 0);
});

test("chain order is fixed and parameter repair clamps invalid values", () => {
  assert.equal(CHAIN_IDS.join(">"), "highpass>lowshelf>lowpass>gate>softclip");
  assert.match(nodeOrderLabel(), /安全天花板$/);
  const broken = cloneParams(DEFAULT_PARAMS);
  broken.masterGainDb = 99;
  broken.nodes.highpass.cutoff = -20;
  broken.nodes.softclip.drive = Number.NaN;
  const repaired = repairParams(broken);
  assert.equal(repaired.masterGainDb, 6);
  assert.equal(repaired.nodes.highpass.cutoff, 20);
  assert.equal(repaired.nodes.softclip.drive, DEFAULT_PARAMS.nodes.softclip.drive);
  assert.equal(validateChainOrder(repaired).ok, true);
});

test("int16 WAV has stable checksum and ten-second duration", () => {
  const fixture = createFixture();
  const pcm = quantizePcm16(fixture.channels);
  const wav = encodeWav16(pcm, SAMPLE_RATE);
  assert.equal(wavDuration(wav), 10);
  assert.equal(wav.byteLength, 44 + SAMPLE_COUNT * 2 * 2);
  assert.equal(pcmChecksum(pcm), pcmChecksum(quantizePcm16(createFixture().channels)));
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), "WAVE");
});

test("metrics report peak, correlation, pan, and source clipping", () => {
  const fixture = createFixture();
  const metrics = computeMetrics(fixture.channels);
  assert.ok(metrics.peak > 0.97 && metrics.peak <= 1);
  assert.ok(metrics.correlation > 0.9);
  assert.ok(Number.isFinite(metrics.pan));
  assert.equal(metrics.clippedSamples, 0);
});

test("waveform envelope preserves bounded min/max buckets", () => {
  const fixture = createFixture();
  const envelope = downsampleEnvelope(fixture.channels, 430);
  assert.equal(envelope.minimum.length, 430);
  assert.equal(envelope.maximum.length, 430);
  for (let index = 0; index < envelope.minimum.length; index += 1) {
    assert.ok(envelope.minimum[index] <= envelope.maximum[index]);
    assert.ok(envelope.minimum[index] >= -1);
    assert.ok(envelope.maximum[index] <= 1);
  }
});
