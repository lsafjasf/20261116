import { TimeScale } from "./time-scale.js";
import { TILE_STATE } from "./tile-cache.js";

export const DEFAULT_THEME = Object.freeze({
  background: "#0b1020",
  waveform: "#38bdf8",
  centerLine: "#1e293b",
  grid: "#1e293b",
  gridLabel: "#94a3b8",
  playhead: "#f472b6",
  selection: "#facc15",
  selectionFill: "#facc15"
});

const TILE_SECONDS = 5;

/**
 * Renders the waveform overview plus aligned overlays.
 * Draw work is O(viewport width), never O(sample count): the pyramid level
 * is chosen so each pixel maps to at most one min/max bucket.
 */
export class WaveformRenderer {
  constructor(pyramid, cache, theme = DEFAULT_THEME) {
    this.pyramid = pyramid;
    this.cache = cache;
    this.theme = theme;
    this.lastRender = null;
  }

  /** Render synchronously from pyramid data (no async dependency). */
  renderSync(ctx, framebuffer, scale, overlay = {}, metrics = { buckets: 0, fills: 0 }) {
    framebuffer.clear(this.theme.background);
    this.drawGrid(ctx, framebuffer, scale);
    this.drawCenterLine(ctx, framebuffer);
    const chosenLevel = this.pyramid.chooseLevel(scale.secondsPerPixel);
    const level = this.levelForViewport(scale, chosenLevel, metrics);
    this.drawWaveform(ctx, framebuffer, scale, level, metrics);
    this.drawSelection(ctx, framebuffer, scale, overlay);
    this.drawPlayhead(ctx, framebuffer, scale, overlay);
    this.lastRender = { scale: cloneScale(scale), level };
    return framebuffer;
  }

  levelForViewport(scale, preferredLevel, metrics) {
    let level = preferredLevel;
    const startTile = Math.floor(scale.visibleStartSec / TILE_SECONDS);
    const endTile = Math.floor(scale.visibleEndSec / TILE_SECONDS);
    for (let tileIndex = startTile; tileIndex <= endTile; tileIndex += 1) {
      const entry = this.cache.get(level, tileIndex);
      if (entry && entry.state === TILE_STATE.FAILED) {
        level = Math.min(level + 1, this.pyramid.levelCount - 1);
        this.cache.metrics.fallbacks += 1;
        break;
      }
    }
    if (level !== preferredLevel) {
      this.cache.notices.info("FALLBACK_LEVEL", "Coarser detail shown for failed tile region", { level });
    }
    metrics.level = level;
    return level;
  }

  drawWaveform(ctx, framebuffer, scale, levelIndex, metrics) {
    const midY = framebuffer.height / 2;
    const query = this.pyramid.queryRange(levelIndex, scale.visibleStartSec, scale.visibleEndSec);
    const columns = aggregateToPixelColumns(query.buckets, this.pyramid, scale, levelIndex, framebuffer.width);
    for (const column of columns) {
      const topY = Math.round(midY - column.max * (midY - 4));
      const bottomY = Math.round(midY - column.min * (midY - 4));
      ctx.fillStyle = this.theme.waveform;
      ctx.fillRect(column.pixelX, topY, 1, Math.max(1, bottomY - topY));
      metrics.buckets += 1;
    }
    metrics.fills = ctx.drawStats.fills;
  }

  drawGrid(ctx, framebuffer, scale) {
    const spacing = chooseGridSpacing(scale.pixelsPerSecond);
    const firstTime = Math.floor(scale.visibleStartSec / spacing) * spacing;
    for (let timeSec = firstTime; timeSec <= scale.visibleEndSec; timeSec += spacing) {
      const pixelX = Math.round(scale.timeToPixel(timeSec));
      if (pixelX < 0 || pixelX >= framebuffer.width) continue;
      ctx.fillStyle = this.theme.grid;
      ctx.fillRect(pixelX, 0, 1, framebuffer.height);
    }
  }

