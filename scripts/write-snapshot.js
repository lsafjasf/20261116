import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDefaultProject, createSnapshot, projectFingerprint } from "../src/core/project.js";

const project = createDefaultProject();
const snapshot = createSnapshot(
  project,
  {
    currentTimeMs: 0,
    cropAspect: "16:9",
    zoom: 1,
    selectedLayerId: project.layers.at(-1).id,
  },
  "before-export",
);
const outputDirectory = fileURLToPath(new URL("../snapshots/", import.meta.url));
const outputPath = `${outputDirectory}pre-export-default.json`;
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(`snapshot: ${outputPath}`);
console.log(`fingerprint: ${projectFingerprint(project)}`);
