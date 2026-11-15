import test from "node:test";
import assert from "node:assert/strict";
import {
  PROJECT_SCHEMA_VERSION,
  createDefaultProject,
  createSnapshot,
  interpolateLayer,
  normalizeProject,
  projectFingerprint,
  reorderLayer,
  upsertKeyframe,
  validateProject,
} from "../../src/core/project.js";

test("默认工程符合 schema，关键帧时间有序", () => {
  const project = createDefaultProject();
  assert.equal(project.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(validateProject(project), project);
  for (const layer of project.layers) {
    const times = layer.keyframes.map((keyframe) => keyframe.timeMs);
    assert.deepEqual(times, [...times].sort((left, right) => left - right));
  }
});

test("图层顺序、坐标、颜色与关键帧经过 JSON 往返不变", () => {
  let project = createDefaultProject();
  project = reorderLayer(project, "caption", 1);
  project = upsertKeyframe(project, "sun", 12_345, {
    x: 412.5,
    y: 198.25,
    color: "#12abef",
    opacity: 0.63,
  });
  const roundTripped = normalizeProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(roundTripped.layers.map((layer) => layer.id), project.layers.map((layer) => layer.id));
  assert.deepEqual(roundTripped, project);
  const sun = roundTripped.layers.find((layer) => layer.id === "sun");
  const keyframe = sun.keyframes.find((item) => item.timeMs === 12_345);
  assert.equal(keyframe.x, 412.5);
  assert.equal(keyframe.y, 198.25);
  assert.equal(keyframe.color, "#12abef");
  assert.equal(keyframe.opacity, 0.63);
  assert.equal(projectFingerprint(roundTripped), projectFingerprint(project));
});

test("导出前快照是深拷贝，不受后续编辑影响", () => {
  const project = createDefaultProject();
  const snapshot = createSnapshot(project, { currentTimeMs: 5000, cropAspect: "9:16" }, "before-export");
  const originalFingerprint = projectFingerprint(project);
  project.layers[0].color = "#ffffff";
  assert.equal(projectFingerprint(snapshot.project), originalFingerprint);
  assert.equal(snapshot.reason, "before-export");
  assert.equal(snapshot.ui.cropAspect, "9:16");
});

test("边界与异常参数会拒绝非法工程和关键帧", () => {
  const project = createDefaultProject();
  assert.throws(() => validateProject({ ...project, durationMs: 0 }), RangeError);
  assert.throws(() => validateProject({ ...project, fps: 241 }), RangeError);
  assert.throws(() => validateProject({ ...project, layers: [] }), RangeError);
  assert.throws(
    () =>
      validateProject({
        ...project,
        layers: [{ ...project.layers[0], keyframes: [{ ...project.layers[0].keyframes[0], timeMs: 999_999 }] }],
      }),
    RangeError,
  );
  assert.throws(
    () => validateProject({ ...project, layers: [{ ...project.layers[0], color: "red" }] }),
    RangeError,
  );
  assert.throws(() => upsertKeyframe(project, "missing-layer", 0, { x: 1 }), /layer not found/);
});

test("关键帧插值在端点与中点保持有限值", () => {
  const project = createDefaultProject();
  const layer = project.layers.find((item) => item.id === "satellite");
  const start = interpolateLayer(layer, 0);
  const middle = interpolateLayer(layer, 30_000);
  const end = interpolateLayer(layer, 120_000);
  for (const state of [start, middle, end]) {
    for (const field of ["x", "y", "width", "height", "rotation", "opacity"]) {
      assert.ok(Number.isFinite(state[field]));
    }
    assert.match(state.color, /^#[0-9a-f]{6}$/i);
  }
  assert.equal(middle.timeMs, undefined);
  assert.equal(middle.x, 641);
});
