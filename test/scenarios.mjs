// Fixed-scenario verification: before / after / boundary.
// Proves the optimization changed only performance & error handling,
// never visual, interaction, or public data semantics.
import {
  computeBackingSize,
  clientToCanvas,
  canvasToDevice,
  RectCache,
} from '../src/coords.js';
import {
  makeNodes,
  NaiveHitTester,
  GridHitTester,
  Metrics,
} from '../src/scene.js';

const CSS_W = 1280;
const CSS_H = 800;
const NODE_COUNT = 400;
const EVENTS = 5000;

// Deterministic pseudo-random event stream (same for every scenario).
function makeEventStream(count, w, h) {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const rect = { left: 13.5, top: 7.25, width: w, height: h };
  const events = [];
  for (let i = 0; i < count; i += 1) {
    const type = i % 3 === 0 ? 'down' : i % 3 === 1 ? 'move' : 'hover';
    events.push({
      type,
      clientX: rect.left + rand() * w,
      clientY: rect.top + rand() * h,
    });
  }
  return { rect, events };
}

// Runs one event stream through a tester; `useCache` toggles RectCache.
function runStream({ tester, rect, events, useCache }) {
  const cache = new RectCache(() => rect);
  const metrics = new Metrics();
  metrics.nodeCount = tester.nodes.length;
  const hits = [];
  const mem0 = process.memoryUsage().heapUsed;
  for (const e of events) {
    const t0 = performance.now();
    if (!useCache) cache.invalidate(); // "before": fresh read every event
    const p = clientToCanvas(e.clientX, e.clientY, cache.get());
    const hit = tester.hitTest(p.x, p.y);
    metrics.candidates += tester.lastCandidates;
    metrics.recordFrame(performance.now() - t0);
    hits.push(hit ? hit.id : null);
  }
  metrics.cacheHitRate = cache.hitRate;
  return {
    hits,
    metrics: metrics.snapshot(),
    heapDelta: process.memoryUsage().heapUsed - mem0,
  };
}

function probeRoundTrip(rect, label, errors) {
  const probes = [
    ['top', rect.width / 2, 0],
    ['right', rect.width, rect.height / 2],
    ['bottom', rect.width / 2, rect.height],
    ['left', 0, rect.height / 2],
    ['center', rect.width / 2, rect.height / 2],
  ];
  const out = [];
  for (const [name, x, y] of probes) {
    const local = clientToCanvas(rect.left + x, rect.top + y, rect);
    const ok = Math.abs(local.x - x) <= 1e-9 && Math.abs(local.y - y) <= 1e-9;
    if (!ok) errors.push(`${label}:${name} round-trip drift`);
    out.push({ name, ok });
  }
  return out;
}

const results = {};
const errors = [];

// ---- Scenario 1: BEFORE (naive scan, no rect cache) ----
{
  const { rect, events } = makeEventStream(EVENTS, CSS_W, CSS_H);
  const nodes = makeNodes(NODE_COUNT, CSS_W, CSS_H);
  const tester = new NaiveHitTester(nodes);
  results.before = runStream({ tester, rect, events, useCache: false });
  results.before.probes = probeRoundTrip(rect, 'before', errors);
}

// ---- Scenario 2: AFTER (grid index + rect cache), same stream ----
{
  const { rect, events } = makeEventStream(EVENTS, CSS_W, CSS_H);
  const nodes = makeNodes(NODE_COUNT, CSS_W, CSS_H);
  const tester = new GridHitTester(nodes, CSS_W, CSS_H);
  results.after = runStream({ tester, rect, events, useCache: true });
  results.after.probes = probeRoundTrip(rect, 'after', errors);
}

// ---- Scenario 3: BOUNDARY (fractional CSS size, DPR 3.5, tiny canvas,
//      mid-stream monitor switch 1x->2x, fullscreen, zoom 1.25x) ----
{
  const boundary = { probes: [], backing: [], transitions: [] };
  const cases = [
    { label: 'fractional-dpr3.5', w: 1023.5, h: 701.25, dpr: 3.5 },
    { label: 'tiny-1x1', w: 1, h: 1, dpr: 2 },
    { label: 'zoom-1.25', w: 960.75, h: 540.5, dpr: 1.25 },
  ];
  for (const c of cases) {
    const rect = { left: 0.5, top: 0.5, width: c.w, height: c.h };
    const b = computeBackingSize(c.w, c.h, c.dpr);
    if (!Number.isInteger(b.width) || !Number.isInteger(b.height)) {
      errors.push(`${c.label}: non-integer backing store`);
    }
    if (b.width < 1 || b.height < 1) errors.push(`${c.label}: empty backing`);
    boundary.backing.push({ label: c.label, ...b });
    boundary.probes.push(...probeRoundTrip(rect, c.label, errors));
    // device-space edges must map inside the backing store
    const dev = canvasToDevice(c.w, c.h, c.dpr);
    if (Math.round(dev.x) > b.width || Math.round(dev.y) > b.height) {
      errors.push(`${c.label}: device edge exceeds backing store`);
    }
  }
  // Monitor switch + fullscreen: same logical point, rect/dpr change
  // mid-stream; the transform must stay consistent after invalidation.
  const cache = new RectCache(() => currentRect);
  let currentRect = { left: 0, top: 0, width: 1280, height: 800 };
  let dpr = 1;
  const localBefore = clientToCanvas(640, 400, cache.get());
  // move to a 2x monitor: window lands at new offset, DPR doubles
  currentRect = { left: 2560.5, top: 100.25, width: 1280, height: 800 };
  dpr = 2;
  cache.invalidate(); // resize/monitor-change handler does this
  const backingAfter = computeBackingSize(currentRect.width, currentRect.height, dpr);
  const localAfter = clientToCanvas(2560.5 + 640, 100.25 + 400, cache.get());
  if (localBefore.x !== localAfter.x || localBefore.y !== localAfter.y) {
    errors.push('monitor-switch: local coords changed for same logical point');
  }
  if (backingAfter.width !== 2560) errors.push('monitor-switch: backing not 2x');
  // fullscreen toggle: CSS size changes, same transform path
  currentRect = { left: 0, top: 0, width: 1920, height: 1080 };
  cache.invalidate();
  const fs = clientToCanvas(960, 540, cache.get());
  if (fs.x !== 960 || fs.y !== 540) errors.push('fullscreen: center drift');
  boundary.transitions.push({ localBefore, localAfter, fullscreenCenter: fs });
  results.boundary = boundary;
}

// ---- Cross-scenario assertions: semantics unchanged ----
const a = results.before.hits;
const b = results.after.hits;
if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
  errors.push('SEMANTIC CHANGE: hit results differ between before/after');
}
const probeDiff =
  JSON.stringify(results.before.probes) !== JSON.stringify(results.after.probes);
if (probeDiff) errors.push('SEMANTIC CHANGE: probe results differ');

const report = {
  scenarios: {
    before: { metrics: results.before.metrics, heapDelta: results.before.heapDelta },
    after: { metrics: results.after.metrics, heapDelta: results.after.heapDelta },
    boundary: results.boundary,
  },
  semanticsUnchanged: a.every((v, i) => v === b[i]) && !probeDiff,
  errors,
};
console.log(JSON.stringify(report, null, 2));
if (errors.length > 0) process.exit(1);
