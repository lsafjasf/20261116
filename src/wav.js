// 交错 PCM16 立体声 WAV 编码（纯前端，无依赖）。

export function encodeWav(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const frames = audioBuffer.length;
  const data = interleave(audioBuffer);
  const buffer = new ArrayBuffer(44 + data.byteLength);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + data.byteLength, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, data.byteLength, true);

  new Uint8Array(buffer, 44).set(new Uint8Array(data.buffer));
  return new Blob([buffer], { type: "audio/wav" });
}

function interleave(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const frames = audioBuffer.length;
  const result = new Float32Array(frames * channels);
  const sources = [];
  for (let c = 0; c < channels; c++) sources.push(audioBuffer.getChannelData(c));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, sources[c][i]));
      result[i * channels + c] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
  }
  // 先转 Int16，再按字节拷贝，保证正确的小端 PCM。
  const pcm = new Int16Array(result.length);
  pcm.set(result);
  return pcm;
}

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function wavDurationSeconds(blob) {
  // 仅用于测试/校验：从 WAV 头读取时长。
  return blob.arrayBuffer().then((buffer) => {
    const view = new DataView(buffer);
    const sampleRate = view.getUint32(24, true);
    const channels = view.getUint16(22, true);
    const dataBytes = view.getUint32(40, true);
    return dataBytes / (sampleRate * channels * 2);
  });
}
