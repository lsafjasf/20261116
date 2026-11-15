import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMELINE_SECONDS, peakAmplitude } from '../src/js/util.js';
import { createDefaultProject, diffSnapshots, parseProject, takeSnapshot, beatTimes } from '../src/js/project.js';
import { synthesizeAll } from '../src/js/synth.js';
import { PlaybackEngine } from '../src/js/engine.js';
import { MockHost } from '../src/js/mock-host.js';
import { decodeWav } from '../src/js/wav.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = join(root, 'artifacts');
mkdirSync(artifactDir, { recursive: true });

const sources = synthesizeAll();
const report = { scenarios: [], checks: [] };
const record = (name, condition, detail = '') => {
  report.checks.push({ name, passed: Boolean(condition), detail });
};

{
  const host = new MockHost();
  const engine = new PlaybackEngine(host, createDefaultProject(), sources);
  await engine.start(0);
  host.advance(3.4);
  engine.stop();
  host.advance(0.5);
  const master = [...host.nodes.keys()].find((node) => node.kind === 'master');
  report.scenarios.push({
    name: 'input-interrupt',
    nodesAfterStop: engine.activeNodeCount,
    frameSubscriptions: host.frameSubscriptions,
    frameUnsubscriptions: host.frameUnsubscriptions,
    releaseEndsAtZero: master.gain.events.at(-1).value === 0,
    tailWindowSilent: engine.activeNodeCount === 0,
  });
  record('input interrupt leaves no tail nodes', engine.activeNodeCount === 0);
  record('interrupt ramps master to zero', master.gain.events.at(-1).value === 0);
  engine.destroy();
}

{
  const host = new MockHost();
  const engine = new PlaybackEngine(host, createDefaultProject(), sources);
  await engine.start(0);
  host.advance(1.1);
  const created = host.nodes.size;
  engine.destroy();
  const leftovers = [...host.nodes.keys()].filter((node) => !node.closed);
  report.scenarios.push({
    name: 'node-destroy',
    created,
    closed: created - leftovers.length,
    leftoverNodes: leftovers.length,
    frameCallbacks: host._frameCallbacks.size,
  });
  record('destroy closes every created node', leftovers.length === 0);
  record('destroy removes the frame listener', host._frameCallbacks.size === 0);
}

{
  const host = new MockHost();
  const engine = new PlaybackEngine(host, createDefaultProject(), sources);
  await engine.start(0);
  await engine.start(2);
  await engine.start(4);
  const subscriptions = host.frameSubscriptions;
  const nodeCount = engine.activeNodeCount;
  host.advance(0.4);
  report.scenarios.push({
    name: 'repeated-start',
    frameSubscriptions: subscriptions,
    activeNodeCount: nodeCount,
    status: engine.status,
  });
  record('repeated start keeps one frame listener', subscriptions === 1);
  record('repeated start builds one graph only', nodeCount === 14);
  engine.destroy();
}

const saved = parseProject(readFileSync(join(artifactDir, 'project.json'), 'utf8'));
const restoredSnapshot = takeSnapshot(saved);
const originalSnapshot = JSON.parse(readFileSync(join(artifactDir, 'snapshot-before.json'), 'utf8'));
const wav = decodeWav(new Uint8Array(readFileSync(join(artifactDir, 'export', 'soundscape-20s.wav'))));
const snapshotDiff = diffSnapshots(originalSnapshot, restoredSnapshot);
report.snapshot = {
  differences: snapshotDiff,
  beatCountBefore: originalSnapshot.beats.length,
  beatCountAfter: restoredSnapshot.beats.length,
  firstBeats: beatTimes(saved).slice(0, 4),
  pans: restoredSnapshot.clips.map((clip) => clip.pan),
  gainsDb: restoredSnapshot.clips.map((clip) => clip.gainDb),
  automationPoints: restoredSnapshot.automation[0].points,
};
report.export = {
  frames: wav.length,
  durationSeconds: wav.length / wav.sampleRate,
  peak: peakAmplitude(wav.channels),
};
record('snapshot diff is empty', snapshotDiff.length === 0, snapshotDiff.join(','));
record('exported WAV duration equals timeline',
  wav.length === TIMELINE_SECONDS * wav.sampleRate, `${report.export.durationSeconds}s`);
record('exported WAV has no clipped samples', report.export.peak <= 0.95 + 1e-9);

writeFileSync(join(artifactDir, 'verification-report.json'), JSON.stringify(report, null, 2));
const failed = report.checks.filter((check) => !check.passed);
for (const check of report.checks) {
  console.log(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? ` (${check.detail})` : ''}`);
}
if (failed.length) process.exit(1);
console.log('\nartifacts/verification-report.json written');
