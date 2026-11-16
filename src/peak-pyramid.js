/**
 * Multi-resolution min/max peak pyramid.
 *
 * Level 0 stores one { min, max } bucket per `baseBucketSamples` source
 * samples. Every higher level aggregates 4 buckets per parent, so the level
 * count grows logarithmically with audio length and the coarsest level is
 * small enough for a full-length overview.
 *
 * The renderer never touches raw samples: it queries one level whose bucket
 * width maps to roughly one device pixel at the current zoom.
 */

export const DEFAULT_BASE_BUCKET_SAMPLES = 256;
const REDUCTION_FACTOR = 4;

export class PeakPyramid {
  constructor(sampleRate, baseBucketSamples = DEFAULT_BASE_BUCKET_SAMPLES, levels = [], totalSamples = 0) {
    this.sampleRate = sampleRate;
    this.baseBucketSamples = baseBucketSamples;
    this.levels = levels;
    this.totalSamples = totalSamples;
  }

  get levelCount() {
    return this.levels.length;
  }

  get durationSec() {
    return this.totalSamples / this.sampleRate;
  }

  /** Build a pyramid from a full in-memory Float32Array (used by small tests). */
  static fromSamples(samples, sampleRate, baseBucketSamples = DEFAULT_BASE_BUCKET_SAMPLES) {
    const pyramid = new PeakPyramid(sampleRate, baseBucketSamples);
    pyramid.totalSamples = samples.length;
    pyramid.levels = [buildBaseLevel(samples, baseBucketSamples)];
    while (pyramid.levels[pyramid.levels.length - 1].length > 1) {
      pyramid.levels.push(reduceLevel(pyramid.levels[pyramid.levels.length - 1]));
    }
    return pyramid;
  }

  /** Streaming builder: append raw chunks without retaining all samples. */
  static builder(sampleRate, baseBucketSamples = DEFAULT_BASE_BUCKET_SAMPLES) {
    return new PyramidBuilder(sampleRate, baseBucketSamples);
  }

  /** Pick the coarsest level whose bucket time is no wider than a pixel. */
  chooseLevel(secondsPerPixel) {
    const baseSeconds = this.baseBucketSamples / this.sampleRate;
    let selected = 0;
    for (let levelIndex = 0; levelIndex < this.levels.length; levelIndex += 1) {
      const bucketSeconds = baseSeconds * REDUCTION_FACTOR ** levelIndex;
      if (bucketSeconds <= secondsPerPixel) {
        selected = levelIndex;
      }
    }
    return selected;
  }

  bucketTimeRange(levelIndex, bucketIndex) {
    const factor = REDUCTION_FACTOR ** levelIndex;
    const startSample = bucketIndex * factor * this.baseBucketSamples;
    const endSample = Math.min(this.totalSamples, (bucketIndex + 1) * factor * this.baseBucketSamples);
    return { startSample, endSample, startSec: startSample / this.sampleRate, endSec: endSample / this.sampleRate };
  }

  /** Min/max buckets intersecting a time range at a given level. */
  queryRange(levelIndex, startSec, endSec) {
    const level = this.levels[levelIndex];
    const factor = REDUCTION_FACTOR ** levelIndex;
    const samplesPerBucket = factor * this.baseBucketSamples;
    const firstBucket = Math.max(0, Math.ceil((startSec * this.sampleRate) / samplesPerBucket) - 1);
    const lastBucket = Math.min(level.length - 1, Math.floor((endSec * this.sampleRate) / samplesPerBucket));
    const buckets = [];
    for (let bucketIndex = firstBucket; bucketIndex <= lastBucket; bucketIndex += 1) {
      buckets.push({ index: bucketIndex, min: level[bucketIndex].min, max: level[bucketIndex].max });
    }
    return { levelIndex, samplesPerBucket, firstBucket, lastBucket, buckets };
  }

