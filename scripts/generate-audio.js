import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_AUDIO_OPTIONS,
  generateChunks,
  totalSampleCount,
  PyramidBuilder
} from "../src/index.js";
import { encodeWav16 } from "../src/wav.js";

const outputDir = join(process.cwd(), "artifacts", "audio");
mkdirSync(outputDir, { recursive: true });

const settings = { ...DEFAULT_AUDIO_OPTIONS };
const total = totalSampleCount(settings);
const builder = new PyramidBuilder(settings.sampleRate);
const wavPath = join(outputDir, "ten-minutes.wav");
const header = encodeWav16(new Float32Array(total), settings.sampleRate).subarray(0, 44);

const stream = createWriteStream(wavPath);
const write = (chunk) =>
  new Promise((resolve, reject) => {
    stream.write(encodeWav16(chunk, settings.sampleRate).subarray(44), (error) =>
      error ? reject(error) : resolve()
    );
  });

stream.write(header);
let processed = 0;
const started = performance.now();
await generateChunks(settings, async (chunk) => {
  builder.pushChunk(chunk);
  await write(chunk);
  processed += chunk.length;
  if (processed % (settings.chunkSamples * 20) === 0 || processed === total) {
    process.stdout.write(`\rgenerated ${(processed / total * 100).toFixed(1)}%`);
  }
});
await new Promise((resolve, reject) => stream.end((error) => (error ? reject(error) : resolve())));

const pyramid = builder.build();
const pyramidBytes = pyramid.serialize();
const pyramidPath = join(outputDir, "peak-pyramid.bin");
writeFileSync(pyramidPath, pyramidBytes);

const manifest = {
  ...settings,
  totalSamples: total,
  durationSec: settings.durationSec,
  wav: "ten-minutes.wav",
  pyramid: "peak-pyramid.bin",
  pyramidBytes: pyramidBytes.length,
  pyramidLevels: pyramid.levelCount,
  generatedInMs: Math.round(performance.now() - started)
};
writeFileSync(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));
process.stdout.write(`\nWrote ${wavPath} and ${pyramidPath} (${pyramid.levelCount} levels)\n`);