  drawCenterLine(ctx, framebuffer) {
    const midY = Math.round(framebuffer.height / 2);
    ctx.fillStyle = this.theme.centerLine;
    ctx.fillRect(0, midY, framebuffer.width, 1);
  }

  drawSelection(ctx, framebuffer, scale, overlay) {
    if (!overlay.selection) return;
    const { startSec, endSec } = overlay.selection;
    const x0 = Math.round(scale.timeToPixel(startSec));
    const x1 = Math.round(scale.timeToPixel(endSec));
    if (x1 <= 0 || x0 >= framebuffer.width) return;
    for (let pixelX = Math.max(0, x0); pixelX < Math.min(framebuffer.width, x1); pixelX += 1) {
      framebuffer.setPixel(pixelX, 0, withAlpha(this.theme.selectionFill, 45));
      framebuffer.setPixel(pixelX, framebuffer.height - 1, this.theme.selection);
    }
    ctx.fillStyle = this.theme.selection;
    ctx.fillRect(Math.max(0, x0), 0, 1, framebuffer.height);
    ctx.fillRect(Math.min(framebuffer.width - 1, x1), 0, 1, framebuffer.height);
  }

  drawPlayhead(ctx, framebuffer, scale, overlay) {
    if (overlay.playheadSec === undefined || overlay.playheadSec === null) return;
    const pixelX = Math.round(scale.timeToPixel(overlay.playheadSec));
    if (pixelX < 0 || pixelX >= framebuffer.width) return;
    ctx.fillStyle = this.theme.playhead;
    ctx.fillRect(pixelX, 0, 1, framebuffer.height);
  }

  /** Kick off async tile requests for the visible time window. */
  async prefetch(scale) {
    const level = this.pyramid.chooseLevel(scale.secondsPerPixel);
    const startTile = Math.floor(scale.visibleStartSec / TILE_SECONDS);
    const endTile = Math.floor(scale.visibleEndSec / TILE_SECONDS);
    const requests = [];
    for (let tileIndex = startTile; tileIndex <= endTile; tileIndex += 1) {
      requests.push(this.cache.request(level, tileIndex));
    }
    return Promise.all(requests);
  }
}

function chooseGridSpacing(pixelsPerSecond) {
  const candidates = [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600];
  for (const spacing of candidates) {
    if (spacing * pixelsPerSecond >= 48) return spacing;
  }
  return 600;
}

function withAlpha(color, alpha) {
  const hex = color.replace("#", "");
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
    alpha
  ];
}

function cloneScale(scale) {
  return new TimeScale(scale.width, scale.pixelsPerSecond, scale.scrollSec);
}

/**
 * Collapse buckets into one min/max aggregate per device-pixel column.
 * Multiple sub-pixel buckets merge (detail never overdraws a column), and a
 * bucket wider than a pixel still lands in a single column, so draw calls are
 * bounded by the viewport width regardless of audio length or zoom.
 */
function aggregateToPixelColumns(buckets, pyramid, scale, levelIndex, viewportWidth) {
  const columns = new Map();
  for (const bucket of buckets) {
    const range = pyramid.bucketTimeRange(levelIndex, bucket.index);
    const x0 = Math.max(0, Math.floor(scale.timeToPixel(range.startSec)));
    const x1 = Math.min(viewportWidth - 1, Math.ceil(scale.timeToPixel(range.endSec)) - 1);
    for (let pixelX = Math.max(0, x0); pixelX <= x1; pixelX += 1) {
      const existing = columns.get(pixelX);
      if (existing) {
        existing.min = Math.min(existing.min, bucket.min);
        existing.max = Math.max(existing.max, bucket.max);
      } else {
        columns.set(pixelX, { pixelX, min: bucket.min, max: bucket.max });
      }
    }
  }
  return [...columns.values()].sort((a, b) => a.pixelX - b.pixelX);
}
