import { Framebuffer, Canvas2DAdapter } from "./framebuffer.js";
import { TileCache, NoticeBus } from "./tile-cache.js";
import { TimeScale, ZOOM_LEVELS } from "./time-scale.js";
import { WaveformRenderer, DEFAULT_THEME } from "./renderer.js";

/**
 * Single render path for both on-screen preview and file export.
 * The caller supplies a framebuffer + adapter; everything about how pixels
 * are produced is shared, so exported PNGs match the preview exactly.
 */
export function createSurface(width, height, background = DEFAULT_THEME.background) {
  const framebuffer = new Framebuffer(width, height, background);
  const ctx = new Canvas2DAdapter(framebuffer);
  return { framebuffer, ctx };
}

export function scaleFromProject(project, scrollSecOverride) {
  const zoom = ZOOM_LEVELS.find((level) => level.id === project.viewport.zoomId) || ZOOM_LEVELS[0];
  const scrollSec = scrollSecOverride ?? project.viewport.scrollSec ?? 0;
  return new TimeScale(project.canvas.width, zoom.pixelsPerSecond, scrollSec).clamped(
    project.audio.durationSec
  );
}

export function renderProject(pyramid, project, { cache, scale, surface } = {}) {
  const notices = cache?.notices ?? new NoticeBus();
  const tileCache =
    cache ||
    new TileCache(
      () => Promise.reject(new Error("No tile provider configured")),
      { notices }
    );
  const renderScale = scale || scaleFromProject(project);
  const { framebuffer, ctx } = surface || createSurface(project.canvas.width, project.canvas.height, project.theme.background);
  const renderer = new WaveformRenderer(pyramid, tileCache, project.theme);
  const metrics = { buckets: 0, fills: 0 };
  const visibleLayers = new Set(project.layers.filter((layer) => layer.visible).map((layer) => layer.id));
  const overlay = {
    playheadSec: visibleLayers.has("playhead") ? project.overlay.playheadSec : null,
    selection: visibleLayers.has("selection") ? project.overlay.selection : null
  };
  renderer.renderSync(ctx, framebuffer, renderScale, overlay, metrics);
  return { framebuffer, ctx, scale: renderScale, metrics, notices, renderer };
}

/**
 * Render keyframe markers on top of the composed scene using the same
 * coordinates stored in the document, so reload cannot drift them.
 */
export function renderKeyframes(framebuffer, project, scale) {
  for (const keyframe of project.keyframes) {
    const pixelX = Math.round(scale.timeToPixel(keyframe.timeSec));
    if (pixelX < 0 || pixelX >= framebuffer.width) continue;
    framebuffer.fillRect(pixelX - 2, keyframe.y - 2, 5, 5, keyframe.color);
  }
}
