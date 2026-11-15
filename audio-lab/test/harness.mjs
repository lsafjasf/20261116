import assert from 'node:assert/strict';
import { MockAudioContext } from './mockAudio.mjs';
import { ResourceManager, NaiveResourceManager } from '../src/resourceManager.mjs';
import { SceneConfigCache, SCENE_LIBRARY, BOUNDARY_LIBRARY } from '../src/sceneConfig.mjs';
import { SceneController } from '../src/sceneController.mjs';
import { runScenario, compareReports } from '../src/runner.mjs';

const ITERATIONS = 20;

function buildHarness(mode, library, cacheCapacity = 5) {
  const context = new MockAudioContext();
  const violations = [];
  const manager = mode === 'managed'
    ? new ResourceManager(context, {
      onViolation: (event) => violations.push(event),
    })
    : new NaiveResourceManager(context, {
      onViolation: (event) => violations.push(event),
    });
  const cache = new SceneConfigCache(cacheCapacity);
  const controller = new SceneController(context, manager, cache);
  return { context, manager, cache, controller, violations };
}

async function run(mode, library, label, capacity = 5) {
  const harness = buildHarness(mode, library, capacity);
  const report = await runScenario({
    ...harness,
    library,
    iterations: ITERATIONS,
    label,
    flush: async () => harness.context.flushEndedEvents(),
  });
  return { ...harness, report };
}

async function main() {
  const results = {};

  // Fixed scenario 1: pre-optimization behavior (naive, leaks on every switch).
  results.before = await run('naive', SCENE_LIBRARY, 'before');
  // Fixed scenario 2: optimized behavior (centralized manager, full cleanup).
  results.after = await run('managed', SCENE_LIBRARY, 'after');
  // Fixed scenario 3: boundary parameters under the optimized path.
  results.boundary = await run('managed', BOUNDARY_LIBRARY, 'boundary', 2);

  assertNodeGrowth(results);
  assertCallbackGuard();
  assertOutputSemantics(results);
  assertBoundaryTolerance(results);
  assertMetrics(results);
  printReport(results);
}

function assertNodeGrowth(results) {
  const before = results.before.report;
  const after = results.after.report;

  // Naive path: nodes keep growing across all 20 switches.
  assert.ok(before.nodeSeries[before.nodeSeries.length - 1] > before.nodeSeries[0],
    'naive nodes must grow');
  assert.ok(before.tailNodes[0] > 40 && before.tailNodes[4] > before.tailNodes[0],
    'naive tail must stay high and keep growing');

  // Managed path: scenes differ in voice count, so compare full cycles.
  // The node-count series must repeat exactly every library cycle instead of
  // drifting upward, which is the "no sustained growth after 20 switches" rule.
  const steady = after.nodeSeries.slice(0, ITERATIONS);
  const cycle = SCENE_LIBRARY.length;
  for (let index = cycle; index < steady.length; index += 1) {
    assert.equal(steady[index], steady[index - cycle],
      `node count at switch ${index + 1} must match the previous cycle`);
  }
  assert.equal(after.nodeSeries[ITERATIONS], 0,
    'idle snapshot after final teardown must be zero');
  assert.ok(after.summary.peakActiveNodes
    <= 3 * Math.max(...SCENE_LIBRARY.map((s) => s.voices)) + 2,
    'managed peak must stay within the per-scene upper bound');
  assert.ok(after.summary.totalReleases >= ITERATIONS * 7,
    'managed path must release every constructed node');
  assert.equal(after.summary.totalReleases, after.summary.totalCandidates,
    'every candidate node must actually be released');
  assert.equal(after.summary.lastConnections, 0,
    'no connections may remain after the final exit');
  assert.equal(after.summary.lastListeners, 0,
    'no listeners may remain after the final exit');

  console.log('PASS 20-switch node growth: naive grows, managed stays flat');
}

async function assertCallbackGuard() {
  const context = new MockAudioContext();
  const violations = [];
  const manager = new ResourceManager(context, {
    onViolation: (event) => violations.push(event),
  });
  const cache = new SceneConfigCache(5);
  const controller = new SceneController(context, manager, cache);

  controller.enterScene(SCENE_LIBRARY[0]);
  const oscillators = [...manager._records.values()]
    .filter((record) => record.label === 'oscillator')
    .map((record) => record.node);
  controller.exitScene();

  // Even if the platform delivers a late 'ended' event after teardown, the
  // guarded handler stays attached but must short-circuit and be reported.
  for (const osc of oscillators) {
    osc.dispatchEvent({ type: 'ended', target: osc });
  }
  context.flushEndedEvents();

  assert.ok(manager.stats.suppressedCallbacks >= oscillators.length,
    'every post-release callback must be suppressed and counted');
  assert.equal(controller.handlerFired, 0, 'scene handler must never fire after release');
  assert.ok(violations.some((event) => event.kind === 'callback-after-release'),
    'violation must be reported to the observability sink');
  console.log('PASS destroyed nodes cannot trigger callbacks');
}

