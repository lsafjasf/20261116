import { describe, assert, assertEqual, assertThrows } from "./harness.js";
import {
  PeakPyramid,
  TileCache,
  NoticeBus,
  TILE_STATE,
  renderProject,
  addKeyframe,
  serializeProject,
  deserializeProject,
  TimeScale
} from "../src/index.js";
import { tenMinutePyramid, VIEW, defaultProject } from "./fixtures.js";

const ZOOM_PPS = Object.freeze({ overview: 2, medium: 25, detail: 200 });

export const suite = describe("Exception parameters");

suite.test("failed async tile request is marked failed and emits an explicit notice", async () => {
  const notices = new NoticeBus();
  const cache = new TileCache(async () => {
    throw new Error("network down");
  }, { notices });
  const entry = await cache.request(2, 7);
  assertEqual(entry.state, TILE_STATE.FAILED, "entry transitions to failed");
  assert(notices.notices.some((n) => n.code === "TILE_FETCH_FAILED"), "failure notice emitted");
  assertEqual(cache.metrics.failures, 1, "failure metric recorded");
});

suite.test("renderer falls back to a coarser level instead of blank or stale pixels", async () => {
  const pyramid = await tenMinutePyramid();
  const notices = new NoticeBus();
  const preferredLevel = pyramid.chooseLevel(1 / ZOOM_PPS.medium);
  const cache = new TileCache(async (levelIndex) => {
    if (levelIndex === preferredLevel) throw new Error("tile timeout");
    return { ready: true };
  }, { notices });
  for (let tile = 0; tile < 8; tile += 1) {
    await cache.request(preferredLevel, tile);
  }
  const project = defaultProject({ viewport: { zoomId: "medium", scrollSec: 10 } });
  const scale = new TimeScale(VIEW.width, ZOOM_PPS.medium, 10);
  const { framebuffer, metrics } = renderProject(pyramid, project, { cache, scale });
  assert(metrics.level > preferredLevel, "coarser fallback level used");
  assert(metrics.buckets > 0, "fallback still draws waveform, never blank");
  assert(cache.metrics.fallbacks > 0, "fallback metric recorded");
  assert(notices.notices.some((n) => n.code === "FALLBACK_LEVEL"), "fallback notice emitted");
  assert(framebuffer.hash().length === 8, "framebuffer produced deterministic content");
});

suite.test("tile invalidation forces re-fetch rather than serving old content", async () => {
  let calls = 0;
  const cache = new TileCache(async () => {
    calls += 1;
    return { version: calls };
  }, { notices: new NoticeBus() });
  const first = await cache.request(1, 1);
  assertEqual(first.value.version, 1, "first fetch");
  cache.invalidate(1, 1);
  const second = await cache.request(1, 1);
  assertEqual(second.value.version, 2, "re-fetched after invalidation, no stale tile");
});

suite.test("thumbnail provider returning empty value is treated as a failure", async () => {
  const notices = new NoticeBus();
  const cache = new TileCache(async () => null, { notices });
  const entry = await cache.request(0, 3);
  assertEqual(entry.state, TILE_STATE.FAILED, "empty thumbnail fails explicitly");
  assert(notices.notices.some((n) => n.message.includes("failed")), "notice explains thumbnail failure");
});

suite.test("corrupt project documents are rejected on reload", () => {
  const project = defaultProject();
  addKeyframe(project, { timeSec: 12, layerId: "playhead", x: 10, y: 20, color: "#f472b6" });
  const text = serializeProject(project);
  const reloaded = deserializeProject(text);
  assertEqual(reloaded.keyframes[0].color, "#f472b6", "keyframe color survives reload");
  const tampered = text.replace("#f472b6", "#123456");
  assertThrows(() => deserializeProject(tampered), "integrity check failed", "tampered document rejected");
  assertThrows(() => deserializeProject("{not json"), "not valid JSON", "malformed JSON rejected");
});

suite.test("reload preserves layer order, keyframes, coordinates and colors exactly", () => {
  const project = defaultProject({
    overlay: { playheadSec: 33, selection: { startSec: 20, endSec: 25 } }
  });
  addKeyframe(project, { timeSec: 8, layerId: "waveform", x: 120, y: 40, color: "#38bdf8" });
  addKeyframe(project, { timeSec: 40, layerId: "playhead", x: 300, y: 90, color: "#f472b6" });
  const reloaded = deserializeProject(serializeProject(project));
  assertEqual(JSON.stringify(reloaded.layers), JSON.stringify(project.layers), "layer order unchanged");
  assertEqual(reloaded.keyframes.length, 2, "all keyframes retained");
  assertEqual(reloaded.keyframes[0].x, 120, "keyframe x coordinate unchanged");
  assertEqual(reloaded.keyframes[1].y, 90, "keyframe y coordinate unchanged");
  assertEqual(reloaded.theme.waveform, project.theme.waveform, "theme color unchanged");
  assertEqual(JSON.stringify(reloaded.overlay), JSON.stringify(project.overlay), "overlay coordinates unchanged");
});

suite.test("corrupt pyramid binary is rejected instead of silently mis-rendering", () => {
  const pyramid = PeakPyramid.fromSamples(new Float32Array(1024).fill(0.1), 44100);
  const bytes = pyramid.serialize();
  bytes[0] ^= 0xff;
  assertThrows(() => PeakPyramid.deserialize(bytes), "Invalid peak pyramid signature", "bad signature rejected");
});

suite.test("cache eviction never removes an in-flight tile", async () => {
  const releases = [];
  const cache = new TileCache(
    async () =>
      new Promise((resolve) => {
        releases.push(resolve);
      }),
    { maxEntries: 4, notices: new NoticeBus() }
  );
  const requests = [];
  for (let index = 0; index < 8; index += 1) {
    requests.push(cache.request(0, index));
  }
  await Promise.resolve();
  releases.forEach((release) => release({ ready: true }));
  const entries = await Promise.all(requests);
  assert(entries.every((entry) => entry.state === TILE_STATE.READY), "all in-flight tiles resolve");
  assert(cache.metrics.evictions >= 3, "LRU eviction happened under pressure");
});