  /** Compact binary serialization for reload/export snapshots. */
  serialize() {
    const levelLengths = this.levels.map((level) => level.length);
    const totalBuckets = levelLengths.reduce((sum, length) => sum + length, 0);
    const buffer = new ArrayBuffer(32 + levelLengths.length * 4 + totalBuckets * 8);
    const view = new DataView(buffer);
    view.setUint32(0, 0x504b5731, true);
    view.setUint32(4, this.sampleRate, true);
    view.setUint32(8, this.baseBucketSamples, true);
    view.setUint32(12, this.totalSamples, true);
    view.setUint32(16, this.levels.length, true);
    view.setUint32(20, REDUCTION_FACTOR, true);
    view.setUint32(24, totalBuckets, true);
    view.setUint32(28, 0, true);
    let cursor = 32;
    for (const length of levelLengths) {
      view.setUint32(cursor, length, true);
      cursor += 4;
    }
    for (const level of this.levels) {
      for (const bucket of level) {
        writeFloat16(view, cursor, bucket.min);
        writeFloat16(view, cursor + 4, bucket.max);
        cursor += 8;
      }
    }
    return new Uint8Array(buffer);
  }

  static deserialize(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x504b5731) {
      throw new Error("Invalid peak pyramid signature");
    }
    const sampleRate = view.getUint32(4, true);
    const baseBucketSamples = view.getUint32(8, true);
    const totalSamples = view.getUint32(12, true);
    const levelCount = view.getUint32(16, true);
    const factor = view.getUint32(20, true);
    if (factor !== REDUCTION_FACTOR) {
      throw new Error(`Unsupported reduction factor ${factor}`);
    }
    const levels = [];
    let cursor = 32;
    const levelLengths = [];
    for (let levelIndex = 0; levelIndex < levelCount; levelIndex += 1) {
      levelLengths.push(view.getUint32(cursor, true));
      cursor += 4;
    }
    for (let levelIndex = 0; levelIndex < levelCount; levelIndex += 1) {
      const level = [];
      for (let bucketIndex = 0; bucketIndex < levelLengths[levelIndex]; bucketIndex += 1) {
        level.push({ min: readFloat16(view, cursor), max: readFloat16(view, cursor + 4) });
        cursor += 8;
      }
      levels.push(level);
    }
    return new PeakPyramid(sampleRate, baseBucketSamples, levels, totalSamples);
  }
}

export class PyramidBuilder {
  constructor(sampleRate, baseBucketSamples = DEFAULT_BASE_BUCKET_SAMPLES) {
    this.sampleRate = sampleRate;
    this.baseBucketSamples = baseBucketSamples;
    this.baseLevel = [];
    this.pending = [];
    this.totalSamples = 0;
  }

  pushChunk(samples) {
    for (const value of samples) {
      this.pending.push(value);
      if (this.pending.length === this.baseBucketSamples) {
        this.flushBucket();
      }
    }
    this.totalSamples += samples.length;
  }

  flushBucket() {
    let min = this.pending[0];
    let max = this.pending[0];
    for (const value of this.pending) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    this.baseLevel.push({ min, max });
    this.pending.length = 0;
  }

  build() {
    if (this.pending.length > 0) this.flushBucket();
    const levels = [this.baseLevel.slice()];
    while (levels[levels.length - 1].length > 1) {
      levels.push(reduceLevel(levels[levels.length - 1]));
    }
    return new PeakPyramid(this.sampleRate, this.baseBucketSamples, levels, this.totalSamples);
  }
}

function buildBaseLevel(samples, baseBucketSamples) {
  const level = [];
  for (let offset = 0; offset < samples.length; offset += baseBucketSamples) {
    const end = Math.min(offset + baseBucketSamples, samples.length);
    let min = samples[offset];
    let max = samples[offset];
    for (let index = offset + 1; index < end; index += 1) {
      if (samples[index] < min) min = samples[index];
      if (samples[index] > max) max = samples[index];
    }
    level.push({ min, max });
  }
  return level;
}

function reduceLevel(level) {
  const reduced = [];
  for (let offset = 0; offset < level.length; offset += REDUCTION_FACTOR) {
    let min = Infinity;
    let max = -Infinity;
    for (let index = offset; index < Math.min(offset + REDUCTION_FACTOR, level.length); index += 1) {
      if (level[index].min < min) min = level[index].min;
      if (level[index].max > max) max = level[index].max;
    }
    reduced.push({ min, max });
  }
  return reduced;
}

// Values are stored in a fixed-point 16-bit channel (-1..1), avoiding
// endian/rounding ambiguity of Float16 while keeping 1/32767 resolution.
function writeFloat16(view, offset, value) {
  const clamped = Math.max(-1, Math.min(1, value));
  view.setInt32(offset, Math.round(clamped * 32767), true);
}

function readFloat16(view, offset) {
  return view.getInt32(offset, true) / 32767;
}