function assertOutputSemantics(results) {
  const comparison = compareReports(results.before.report, results.after.report);
  assert.equal(comparison.sameFingerprints, true,
    'optimized output fingerprint must match the naive baseline exactly');
  assert.equal(results.before.report.fingerprintStable, true);
  assert.equal(results.after.report.fingerprintStable, true);
  assert.deepEqual(results.before.report.uniqueFingerprints,
    results.after.report.uniqueFingerprints);
  console.log('PASS output semantics identical before/after (fingerprint + per-scene stability)');
}

function assertBoundaryTolerance(results) {
  const boundary = results.boundary.report;
  assert.equal(boundary.summary.errorCount, 0, 'boundary inputs must not throw');
  assert.equal(boundary.summary.lastActiveNodes, 0, 'boundary run must fully clean up');
  assert.equal(boundary.summary.lastConnections, 0);
  assert.ok(boundary.summary.peakActiveNodes <= 40,
    'heavy scene (12 voices) stays within bounded node count');
  const zeroVoice = boundary.fingerprints
    .filter((value) => value.startsWith('zero-voices'));
  assert.ok(zeroVoice.every((value) => value.includes('#0[')),
    'zero-voice scene renders an empty voice list deterministically');
  const normalized = boundary.fingerprints
    .filter((value) => value.startsWith('null-type'));
  assert.ok(normalized.every((value) => value.includes('sine:440')),
    'invalid config must be normalized to safe defaults');
  console.log('PASS boundary parameters handled without leaks or exceptions');
}

function assertMetrics(results) {
  for (const [key, result] of Object.entries(results)) {
    const summary = result.report.summary;
    for (const field of ['activeNodes', 'activeConnections', 'frameLastMs',
      'cacheHitRate', 'heapBytes']) {
      assert.ok(field in result.report.snapshots[0], `${key} missing metric ${field}`);
    }
    assert.ok(summary.avgFrameMs >= 0);
    assert.ok(summary.finalCacheHitRate >= 0 && summary.finalCacheHitRate <= 1);
  }
  // LRU with capacity 2 over a 3-scene cycle cannot reach full hit rate.
  assert.ok(results.boundary.report.summary.finalCacheHitRate < 1);
  console.log('PASS at least three observability metrics captured per snapshot');
}

function printReport(results) {
  console.log('\n================ fixed scenario comparison ================');
  for (const [key, result] of Object.entries(results)) {
    const { summary, headNodes, tailNodes, errors, heapSeries } = result.report;
    console.log(`\n[${key}]`);
    console.log('  head nodes      :', headNodes.join(', '));
    console.log('  tail nodes      :', tailNodes.join(', '));
    console.log('  peak/last nodes :', summary.peakActiveNodes, '/', summary.lastActiveNodes);
    console.log('  connections     :', summary.firstConnections, '->', summary.lastConnections);
    console.log('  releases        :', summary.totalReleases);
    console.log('  candidates      :', summary.totalCandidates);
    console.log('  cache hit rate  :', `${(summary.finalCacheHitRate * 100).toFixed(1)}%`);
    console.log('  frame avg/max ms:', summary.avgFrameMs.toFixed(4), '/', summary.maxFrameMs.toFixed(4));
    console.log('  heap first/last :', fmtBytes(summary.firstHeapBytes), '->',
      fmtBytes(summary.lastHeapBytes), 'peak', fmtBytes(summary.peakHeapBytes));
    console.log('  heap trend (B)  :', compactSeries(heapSeries));
    console.log('  errors          :', errors.length);
  }
  const comparison = compareReports(results.before.report, results.after.report);
  console.log('\n[before -> after diff]');
  console.log('  same fingerprints :', comparison.sameFingerprints);
  console.log('  last-node delta   :', comparison.nodeDelta);
  console.log('  release delta     :', comparison.releaseDelta);
  console.log('  frame avg delta ms:', comparison.frameAvgDeltaMs.toFixed(4));
  console.log('  heap delta        :', fmtBytes(comparison.heapDeltaBytes));
  console.log('\nALL HARNESS ASSERTIONS PASSED');
}

function fmtBytes(value) {
  if (!value) return 'n/a';
  return `${(value / 1024).toFixed(1)} KiB`;
}

function compactSeries(series) {
  const kept = series.filter((_, index) => index % 4 === 0 || index === series.length - 1);
  return kept.map((value) => value ? Math.round(value / 1024) + 'K' : 'n/a').join(' -> ');
}

main().catch((error) => {
  console.error('HARNESS FAILED:', error);
  process.exit(1);
});
