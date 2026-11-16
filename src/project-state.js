import { DEFAULT_THEME } from "./renderer.js";
import { ZOOM_LEVELS } from "./time-scale.js";

/**
 * Serializable project document.
 *
 * Layer order, keyframes, viewport coordinates and theme colors are all part
 * of the document. A content hash plus schema version lets reload verify
 * byte-for-byte equivalence with the pre-export snapshot.
 */

export const SCHEMA_VERSION = 1;

export const DEFAULT_LAYERS = Object.freeze([
  { id: "grid", name: "Time grid", visible: true },
  { id: "waveform", name: "Waveform", visible: true },
  { id: "selection", name: "Selection", visible: true },
  { id: "playhead", name: "Playhead", visible: true }
]);

export function createProject({
  name = "ten-minute-waveform",
  width = 960,
  height = 320,
  audio = {},
  viewport = { zoomId: "overview", scrollSec: 0 },
  layers = DEFAULT_LAYERS.map((layer) => ({ ...layer })),
  keyframes = [],
  theme = { ...DEFAULT_THEME },
  overlay = { playheadSec: 0, selection: null }
} = {}) {
  const project = {
    schemaVersion: SCHEMA_VERSION,
    name,
    canvas: { width, height },
    audio: {
      sampleRate: audio.sampleRate ?? 44100,
      durationSec: audio.durationSec ?? 600,
      seed: audio.seed ?? "uid634-ten-minutes",
      pyramidChecksum: audio.pyramidChecksum ?? null
    },
    viewport,
    layers,
    keyframes,
    theme,
    overlay
  };
  project.contentHash = hashProject(project);
  return project;
}

export function addKeyframe(project, keyframe) {
  if (!Number.isFinite(keyframe.timeSec) || keyframe.timeSec < 0) {
    throw new Error("Keyframe timeSec must be a non-negative finite number");
  }
  const record = {
    id: keyframe.id ?? `kf-${project.keyframes.length + 1}`,
    timeSec: keyframe.timeSec,
    layerId: keyframe.layerId ?? "playhead",
    x: keyframe.x ?? 0,
    y: keyframe.y ?? 0,
    color: keyframe.color ?? project.theme.playhead
  };
  project.keyframes.push(record);
  project.keyframes.sort((a, b) => a.timeSec - b.timeSec);
  project.contentHash = hashProject(project);
  return record;
}

export function serializeProject(project) {
  return JSON.stringify(project, null, 2);
}

export function deserializeProject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Project document is not valid JSON: ${error.message}`);
  }
  validateProject(parsed);
  const expectedHash = parsed.contentHash;
  const actualHash = hashProject(parsed);
  if (expectedHash !== actualHash) {
    throw new Error(`Project integrity check failed: hash ${actualHash} != ${expectedHash}`);
  }
  return parsed;
}

export function validateProject(project) {
  if (!project || project.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported schema version (expected ${SCHEMA_VERSION})`);
  }
  if (!Array.isArray(project.layers) || project.layers.length === 0) {
    throw new Error("Project must define at least one layer");
  }
  const ids = new Set();
  for (const layer of project.layers) {
    if (!layer.id || ids.has(layer.id)) throw new Error(`Duplicate or missing layer id: ${layer.id}`);
    ids.add(layer.id);
  }
  if (!project.canvas || project.canvas.width <= 0 || project.canvas.height <= 0) {
    throw new Error("Project canvas dimensions must be positive");
  }
  if (!ZOOM_LEVELS.some((level) => level.id === project.viewport.zoomId)) {
    throw new Error(`Unknown zoom id: ${project.viewport.zoomId}`);
  }
  for (const keyframe of project.keyframes) {
    if (!ids.has(keyframe.layerId)) throw new Error(`Keyframe references unknown layer: ${keyframe.layerId}`);
    if (!/^#[0-9a-f]{6}$/i.test(keyframe.color)) throw new Error(`Invalid keyframe color: ${keyframe.color}`);
  }
  return true;
}

/** Stable FNV-1a over canonical JSON (excludes the hash field itself). */
export function hashProject(project) {
  const { contentHash, ...rest } = project;
  const canonical = JSON.stringify(rest, stableReplacer);
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableReplacer(key, value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value)
      .sort()
      .reduce((sorted, subKey) => {
        sorted[subKey] = value[subKey];
        return sorted;
      }, {});
  }
  return value;
}
