// Save/restore the whole session: both players' input timeline, the shared
// rig state, durability, film and photo progress. The same blob is used in
// Node tests (injected storage) and the browser (window.localStorage).

const KEY = 'camera-rig-save-v1';

export function serializeSession({ timeline, mode, order, label }) {
  return JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    mode,
    order,
    label,
    initial: timeline.initial,
    frames: timeline.frames,
    state: timeline.state,
  });
}

export function saveSession(bundle, storage = globalThis.localStorage) {
  storage.setItem(KEY, serializeSession(bundle));
  return bundle;
}

export function loadSession(storage = globalThis.localStorage) {
  const raw = storage.getItem(KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (parsed.version !== 1) throw new Error(`unknown save version ${parsed.version}`);
  return parsed;
}

export function clearSession(storage = globalThis.localStorage) {
  storage.removeItem(KEY);
}

export function storageKey() {
  return KEY;
}

// In-memory storage used by the Node test suite and as a fallback when the
// browser blocks localStorage.
export function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}
