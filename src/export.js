import { renderStage } from "./renderer.js";

const DURATION_MS = 12000;
const TARGET_FPS = 30;

function chooseMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm"
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function buildAudio(context, streamDestination) {
  const master = context.createGain();
  master.gain.value = 0.52;
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 18;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.01;
  compressor.release.value = 0.25;
  master.connect(compressor);
  compressor.connect(streamDestination);

  const now = context.currentTime;
  const padNotes = [
    { frequency: 110, gain: 0.045, detune: -5 },
    { frequency: 164.81, gain: 0.028, detune: 4 },
    { frequency: 220, gain: 0.018, detune: 0 }
  ];
  for (const note of padNotes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const filter = context.createBiquadFilter();
    oscillator.type = "sine";
    oscillator.frequency.value = note.frequency;
    oscillator.detune.value = note.detune;
    filter.type = "lowpass";
    filter.frequency.value = 900;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(note.gain, now + 1.2);
    gain.gain.setValueAtTime(note.gain, now + 9.4);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 11.95);
    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    oscillator.start(now);
    oscillator.stop(now + 12.02);
  }

  const melody = [440, 523.25, 659.25, 523.25, 587.33, 698.46, 880, 783.99];
  melody.forEach((frequency, index) => {
    const start = now + 0.35 + index * 1.38;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = index % 2 ? "triangle" : "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.045, start + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.72);
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(start);
    oscillator.stop(start + 0.75);
  });

  return { master, compressor };
}

export async function exportWebm(canvas, state, options = {}) {
  if (!window.MediaRecorder) throw new Error("当前浏览器不支持 MediaRecorder");
  if (!canvas.captureStream) throw new Error("当前浏览器不支持 Canvas 视频流");

  const duration = options.durationMs || DURATION_MS;
  const fps = options.fps || TARGET_FPS;
  const mimeType = chooseMimeType();
  const audioContext = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  await audioContext.resume();
  const streamDestination = audioContext.createMediaStreamDestination();
  const audioGraph = buildAudio(audioContext, streamDestination);
  const canvasStream = canvas.captureStream(fps);
  const videoTrack = canvasStream.getVideoTracks()[0];
  const audioTrack = streamDestination.stream.getAudioTracks()[0];
  if (!videoTrack) throw new Error("视频轨道创建失败");
  if (!audioTrack) throw new Error("音频轨道创建失败");

  const stream = new MediaStream([videoTrack, audioTrack]);
  const chunks = [];
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 5_000_000,
    audioBitsPerSecond: 128_000
  });

  let frameCount = 0;
  let renderPasses = 0;
  let lastFrameAt = -1;
  let animationFrame = 0;
  const startedAt = performance.now();

  const stopped = new Promise((resolve, reject) => {
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    recorder.addEventListener("stop", resolve, { once: true });
    recorder.addEventListener("error", (event) => reject(event.error || new Error("录制失败")), { once: true });
  });

  renderStage(canvas, { ...state, time: 0 });
  recorder.start(500);

  const draw = () => {
    const elapsed = performance.now() - startedAt;
    const time = Math.min(12, elapsed / 1000);
    const interval = 1000 / fps;
    if (elapsed - lastFrameAt >= interval - 1 || elapsed >= duration) {
      lastFrameAt = elapsed;
      const layout = renderStage(canvas, { ...state, time });
      frameCount += 1;
      options.onProgress?.({
        elapsed,
        time,
        progress: Math.min(1, elapsed / duration),
        frameCount,
        renderPasses,
        fps,
        layout
      });
      renderPasses += 1;
    }
    if (elapsed < duration) {
      animationFrame = requestAnimationFrame(draw);
    } else {
      cancelAnimationFrame(animationFrame);
      setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, 40);
    }
  };
  animationFrame = requestAnimationFrame(draw);

  await stopped;
  videoTrack.stop();
  audioTrack.stop();
  await audioContext.close();

  let blob = new Blob(chunks, { type: mimeType || "video/webm" });
  if (!blob.size) throw new Error("导出结果为空");
  let durationPatched = false;
  if (typeof window.ysFixWebmDuration === "function") {
    try {
      blob = await window.ysFixWebmDuration(blob, duration);
      durationPatched = true;
    } catch {
      durationPatched = false;
    }
  }
  return {
    blob,
    mimeType,
    durationMs: duration,
    frameCount,
    renderPasses,
    nominalFrames: Math.round((duration / 1000) * fps),
    fps,
    videoTrack: { present: true, settings: videoTrack.getSettings() },
    audioTrack: { present: true, settings: audioTrack.getSettings() },
    audioGraph,
    size: blob.size,
    durationPatched,
    createdAt: new Date().toISOString()
  };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return url;
}
