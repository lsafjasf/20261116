import test from "node:test";
import assert from "node:assert/strict";
import { StableAtlasPacker } from "../src/core/packer.js";
import { createDemoProject, projectFingerprint } from "../src/core/project.js";
import { pixelsEqual, renderAtlas, restoreOriginalFrame } from "../src/core/render.js";
import {
  buildAtlasPackage,
  createSnapshotPackage,
  packageFingerprint,
  packerFromPackage,
  validateAtlasPackage,
} from "../src/core/schema.js";
import { createDemoFrames, hashPixels } from "../src/core/sprite.js";
import { dataUrlToPng, decodePng, encodePng, pngDataUrl } from "../src/node/png.js";

test("exported PNG equals preview buffer and JSON restores rotation, trim and source size", () => {
  const frames = createDemoFrames(100, { seed: 628 });
  const packer = new StableAtlasPacker();
  packer.packAll(frames);
  const project = createDemoProject(frames);
  const preview = renderAtlas(packer, frames);
  const png = encodePng(preview.width, preview.height, preview.pixels);
  const packageJson = buildAtlasPackage({
    packer,
    project,
    atlas: preview,
    imageDataUrl: pngDataUrl(png),
  });
  const exported = decodePng(dataUrlToPng(packageJson.atlas.imageDataUrl));
  assert.equal(pixelsEqual(preview, exported), true);
  assert.equal(hashPixels(exported.pixels), packageJson.atlas.pixelHash);
  assert.equal(validateAtlasPackage(packageJson).ok, true);

  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  let rotated = 0;
  let trimmed = 0;
  for (const slice of packageJson.frames) {
    if (slice.rotated) rotated += 1;
    if (slice.trimmed) trimmed += 1;
    assert.equal(slice.sourceSize.w, byId.get(slice.id).width);
    assert.equal(slice.sourceSize.h, byId.get(slice.id).height);
    assert.equal(slice.frame.w, slice.rotated ? slice.spriteSourceSize.h : slice.spriteSourceSize.w);
    assert.equal(slice.frame.h, slice.rotated ? slice.spriteSourceSize.w : slice.spriteSourceSize.h);
    assert.equal(pixelsEqual(restoreOriginalFrame(slice, exported), byId.get(slice.id)), true);
  }
  assert.ok(rotated > 0);
  assert.ok(trimmed > 0);
});

test("reloading export preserves layer order, keyframes, coordinates and colors", () => {
  const frames = createDemoFrames(100, { seed: 628 });
  const packer = new StableAtlasPacker();
  packer.packAll(frames);
  const project = createDemoProject(frames);
  project.layers.reverse();
  project.layers.forEach((layer, index) => {
    layer.order = index;
    layer.color = ["#102030", "#405060", "#708090"][index];
  });
  project.keyframes[1].colors.character = "#abcdef";
  const data = renderAtlas(packer, frames);
  const png = encodePng(data.width, data.height, data.pixels);
  const packageJson = buildAtlasPackage({
    packer,
    project,
    atlas: data,
    imageDataUrl: pngDataUrl(png),
  });
  const reloadedPacker = packerFromPackage(packageJson);
  const reloadedProject = JSON.parse(JSON.stringify(packageJson.project));
  assert.equal(
    projectFingerprint(reloadedProject, reloadedPacker),
    projectFingerprint(project, packer),
  );
  assert.equal(packageJson.fingerprint, projectFingerprint(reloadedProject, reloadedPacker));
  assert.deepEqual(reloadedProject.layers.map((layer) => layer.id), project.layers.map((layer) => layer.id));
  assert.deepEqual(reloadedProject.keyframes, project.keyframes);
  assert.equal(reloadedProject.keyframes[1].colors.character, "#abcdef");
});

test("pre-export snapshot captures the same project and pixel state as export", () => {
  const frames = createDemoFrames(12, { seed: 7 });
  const packer = new StableAtlasPacker({ width: 256, height: 256 });
  packer.packAll(frames);
  const project = createDemoProject(frames);
  const atlas = renderAtlas(packer, frames);
  const png = encodePng(atlas.width, atlas.height, atlas.pixels);
  const imageDataUrl = pngDataUrl(png);
  const snapshot = createSnapshotPackage({
    packer,
    project,
    atlas,
    imageDataUrl,
    label: "pre-export",
    snapshotId: "test-snapshot",
    capturedAt: "2026-11-16T00:00:00.000Z",
  });
  const exported = buildAtlasPackage({ packer, project, atlas, imageDataUrl });
  assert.equal(snapshot.format, "stable-sprite-atlas-snapshot");
  assert.equal(snapshot.snapshot.beforeExport, true);
  assert.equal(snapshot.snapshot.packageFingerprint, packageFingerprint(exported));
  assert.equal(packageFingerprint(snapshot), packageFingerprint(exported));
  assert.equal(validateAtlasPackage(snapshot).ok, true);
});
