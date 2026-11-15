import {
  buildSignature,
  normalizeParams,
  resultWithoutMask,
  vectorizeSample
} from "./vectorizer.js";
import { readVectorCache, writeVectorCache } from "./storage.js";

function cloneSampleForWorker(sample) {
  return {
    id: sample.id,
    name: sample.name,
    width: sample.width,
    height: sample.height,
    gray: sample.gray.slice(),
    referenceMask: sample.referenceMask?.slice(),
    thinLineMask: sample.thinLineMask?.slice(),
    speckMask: sample.speckMask?.slice()
  };
}

function defaultWorkerFactory() {
  return new Worker(new URL("./vectorizer.worker.js", import.meta.url), { type: "module" });
}

function runInWorker(sample, params, options = {}) {
  const factory = options.workerFactory || defaultWorkerFactory;
  const timeoutMs = options.timeoutMs || 4000;
  return new Promise((resolve, reject) => {
    let worker;
    let settled = false;
    const requestId = `vector-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        worker?.terminate();
      } catch {
        // Terminating an already-closed worker is harmless.
      }
      callback(value);
    };
    const timeout = setTimeout(() => {
      finish(reject, new Error("矢量化 Worker 超时"));
    }, timeoutMs);
    try {
      worker = factory();
      if (!worker || typeof worker.postMessage !== "function") {
        throw new Error("浏览器不支持矢量化 Worker");
      }
      worker.addEventListener("message", (event) => {
        if (event.data?.requestId !== requestId) return;
        if (event.data.ok) finish(resolve, event.data.result);
        else finish(reject, new Error(event.data.error || "Worker 计算失败"));
      });
      worker.addEventListener("error", (event) => {
        finish(reject, new Error(event.message || "Worker 启动失败"));
      });
      worker.postMessage({ requestId, sample: cloneSampleForWorker(sample), params });
    } catch (error) {
      finish(reject, error);
    }
  });
}

export async function vectorizeWithRecovery(sample, paramsInput, options = {}) {
  const notify = options.notify || (() => {});
  const storage = options.storage;
  const normalized = normalizeParams(paramsInput);
  const params = normalized.params;
  const mergeWarnings = (result) => {
    if (!result) return result;
    const warnings = [...normalized.warnings, ...(result.warnings || [])];
    return { ...result, warnings: [...new Set(warnings)] };
  };
  const signature = buildSignature(sample, params);
  const cacheResult = readVectorCache(signature, storage);
  if (cacheResult.value) {
    return { result: mergeWarnings(cacheResult.value), source: "cache", recovered: false };
  }
  if (cacheResult.stale) {
    notify({
      level: "warning",
      title: "缓存已回退",
      message: `${cacheResult.error.message}，已绕过旧缓存重新矢量化。`
    });
  }

  let result;
  let source = "worker";
  let recovered = false;
  try {
    if (options.disableWorker) throw new Error("Worker 已禁用");
    result = await runInWorker(sample, params, options);
  } catch (error) {
    recovered = true;
    source = "main-thread-fallback";
    notify({
      level: "warning",
      title: "异步计算已回退",
      message: `${error.message}；已自动切换到本地线程，结果不中断。`
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    result = resultWithoutMask(vectorizeSample(sample, params));
  }
  result = mergeWarnings(result);
  writeVectorCache(signature, resultWithoutMask(result), storage);
  return { result, source, recovered, signature };
}

export function attachThumbnailFallback(image, notify, label) {
  if (!image) return;
  image.dataset.fallbackAttempted = "false";
  image.addEventListener("error", () => {
    if (image.dataset.fallbackAttempted === "true") return;
    image.dataset.fallbackAttempted = "true";
    import("./storage.js").then(({ fallbackThumbnail }) => {
      image.src = fallbackThumbnail(label || "缩略图已回退");
      image.classList.add("is-fallback");
      notify?.({
        level: "warning",
        title: "缩略图已回退",
        message: "缩略图加载失败，已显示可识别的矢量占位图。"
      });
    }).catch(() => {
      image.classList.add("is-unavailable");
      image.alt = label || "缩略图不可用";
    });
  });
}
