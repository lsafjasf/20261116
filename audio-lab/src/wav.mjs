// Encodes mono Float32 PCM into a 16-bit PCM WAV blob for manual listening.

export function encodeWav(channel, sampleRate) {
  const buffer = new ArrayBuffer(44 + channel.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + channel.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, channel.length * 2, true);
  let offset = 44;
  for (const sample of channel) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}

function writeString(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

// Lightweight perceptual descriptors: loudness (RMS), peak, centroid and
// flatness proxy. Same values before/after prove listening character is intact.
export function perceptualStats(channel, sampleRate) {
  let sumSquares = 0;
  let peak = 0;
  let zeroCrossings = 0;
  let weightedSum = 0;
  let magnitudeSum = 0;
  const bins = 32;
  const binEnergy = new Array(bins).fill(0);
  for (let index = 0; index < channel.length; index += 1) {
    const sample = channel[index];
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    if (index > 0 && ((channel[index - 1] >= 0) !== (sample >= 0))) {
      zeroCrossings += 1;
    }
    const bin = Math.min(bins - 1,
      Math.floor((index / channel.length) * bins));
    binEnergy[bin] += sample * sample;
    magnitudeSum += Math.abs(sample);
  }
  for (let bin = 0; bin < bins; bin += 1) {
    weightedSum += bin * binEnergy[bin];
  }
  const totalEnergy = binEnergy.reduce((a, b) => a + b, 0) || 1;
  return {
    rms: Math.sqrt(sumSquares / channel.length),
    peak,
    zeroCrossRate: zeroCrossings / channel.length,
    spectralCentroidBin: weightedSum / totalEnergy,
    estimatedFundamentalHz: (zeroCrossings / 2 / channel.length) * sampleRate,
    meanAbs: magnitudeSum / channel.length,
  };
}
