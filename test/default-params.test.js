import { describe, assert, assertEqual, assertApprox } from "./harness.js";
import {
  DEFAULT_AUDIO_OPTIONS,
  generateChunks,
  totalSampleCount,
  sampleAt,
  TimeScale,
  ZOOM_LEVELS,
  renderProject,
  NoticeBus
} from "../src/index.js";
import { tenMinutePyramid, VIEW, defaultProject, resolvingCache } from "./fixtures.js";

const VIEW_WIDTH = VIEW.width;
const VIEW_HEIGHT = VIEW.height;

export const suite = describe("Default parameters");

suite.test("generates exactly ten minutes of 44.1kHz audio deterministically", async () => {
  const expected = 44100 * 600;
  assertEqual(totalSampleCount(DEFAULT_AUDIO_OPTIONS), expected, "total sample count");
  let chunks = 0;
  let observed = 0;
  await generateChunks(DEFAULT_AUDIO_OPTIONS, async (chunk, offset, total) => {
    chunks += 1;
    observed += chunk.length;
    assertEqual(total, expected, "stream reports total");
    assert(Number.isFinite(chunk[0]), "chunk samples are finite");
  });
  assertEqual(observed, expected, "streamed sample count");
  assert(chunks > 1, "audio was processed in multiple bounded chunks");
  assertEqual(sampleAt(123456, 44100, DEFAULT_AUDIO_OPTIONS.seed), sampleAt(123456, 44100, DEFAULT_AUDIO_OPTIONS.seed), "deterministic sample");
});

suite.test("builds a logarithmic peak pyramid with valid min/max invariants", async () => {
  const pyramid = await tenMinutePyramid();
  assertEqual(pyramid.totalSamples, 44100 * 600, "pyramid total samples");
  assert(pyramid.levelCount >= 6, `pyramid has enough levels (got ${pyramid.levelCount})`);
  for (const level of pyramid.levels) {
    for (const bucket of level) {
      assert(bucket.min <= bucket.max, "min <= max for every bucket");
      assert(bucket.min >= -1 && bucket.max <= 1, "peaks stay within [-1, 1]");
    }
  }
  const coarsest = pyramid.levels[pyramid.levelCount - 1];
  assertEqual(coarsest.length, 1, "coarsest level is a single bucket overview");
});

suite.test("three zoom levels keep the same time point at the same pixel", async () => {
  const pyramid = await tenMinutePyramid();
  const anchorTime = 250;
  const anchorPixel = 400;
  const scales = ZOOM_LEVELS.map((zoom) => {
    const scrollSec = anchorTime - anchorPixel / zoom.pixelsPerSecond;
    return new TimeScale(VIEW_WIDTH, zoom.pixelsPerSecond, scrollSec).clamped(pyramid.durationSec);
  });
  for (const scale of scales) {
    const expectedPixel = scale.timeToPixel(anchorTime);
    assertApprox(scale.pixelToTime(expectedPixel), anchorTime, 1e-9, "inverse mapping round trips");
    assert(expectedPixel >= 0 && expectedPixel <= VIEW_WIDTH, "anchor stays inside the viewport after clamp");
  }
  const pixels = scales.map((scale) => Math.round(scale.timeToPixel(anchorTime)));
  assert(new Set(pixels).size === 1, `all zoom levels place anchor at pixel ${pixels[0]} (got ${pixels.join(",")})`);
});

suite.test("rendering stays O(viewport width), not O(sample count), at every zoom", async () => {
  const pyramid = await tenMinutePyramid();
  const notices = new NoticeBus();
  for (const zoom of ZOOM_LEVELS) {
    const project = defaultProject({ viewport: { zoomId: zoom.id, scrollSec: 30 }, overlay: { playheadSec: 120, selection: { startSec: 100, endSec: 110 } } });
    const cache = resolvingCache();
    const scale = new TimeScale(VIEW_WIDTH, zoom.pixelsPerSecond, 30);
    const { metrics } = renderProject(pyramid, project, { cache, scale });
    assert(metrics.buckets <= VIEW_WIDTH * 1.2, `${zoom.id} bucket count bounded by viewport (got ${metrics.buckets})`);
    assert(metrics.buckets > 0, `${zoom.id} actually drew waveform buckets`);
    assert(metrics.fills < VIEW_WIDTH * 3, `${zoom.id} total fills stay near viewport scale`);
  }
});

suite.test("playhead and selection align with the waveform time mapping", async () => {
  const pyramid = await tenMinutePyramid();
  const notices = new NoticeBus();
  const scale = new TimeScale(VIEW_WIDTH, ZOOM_LEVELS[1].pixelsPerSecond, 100);
  const project = defaultProject({ viewport: { zoomId: "medium", scrollSec: 100 }, overlay: { playheadSec: 115, selection: { startSec: 105, endSec: 109 } } });
  const cache = resolvingCache();
  const { framebuffer } = renderProject(pyramid, project, { cache, scale });
  const playheadPixel = Math.round(scale.timeToPixel(115));
  const selectStartPixel = Math.round(scale.timeToPixel(105));
  const selectEndPixel = Math.round(scale.timeToPixel(109));
  const playheadColumn = columnColors(framebuffer, playheadPixel);
  assert(playheadColumn.some(([r, g, b]) => r === 244 && g === 114 && b === 182), "playhead color present at mapped pixel");
  assert(framebuffer.pixels[(0 * VIEW_WIDTH + selectStartPixel) * 4] === 250, "selection start edge at mapped pixel");
  assert(framebuffer.pixels[(0 * VIEW_WIDTH + selectEndPixel) * 4] === 250, "selection end edge at mapped pixel");
});

function columnColors(framebuffer, pixelX) {
  const colors = [];
  for (let y = 0; y < framebuffer.height; y += 1) {
    const offset = (y * framebuffer.width + pixelX) * 4;
    colors.push([framebuffer.pixels[offset], framebuffer.pixels[offset + 1], framebuffer.pixels[offset + 2]]);
  }
  return colors;
}

suite.test("zooming progressively reveals finer pyramid detail on the same window", async () => {
  const pyramid = await tenMinutePyramid();
  const windowStart = 120;
  const detailByZoom = ZOOM_LEVELS.map((zoom) => {
    const scale = new TimeScale(VIEW_WIDTH, zoom.pixelsPerSecond, windowStart);
    const level = pyramid.chooseLevel(scale.secondsPerPixel);
    const samplesPerBucket = 4 ** level * pyramid.baseBucketSamples;
    return { zoom: zoom.id, level, samplesPerBucket };
  });
  assertEqual(detailByZoom[0].level > detailByZoom[1].level, true, "overview uses a coarser level than medium");
  assertEqual(detailByZoom[1].level > detailByZoom[2].level, true, "medium uses a coarser level than detail");
  assert(detailByZoom[2].samplesPerBucket < detailByZoom[1].samplesPerBucket, "detail bucket resolves more samples precisely");
  assert(detailByZoom[1].samplesPerBucket < detailByZoom[0].samplesPerBucket, "medium resolves more precisely than overview");
});
