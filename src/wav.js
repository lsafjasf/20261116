// Encode an AudioBuffer (or channel arrays) into a 16-bit PCM WAV Blom/Buffer.
export function encodeWav(buffer, { sampleRate = buffer.sampleRate } = {}) {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = length * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return out;
}

export function wavDurationMs(byteLength, channels = 2, sampleRate = 44100) {
  const dataSize = byteLength - 44;
  return (dataSize / (channels * 2)) / sampleRate * 1000;
}
