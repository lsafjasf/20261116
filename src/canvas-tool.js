// Browser glue: sizing, DPR tracking, unified pointer transform, HUD.
import { computeBackingSize, clientToCanvas, RectCache } from './coords.js';
import { makeNodes, NaiveHitTester, GridHitTester, Metrics } from './scene.js';

const NODE_COUNT = 400;
const USE_GRID = true; // "after" build; flip to false to reproduce "before".

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const logEl = document.getElementById('log');

const metrics = new Metrics();
const errors = [];
let nodes = [];
let tester = null;
let backing = { width: 1, height: 1, dpr: 1 };
let pointer = null; // canvas-local CSS px
let dragging = false;
let dprMedia = null;

const rectCache = new RectCache(() => canvas.getBoundingClientRect());

function logError(msg) {
  errors.push(msg);
  logEl.textContent = errors.join('\n');
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  backing = computeBackingSize(rect.width, rect.height, dpr);
  if (canvas.width !== backing.width) canvas.width = backing.width;
  if (canvas.height !== backing.height) canvas.height = backing.height;
  // Draw in CSS pixel space; the transform absorbs the DPR.
  ctx.setTransform(backing.dpr, 0, 0, backing.dpr, 0, 0);
  rectCache.invalidate();
  nodes = makeNodes(NODE_COUNT, rect.width, rect.height);
  tester = USE_GRID
    ? new GridHitTester(nodes, rect.width, rect.height)
    : new NaiveHitTester(nodes);
  metrics.nodeCount = nodes.length;
  watchDpr();
}

// Re-register after every change: zoom and monitor switches change DPR.
function watchDpr() {
  if (dprMedia) dprMedia.removeEventListener('change', resize);
  dprMedia = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  dprMedia.addEventListener('change', resize);
}

new ResizeObserver(resize).observe(canvas);
window.addEventListener('resize', resize);
document.addEventListener('fullscreenchange', resize);
window.addEventListener('scroll', () => rectCache.invalidate(), true);

// ONE transform for click, drag and hover.
function toCanvasPoint(e) {
  const rect = rectCache.get();
  return clientToCanvas(e.clientX, e.clientY, rect);
}

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
  pointer = toCanvasPoint(e);
});
canvas.addEventListener('pointermove', (e) => {
  pointer = toCanvasPoint(e); // hover and drag share this path
});
canvas.addEventListener('pointerup', () => {
  dragging = false;
});
canvas.addEventListener('pointerleave', () => {
  if (!dragging) pointer = null;
});

// Self-test: synthesize client coords for the four edge midpoints and the
// center, run them through the SAME transform as real events, and check the
// round trip lands within 0.5 CSS px. Draws the crosshair at each probe.
export function probePoints(rect) {
  return [
    { name: 'top', x: rect.width / 2, y: 0 },
    { name: 'right', x: rect.width, y: rect.height / 2 },
    { name: 'bottom', x: rect.width / 2, y: rect.height },
    { name: 'left', x: 0, y: rect.height / 2 },
    { name: 'center', x: rect.width / 2, y: rect.height / 2 },
  ];
}

function runSelfTest() {
  const rect = rectCache.get();
  const results = probePoints(rect).map((p) => {
    const clientX = rect.left + p.x;
    const clientY = rect.top + p.y;
    const local = clientToCanvas(clientX, clientY, rectCache.get());
    const dx = Math.abs(local.x - p.x);
    const dy = Math.abs(local.y - p.y);
    const hit = tester.hitTest(local.x, local.y);
    return { ...p, dx, dy, ok: dx <= 0.5 && dy <= 0.5, hit: hit ? hit.id : null };
  });
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) logError(`self-test failed: ${JSON.stringify(failed)}`);
  document.getElementById('selftest').textContent = results
    .map((r) => `${r.name}:${r.ok ? 'OK' : 'FAIL'} hit=${r.hit}`)
    .join('  ');
  // Flash the crosshair on each probe so the check is visible.
  results.forEach((r, i) => {
    setTimeout(() => {
      pointer = { x: r.x, y: r.y };
    }, i * 120);
  });
  setTimeout(() => {
    pointer = null;
  }, results.length * 120);
  return results;
}

document.getElementById('selftest-btn').addEventListener('click', runSelfTest);
document.getElementById('fullscreen-btn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});

resize();
runSelfTest();
requestAnimationFrame(draw);

function draw() {
  const t0 = performance.now();
  const w = backing.width / backing.dpr;
  const h = backing.height / backing.dpr;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#dfe8ff';
  for (const n of nodes) ctx.fillRect(n.x, n.y, n.w, n.h);
  if (pointer) {
    const hit = tester.hitTest(pointer.x, pointer.y);
    metrics.candidates = tester.lastCandidates;
    if (hit) {
      ctx.strokeStyle = '#e0245e';
      ctx.strokeRect(hit.x - 0.5, hit.y - 0.5, hit.w + 1, hit.h + 1);
    }
    drawCrosshair(pointer.x, pointer.y, hit ? '#e0245e' : '#1b6ef3');
  }
  metrics.cacheHitRate = rectCache.hitRate;
  metrics.recordFrame(performance.now() - t0);
  hud.textContent = JSON.stringify(metrics.snapshot());
  requestAnimationFrame(draw);
}

function drawCrosshair(x, y, color) {
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - 12, y);
  ctx.lineTo(x + 12, y);
  ctx.moveTo(x, y - 12);
  ctx.lineTo(x, y + 12);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.stroke();
}
