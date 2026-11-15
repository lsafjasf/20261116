import { OfflineAudioContext } from 'web-audio-engine';
import { SoundtrackEngine } from '../src/engine.js';
import { encodeWav, wavDurationMs } from '../src/wav.js';
import { check, section, saveWav, saveJson } from './lib.mjs';

const params = {
  bpm: 112,
  thresholdCalmChase: 0.4,
  thresholdChaseDanger: 0.7,
  fadeInSeconds: 0.8,
  density: { ambient: 0.5, bass: 0.7, drums: 0.55, melody: 0.6 },
};

const headEvents = [
  { t: 1, type: 'intensity', value: 0.55 },
  { t: 3, type: 'intensity', value: 0.9 },
  { t: 5, type: 'intensity', value: 0.15 },
  { t: 7, type: 'intensity', value: 0.75 },
];
const tailEvents = [
  { t: 9, type: 'intensity', value: 0.55 },
  { t: 11, type: 'intensity', value: 0.9 },
  { t: 13, type: 'intensity', value: 0.15 },
  { t: 15, type: 'intensity', value: 0.75 },
  { t: 17, type: 'intensity', value: 0.2 },
];
const RESTORE_AT = 8;
const DURATION = 20;

const noop = () => ({ setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} });

function createEngine(ctx, virtualRef) {
  return new SoundtrackEngine(ctx, params, { clock: () => virtualRef.t, driver: noop() });
}

function drive(engine, events, virtualRef, until) {
  for (const ev of events) {
    virtualRef.t = ev.t;
    engine.setIntensity(ev.value, ev.t);
    engine.tick(ev.t + 0.13);
  }
  virtualRef.t = until;
  engine.tick(until + 0.2);
}

async function render(useSnapshot, snapshot) {
  const sr = 44100;
  const ctx = new OfflineAudioContext(2, DURATION * sr, sr);
  const virtualRef = { t: 0 };
  const engine = createEngine(ctx, virtualRef);
  engine.start();
  if (useSnapshot) {
    engine.restoreSnapshot(snapshot);
  } else {
    for (const ev of headEvents) {
      virtualRef.t = ev.t;
      engine.setIntensity(ev.value, ev.t);
      engine.tick(ev.t + 0.13);
    }
    virtualRef.t = RESTORE_AT;
    engine.tick(RESTORE_AT);
  }
  drive(engine, tailEvents, virtualRef, DURATION);
  const rendered = await ctx.startRendering();
  return { engine, rendered, wav: encodeWav(rendered, { sampleRate: sr }) };
}

// Build the snapshot from a separate engine run at t = 8 s.
const sr = 44100;
const snapCtx = new OfflineAudioContext(2, DURATION * sr, sr);
const snapRef = { t: 0 };
const snapEngine = createEngine(snapCtx, snapRef);
snapEngine.start();
for (const ev of headEvents) {
  snapRef.t = ev.t;
  snapEngine.setIntensity(ev.value, ev.t);
  snapEngine.tick(ev.t + 0.13);
}
snapRef.t = RESTORE_AT;
snapEngine.tick(RESTORE_AT);
const snapshot = snapEngine.snapshot();
saveJson('artifacts/snapshot.json', snapshot);

section('snapshot: save current params and restore once');
check('snapshot keeps thresholds/fade/density',
  snapshot.params.thresholdChaseDanger === 0.7 &&
  snapshot.params.fadeInSeconds === 0.8 &&
  snapshot.params.density.bass === 0.7);
check('snapshot keeps rng and step state', snapshot.stepIndex > 0 && typeof snapshot.rngState === 'number');
check('snapshot stores layer gain and pan', Object.keys(snapshot.layerGain).length === 4);

const baseline = await render(false);
const restored = await render(true, snapshot);

const after = (list) => list.filter((e) => e.time >= RESTORE_AT - 1e-9);
const beatKey = (e) => [e.time, e.step, e.state, e.bpm, e.intensity];
const baseBeats = after(baseline.engine.events.filter((e) => e.kind === 'beat')).map(beatKey);
const restBeats = after(restored.engine.events.filter((e) => e.kind === 'beat')).map(beatKey);
check('beat points after restore identical', JSON.stringify(baseBeats) === JSON.stringify(restBeats), `${baseBeats.length} beats compared`);

const noteKey = (e) => [e.time, e.freq, e.pan, e.gain];
const baseNotes = after(baseline.engine.events.filter((e) => e.kind === 'note')).map(noteKey);
const restNotes = after(restored.engine.events.filter((e) => e.kind === 'note')).map(noteKey);
check('note time/freq/pan/gain identical', JSON.stringify(baseNotes) === JSON.stringify(restNotes), `${baseNotes.length} notes compared`);

check('layer pan identical',
  Object.keys(snapshot.layerPan).every((k) => Math.abs(restored.engine.layerPan[k] - baseline.engine.layerPan[k]) < 1e-9));
check('layer gain identical',
  Object.keys(snapshot.layerGain).every((k) => Math.abs(restored.engine.layerGain[k] - baseline.engine.layerGain[k]) < 1e-9));

check('both WAV exports are 20 s',
  Math.abs(wavDurationMs(baseline.wav.byteLength) - 20000) < 1 &&
  Math.abs(wavDurationMs(restored.wav.byteLength) - 20000) < 1);

// Persistent ambient/bass voices alive at the restore point keep playing by
// design (returning to calm must not restart them from zero). Once every
// pre-restore voice has ended (~12.1 s), the two renders must be sample-exact.
const PCM_COMPARE_FROM = 12.5;
const cut = Math.floor(PCM_COMPARE_FROM * sr);
let maxDiff = 0;
const a0 = baseline.rendered.getChannelData(0);
const b0 = restored.rendered.getChannelData(0);
const a1 = baseline.rendered.getChannelData(1);
const b1 = restored.rendered.getChannelData(1);
for (let i = cut; i < a0.length; i++) {
  maxDiff = Math.max(maxDiff, Math.abs(a0[i] - b0[i]), Math.abs(a1[i] - b1[i]));
}
check('post-restore PCM identical', maxDiff === 0, `max diff ${maxDiff}`);

saveWav('artifacts/mix-snapshot-baseline.wav', baseline.wav);
saveWav('artifacts/mix-snapshot-restored.wav', restored.wav);
saveJson('artifacts/snapshot-compare.json', {
  restoreAt: RESTORE_AT,
  pcmCompareFrom: PCM_COMPARE_FROM,
  comparedBeats: baseBeats.length,
  comparedNotes: baseNotes.length,
  maxPcmDiffAfterRestore: maxDiff,
  baselineWavMs: wavDurationMs(baseline.wav.byteLength),
  restoredWavMs: wavDurationMs(restored.wav.byteLength),
  layerGain: restored.engine.layerGain,
  layerPan: restored.engine.layerPan,
});
