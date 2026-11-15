import test from "node:test";
import assert from "node:assert/strict";

import { createCrossingSample } from "../src/samples.js";
import { DEFAULT_PARAMS, resultWithoutMask, vectorizeSample } from "../src/vectorizer.js";
import {
  addResultLayer,
  createProjectFromResult,
  deserializeProject,
  interpolateKeyframe,
  moveLayer,
  normalizeProject,
  projectFingerprint,
  serializeProject,
  upsertKeyframe
} from "../src/project.js";
import { buildSceneSvg, exportSvgDocument } from "../src/svg.js";
import {
  fallbackThumbnail,
  readSnapshots,
  readVectorCache,
  saveProject,
  writeSnapshot,
  writeVectorCache
} from "../src/storage.js";
import { vectorizeWithRecovery } from "../src/async-vectorize.js";

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }
}

const sample = createCrossingSample();
const result = resultWithoutMask(vectorizeSample(sample, DEFAULT_PARAMS));

function buildThreeLayerProject() {
  let project = createProjectFromResult(result, sample);
  project = addResultLayer(project, result, { id: "layer-clean", name: "清理结果", color: "#365f52" });
  project = addResultLayer(project, result, { id: "layer-detail", name: "细线检查", color: "#9a611e" });
  project.layers[0].keyframes = [
    { time: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    { time: 0.42, x: 18.5, y: -4.25, scale: 1.15, rotation: 2.5, opacity: 0.85 },
    { time: 1, x: 40, y: 12, scale: 1.3, rotation: 5, opacity: 0.7 }
  ];
  return normalizeProject(project);
}

test("project JSON round-trip preserves layer order, keyframes, coordinates and colors", () => {
  const project = buildThreeLayerProject();
  const restored = deserializeProject(serializeProject(project));
  assert.equal(projectFingerprint(restored), projectFingerprint(project));
  assert.deepEqual(restored.layers.map((layer) => layer.order), [0, 1, 2]);
  assert.deepEqual(restored.layers.map((layer) => layer.id), ["layer-ink", "layer-clean", "layer-detail"]);
  assert.deepEqual(
    restored.layers.map((layer) => layer.color),
    ["#17191c", "#365f52", "#9a611e"]
  );
  assert.deepEqual(
    restored.layers[0].keyframes,
    project.layers[0].keyframes
  );
  assert.deepEqual(
    restored.layers[0].paths.map((path) => path.d),
    project.layers[0].paths.map((path) => path.d)
  );
  assert.equal(
    buildSceneSvg(restored, { time: 0.42 }).svg,
    buildSceneSvg(project, { time: 0.42 }).svg
  );
});

test("keyframe interpolation and upsert keep editable coordinates", () => {
  let project = buildThreeLayerProject();
  project = upsertKeyframe(project, project.activeLayerId, 0.42, {
    x: 22,
    y: 9,
    scale: 1.2
  });
  const layer = project.layers.find((item) => item.id === project.activeLayerId);
  const frame = interpolateKeyframe(layer, 0.42);
  assert.equal(frame.x, 22);
  assert.equal(frame.y, 9);
  assert.equal(frame.scale, 1.2);
  const restored = deserializeProject(serializeProject(project));
  assert.equal(projectFingerprint(restored), projectFingerprint(project));
});

test("layer reorder is stable across JSON reload and keeps scene order", () => {
  const project = buildThreeLayerProject();
  const moved = moveLayer(project, "layer-detail", -1);
  assert.deepEqual(moved.layers.map((layer) => layer.id), ["layer-ink", "layer-detail", "layer-clean"]);
  assert.deepEqual(moved.layers.map((layer) => layer.order), [0, 1, 2]);
  const restored = deserializeProject(serializeProject(moved));
  assert.equal(projectFingerprint(restored), projectFingerprint(moved));
  assert.equal(
    buildSceneSvg(restored, { time: 0.42 }).svg,
    buildSceneSvg(moved, { time: 0.42 }).svg
  );
});

test("pre-export snapshot retains the complete project and survives reload", () => {
  const storage = new MemoryStorage();
  const project = buildThreeLayerProject();
  saveProject(project, storage);
  const snapshot = writeSnapshot(project, "导出前", storage, "pre-export");
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.reason, "pre-export");
  const snapshots = readSnapshots(storage).value;
  assert.equal(snapshots.length, 1);
  assert.equal(projectFingerprint(snapshots[0].project), projectFingerprint(project));
  const exported = exportSvgDocument(project, 0.42, { scale: 10 });
  assert.match(exported, /width="7200" height="4800"/);
  assert.doesNotMatch(exported, /<image\b/i);
});

test("cache corruption and old schema are reported as stale, never reused", () => {
  const storage = new MemoryStorage();
  storage.setItem("inktrace.cache.v1", "{broken");
  const broken = readVectorCache("signature", storage);
  assert.equal(broken.value, null);
  assert.equal(broken.stale, true);

  storage.setItem("inktrace.cache.v1", JSON.stringify({ schema: 0, entries: {} }));
  const oldSchema = readVectorCache("signature", storage);
  assert.equal(oldSchema.value, null);
  assert.equal(oldSchema.stale, true);

  writeVectorCache("signature", result, storage);
  const valid = readVectorCache("signature", storage);
  assert.ok(valid.value);
  assert.equal(valid.value.nodeCount, result.nodeCount);
});

test("worker failure falls back locally and emits an explicit notice", async () => {
  const storage = new MemoryStorage();
  const notices = [];
  const outcome = await vectorizeWithRecovery(sample, DEFAULT_PARAMS, {
    storage,
    disableWorker: true,
    notify: (notice) => notices.push(notice)
  });
  assert.equal(outcome.source, "main-thread-fallback");
  assert.equal(outcome.recovered, true);
  assert.ok(outcome.result.paths.length > 0);
  assert.ok(notices.some((notice) => notice.title.includes("异步计算已回退")));
  const cached = await vectorizeWithRecovery(sample, DEFAULT_PARAMS, {
    storage,
    disableWorker: true,
    notify: (notice) => notices.push(notice)
  });
  assert.equal(cached.source, "cache");
});

test("thumbnail fallback is a valid identifiable vector placeholder", () => {
  const url = fallbackThumbnail("缩略图已回退");
  assert.match(url, /^data:image\/svg\+xml/);
  assert.ok(url.includes(encodeURIComponent("缩略图已回退")));
  assert.doesNotMatch(decodeURIComponent(url), /<image\b/i);
});
