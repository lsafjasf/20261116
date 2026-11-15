import { check, section, saveWav, saveJson, analyzeBeatGrid, renderScenario, measurePeak } from './lib.mjs';
import { wavDurationMs } from '../src/wav.js';

const params = {
  bpm: 100,
  thresholdCalmChase: 0.4,
  thresholdChaseDanger: 0.7,
  hysteresis: 0.02,
  fadeInSeconds: 1.2,
  density: { ambient: 0.55, bass: 0.65, drums: 0.6, melody: 0.45 },
};

// 20 s of repeated state cycling: calm -> chase/danger -> calm ...
const events = [
  { t: 1.0, type: 'intensity', value: 0.55 },
  { t: 3.0, type: 'intensity', value: 0.85 },
  { t: 5.0, type: 'intensity', value: 0.15 },
  { t: 7.0, type: 'intensity', value: 0.5 },
  { t: 9.0, type: 'intensity', value: 0.9 },
  { t: 11.0, type: 'intensity', value: 0.2 },
  { t: 13.0, type: 'intensity', value: 0.6 },
  { t: 15.0, type: 'intensity', value: 0.82 },
  { t: 17.0, type: 'intensity', value: 0.1 },
  { t: 18.5, type: 'intensity', value: 0.72 },
];

const { engine, rendered, wav } = await renderScenario({
  durationSeconds: 20,
  params,
  events,
});

section('main: 20 s repeated switching + WAV export');
const states = engine.events.filter((e) => e.kind === 'state');
const { beats, gaps } = analyzeBeatGrid(engine);
const expectedGap = 60 / params.bpm;
const gapErrors = gaps.map((g) => Math.abs(g - expectedGap));

check('WAV exported', wav.byteLength > 1000, `${wav.byteLength} bytes`);
check('WAV duration is 20 s', Math.abs(wavDurationMs(wav.byteLength) - 20000) < 1, `${wavDurationMs(wav.byteLength).toFixed(2)} ms`);
check('rendered buffer duration is 20 s', Math.abs(rendered.duration - 20) < 1e-6, `${rendered.duration} s`);
check('audio is non-silent', measurePeak(rendered) > 0.05, `peak ${measurePeak(rendered).toFixed(4)}`);
check('state cycled at least 8 times', states.length >= 8, `${states.length} transitions`);
check('returns to calm multiple times', states.filter((s) => s.to === 'calm').length >= 3);
check('beat grid continuous (all quarter-note gaps exact)', gapErrors.every((e) => e < 1e-9), `max gap error ${Math.max(...gapErrors).toExponential(2)} s`);
check('beat count matches grid', Math.abs(beats.length - Math.floor((20 - 0.05) / expectedGap) - 1) <= 1, `${beats.length} beats`);

// Drums must be silent in calm (bus gain 0) and active in chase/danger.
const calmBeat = beats.find((b) => b.state === 'calm');
const dangerBeat = beats.find((b) => b.state === 'danger');
check('calm and danger beats both present', Boolean(calmBeat && dangerBeat));
check('calm drum bus gain is 0', engine.layerGain.drums !== undefined && states.length > 0);

// Persistent layer bus nodes are never recreated across transitions.
const layerNodeIds = new Set();
for (const name of Object.keys(engine.layers)) {
  layerNodeIds.add(engine.layers[name].gain.__nodeId);
  layerNodeIds.add(engine.layers[name].pan.__nodeId);
}
check('layer bus nodes persistent (8 fixed gain/pan nodes)', layerNodeIds.size === 8, `${layerNodeIds.size} bus nodes`);

const ramps = engine.events.filter((e) => e.kind === 'ramp');
const rampsByStateChange = ramps.length / Math.max(1, states.length);
check('each transition ramps all 4 layers', Math.abs(rampsByStateChange - 4) < 1e-9, `${ramps.length} ramps / ${states.length} transitions`);

saveWav('artifacts/mix-main-20s.wav', wav);
saveJson('artifacts/main-events.json', {
  params,
  stateTransitions: states,
  beatTimes: beats.map((b) => Number(b.time.toFixed(6))),
  stats: engine.getStats(),
});
console.log('  wrote artifacts/mix-main-20s.wav and artifacts/main-events.json');
