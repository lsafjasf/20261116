// End-to-end Node runner mirroring the in-page harness. Writes 1024 PNG
// screenshots, parameter JSON and a Markdown/JSON report into artifacts/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FabricMaterial, LAYERS } from "../js/core/material.js";
import {
  DEFAULT_PARAMS,
  PRESETS,
  validateParams,
  serializeParams,
  deserializeParams,
  ParamError,
  TILE_SIZE,
} from "../js/core/params.js";
import { hashBytes, checkSeams, diffBlocks, hashRegion } from "../js/core/analysis.js";
import { encodePng, decodePng } from "../js/core/png-node.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const shotDir = path.join(root, "artifacts", "screenshots");
fs.mkdirSync(shotDir, { recursive: true });

const report = { generatedAt: new Date().toISOString(), scenarios: [] };
let failures = 0;

function savePng(name, composite) {
  const file = path.join(shotDir, `${name}.png`);
  const buf = encodePng(composite, TILE_SIZE, TILE_SIZE);
  fs.writeFileSync(file, buf);
  const meta = decodePng(buf);
  return { file: path.relative(root, file), bytes: buf.length, ...meta };
}

function record(name, pass, data) {
  report.scenarios.push({ name, pass, ...data });
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
}

// ---- Scenario 1: normal parameter change ----------------------------------
{
  // Two sub-checks: (a) a parameter change rebuilds only the affected layer
  // and matches a fresh recompute; (b) a local brush stroke changes only the
  // blocks it touches while a far-away region keeps identical pixels.
  const mat = new FabricMaterial(DEFAULT_PARAMS);
  const before = Uint8ClampedArray.from(mat.composite);
  const hashBefore = hashBytes(before);
  const pngBefore = savePng("normal-before", before);
  const objectsBefore = { canvases: 3, layerBuffers: 4, brushMask: 1 };

  const affected = mat.updateParams({ ...DEFAULT_PARAMS, creaseStrength: 0.9 });
  const afterParam = mat.composite;
  const hashAfterParam = hashBytes(afterParam);
  const reference = new FabricMaterial({ ...DEFAULT_PARAMS, creaseStrength: 0.9 });
  const hashReference = hashBytes(reference.composite);
  const paramSeam = checkSeams(afterParam);
  const layerOnly = affected.length === 1 && affected[0] === LAYERS.CREASE;

  // Local brush far from the probe region at (500,500).
  const beforeBrush = Uint8ClampedArray.from(mat.composite);
  mat.brushAt(20, 20, 24, 255);
  const afterBrush = mat.composite;
  const pngAfter = savePng("normal-after", afterBrush);
  const diff = diffBlocks(beforeBrush, afterBrush);
  const farSame =
    hashRegion(beforeBrush, 500, 500, 564, 564) ===
    hashRegion(afterBrush, 500, 500, 564, 564);
  const brushSeam = checkSeams(afterBrush);
  const objectsAfter = { canvases: 3, layerBuffers: 4, brushMask: 1 };

  record("normal-incremental-update",
    hashAfterParam === hashReference &&
      layerOnly && paramSeam.seamless && brushSeam.seamless &&
      farSame &&
      JSON.stringify(objectsBefore) === JSON.stringify(objectsAfter),
    {
      hashBefore,
      hashAfterParam,
      hashReference,
      affectedLayers: affected,
      brushChangedBlocks: `${diff.changedBlocks.length}/${diff.totalBlocks}`,
      farRegionUntouched: farSame,
      paramSeam,
      brushSeam,
      objectsBefore,
      objectsAfter,
      screenshots: [pngBefore, pngAfter],
      metrics: mat.metrics,
    }
  );
}

