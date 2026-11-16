import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  PeakPyramid,
  encodePng,
  deserializeProject,
  renderProject,
  renderKeyframes,
  scaleFromProject
} from "../src/index.js";
import { resolvingCache } from "../test/fixtures.js";

const root = process.cwd();
const snapshotDir = latestSnapshot(join(root, "snapshots"));
if (!snapshotDir) {
  process.stderr.write("No pre-export snapshot found. Run `npm run snapshot` first.\n");
  process.exit(1);
}

const projectText = readFileSync(join(snapshotDir, "project.json"), "utf8");
const project = deserializeProject(projectText);
const pyramid = PeakPyramid.deserialize(readFileSync(join(root, "artifacts", "audio", "peak-pyramid.bin")));

const scale = scaleFromProject(project);
const rendered = renderProject(pyramid, project, { cache: resolvingCache(), scale });
renderKeyframes(rendered.framebuffer, project, scale);

const exportDir = join(root, "artifacts", "exports");
mkdirSync(exportDir, { recursive: true });
const png = encodePng(rendered.framebuffer);
const pngPath = join(exportDir, "waveform-export.png");
writeFileSync(pngPath, png);

const reloaded = deserializeProject(serializeForReload(project));
const reloadedRender = renderProject(pyramid, reloaded, { cache: resolvingCache(), scale });
renderKeyframes(reloadedRender.framebuffer, reloaded, scale);

const snapshotRecord = JSON.parse(readFileSync(join(snapshotDir, "snapshot.json"), "utf8"));
const checks = {
  previewEqualsExport: rendered.framebuffer.hash() === snapshotRecord.previewHash,
  reloadPixelHash: reloadedRender.framebuffer.hash(),
  reloadPixelsIdentical: rendered.framebuffer.differenceCount(reloadedRender.framebuffer) === 0,
  layerOrderIdentical: JSON.stringify(reloaded.layers) === JSON.stringify(project.layers),
  keyframesIdentical: JSON.stringify(reloaded.keyframes) === JSON.stringify(project.keyframes),
  coordinatesIdentical: JSON.stringify(reloaded.overlay) === JSON.stringify(project.overlay),
  colorsIdentical: JSON.stringify(reloaded.theme) === JSON.stringify(project.theme),
  pngBytes: png.length,
  pngSha256: createHash("sha256").update(png).digest("hex")
};

writeFileSync(join(exportDir, "export-report.json"), JSON.stringify({ source: snapshotDir, checks }, null, 2));
const failed = Object.entries(checks).filter(([, value]) => value === false).map(([key]) => key);
process.stdout.write(`Exported ${pngPath} (${png.length} bytes)\n`);
process.stdout.write(JSON.stringify(checks, null, 2) + "\n");
if (failed.length) {
  process.stderr.write(`Export verification failed: ${failed.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write("Export matches preview and reload state is unchanged.\n");

function latestSnapshot(baseDir) {
  try {
    const entries = readdirSync(baseDir).filter((name) => name.startsWith("pre-export-")).sort();
    return entries.length ? join(baseDir, entries[entries.length - 1]) : null;
  } catch {
    return null;
  }
}

function serializeForReload(document) {
  return JSON.stringify(document);
}
