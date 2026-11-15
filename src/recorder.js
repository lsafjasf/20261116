// 16-second performance recorder + lookahead scheduler playback + WAV export.
// Every recorded note-on captures a deep snapshot of the key's parameters, so
// switching presets afterwards never alters already-recorded notes.

import { SynthEngine } from './engine.js';
import { encodeWav } from './wav.js';

export const MAX_RECORD_SECONDS = 16;

export class Recorder {
  constructor(engine, { lookaheadMs = 25, scheduleAheadSec = 0.12 } = {}) {
    this.engine = engine;
    this.lookaheadMs = lookaheadMs;
    this.scheduleAheadSec = scheduleAheadSec;

    this.recording = null; // { duration, events: [{t, type, key, params?}] }
    this.isRecording = false;
    this.isPlaying = false;
    this.playhead = 0; // seconds into the recording
    this._recordStartCtxTime = 0;
    this._timer = null;
    this._nextEventIndex = 0;
    this._playStartCtxTime = 0;
    this._recordDeadline = null;
  }

  // ---- Recording ----------------------------------------------------------

  startRecording() {
    if (this.isRecording) return; // idempotent: no duplicate timers
    this.stopPlayback();
    this.isRecording = true;
    this._events = [];
    this._recordStartCtxTime = this.engine.ctx.currentTime;
    // Hard stop at MAX_RECORD_SECONDS.
    this._recordDeadline = setTimeout(
      () => this.stopRecording(),
      MAX_RECORD_SECONDS * 1000
    );
    if (this._recordDeadline.unref) this._recordDeadline.unref();
  }

  _recordTime() {
    return Math.min(
      MAX_RECORD_SECONDS,
      this.engine.ctx.currentTime - this._recordStartCtxTime
    );
  }

  recordNoteOn(keyIndex) {
    if (!this.isRecording) return;
    const params = { ...this.engine.keys[keyIndex] }; // snapshot for playback
    this._events.push({ t: this._recordTime(), type: 'on', key: keyIndex, params });
    this.engine.noteOn(keyIndex);
  }

  recordNoteOff(keyIndex) {
    if (!this.isRecording) return;
    this._events.push({ t: this._recordTime(), type: 'off', key: keyIndex });
    this.engine.noteOff(keyIndex);
  }

  stopRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;
    if (this._recordDeadline != null) {
      clearTimeout(this._recordDeadline);
      this._recordDeadline = null;
    }
    this.engine.stopAll(0.005);
    const events = this._events.filter((e) => e.t <= MAX_RECORD_SECONDS);
    events.sort((a, b) => a.t - b.t);
    this.recording = { duration: MAX_RECORD_SECONDS, events };
    this._events = [];
  }

  // ---- Playback -----------------------------------------------------------

  play() {
    if (!this.recording || this.isPlaying) return; // idempotent
    this.isPlaying = true;
    const ctx = this.engine.ctx;
    this._playStartCtxTime = ctx.currentTime;
    const from = this.playhead;
    this._nextEventIndex = this.recording.events.findIndex((e) => e.t >= from);
    if (this._nextEventIndex < 0) this._nextEventIndex = this.recording.events.length;
    if (this._timer == null) {
      this._timer = setInterval(() => this._tick(), this.lookaheadMs);
      if (this._timer.unref) this._timer.unref();
    }
  }

  _tick() {
    if (!this.isPlaying) return;
    const ctx = this.engine.ctx;
    const elapsed = ctx.currentTime - this._playStartCtxTime;
    const now = this.playhead + elapsed;
    const horizon = now + this.scheduleAheadSec;
    const events = this.recording.events;
    while (
      this._nextEventIndex < events.length &&
      events[this._nextEventIndex].t <= horizon
    ) {
      const ev = events[this._nextEventIndex++];
      const when = this._playStartCtxTime + (ev.t - this.playhead);
      if (when < ctx.currentTime - 0.25) continue; // hopelessly late, skip
      if (ev.type === 'on') this.engine.noteOn(ev.key, Math.max(when, ctx.currentTime), ev.params);
      else this.engine.noteOff(ev.key, Math.max(when, ctx.currentTime));
    }
    if (now >= this.recording.duration && this._nextEventIndex >= events.length) {
      this.stopPlayback();
      this.playhead = 0;
    }
  }

  // Pause: freeze playhead, silence immediately (no release tail allowed).
  pause() {
    if (!this.isPlaying) return;
    this.playhead += this.engine.ctx.currentTime - this._playStartCtxTime;
    this._haltScheduling();
    this.engine.stopAll(0.005);
  }

  stopPlayback() {
    if (!this.isPlaying && this._timer == null) return;
    this._haltScheduling();
    this.engine.stopAll(0.005);
    this.playhead = 0;
  }

  _haltScheduling() {
    this.isPlaying = false;
    if (this._timer != null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ---- Export -------------------------------------------------------------

  // Render the recording through a fresh engine on an OfflineAudioContext and
  // encode a stereo WAV. Deterministic: identical recording -> identical bytes.
  async exportWav(OfflineContextCtor, { sampleRate = 44100 } = {}) {
    if (!this.recording) throw new Error('Recorder: nothing recorded');
    const duration = this.recording.duration;
    const ctx = new OfflineContextCtor(2, Math.ceil(duration * sampleRate), sampleRate);
    const offline = new SynthEngine({ context: ctx, autoCollectMs: 1000 });
    offline.keys = this.engine.keys.map((k) => ({ ...k }));
    offline.start();
    for (const ev of this.recording.events) {
      if (ev.type === 'on') offline.noteOn(ev.key, ev.t, ev.params);
      else offline.noteOff(ev.key, ev.t);
    }
    const buffer = await ctx.startRendering();
    const channels = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      channels.push(buffer.getChannelData(ch));
    }
    const wav = encodeWav(channels, buffer.sampleRate);
    await offline.destroy();
    return { wav, duration, sampleRate: buffer.sampleRate };
  }

  getStatus() {
    return {
      isRecording: this.isRecording,
      isPlaying: this.isPlaying,
      playhead: this.playhead,
      recorded: this.recording != null,
      eventCount: this.recording ? this.recording.events.length : 0,
      schedulerRunning: this._timer != null,
    };
  }
}
