export const FALLBACK_MESSAGES = Object.freeze({
  EXPIRED: "缓存已过期，已从工程源数据重建",
  VERSION: "缓存版本失效，已丢弃旧内容并自动重建",
  INVALID: "缓存内容损坏，已丢弃旧内容并自动重建",
  REQUEST: "异步请求失败，已切换到本地工程数据",
  TIMEOUT: "异步请求超时，已切换到本地工程数据",
  THUMBNAIL: "缩略图解码失败，已显示颜色占位缩略图",
});

export class VersionedResourceCache {
  constructor({ ttlMs = 5000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  invalidate(key, reason = "manual") {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    return { invalidated: Boolean(entry), reason };
  }

  bumpVersion(key) {
    const entry = this.entries.get(key);
    if (entry) entry.version += 1;
  }

  async getOrLoad(key, options) {
    const {
      version = 1,
      signature = key,
      loader,
      fallback,
      validate = () => true,
      timeoutMs = 1200,
      forceInvalid = false,
    } = options;
    const entry = this.entries.get(key);
    let reason = null;
    if (forceInvalid) reason = FALLBACK_MESSAGES.INVALID;
    else if (entry && entry.version !== version) reason = FALLBACK_MESSAGES.VERSION;
    else if (entry && entry.signature !== signature) reason = FALLBACK_MESSAGES.VERSION;
    else if (entry && this.now() - entry.createdAt > this.ttlMs) reason = FALLBACK_MESSAGES.EXPIRED;
    else if (entry && !validate(entry.value)) reason = FALLBACK_MESSAGES.INVALID;

    if (reason) this.entries.delete(key);
    if (entry && !reason) return { value: entry.value, source: "cache", stale: false, message: null };

    try {
      const value = await promiseWithTimeout(Promise.resolve().then(loader), timeoutMs);
      if (!validate(value)) throw new Error("resource validation failed");
      this.entries.set(key, {
        value,
        version,
        signature,
        createdAt: this.now(),
      });
      return {
        value,
        source: "network",
        stale: false,
        message: reason,
      };
    } catch (error) {
      this.entries.delete(key);
      const timedOut = error?.code === "TIMEOUT";
      const message = reason ?? (timedOut ? FALLBACK_MESSAGES.TIMEOUT : FALLBACK_MESSAGES.REQUEST);
      if (typeof fallback !== "function") throw error;
      const value = await fallback({
        reason,
        error,
        message,
        timedOut,
      });
      return {
        value,
        source: "fallback",
        stale: false,
        message,
        error: error?.message ?? String(error),
      };
    }
  }
}

export function promiseWithTimeout(promise, timeoutMs = 1200) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error("Resource request timed out");
      error.code = "TIMEOUT";
      reject(error);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createThumbnailFallback(frame, reason = FALLBACK_MESSAGES.THUMBNAIL) {
  const color = frame?.colors?.[0] ?? "#6b7280";
  return {
    kind: "placeholder",
    id: frame?.id ?? "unknown",
    label: (frame?.id ?? "?").split("-").at(-1),
    color,
    message: reason,
  };
}
