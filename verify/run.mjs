// Headless verification suite for the 8-key Web Audio synth.
// Run: npm run verify
import { OfflineAudioContext } from 'node-web-audio-api';
import { SynthEngine, defaultKeyParams } from '../src/engine.js';
import { Recorder, MAX_RECORD_SECONDS } from '../src/recorder.js';
import {
  snapshotProject,
  restoreProject,
  diffProjects,
  musicalFeatures,
} from '../src/project.js';
import { wavDurationSeconds } from '../src/wav.js';
import { MockAudioContext } from './mock-context.mjs';
import { writeFileSync } from 'node:fs';

let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`);
  if (!ok) failures++;
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// 1. Record a 16s performance containing a chord and a glide.
// ---------------------------------------------------------------------------
const ctx = new MockAudioContext();
const engine = new SynthEngine({ context: ctx }).start();
const recorder = new Recorder(engine);

engine.setKeyParams(3, { glide: 0.4, waveform: 'sawtooth', pan: -0.5 });
engine.setKeyParams(0, { pan: -0.3, gain: 0.7 });
engine.setKeyParams(2, { pan: 0.2 });
engine.setKeyParams(4, { pan: 0.5, gain: 0.9 });

recorder.startRecording();
ctx.advance(0.5);
recorder.recordNoteOn(0); // chord: C E G
recorder.recordNoteOn(2);
recorder.recordNoteOn(4);
ctx.advance(1.5);
recorder.recordNoteOff(0);
recorder.recordNoteOff(2);
recorder.recordNoteOff(4);
ctx.advance(1.0); // t=3.0
recorder.recordNoteOn(3);
ctx.advance(0.5);
recorder.recordNoteOff(3);
ctx.advance(0.2); // t=3.7
engine.setKeyParams(3, { pitchOffset: 2 }); // pitch change -> portamento sweep
recorder.recordNoteOn(3); // retrigger -> glide from previous frequency
ctx.advance(1.0);
recorder.recordNoteOff(3);
engine.setKeyParams(3, { pitchOffset: 0 });
ctx.advance(11.3); // total 16.0
recorder.stopRecording();

const rec = recorder.recording;
check('record: 16s window', approx(rec.duration, MAX_RECORD_SECONDS));
check('record: events captured', rec.events.length === 10, `got ${rec.events.length}`);
const ons = rec.events.filter((e) => e.type === 'on');
const chordOns = ons.filter((e) => approx(e.t, 0.5, 1e-3));
check('record: chord of 3 notes at t=0.5', chordOns.length === 3);
check('record: note-on snapshots params', ons.every((e) => e.params && e.params.waveform));

// Glide proof: second note-on for key 3 ramps frequency from previous value.
const glideVoice = engine.voices.get(3);
const freqHist = glideVoice.osc.frequency.history;
const hasGlide =
  freqHist.some((h) => h.m === 'set' && approx(h.v, 349.228, 0.01)) &&
  freqHist.some((h) => h.m === 'lin' && approx(h.v, 392.0, 0.01));
check('record: glide produced frequency ramp', hasGlide, JSON.stringify(freqHist));

// ---------------------------------------------------------------------------
// 2. Export WAV through a real OfflineAudioContext.
// ---------------------------------------------------------------------------
const { wav, duration } = await recorder.exportWav(OfflineAudioContext);
const magic = String.fromCharCode(...wav.slice(0, 4)) + String.fromCharCode(...wav.slice(8, 12));
check('export: RIFF/WAVE header', magic === 'RIFFWAVE', magic);
check('export: duration == 16s', approx(wavDurationSeconds(wav), 16, 1e-3),
  String(wavDurationSeconds(wav)));
let peak = 0;
const wavBuf = Buffer.from(wav);
for (let i = 44; i < wavBuf.length; i += 2) {
  const s = Math.abs(wavBuf.readInt16LE(i));
  if (s > peak) peak = s;
}
check('export: non-silent audio', peak > 1000, `peak=${peak}`);
writeFileSync(new URL('../artifacts/performance.wav', import.meta.url), wav);

// ---------------------------------------------------------------------------
// 3. Pause leaves no tail; resume continues from the playhead.
// ---------------------------------------------------------------------------
const ctx2 = new MockAudioContext();
const engine2 = new SynthEngine({ context: ctx2 }).start();
const rec2 = new Recorder(engine2);
rec2.recording = JSON.parse(JSON.stringify(rec));

rec2.play();
ctx2.advance(0.6); // inside the chord (ons at 0.5)
rec2._tick();
check('pause: chord voices sounding', engine2.getStatus().activeVoices === 3,
  JSON.stringify(engine2.getStatus()));
ctx2.advance(0.4); // ctx t=1.0, playhead ~1.0
rec2.pause();
const pausedPlayhead = rec2.playhead;
check('pause: playhead frozen mid-performance', approx(pausedPlayhead, 1.0, 1e-6),
  String(pausedPlayhead));
// No tail: every live voice env gain was cancelled and ramped to 0 within 5ms.
let tailFree = true;
for (const v of engine2.voices.values()) {
  const h = v.envGain.gain.history;
  const last = h[h.length - 1];
  const cancelled = h.some((e) => e.m === 'cancel');
  if (!(cancelled && last.m === 'lin' && last.v === 0 && last.t - 1.0 <= 0.005 + 1e-9)) {
    tailFree = false;
  }
}
check('pause: all voices silenced within 5ms (no tail)', tailFree);
ctx2.advance(30); // long after pause
engine2.collectVoices();
check('pause: no lingering nodes after collect', engine2.activeNodeCount === 0,
  `active=${engine2.activeNodeCount}`);

rec2.play(); // resume
check('resume: playhead preserved', approx(rec2.playhead, pausedPlayhead, 1e-9));
ctx2.advance(1.6); // playhead now ~2.6 -> offs at 2.0 fire, on at 3.0 pending
rec2._tick();
check('resume: scheduler active again', rec2.getStatus().schedulerRunning);
rec2.stopPlayback();

// ---------------------------------------------------------------------------
// 4. Project reload keeps parameters identical.
// ---------------------------------------------------------------------------
const snap1 = snapshotProject(engine, recorder);
const roundTrip = JSON.parse(JSON.stringify(snap1));
const ctx3 = new MockAudioContext();
const engine3 = new SynthEngine({ context: ctx3 }).start();
const rec3 = new Recorder(engine3);
restoreProject(engine3, rec3, roundTrip);
const snap2 = snapshotProject(engine3, rec3);
check('reload: params + recording identical after JSON round-trip',
  diffProjects(snap1, snap2).length === 0,
  diffProjects(snap1, snap2).join('; '));

// Preset switch must not alter recorded notes (params are snapshotted per note).
engine.applyPreset(Array.from({ length: 8 }, () => ({
  ...defaultKeyParams(), waveform: 'square', gain: 0.1, pan: 1,
})));
const afterPreset = snapshotProject(engine, recorder);
check('preset switch: recorded events untouched',
  JSON.stringify(afterPreset.recording.events) === JSON.stringify(snap1.recording.events));
restoreProject(engine, recorder, roundTrip); // put original params back

// ---------------------------------------------------------------------------
// 5. Input interruption: silence immediately, no leaked nodes.
// ---------------------------------------------------------------------------
const ctx4 = new MockAudioContext();
const engine4 = new SynthEngine({ context: ctx4 }).start();
engine4.noteOn(0);
engine4.noteOn(4);
ctx4.advance(0.3);
await engine4.handleInterrupt();
check('interrupt: context suspended', ctx4.state === 'suspended' && ctx4.suspendCount === 1);
let interruptSilent = true;
for (const v of engine4.voices.values()) {
  const h = v.envGain.gain.history;
  if (!(h.some((e) => e.m === 'cancel') && h[h.length - 1].v === 0)) interruptSilent = false;
}
check('interrupt: voices ramped to zero', interruptSilent);
ctx4.advance(10);
engine4.collectVoices();
check('interrupt: no residual nodes', engine4.activeNodeCount === 0,
  `active=${engine4.activeNodeCount}`);

// Retrigger regression: replaced voices must still be collected (no leak).
const ctx4b = new MockAudioContext();
const engine4b = new SynthEngine({ context: ctx4b }).start();
engine4b.noteOn(2);
ctx4b.advance(0.1);
engine4b.noteOn(2); // retrigger same key: old voice leaves the map
engine4b.noteOff(2);
ctx4b.advance(5);
engine4b.collectVoices();
check('retrigger: replaced voice collected, zero leaked nodes',
  engine4b.activeNodeCount === 0, `active=${engine4b.activeNodeCount}`);
await engine4b.destroy();

// ---------------------------------------------------------------------------
// 6. Destroy: everything disconnected, closed, and unwound.
// ---------------------------------------------------------------------------
const target = new EventTarget();
engine4.addManagedListener(target, 'keydown', () => {});
engine4.addManagedListener(target, 'keyup', () => {});
engine4.noteOn(1);
await engine4.destroy();
const st4 = engine4.getStatus();
check('destroy: active node count is zero', engine4.activeNodeCount === 0,
  `active=${engine4.activeNodeCount}`);
check('destroy: all mock nodes disconnected', ctx4.liveNodes().length === 0,
  `live=${ctx4.liveNodes().length}`);
check('destroy: context closed', ctx4.state === 'closed');
check('destroy: listeners removed, timer cleared',
  st4.managedListeners === 0 && !st4.collectorRunning && !st4.started);

// ---------------------------------------------------------------------------
// 7. Repeated start: no duplicate listeners, timers, or nodes.
// ---------------------------------------------------------------------------
const ctx5 = new MockAudioContext();
const engine5 = new SynthEngine({ context: ctx5 });
engine5.start(); engine5.start(); engine5.start();
let hits = 0;
engine5.addManagedListener(target, 'ping', () => hits++);
engine5.start(); // must be a no-op
target.dispatchEvent(new Event('ping'));
check('repeat start: single listener registration', hits === 1, `hits=${hits}`);
check('repeat start: single collector + started flag',
  engine5.getStatus().collectorRunning && engine5.started);
const rec5 = new Recorder(engine5);
rec5.recording = { duration: 16, events: [{ t: 0, type: 'on', key: 0, params: { ...engine5.keys[0] } }] };
rec5.play(); rec5.play(); rec5.play();
check('repeat play: single scheduler', rec5.getStatus().schedulerRunning);
rec5.pause(); rec5.pause();
check('repeat pause: idempotent', !rec5.isPlaying);
rec5.startRecording(); rec5.startRecording();
check('repeat record: idempotent', rec5.isRecording);
rec5.stopRecording();
await engine5.destroy();

// ---------------------------------------------------------------------------
// 8. Snapshot save/restore: beat points, pan, gain, export duration match.
// ---------------------------------------------------------------------------
const featBefore = musicalFeatures(snapshotProject(engine, recorder));
const saved = JSON.stringify(snapshotProject(engine, recorder));
// Mutate everything, then restore from the snapshot.
engine.applyPreset(Array.from({ length: 8 }, () => ({ ...defaultKeyParams(), pan: -1, gain: 0.05 })));
restoreProject(engine, recorder, JSON.parse(saved));
const featAfter = musicalFeatures(snapshotProject(engine, recorder));
check('snapshot: beat points identical',
  JSON.stringify(featBefore.onsets) === JSON.stringify(featAfter.onsets));
check('snapshot: pans identical',
  JSON.stringify(featBefore.pans) === JSON.stringify(featAfter.pans));
check('snapshot: gains identical',
  JSON.stringify(featBefore.gains) === JSON.stringify(featAfter.gains));
check('snapshot: export duration identical', featBefore.duration === featAfter.duration);
const exportAgain = await recorder.exportWav(OfflineAudioContext);
check('snapshot: re-export duration still 16s',
  approx(wavDurationSeconds(exportAgain.wav), 16, 1e-3));
check('snapshot: re-export deterministic (byte-identical)',
  Buffer.from(exportAgain.wav).equals(Buffer.from(wav)));

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
