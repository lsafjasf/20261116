import { SAVE_VERSION, createInitialState } from "./simulation.js";
import { parseTimeline, serializeTimeline } from "./timeline.js";

export const STORAGE_KEY = "dual-cockpit-flight-v1";

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function hydrateState(rawState) {
  const base = createInitialState();
  if (!rawState || typeof rawState !== "object") return base;
  const saved = rawState;
  base.tick = Math.max(0, finite(saved.tick, 0));
  base.time = Math.max(0, finite(saved.time, 0));
  base.stage = saved.stage || base.stage;
  base.progress = Math.max(0, Math.min(100, finite(saved.progress, 0)));
  base.x = finite(saved.x, 0);
  base.altitude = Math.max(0, finite(saved.altitude, 0));
  base.verticalSpeed = finite(saved.verticalSpeed, 0);
  base.speed = Math.max(0, finite(saved.speed, 0));
  base.pitch = finite(saved.pitch, 0);
  base.roll = finite(saved.roll, 0);
  base.mode = saved.mode || base.mode;

  Object.assign(base.controls.left, saved.controls?.left || {});
  Object.assign(base.controls.right, saved.controls?.right || {});
  Object.assign(base.engine, saved.engine || {});
  Object.assign(base.hydraulic, saved.hydraulic || {});
  Object.assign(base.shared, saved.shared || {});
  Object.assign(base.mission, saved.mission || {});
  if (saved.lastCollision) base.lastCollision = { ...saved.lastCollision };
  return base;
}

export function createSavePayload(state, timeline, options = {}) {
  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    state,
    timeline: serializeTimeline(timeline),
    replayMode: options.replayMode || null,
    selectedDemo: options.selectedDemo || null
  };
}

export function parseSavePayload(raw) {
  if (!raw) return null;
  try {
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!payload || payload.version !== SAVE_VERSION) return null;
    const timeline = parseTimeline(payload.timeline);
    if (!timeline) return null;
    return {
      ...payload,
      state: hydrateState(payload.state),
      timeline
    };
  } catch {
    return null;
  }
}

export function saveToStorage(storage, state, timeline, options = {}) {
  if (!storage) return false;
  const payload = createSavePayload(state, timeline, options);
  storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  return true;
}

export function loadFromStorage(storage) {
  if (!storage) return null;
  return parseSavePayload(storage.getItem(STORAGE_KEY));
}

export function clearStorage(storage) {
  if (storage) storage.removeItem(STORAGE_KEY);
}
