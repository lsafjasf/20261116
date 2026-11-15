import { MetricsCollector } from './metrics.mjs';

// Drives N deterministic scene switches and records head/tail snapshots,
// memory trend and a stable output fingerprint for each fixed scenario.
export async function runScenario({
  context,
  controller,
  manager,
  cache,
  library,
  iterations = 20,
  label = 'scenario',
  flush = async () => {},
  measureHeap = null,
}) {
  const metrics = new MetricsCollector();
  const fingerprints = [];
  const errorSink = (entry) => metrics.recordError(entry);
  controller.onError = errorSink;

  // Warm up the config cache once; measured iterations are all subsequent.
  const warm = library[0];
  controller.enterScene(warm);
  await flush();
  controller.exitScene();
  await flush();

  for (let index = 0; index < iterations; index += 1) {
    const config = library[index % library.length];
    const manifest = await controller.switchTo(config);
    await flush();
    fingerprints.push(fingerprint(manifest));
    if (measureHeap) await measureHeap();
    metrics.snapshot(`${label}#${index + 1}`, manager, controller, cache, {
      iteration: index + 1,
      scene: config.id,
    });
  }

  controller.exitScene();
  await flush();
  metrics.snapshot(`${label}:tail`, manager, controller, cache, {
    iteration: iterations,
    scene: 'idle',
  });

  return buildReport(label, metrics, fingerprints, library.length);
}

function fingerprint(manifest) {
  const voices = manifest.voices
    .map((voice) => `${voice.oscType}:${round(voice.freq)}:${round(voice.gain)}:${round(voice.delay)}`)
    .join('|');
  return `${manifest.id}#${manifest.voices.length}[${voices}]`;
}

function round(value) {
  return Math.round(value * 100000) / 100000;
}

function buildReport(label, metrics, fingerprints, cycleLength) {
  const summary = metrics.summarize();
  const unique = new Set(fingerprints);
  const nodeSeries = metrics.snapshots.map((point) => point.activeNodes);
  const head = nodeSeries.slice(0, 5);
  const tail = nodeSeries.slice(-5);
  const heapSeries = metrics.snapshots.map((point) => point.heapBytes);
  return {
    label,
    summary,
    headNodes: head,
    tailNodes: tail,
    nodeSeries,
    heapSeries,
    fingerprints,
    uniqueFingerprints: [...unique],
    fingerprintStable: samePerScene(fingerprints, cycleLength),
    errors: metrics.errors,
    snapshots: metrics.snapshots,
  };
}

// A 5-scene cycle must produce the same fingerprint on every cycle.
function samePerScene(fingerprints, cycleLength) {
  for (let index = cycleLength; index < fingerprints.length; index += 1) {
    if (fingerprints[index] !== fingerprints[index - cycleLength]) return false;
  }
  return true;
}

export function compareReports(reference, candidate) {
  return {
    sameFingerprints: JSON.stringify(reference.fingerprints)
      === JSON.stringify(candidate.fingerprints),
    referenceErrors: reference.errors.length,
    candidateErrors: candidate.errors.length,
    nodeDelta: candidate.summary.lastActiveNodes - reference.summary.lastActiveNodes,
    releaseDelta: candidate.summary.totalReleases - reference.summary.totalReleases,
    heapDeltaBytes: candidate.summary.lastHeapBytes - reference.summary.lastHeapBytes,
    frameAvgDeltaMs: candidate.summary.avgFrameMs - reference.summary.avgFrameMs,
  };
}
