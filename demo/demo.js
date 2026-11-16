import {
  generateChunks,
  PeakPyramid,
  PyramidBuilder,
  TimeScale,
  ZOOM_LEVELS,
  WaveformRenderer,
  TileCache,
  NoticeBus,
  DEFAULT_THEME
} from "../src/index.js";

const canvas = document.getElementById("wave");
const ctx = canvas.getContext("2d");
const noticesEl = document.getElementById("notices");
const levelEl = document.getElementById("level");
const bucketsEl = document.getElementById("buckets");
const windowEl = document.getElementById("window");
const headEl = document.getElementById("head");

const sampleRate = 44100;
const durationSec = 600;
const builder = new PyramidBuilder(sampleRate);
await generateChunks({ sampleRate, durationSec, seed: "uid634-ten-minutes" }, async (chunk) =>
  builder.pushChunk(chunk)
);
const pyramid = builder.build();

const notices = new NoticeBus();
let failing = false;
const cache = new TileCache(
  async (levelIndex, tileIndex) => {
    if (failing) throw new Error(`tile ${levelIndex}/${tileIndex} unavailable`);
    return { levelIndex, tileIndex };
  },
  { notices }
);

const renderer = new WaveformRenderer(pyramid, cache, DEFAULT_THEME);
let scale = new TimeScale(canvas.width, ZOOM_LEVELS[0].pixelsPerSecond, 0);
let zoomIndex = 0;
const overlay = { playheadSec: 145, selection: { startSec: 130, endSec: 138 } };

function paint() {
  ctx.fillStyle = DEFAULT_THEME.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const metrics = { buckets: 0, fills: 0 };
  const chosen = pyramid.chooseLevel(scale.secondsPerPixel);
  const level = renderer.levelForViewport(scale, chosen, metrics);
  drawGrid(level);
  drawWave(level, metrics);
  drawOverlays();
  levelEl.textContent = String(level);
  bucketsEl.textContent = String(metrics.buckets);
  windowEl.textContent = `${scale.visibleStartSec.toFixed(1)}s – ${scale.visibleEndSec.toFixed(1)}s`;
  headEl.textContent = `${overlay.playheadSec.toFixed(2)}s`;
  noticesEl.textContent = notices.notices.length
    ? `⚠ ${notices.notices[notices.notices.length - 1].message}`
    : "所有瓦片正常";
}

function drawGrid() {
  ctx.fillStyle = DEFAULT_THEME.grid;
  const spacing = [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600].find((value) => value * scale.pixelsPerSecond >= 48) ?? 600;
  for (let time = Math.floor(scale.visibleStartSec / spacing) * spacing; time <= scale.visibleEndSec; time += spacing) {
    const x = Math.round(scale.timeToPixel(time));
    if (x >= 0 && x < canvas.width) ctx.fillRect(x, 0, 1, canvas.height);
  }
}

function drawWave(levelIndex, metrics) {
  const midY = canvas.height / 2;
  const query = pyramid.queryRange(levelIndex, scale.visibleStartSec, scale.visibleEndSec);
  const columns = new Map();
  for (const bucket of query.buckets) {
    const range = pyramid.bucketTimeRange(levelIndex, bucket.index);
    const x0 = Math.max(0, Math.floor(scale.timeToPixel(range.startSec)));
    const x1 = Math.min(canvas.width - 1, Math.ceil(scale.timeToPixel(range.endSec)) - 1);
    for (let x = x0; x <= x1; x += 1) {
      const current = columns.get(x);
      if (current) {
        current.min = Math.min(current.min, bucket.min);
        current.max = Math.max(current.max, bucket.max);
      } else {
        columns.set(x, { x, min: bucket.min, max: bucket.max });
      }
    }
  }
  ctx.fillStyle = DEFAULT_THEME.waveform;
  for (const column of columns.values()) {
    const top = Math.round(midY - column.max * (midY - 4));
    const bottom = Math.round(midY - column.min * (midY - 4));
    ctx.fillRect(column.x, top, 1, Math.max(1, bottom - top));
    metrics.buckets += 1;
  }
}

function drawOverlays() {
  ctx.fillStyle = DEFAULT_THEME.selection;
  const sx0 = Math.round(scale.timeToPixel(overlay.selection.startSec));
  const sx1 = Math.round(scale.timeToPixel(overlay.selection.endSec));
  ctx.fillRect(sx0, 0, 1, canvas.height);
  ctx.fillRect(sx1, 0, 1, canvas.height);
  ctx.fillStyle = DEFAULT_THEME.playhead;
  const hx = Math.round(scale.timeToPixel(overlay.playheadSec));
  if (hx >= 0 && hx < canvas.width) ctx.fillRect(hx, 0, 2, canvas.height);
}

document.querySelectorAll("button[data-zoom]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("button[data-zoom]").forEach((b) => b.classList.remove("active"));
    button.classList.add("active");
    zoomIndex = ZOOM_LEVELS.findIndex((level) => level.id === button.dataset.zoom);
    scale = scale.zoomAt(ZOOM_LEVELS[zoomIndex].pixelsPerSecond, canvas.width / 2, durationSec);
    paint();
  });
});

document.getElementById("fail-toggle").addEventListener("click", (event) => {
  failing = !failing;
  event.target.textContent = failing ? "恢复瓦片请求" : "模拟瓦片请求失效";
  cache.invalidateAll();
  paint();
});

document.getElementById("invalidate").addEventListener("click", () => {
  cache.invalidateAll();
  paint();
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const anchorX = event.clientX - rect.left;
  if (event.shiftKey) {
    scale = scale.panBy(event.deltaY, durationSec);
  } else {
    zoomIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, zoomIndex + (event.deltaY < 0 ? 1 : -1)));
    scale = scale.zoomAt(ZOOM_LEVELS[zoomIndex].pixelsPerSecond, anchorX, durationSec);
  }
  paint();
}, { passive: false });

let dragStart = null;
canvas.addEventListener("mousedown", (event) => {
  dragStart = { x: event.clientX, scroll: scale.scrollSec };
});
canvas.addEventListener("mousemove", (event) => {
  if (!dragStart) return;
  const deltaPixels = event.clientX - dragStart.x;
  scale = new TimeScale(canvas.width, scale.pixelsPerSecond, dragStart.scroll - deltaPixels / scale.pixelsPerSecond).clamped(durationSec);
  paint();
});
window.addEventListener("mouseup", () => {
  dragStart = null;
});

paint();
