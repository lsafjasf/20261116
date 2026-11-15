import { clamp } from './util.js';

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

export function encodeWav(channels, sampleRate) {
  const numberOfChannels = channels.length;
  const length = channels[0].length;
  const bytesPerSample = 2;
  const blockAlign = numberOfChannels * bytesPerSample;
  const dataSize = length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < length; i += 1) {
    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      const sample = clamp(channels[channel][i], -1, 1);
      const quantized = Math.round(sample * 0x7fff);
      view.setInt16(offset, Math.max(-0x8000, Math.min(0x7fff, quantized)), true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

export function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let audioFormat = 1;
  let numberOfChannels = 2;
  let sampleRate = 44100;
  let dataOffset = 0;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(
      bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3],
    );
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      audioFormat = view.getUint16(body, true);
      numberOfChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size % 2);
  }
  if (audioFormat !== 1) throw new Error(`Unsupported WAV format ${audioFormat}`);
  const frameCount = Math.floor(dataSize / (numberOfChannels * 2));
  const channels = Array.from(
    { length: numberOfChannels },
    () => new Float32Array(frameCount),
  );
  let p = dataOffset;
  for (let i = 0; i < frameCount; i += 1) {
    for (let c = 0; c < numberOfChannels; c += 1) {
      channels[c][i] = view.getInt16(p, true) / 0x8000;
      p += 2;
    }
  }
  return { sampleRate, numberOfChannels, length: frameCount, channels };
}
