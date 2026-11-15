import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIG, SortingSimulation, replayRecording } from '../src/sim.js';
import {
  createContaminationController,
  createFailureController,
  createSuccessController,
  runController,
} from '../scripts/controllers.js';

function buildSuccessRecording() {
  const sim = new SortingSimulation({
    seed: 20261116,
    runId: 'TEST-SUCCESS',
  });
  runController(sim, createSuccessController());
  return sim.recording();
}

function replayWithPattern(recording, pattern) {
  const sim = SortingSimulation.fromRecording(recording);
  let cursor = 0;
  while (sim.phase === 'running' && sim.time < recording.duration - 1e-7) {
    const chunk = pattern[cursor % pattern.length];
    cursor += 1;
    if (chunk === 'pause') continue;
    const steps = Number(chunk);
    for (let index = 0; index < steps && sim.phase === 'running'; index += 1) {
      sim.advanceTick();
    }
  }
  return sim;
}

test('actual two-sided success run completes all packages below threshold', () => {
  const recording = buildSuccessRecording();
  assert.equal(recording.phase, 'success');
  assert.equal(recording.success, true);
  assert.equal(recording.stats.packed, CONFIG.totalPackages);
  assert.equal(recording.stats.scanned, CONFIG.totalPackages);
  assert.equal(recording.stats.released, CONFIG.totalPackages);
  assert.equal(recording.stats.errors, 0);
  assert.ok(recording.duration < CONFIG.duration);
  assert.ok(recording.inputs.some((input) => input.side === 'p1'));
  assert.ok(recording.inputs.some((input) => input.side === 'p2'));
  assert.ok(
    recording.timeline.some(
      (entry) => entry.kind === 'line_stop' && entry.result?.safetyConfirmed
    ),
    'success run should demonstrate a safe cache-full line stop'
  );
  assert.ok(
    recording.timeline.some(
      (entry) =>
        entry.kind === 'overflow_clear' &&
        entry.at >= 357 &&
        entry.state?.durability?.p1 > 0
    ),
    'success run should recover from a full cache without chain damage'
  );
});

test('failure run proves three-step cache overflow chain and replay fidelity', () => {
  const sim = new SortingSimulation({
    seed: 20261117,
    runId: 'TEST-FAILURE',
  });
  runController(sim, createFailureController());
  assert.equal(sim.phase, 'failure');
  assert.equal(sim.failureReason, 'cache_overflow_chain');
  assert.equal(sim.stats.overflowHits, 3);
  assert.equal(sim.stats.stops, 0);

  const chain = sim.timeline.filter(
    (entry) => entry.kind === 'collision' && entry.collision === 'overflow_chain'
  );
  assert.equal(chain.length, 3);
  assert.deepEqual(
    chain.map((entry) => entry.result.overflowHits),
    [1, 2, 3]
  );
  assert.ok(chain[0].at < chain[1].at && chain[1].at < chain[2].at);
  for (const entry of chain) {
    assert.equal(entry.result.lane, 'A');
    assert.ok(Number.isFinite(entry.point.x));
    assert.ok(Number.isFinite(entry.point.y));
    assert.ok(entry.objects.some((object) => object.role === '阻塞包裹'));
  }
  assert.ok(
    sim.durability.p1 < 100 && sim.durability.p2 < 100,
    'chain reaction should damage both stations'
  );

  const recording = sim.recording();
  const replayed = replayRecording(recording);
  assert.equal(replayed.phase, 'failure');
  assert.equal(replayed.failureReason, 'cache_overflow_chain');
  assert.equal(replayed.digest(), recording.finalDigest);
});

test('pause, single-step and seek/continue produce the same final state', () => {
  const recording = buildSuccessRecording();
  const prerecorded = replayRecording(recording);
  assert.equal(prerecorded.digest(), recording.finalDigest);

  const stepped = replayWithPattern(recording, [1, 1, 'pause', 7, 1, 'pause', 19]);
  assert.equal(stepped.phase, 'success');
  assert.equal(stepped.time, prerecorded.time);
  assert.equal(stepped.digest(), recording.finalDigest);

  const pausedAt = 218.4;
  const seeked = SortingSimulation.fromRecording(recording);
  seeked.advanceTo(pausedAt);
  const pausedDigest = seeked.digest();
  seeked.advanceTo(pausedAt);
  assert.equal(seeked.digest(), pausedDigest, 'pause must not mutate state');
  seeked.advanceTo(recording.duration);
  assert.equal(seeked.digest(), recording.finalDigest);
});

test('opposite action order exposes exact execution time and object positions', () => {
  const sim = new SortingSimulation({ seed: 42, runId: 'TEST-CONFLICT' });
  runController(sim, createFailureController(), 30);
  sim.durability.p1 = 20;
  const p1Input = sim.press('p1', 'scan');
  sim.advanceTick();
  const p2Input = sim.press('p2', 'laneA');
  assert.ok(p1Input.effectiveAt > p2Input.effectiveAt);

  const conflicts = sim.timeline.filter((entry) => entry.kind === 'conflict');
  assert.ok(conflicts.length >= 1);
  const conflict = conflicts.at(-1);
  assert.equal(conflict.conflict, 'order_inversion');
  assert.equal(conflict.inputOrder[0].side, 'p1');
  assert.equal(conflict.executionOrder[0].side, 'p2');
  assert.equal(conflict.atExecution, p2Input.effectiveAt);
  assert.ok(conflict.objects.length >= 1);
  assert.ok(
    conflict.objects.every(
      (object) =>
        Number.isFinite(object.position.x) &&
        Number.isFinite(object.position.y) &&
        object.position.x >= 0
    )
  );
});

test('wrong routing contaminates subsequent downstream packing', () => {
  const sim = new SortingSimulation({
    seed: 20261117,
    runId: 'TEST-CONTAMINATION',
  });
  runController(sim, createContaminationController());
  const completions = sim.timeline.filter(
    (entry) => entry.kind === 'pack_complete'
  );
  const wrong = completions.find(
    (entry) => entry.result?.errorReason === 'wrong_lane'
  );
  const downstream = completions.find(
    (entry) => entry.result?.errorReason === 'downstream_contamination'
  );
  assert.ok(wrong, 'one deliberately wrong route must count as an error');
  assert.ok(downstream, 'the same lane must contaminate a later pack');
  assert.ok(downstream.at > wrong.at);
  assert.ok(downstream.result.contamination > 0);
});

test('serialized checkpoint restores gauges, durability, progress and timeline', () => {
  const sim = new SortingSimulation({ seed: 77, runId: 'TEST-RESTORE' });
  runController(sim, createSuccessController(), 185);
  const before = sim.snapshot();
  const restored = SortingSimulation.fromSnapshot(
    JSON.parse(JSON.stringify(before))
  );
  assert.equal(restored.digest(), sim.digest());
  assert.equal(restored.durability.p1, sim.durability.p1);
  assert.equal(restored.durability.p2, sim.durability.p2);
  assert.equal(restored.stats.packed, sim.stats.packed);
  assert.equal(restored.stats.scanned, sim.stats.scanned);
  assert.equal(restored.timeline.length, sim.timeline.length);
  assert.equal(restored.cacheLoad(), sim.cacheLoad());
});
