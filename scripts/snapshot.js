import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  PeakPyramid,
  createProject,
  addKeyframe,
  serializeProject,
  renderProject,
  renderKeyframes,
  TimeScale,
  ZOOM_LEVELS,
  TileCache,
  NoticeBus
} from "../src/index.js";
import { VIEW, resolvingCache } from "../test/fixtures.js";

const root = process.cwd();
const audioDir = join(root, "artifacts", "audio");
const pyramidPath = join(audioDir, "peak-pyramid.bin");
if (!existsSync(pyramidPath)) {
  process.stderr.write("Run `npm run generate` before taking a snapshot.\n");
  process.exit(1);
}

const pyramidBytes = readFileSync(pyramidPath);
const pyramid = PeakPyramid.deserialize(pyramidBytes);
const pyramidChecksum = createHash("sha256").update(pyramidBytes).digest("hex");

const project = createProject({
  width: VIEW.width,
  height: VIEW.height,
  audio: {
    sampleRate: 44100,
    durationSec: 600,
    seed: "uid634-ten-minutes",
    pyramidChecksum
  },
  viewport: { zoomId: "medium", scrollSec: 120 },
  overlay: { playheadSec: 145, selection: { startSec: 130, endSec: 138 } }
});
addKeyframe(project, { timeSec: 126, layerId: "playhead", x: 150, y: 60, color: "#f472b6" });
addKeyframe(project, { timeSec: 152, layerId: "waveform", x: 800, y: 260, color: "#38bdf8" });

const zoom = ZOOM_LEVELS.find((level) => level.id === project.viewport.zoomId);
const scale = new TimeScale(VIEW.width, zoom.pixelsPerSecond, project.viewport.scrollSec);
const cache = resolvingCache();
const preview = renderProject(pyramid, project, { cache, scale });
renderKeyframes(preview.framebuffer, project, scale);
const previewHash = preview.framebuffer.hash();

const previews = {};
for (const level of ZOOM_LEVELS) {
  const levelScale = new TimeScale(VIEW.width, level.pixelsPerSecond, project.viewport.scrollSec).clamped(600);
  const result = renderProject(pyramid, project, {
    cache: new TileCache(async () => ({ ready: true }), { notices: new NoticeBus() }),
    scale: levelScale
  });
  previews[level.id] = result.framebuffer.hash();
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const snapshotDir = join(root, "snapshots", `pre-export-${stamp}`);
mkdirSync(snapshotDir, { recursive: true });

let gitCommit = "unknown";
try {
  gitCommit = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
} catch {
  gitCommit = "no-git";
}

const record = {
  snapshotId: `pre-export-${stamp}`,
  createdAt: new Date().toISOString(),
  gitCommit,
  pyramidChecksum,
  pyramidLevels: pyramid.levelCount,
  previewHash,
  previewHashesByZoom: previews,
  viewport: project.viewport,
  layerOrder: project.layers.map((layer) => layer.id),
  keyframeCount: project.keyframes.length,
  projectFile: "project.json"
};

writeFileSync(join(snapshotDir, "project.json"), serializeProject(project));
writeFileSync(join(snapshotDir, "snapshot.json"), JSON.stringify(record, null, 2));
writeFileSync(join(snapshotDir, "preview-hash.txt"), `${previewHash}\n`);
process.stdout.write(`Snapshot saved to ${snapshotDir}\n  preview hash ${previewHash}\n  pyramid ${pyramidChecksum.slice(0, 16)}…\n`);
