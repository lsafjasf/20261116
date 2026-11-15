import { resultWithoutMask, vectorizeSample } from "./vectorizer.js";

self.addEventListener("message", (event) => {
  try {
    const { requestId, sample, params } = event.data;
    const result = vectorizeSample(sample, params);
    self.postMessage({ requestId, ok: true, result: resultWithoutMask(result) });
  } catch (error) {
    self.postMessage({
      requestId: event.data?.requestId || null,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
