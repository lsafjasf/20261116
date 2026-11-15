import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createCrossingSample } from "../src/samples.js";
import {
  ALGORITHM_VERSION,
  DEFAULT_PARAMS,
  PARAM_BOUNDS,
  PARAM_PRESETS,
  normalizeParams,
  resultWithoutMask,
  vectorizeSample
} from "../src/vectorizer.js";
import {
  createProjectFromResult,
  normalizeProject
} from "../src/project.js";
import { buildSceneSvg, exportSvgDocument } from "../src/svg.js";

const sample = createCrossingSample();

function digest(values) {
  return createHash("sha256").update(Buffer.from(values)).digest("hex");
}

test("fixed sample is byte-for-byte deterministic", () => {
  const second = createCrossingSample();
  assert.equal(sample.id, "crossing-speck-v1");
  assert.equal(sample.width, 720);
  assert.equal(sample.height, 480);
  assert.equal(digest(sample.gray), digest(second.gray));
  assert.equal(sample.speckMask.reduce((sum, value) => sum + value, 0), 80);
  assert.equal(sample.thinLineMask.reduce((sum, value) => sum + value, 0), 7167);
});

test("default preset preserves thin lines and filters every isolated speck", () => {
  const result = vectorizeSample(sample, DEFAULT_PARAMS);
  assert.equal(result.version, ALGORITHM_VERSION);
  assert.deepEqual(result.params, DEFAULT_PARAMS);
  assert.ok(result.paths.length >= 3, "crossing network must produce closed paths");
  assert.ok(result.nodeCount > 0);
  assert.ok(result.metrics.completeness >= 95, "visual completeness must stay high");
  assert.ok(result.metrics.thinLineCoverage >= 95, "0.9px line must survive");
  assert.ok(result.metrics.noiseRemoved >= 99, "compact specks must be removed");
  assert.equal(result.fallbackApplied, false);
  assert.equal(result.warnings.length, 0);
});

test("all boundary parameters are valid and still retain thin lines", () => {
  const definition = PARAM_PRESETS.boundary.params;
  const normalized = normalizeParams(definition);
  assert.equal(normalized.warnings.length, 0);
  assert.equal(normalized.params.threshold, PARAM_BOUNDS.threshold.max);
  assert.equal(normalized.params.smoothing, PARAM_BOUNDS.smoothing.max);
  assert.equal(normalized.params.merge, PARAM_BOUNDS.merge.max);
  assert.equal(normalized.params.minRegion, PARAM_BOUNDS.minRegion.max);
  const result = vectorizeSample(sample, definition);
  const defaultResult = vectorizeSample(sample, DEFAULT_PARAMS);
  assert.ok(result.nodeCount < defaultResult.nodeCount, "node merge must reduce anchors");
  assert.ok(result.metrics.completeness >= 96, "boundary output must not lose structure");
  assert.ok(result.metrics.thinLineCoverage >= 96);
  assert.ok(result.metrics.noiseRemoved >= 99);
});

test("out-of-range exception parameters are clamped with explicit warnings", () => {
  const result = vectorizeSample(sample, PARAM_PRESETS.exception.params);
  assert.deepEqual(result.params, {
    threshold: PARAM_BOUNDS.threshold.max,
    smoothing: PARAM_BOUNDS.smoothing.min,
    merge: PARAM_BOUNDS.merge.max,
    minRegion: PARAM_BOUNDS.minRegion.max
  });
  assert.equal(result.warnings.length, 4);
  assert.ok(result.warnings.every((warning) => warning.includes("超出范围")));
  assert.ok(result.paths.length > 0, "exception parameters must not blank the canvas");
  assert.ok(result.metrics.thinLineCoverage >= 98);
  assert.ok(result.metrics.noiseRemoved >= 99);
});

test("vector output is editable, deterministic and free of raster nodes", () => {
  const first = vectorizeSample(sample, DEFAULT_PARAMS);
  const second = vectorizeSample(sample, DEFAULT_PARAMS);
  assert.equal(first.nodeCount, second.nodeCount);
  assert.deepEqual(first.paths.map((path) => path.d), second.paths.map((path) => path.d));
  const project = createProjectFromResult(resultWithoutMask(first), sample);
  const preview = buildSceneSvg(project, { time: 0 }).svg;
  const exported = exportSvgDocument(project, 0);
  assert.ok(preview.includes("<path "));
  assert.ok(exported.includes(preview));
  assert.match(exported, /Q-?\d/);
  assert.doesNotMatch(exported, /<image\b/i);
  assert.doesNotMatch(exported, /data:image\//i);
  assert.match(exported, /shape-rendering="geometricPrecision"/);
  const tenX = exportSvgDocument(project, 0, { scale: 10 });
  assert.match(tenX, /width="7200" height="4800"/);
  assert.match(tenX, /viewBox="0 0 720 480"/);
  assert.doesNotMatch(tenX, /<image\b/i);
  assert.equal(
    (tenX.match(/<path\b/g) || []).length,
    (exported.match(/<path\b/g) || []).length
  );
});

test("project normalization rejects malformed geometry instead of rendering blank", () => {
  assert.throws(() => normalizeProject({ width: 720, height: 480, layers: [] }), /图层/);
  assert.throws(() => normalizeProject({
    width: 720,
    height: 480,
    layers: [{ paths: [{ d: "not-a-path" }] }]
  }), /SVG path/);
});
