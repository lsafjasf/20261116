import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_RATE, TIMELINE_SECONDS, peakAmplitude, rms } from '../src/js/util.js';
import { synthesizeAll } from '../src/js/synth.js';
import {
  createDefaultProject,
  diffSnapshots,
  parseProject,
  serializeProject,
  takeSnapshot,
} from '../src/js/project.js';
import { renderTimeline } from '../src/js/renderer.js';
import { decodeWav, encodeWav } from '../src/js/wav.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = join(root, 'artifacts');
const exportDir = join(artifactDir, 'export');
mkdirSync(exportDir, { recursive: true });

const sources = synthesizeAll();
const project = createDefaultProject();

function writeArtifact(name, data) {
  const path = join(artifactDir, name);
  writeFileSync(path, data);
  return path;
}

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, passed: Boolean(condition), detail });
}

const render = renderTimeline(project, sources);
const wavBytes = encodeWav(render.channels, SAMPLE_RATE);
const wavPath = join(exportDir, 'soundscape-20s.wav');
writeFileSync(wavPath, wavBytes);

const projectPath = writeArtifact('project.json', serializeProject(project));
const snapshotBefore = takeSnapshot(project);
const snapshotPath = writeArtifact('snapshot-before.json', JSON.stringify(snapshotBefore, null, 2));

const reloadedProject = parseProject(readFileSync(projectPath, 'utf8'));
const snapshotAfter = takeSnapshot(reloadedProject);
const restoredWav = decodeWav(new Uint8Array(readFileSync(wavPath)));
const reRender = renderTimeline(reloadedProject, synthesizeAll());

check('snapshot restore matches', diffSnapshots(snapshotBefore, snapshotAfter).length === 0,
  diffSnapshots(snapshotBefore, snapshotAfter).join(','));
check('beat count stable', snapshotBefore.beats.length === snapshotAfter.beats.length,
  `${snapshotBefore.beats.length} vs ${snapshotAfter.beats.length}`);
check('pan values stable',
  JSON.stringify(snapshotBefore.clips.map((c) => c.pan)) ===
  JSON.stringify(snapshotAfter.clips.map((c) => c.pan)));
check('gain values stable',
  JSON.stringify(snapshotBefore.clips.map((c) => c.gainDb)) ===
  JSON.stringify(snapshotAfter.clips.map((c) => c.gainDb)));
check('export duration is twenty seconds',
  restoredWav.length === TIMELINE_SECONDS * SAMPLE_RATE,
  `${restoredWav.length} frames`);
check('reloaded timeline re-renders identical audio',
  Math.abs(peakAmplitude([render.channels[0].map((v, i) => v - reRender.channels[0][i])])) < 1e-12);
check('export never clips', peakAmplitude(restoredWav.channels) <= 0.95 + 1e-9,
  `peak=${peakAmplitude(restoredWav.channels).toFixed(4)}`);

const report = {
  generatedAt: new Date().toISOString(),
  timelineSeconds: TIMELINE_SECONDS,
  sampleRate: SAMPLE_RATE,
  clips: snapshotBefore.clips,
  automation: snapshotBefore.automation,
  beats: snapshotBefore.beats,
  export: {
    file: 'artifacts/export/soundscape-20s.wav',
    bytes: wavBytes.length,
    frames: restoredWav.length,
    durationSeconds: restoredWav.length / restoredWav.sampleRate,
    preLimiterPeak: render.prePeak,
    postLimiterPeak: render.postPeak,
    limiterScale: render.limiterScale,
    rms: rms(restoredWav.channels),
  },
  checks,
};
writeArtifact('build-report.json', JSON.stringify(report, null, 2));

const failed = checks.filter((entry) => !entry.passed);
for (const entry of checks) {
  console.log(`${entry.passed ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`);
}
if (failed.length) {
  console.error(`\n${failed.length} verification check(s) failed`);
  process.exit(1);
}
console.log(`\nWrote ${wavPath} (${wavBytes.length} bytes)`);
console.log(`Wrote ${projectPath} and ${snapshotPath}`);
