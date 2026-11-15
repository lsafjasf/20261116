import { normalizeScene, sceneDigest } from "./core.js";

const PROJECT_KEY = "seamlab.project.v4";
const SNAPSHOT_KEY = "seamlab.snapshots.v4";
const RELOAD_KEY = "seamlab.reloadCheck.v4";

function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function loadProject() {
  try {
    const raw = localStorage.getItem(PROJECT_KEY);
    if (!raw) return { scene: null, restored: false };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.layers)) {
      throw new Error("工程结构不完整");
    }
    return { scene: normalizeScene(parsed), restored: true };
  } catch (error) {
    try {
      localStorage.removeItem(PROJECT_KEY);
    } catch {
      // Storage can be blocked entirely; the app still boots with defaults.
    }
    return { scene: null, restored: false, error: error.message };
  }
}

export function saveProject(scene) {
  try {
    localStorage.setItem(PROJECT_KEY, JSON.stringify(scene));
    return { ok: true, at: new Date().toISOString() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function readSnapshots() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "[]");
    if (!Array.isArray(parsed)) throw new Error("快照索引格式错误");
    return parsed.filter((item) => item && item.scene && item.id);
  } catch {
    try {
      localStorage.removeItem(SNAPSHOT_KEY);
    } catch {
      // Ignore blocked storage.
    }
    return [];
  }
}

export function writeSnapshots(snapshots) {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots.slice(0, 12)));
    return true;
  } catch {
    return false;
  }
}

export function createSnapshot(scene, reason = "导出前自动留档", size = scene.exportSize) {
  const createdAt = new Date().toISOString();
  const snapshot = {
    id: `snap-${Date.now().toString(36)}`,
    createdAt,
    reason,
    size,
    digest: sceneDigest(scene),
    scene: clone(scene)
  };
  const snapshots = readSnapshots();
  snapshots.unshift(snapshot);
  const stored = writeSnapshots(snapshots);
  return { snapshot, stored, snapshots: readSnapshots() };
}

export function clearSnapshots() {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    // Ignore.
  }
}

export function prepareReloadCheck(scene) {
  const digest = sceneDigest(scene);
  try {
    sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ digest, at: Date.now() }));
  } catch {
    // The reload can still proceed; verification will be reported as unavailable.
  }
  return digest;
}

export function consumeReloadCheck(scene) {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(RELOAD_KEY);
    const previous = JSON.parse(raw);
    const current = sceneDigest(scene);
    return {
      ok: previous.digest === current,
      previous: previous.digest,
      current,
      at: previous.at
    };
  } catch {
    return { ok: false, error: "重载校验记录不可用" };
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(text, filename, type = "application/json") {
  downloadBlob(new Blob([text], { type }), filename);
}
