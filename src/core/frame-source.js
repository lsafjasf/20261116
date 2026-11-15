import { getCropRect, renderProjectFrame } from "./renderer.js";

export function createFrameSource({
  latencyMs = 24,
  jitterMs = 18,
  random = Math.random,
} = {}) {
  const failure = {
    remaining: 0,
    always: false,
    corruptRemaining: 0,
    latencyMs,
    jitterMs,
    sequence: 0,
  };

  async function loadFrame(request) {
    const started = performance.now();
    const delay = Math.max(0, failure.latencyMs + Math.round(random() * failure.jitterMs));
    await abortableDelay(delay, request.signal);
    failure.sequence += 1;
    if (failure.always || failure.remaining > 0) {
      if (!failure.always) failure.remaining -= 1;
      throw new Error("模拟缩略帧解码失败");
    }

    const canvas = document.createElement("canvas");
    canvas.width = request.width;
    canvas.height = request.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("当前浏览器无法创建 2D 画布");
    renderProjectFrame(context, request.project, request.timeMs, {
      width: request.width,
      height: request.height,
      cropAspect: request.cropAspect,
      overlay: true,
    });

    let timeMs = request.timeMs;
    if (failure.corruptRemaining > 0) {
      failure.corruptRemaining -= 1;
      timeMs = Math.min(request.project.durationMs, request.timeMs + 1_000);
    }
    return {
      canvas,
      key: request.key,
      revision: request.revision,
      timeMs,
      width: request.width,
      height: request.height,
      cropAspect: request.cropAspect,
      crop: getCropRect(request.project, request.cropAspect),
      decodeMs: performance.now() - started,
    };
  }

  return {
    loadFrame,
    failure,
    failNext(count = 1, { always = false } = {}) {
      failure.remaining = Math.max(0, count);
      failure.always = always;
    },
    corruptNext(count = 1) {
      failure.corruptRemaining = Math.max(0, count);
    },
    setLatency(milliseconds, jitter = 0) {
      failure.latencyMs = Math.max(0, milliseconds);
      failure.jitterMs = Math.max(0, jitter);
    },
    recover() {
      failure.remaining = 0;
      failure.always = false;
      failure.corruptRemaining = 0;
    },
  };
}

function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("frame request aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("frame request aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
