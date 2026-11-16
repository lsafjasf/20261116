import { describe, assert, assertEqual, assertApprox, assertThrows } from "./harness.js";
import {
  PeakPyramid,
  TimeScale,
  ZOOM_LEVELS,
  Framebuffer,
  renderProject,
  createProject,
  TileCache,
  NoticeBus
} from "../src/index.js";
import { resolvingCache, VIEW } from "./fixtures.js";

export const suite = describe("Boundary parameters");

suite.test("single-sample audio builds a one-bucket pyramid without crashing", () => {
  const pyramid = PeakPyramid.fromSamples(new Float32Array([0.42]), 44100, 256);
  assertEqual(pyramid.levelCount, 1, "single level");
  assertEqual(pyramid.levels[0].length, 1, "one bucket");
  assertApprox(pyramid.levels[0][0].max, 0.42, 1e-6, "bucket max preserved");
});

suite.test("partially filled trailing bucket keeps correct min/max", () => {
  const samples = new Float32Array(300).fill(0.1);
  samples[299] = -0.9;
  const pyramid = PeakPyramid.fromSamples(samples, 1000, 256);
  assertEqual(pyramid.levels[0].length, 2, "full plus partial bucket");
  assertApprox(pyramid.levels[0][1].min, -0.9, 1e-6, "partial bucket min");
});

suite.test("clamping prevents scrolling past the end at every zoom level", () => {
  for (const zoom of ZOOM_LEVELS) {
    const scale = new TimeScale(VIEW.width, zoom.pixelsPerSecond, 999999).clamped(600);
    const maxScroll = Math.max(0, 600 - VIEW.width / zoom.pixelsPerSecond);
    assertApprox(scale.scrollSec, maxScroll, 1e-9, `${zoom.id} clamps scroll to max`);
    assert(scale.visibleEndSec <= 600 + 1e-9, `${zoom.id} never shows beyond audio end`);
  }
});

suite.test("zoom anchor stays fixed when zooming across all three levels", () => {
  let scale = new TimeScale(VIEW.width, ZOOM_LEVELS[0].pixelsPerSecond, 0);
  const anchorPixel = 320;
  const anchorTime = scale.pixelToTime(anchorPixel);
  for (const zoom of ZOOM_LEVELS) {
    scale = scale.zoomAt(zoom.pixelsPerSecond, anchorPixel, 600);
    assertApprox(scale.timeToPixel(anchorTime), anchorPixel, 1e-9, `${zoom.id} anchor pixel stable`);
  }
  for (let index = ZOOM_LEVELS.length - 1; index >= 0; index -= 1) {
    scale = scale.zoomAt(ZOOM_LEVELS[index].pixelsPerSecond, anchorPixel, 600);
    assertApprox(scale.timeToPixel(anchorTime), anchorPixel, 1e-9, "reverse zoom anchor stable");
  }
});

suite.test("minimum 1x1 framebuffer renders without out-of-range writes", () => {
  const pyramid = PeakPyramid.fromSamples(new Float32Array([0, 0.5, -0.5, 1]), 4, 1);
  const project = createProject({
    width: 1,
    height: 1,
    audio: { sampleRate: 4, durationSec: 1 },
    viewport: { zoomId: "detail", scrollSec: 0 }
  });
  const cache = resolvingCache();
  const { framebuffer, metrics } = renderProject(pyramid, project, {
    cache,
    scale: new TimeScale(1, ZOOM_LEVELS[2].pixelsPerSecond, 0)
  });
  assertEqual(framebuffer.width, 1, "tiny framebuffer width");
  assert(metrics.buckets >= 0, "render completes on 1px viewport");
});

suite.test("invalid TimeScale and framebuffer inputs are rejected", () => {
  assertThrows(() => new TimeScale(0, 10), "width must be positive", "zero width");
  assertThrows(() => new TimeScale(100, 0), "pixelsPerSecond must be positive", "zero zoom");
  assertThrows(() => new TimeScale(100, -5), "pixelsPerSecond must be positive", "negative zoom");
  assertThrows(() => new Framebuffer(2.5, 10), "positive integers", "fractional dimensions");
});

suite.test("queryRange clips to the final bucket instead of reading past the end", () => {
  const pyramid = PeakPyramid.fromSamples(new Float32Array(1000).fill(0.25), 1000, 256);
  const result = pyramid.queryRange(0, 0, 5);
  assertEqual(result.lastBucket, pyramid.levels[0].length - 1, "last bucket is the final one");
  assert(result.buckets.length === pyramid.levels[0].length, "all buckets returned once");
});
