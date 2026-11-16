/**
 * Pure time <-> pixel mapping shared by the renderer, overlay (playhead and
 * selection) and exporter. Using one mapping everywhere is what keeps the
 * waveform, playhead and selection perfectly aligned.
 */

export class TimeScale {
  /**
   * @param {number} width viewport width in device pixels
   * @param {number} pixelsPerSecond zoom factor
   * @param {number} scrollSec time shown at the left edge
   */
  constructor(width, pixelsPerSecond, scrollSec = 0) {
    if (width <= 0 || !Number.isFinite(width)) throw new Error("width must be positive");
    if (pixelsPerSecond <= 0 || !Number.isFinite(pixelsPerSecond)) {
      throw new Error("pixelsPerSecond must be positive");
    }
    this.width = width;
    this.pixelsPerSecond = pixelsPerSecond;
    this.scrollSec = Math.max(0, scrollSec);
  }

  timeToPixel(timeSec) {
    return (timeSec - this.scrollSec) * this.pixelsPerSecond;
  }

  pixelToTime(pixelX) {
    return this.scrollSec + pixelX / this.pixelsPerSecond;
  }

  get visibleStartSec() {
    return this.scrollSec;
  }

  get visibleEndSec() {
    return this.scrollSec + this.width / this.pixelsPerSecond;
  }

  get secondsPerPixel() {
    return 1 / this.pixelsPerSecond;
  }

  /** Clamp scrolling so the viewport never runs past the end of the audio. */
  clamped(durationSec) {
    const maxScroll = Math.max(0, durationSec - this.width / this.pixelsPerSecond);
    return new TimeScale(this.width, this.pixelsPerSecond, Math.min(this.scrollSec, maxScroll));
  }

  /**
   * Zoom while keeping the time under `anchorPixelX` fixed on screen.
   * This guarantees scroll consistency: zooming in/out never jumps content.
   */
  zoomAt(newPixelsPerSecond, anchorPixelX, durationSec) {
    if (newPixelsPerSecond <= 0 || !Number.isFinite(newPixelsPerSecond)) {
      throw new Error("newPixelsPerSecond must be positive");
    }
    const anchorTime = this.pixelToTime(anchorPixelX);
    const nextScroll = anchorTime - anchorPixelX / newPixelsPerSecond;
    return new TimeScale(this.width, newPixelsPerSecond, nextScroll).clamped(durationSec);
  }

  /** Pan by a pixel delta, keeping content anchored to the cursor. */
  panBy(pixelDelta, durationSec) {
    const nextScroll = this.scrollSec - pixelDelta / this.pixelsPerSecond;
    return new TimeScale(this.width, this.pixelsPerSecond, nextScroll).clamped(durationSec);
  }
}

export const ZOOM_LEVELS = Object.freeze([
  { id: "overview", pixelsPerSecond: 2, label: "Overview: 2 px/s" },
  { id: "medium", pixelsPerSecond: 25, label: "Medium: 25 px/s" },
  { id: "detail", pixelsPerSecond: 200, label: "Detail: 200 px/s" }
]);