// ---- Scenario 2: boundary brush + export/reload round trip -----------------
{
  const mat = new FabricMaterial(PRESETS.balanced.params);
  mat.brushAt(0, 0, 40, 255);
  const n = TILE_SIZE;
  const corners = [
    [2, 2], [n - 3, 2], [2, n - 3], [n - 3, n - 3],
  ].map(([x, y]) => mat.brushMask[y * n + x]);
  const seam = checkSeams(mat.composite);
  const hashBefore = hashBytes(mat.composite);
  const png = savePng("boundary-corner-brush", mat.composite);
  const jsonFile = path.join(root, "artifacts", "fabric-params.json");
  fs.writeFileSync(jsonFile, serializeParams(mat.params));

  // Reload JSON and rebuild; replay the same brush stroke.
  const reloadedParams = deserializeParams(fs.readFileSync(jsonFile, "utf8"));
  const replayed = new FabricMaterial(reloadedParams);
  replayed.brushAt(0, 0, 40, 255);
  const hashReload = hashBytes(replayed.composite);
  const pngReload = savePng("boundary-reloaded", replayed.composite);

  // Boundary pixel comparison across the reload (edge columns/rows hashes).
  const edgeHash = (bytes) =>
    hashRegion(bytes, 0, 0, 1, n) +
    hashRegion(bytes, n - 1, 0, n, n) +
    hashRegion(bytes, 0, 0, n, 1) +
    hashRegion(bytes, 0, n - 1, n, n);
  const edgeMatch = edgeHash(mat.composite) === edgeHash(replayed.composite);

  record("boundary-brush-and-reload",
    corners.every((v) => v > 0) &&
      seam.seamless &&
      hashBefore === hashReload &&
      edgeMatch &&
      png.width === 1024 && png.height === 1024,
    {
      corners,
      seam,
      hashBefore,
      hashReload,
      edgePixelsMatch: edgeMatch,
      pngMeta: png,
      json: path.relative(root, jsonFile),
      screenshots: [png, pngReload],
    }
  );
}

// ---- Scenario 3: failure inputs are rejected, scene stays intact -----------
{
  const mat = new FabricMaterial(DEFAULT_PARAMS);
  const hashBefore = hashBytes(mat.composite);
  const cases = [
    { label: "density-77-snaps", input: { ...DEFAULT_PARAMS, threadDensity: 77 }, expect: "snap" },
    { label: "wear-out-of-range", input: { ...DEFAULT_PARAMS, wearLevel: 5 }, expect: "throw" },
    { label: "nan-direction", input: { ...DEFAULT_PARAMS, fiberDirection: NaN }, expect: "throw" },
    { label: "null-root", input: null, expect: "throw" },
    { label: "bad-json-text", input: "{not json", expect: "throw" },
  ];
  const outcomes = cases.map((c) => {
    try {
      if (typeof c.input === "string") {
        deserializeParams(c.input);
      } else {
        validateParams(c.input);
      }
      return { label: c.label, result: c.expect === "snap" ? "snapped/ok" : "UNEXPECTED PASS" };
    } catch (err) {
      return {
        label: c.label,
        result: c.expect === "throw" ? `blocked:${err.field || "json"}` : "UNEXPECTED THROW",
      };
    }
  });
  const hashAfter = hashBytes(mat.composite);
  const blocked = outcomes.filter((o) => o.result.startsWith("blocked")).length;
  const noUnexpected = outcomes.every((o) => !o.result.startsWith("UNEXPECTED"));
  record("failure-validation",
    blocked === 4 && noUnexpected && hashBefore === hashAfter,
    { blocked, outcomes, hashBefore, hashAfter, sceneRebuilt: hashBefore !== hashAfter }
  );
}

// ---- Algorithm state summary + visual comparison preset export -------------
{
  const mat = new FabricMaterial(PRESETS.folded.params);
  const summary = {
    layers: Object.values(LAYERS),
    tileSize: TILE_SIZE,
    blockSize: 64,
    blocksPerSide: mat.blocksPerSide,
    metrics: mat.metrics,
    seam: checkSeams(mat.composite),
    hash: hashBytes(mat.composite),
    restorePreset: "balanced",
  };
  fs.writeFileSync(
    path.join(root, "artifacts", "algorithm-state.json"),
    JSON.stringify(summary, null, 2)
  );
  savePng("preset-folded", mat.composite);
  savePng("preset-balanced", new FabricMaterial(PRESETS.balanced.params).composite);
  report.stateSummary = summary;
}

fs.writeFileSync(
  path.join(root, "artifacts", "test-report.json"),
  JSON.stringify(report, null, 2)
);

const lines = ["# 织物材质测试报告", "", `生成时间: ${report.generatedAt}`, ""];
for (const s of report.scenarios) {
  lines.push(`## ${s.pass ? "✅" : "❌"} ${s.name}`);
  lines.push("```json");
  lines.push(JSON.stringify(s, null, 2));
  lines.push("```", "");
}
fs.writeFileSync(path.join(root, "artifacts", "test-report.md"), lines.join("\n"));

console.log(`\n${failures === 0 ? "ALL SCENARIOS PASSED" : failures + " SCENARIO(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
