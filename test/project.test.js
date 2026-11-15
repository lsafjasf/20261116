import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beatTimes,
  createDefaultProject,
  diffSnapshots,
  moveClip,
  parseProject,
  serializeProject,
  setAutomationPoints,
  setClipFade,
  setClipGain,
  setClipPan,
  takeSnapshot,
} from '../src/js/project.js';

test('default project contains three clips and two automation points', () => {
  const project = createDefaultProject();
  assert.equal(project.clips.length, 3);
  assert.equal(project.automation[0].points.length, 2);
  assert.ok(project.clips.every((clip) => clip.start + clip.duration <= 20));
});

test('clip movement, fades, gain and pan are clamped', () => {
  const project = createDefaultProject();
  moveClip(project, 'voice', 99);
  assert.equal(get(project, 'voice').start, 20 - get(project, 'voice').duration);
  moveClip(project, 'voice', -5);
  assert.equal(get(project, 'voice').start, 0);
  setClipFade(project, 'rain', 'fadeIn', 99);
  assert.ok(get(project, 'rain').fadeIn <= get(project, 'rain').duration / 2);
  setClipGain(project, 'rain', 100);
  assert.equal(get(project, 'rain').gainDb, 12);
  setClipPan(project, 'rain', -5);
  assert.equal(get(project, 'rain').pan, -1);
});

test('automation points are sorted and bounded', () => {
  const project = createDefaultProject();
  setAutomationPoints(project, 'rain', [
    { time: 18, value: -12 },
    { time: 1, value: 4 },
  ]);
  const points = project.automation[0].points;
  assert.deepEqual(points.map((p) => p.time), [1, 18]);
});

test('beat grid follows bpm inside the twenty-second window', () => {
  const project = createDefaultProject();
  const beats = beatTimes(project);
  assert.equal(beats[0], 0);
  assert.ok(beats.at(-1) <= 20 + 1e-9);
  assert.ok(Math.abs(beats[1] - 60 / project.bpm) < 1e-9);
  assert.equal(beats.length, 33);
});

test('serialize/parse round-trip preserves an identical snapshot', () => {
  const project = createDefaultProject();
  setClipGain(project, 'machine', -7.5);
  setClipPan(project, 'voice', 0.42);
  const before = takeSnapshot(project);
  const restored = parseProject(serializeProject(project));
  const after = takeSnapshot(restored);
  assert.deepEqual(diffSnapshots(before, after), []);
  assert.deepEqual(after.clips.find((c) => c.id === 'machine').gainDb, -7.5);
});

test('malformed project text is rejected', () => {
  assert.throws(() => parseProject('{"version":1,"clips":[]}'), /no clips/);
  assert.throws(() => parseProject('{"version":9,"clips":[]}'), /version/);
});

function get(project, id) {
  return project.clips.find((clip) => clip.id === id);
}
