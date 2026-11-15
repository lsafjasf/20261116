const PROJECT_KEY = "inktrace.project.v1";
const SNAPSHOT_KEY = "inktrace.snapshots.v1";
const CACHE_KEY = "inktrace.cache.v1";
export const STORAGE_SCHEMA = 1;

function storageOrNull(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function readJson(storage, key, fallback) {
  const target = storageOrNull(storage);
  if (!target) return { value: fallback, error: new Error("浏览器存储不可用") };
  try {
    const raw = target.getItem(key);
    if (!raw) return { value: fallback, error: null };
    return { value: JSON.parse(raw), error: null };
  } catch (error) {
    return { value: fallback, error };
  }
}

export function writeJson(storage, key, value) {
  const target = storageOrNull(storage);
  if (!target) return { ok: false, error: new Error("浏览器存储不可用") };
  try {
    target.setItem(key, JSON.stringify(value));
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error };
  }
}

export function saveProject(project, storage) {
  return writeJson(storage, PROJECT_KEY, project);
}

export function loadProject(storage) {
  return readJson(storage, PROJECT_KEY, null);
}

export function clearSavedProject(storage) {
  try {
    storageOrNull(storage)?.removeItem(PROJECT_KEY);
    return true;
  } catch {
    return false;
  }
}

export function readSnapshots(storage) {
  const result = readJson(storage, SNAPSHOT_KEY, []);
  if (!Array.isArray(result.value)) {
    return { value: [], error: new Error("快照索引格式损坏") };
  }
  return result;
}

export function writeSnapshot(project, label, storage, reason = "manual") {
  const snapshots = readSnapshots(storage);
  const snapshot = {
    schema: STORAGE_SCHEMA,
    id: `snapshot-${Date.now()}`,
    label,
    reason,
    createdAt: new Date().toISOString(),
    project
  };
  const next = [snapshot, ...(snapshots.value || [])].slice(0, 12);
  const writeResult = writeJson(storage, SNAPSHOT_KEY, next);
  return { snapshot, reason, ...writeResult, warning: snapshots.error?.message || null };
}

export function deleteSnapshot(id, storage) {
  const snapshots = readSnapshots(storage);
  writeJson(storage, SNAPSHOT_KEY, (snapshots.value || []).filter((item) => item.id !== id));
}

export function readVectorCache(signature, storage) {
  const result = readJson(storage, CACHE_KEY, {});
  if (result.error) return { value: null, error: result.error, stale: true };
  if (!result.value || (typeof result.value === "object" && Object.keys(result.value).length === 0)) {
    return { value: null, error: null, stale: false };
  }
  if (result.value.schema !== STORAGE_SCHEMA) {
    return { value: null, error: new Error("缓存版本不匹配"), stale: true };
  }
  const entry = result.value.entries?.[signature];
  if (!entry) return { value: null, error: null, stale: false };
  if (entry.signature !== signature || !Array.isArray(entry.result?.paths)) {
    return { value: null, error: new Error("缓存内容损坏"), stale: true };
  }
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    return { value: null, error: new Error("缓存已过期"), stale: true };
  }
  return { value: entry.result, error: null, stale: false };
}

export function writeVectorCache(signature, result, storage, ttlMs = 1000 * 60 * 60 * 24) {
  const current = readJson(storage, CACHE_KEY, {});
  const base = current.error || !current.value?.entries ? {} : current.value.entries;
  const entries = { ...base };
  entries[signature] = {
    signature,
    expiresAt: Date.now() + ttlMs,
    result
  };
  const keys = Object.keys(entries);
  if (keys.length > 20) {
    keys
      .sort((a, b) => (entries[a].expiresAt || 0) - (entries[b].expiresAt || 0))
      .slice(0, keys.length - 20)
      .forEach((key) => delete entries[key]);
  }
  return writeJson(storage, CACHE_KEY, { schema: STORAGE_SCHEMA, entries });
}

export function consumeCachedResult(signature, storage, notify) {
  const cache = readVectorCache(signature, storage);
  if (cache.stale) {
    notify?.({
      level: "warning",
      title: "缓存已回退",
      message: `${cache.error.message}，正在重新计算矢量结果。`
    });
  }
  return cache.value;
}

export function fallbackThumbnail(label = "预览不可用") {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100"><rect width="160" height="100" rx="10" fill="#ece9e2"/><path d="M34 68L62 38l22 19 20-27 22 38" fill="none" stroke="#9b958a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="50" cy="32" r="5" fill="none" stroke="#9b958a" stroke-width="2"/><text x="80" y="91" font-family="sans-serif" font-size="9" text-anchor="middle" fill="#777168">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
