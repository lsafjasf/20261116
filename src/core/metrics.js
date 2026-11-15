// Rolling performance counters. At least three observable metrics are always
// available; we keep four: frame time, open-set candidates, cache hit rate
// and expanded nodes.
export class Metrics {
  constructor({ windowSize = 60 } = {}) {
    this.windowSize = windowSize;
    this.frameTimes = [];
    this.candidateSamples = [];
    this.last = {
      frameMs: 0,
      candidates: 0,
      hitRate: 0,
      nodesExpanded: 0,
      queries: 0,
    };
  }

  recordFrame(frameMs, pathService) {
    this.frameTimes.push(frameMs);
    if (this.frameTimes.length > this.windowSize) {
      this.frameTimes.shift();
    }
    const candidates = pathService ? pathService.candidatesPeak : 0;
    this.candidateSamples.push(candidates);
    if (this.candidateSamples.length > this.windowSize) {
      this.candidateSamples.shift();
    }
    this.last = {
      frameMs,
      candidates,
      hitRate: pathService ? pathService.cache.hitRate : 0,
      nodesExpanded: pathService ? pathService.nodesExpanded : 0,
      queries: pathService ? pathService.queries : 0,
    };
    return this.snapshot();
  }

  average(list) {
    if (list.length === 0) {
      return 0;
    }
    return list.reduce((sum, value) => sum + value, 0) / list.length;
  }

  snapshot() {
    return {
      frameMs: round3(this.last.frameMs),
      avgFrameMs: round3(this.average(this.frameTimes)),
      candidates: this.last.candidates,
      avgCandidates: round3(this.average(this.candidateSamples)),
      hitRate: round3(this.last.hitRate),
      nodesExpanded: this.last.nodesExpanded,
      queries: this.last.queries,
    };
  }
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

export function nowMs() {
  const hr = process.hrtime ? process.hrtime() : null;
  if (hr) {
    return hr[0] * 1000 + hr[1] / 1e6;
  }
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}
