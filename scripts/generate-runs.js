import { mkdir, writeFile } from 'node:fs/promises';
import { SortingSimulation, replayRecording } from '../src/sim.js';
import {
  createFailureController,
  createSuccessController,
  runController,
} from './controllers.js';

const configurations = [
  {
    name: 'success',
    seed: 20261116,
    controller: createSuccessController,
    runId: 'DEMO-SUCCESS',
  },
  {
    name: 'failure',
    seed: 20261117,
    controller: createFailureController,
    runId: 'DEMO-FAILURE',
  },
];

await mkdir(new URL('../runs/', import.meta.url), { recursive: true });
const index = [];

for (const configuration of configurations) {
  const sim = new SortingSimulation({
    seed: configuration.seed,
    runId: configuration.runId,
  });
  runController(sim, configuration.controller());
  const recording = sim.recording();
  const replayed = replayRecording(recording);
  if (replayed.digest() !== recording.finalDigest) {
    throw new Error(`${configuration.name} replay digest mismatch`);
  }
  await writeFile(
    new URL(`../runs/${configuration.name}.json`, import.meta.url),
    `${JSON.stringify(recording, null, 2)}\n`
  );
  index.push({
    name: configuration.name,
    runId: recording.runId,
    success: recording.success,
    phase: recording.phase,
    duration: recording.duration,
    stats: recording.stats,
    finalDigest: recording.finalDigest,
    inputs: recording.inputs.length,
    timelineEntries: recording.timeline.length,
  });
  console.log(
    `${configuration.name}: ${recording.phase} at ${recording.duration}s, ` +
      `${recording.stats.packed}/${recording.total} packed, ` +
      `digest ${recording.finalDigest}`
  );
}

await writeFile(
  new URL('../runs/index.json', import.meta.url),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), runs: index }, null, 2)}\n`
);
