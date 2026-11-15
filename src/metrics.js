function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1);
  return sorted[index];
}

export class LiveMetrics {
  constructor(windowSize = 90) {
    this.windowSize = windowSize;
    this.reset();
  }

  reset() {
    this.frames = [];
    this.candidates = [];
    this.hits = 0;
    this.lookups = 0;
    this.totalCandidates = 0;
    this.errors = 0;
  }

  record({ elapsed, candidates, cacheHit, cacheEnabled }) {
    this.frames.push(elapsed);
    this.candidates.push(candidates);
    this.totalCandidates += candidates;
    this.lookups += 1;
    if (cacheEnabled && cacheHit) this.hits += 1;
    if (this.frames.length > this.windowSize) this.frames.shift();
    if (this.candidates.length > this.windowSize) this.candidates.shift();
  }

  recordError() {
    this.errors += 1;
  }

  snapshot() {
    const sorted = [...this.frames].sort((a, b) => a - b);
    const frameAvg = this.frames.length
      ? this.frames.reduce((sum, value) => sum + value, 0) / this.frames.length
      : 0;
    const candidateAvg = this.candidates.length
      ? this.candidates.reduce((sum, value) => sum + value, 0) / this.candidates.length
      : 0;
    return {
      frameAvg,
      frameP95: percentile(sorted, 0.95),
      frameMax: sorted[sorted.length - 1] || 0,
      candidateAvg,
      candidateTotal: this.totalCandidates,
      hitRate: this.lookups ? this.hits / this.lookups : 0,
      hits: this.hits,
      lookups: this.lookups,
      errors: this.errors,
      samples: [...this.frames]
    };
  }
}

export function drawSparkline(canvas, samples) {
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  context.strokeStyle = "rgba(255,255,255,0.055)";
  context.lineWidth = 1;
  for (let row = 1; row < 4; row += 1) {
    const y = (height / 4) * row + 0.5;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  if (!samples.length) return;
  const max = Math.max(1, ...samples) * 1.12;
  const step = width / Math.max(1, samples.length - 1);
  const points = samples.map((value, index) => ({
    x: index * step,
    y: height - Math.min(height, (value / max) * height)
  }));

  const fill = context.createLinearGradient(0, 0, 0, height);
  fill.addColorStop(0, "rgba(244,182,98,0.22)");
  fill.addColorStop(1, "rgba(244,182,98,0)");
  context.beginPath();
  context.moveTo(points[0].x, height);
  for (const point of points) context.lineTo(point.x, point.y);
  context.lineTo(points[points.length - 1].x, height);
  context.closePath();
  context.fillStyle = fill;
  context.fill();

  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.strokeStyle = "#f4b662";
  context.lineWidth = 1.5;
  context.stroke();

  const last = points[points.length - 1];
  context.fillStyle = "#f4b662";
  context.beginPath();
  context.arc(last.x, last.y, 2.2, 0, Math.PI * 2);
  context.fill();
}
