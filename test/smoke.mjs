import { renderScenario, measurePeak, isSilent } from '../src/offline-runner.js';

const { engine, rendered, wav } = await renderScenario({
  durationSeconds: 5,
  params: { bpm: 100, fadeInSeconds: 0.3 },
  events: [
    { t: 0.6, type: 'intensity', value: 0.85 },
    { t: 1.8, type: 'intensity', value: 0.2 },
    { t: 2.8, type: 'intensity', value: 0.75 },
    { t: 3.8, type: 'intensity', value: 0.1 },
  ],
});

const beats = engine.events.filter((e) => e.kind === 'beat');
const states = engine.events.filter((e) => e.kind === 'state');
console.log('wav bytes', wav.byteLength, 'duration', rendered.duration);
console.log('peak', measurePeak(rendered).toFixed(4));
console.log('beats', beats.length, 'first beat times', beats.slice(0, 4).map((b) => b.time.toFixed(4)));
console.log('states', states.map((s) => `${s.from}->${s.to}@${s.time}`));
console.log('active nodes after render', engine.activeNodeCount);
console.log('registry size', engine.registry.size);
