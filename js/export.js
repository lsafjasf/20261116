// Offline render of the current snapshot to a downloadable WAV file.
// Uses the same deterministic sim as the realtime engine, so the exported
// file matches what was heard.

import { N, stepSim, voiceState, restoreSim } from './sim.js';

export async function renderOffline(snapshot, seconds, sampleRate = 44100) {
  const frames = Math.round(seconds * sampleRate);
  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  const master = ctx.createGain();
  master.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -6; comp.ratio.value = 12;
  master.connect(comp); comp.connect(ctx.destination);

  const sim = restoreSim(snapshot);
  const voices = [];
  for (let i = 0; i < N; i++) {
    const osc = ctx.createOscillator();
    osc.type = i % 2 === 0 ? 'sine' : 'triangle';
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    osc.connect(gain); gain.connect(pan); pan.connect(master);
    osc.start(0); osc.stop(seconds);
    voices.push({ osc, gain, pan });
  }
  // Sample-accurate-ish automation: one control point per sim tick (60 Hz).
  const ticks = Math.floor(seconds * 60);
  for (let t = 0; t <= ticks; t++) {
    const time = t / 60;
    for (let i = 0; i < N; i++) {
      const v = voiceState(sim, i);
      voices[i].osc.frequency.setValueAtTime(v.freq, time);
      voices[i].gain.gain.setValueAtTime(v.gain, time);
      voices[i].pan.pan.setValueAtTime(v.pan, time);
    }
    stepSim(sim);
  }
  const buffer = await ctx.startRendering();
  return { wav: encodeWav(buffer), duration: buffer.duration, frames: buffer.length };
}

export function encodeWav(buffer) {
  const ch = buffer.numberOfChannels;
  const len = buffer.length * ch * 2;
  const out = new DataView(new ArrayBuffer(44 + len));
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); out.setUint32(4, 36 + len, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true);
  out.setUint16(22, ch, true); out.setUint32(24, buffer.sampleRate, true);
  out.setUint32(28, buffer.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  wstr(36, 'data'); out.setUint32(40, len, true);
  let off = 44;
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      out.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
  }
  return out.buffer;
}
