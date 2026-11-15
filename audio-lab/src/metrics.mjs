// Single source of truth for every observable metric shown in the UI and used
// by the regression comparisons. Snapshotting on every scene switch makes the
// node/memory trend over 20 switches directly inspectable.

export class MetricsCollector {
  constructor() {
    this.errors = [];
    this.snapshots = [];
  }

  recordError(entry) {
    this.errors.push({
      at: Date.now(),
      where: entry.where || 'unknown',
      message: entry.error?.message || String(entry.error || entry.message),
    });
  }

  snapshot(label, manager, controller, cache, extra = {}) {
    const stats = manager.stats;
    const frame = controller.frameStats;
    const point = {
      label,
      activeNodes: stats.activeNodes,
      activeConnections: stats.activeConnections,
      activeListeners: stats.activeListeners,
      candidates: stats.candidates,
      releases: stats.releases,
      suppressedCallbacks: stats.suppressedCallbacks,
      cacheHitRate: cache.hitRate,
      frameLastMs: frame.last,
      frameAvgMs: frame.avg,
      frameMaxMs: frame.max,
      heapBytes: readHeapBytes(),
      errors: this.errors.length,
      ...extra,
    };
    this.snapshots.push(point);
    return point;
  }

  get latest() {
    return this.snapshots[this.snapshots.length - 1] || null;
  }

  summarize() {
    const series = this.snapshots;
    if (series.length === 0) return null;
    const first = series[0];
    const last = series[series.length - 1];
    const peakNodes = Math.max(...series.map((p) => p.activeNodes));
    const peakHeap = Math.max(...series.map((p) => p.heapBytes));
    return {
      samples: series.length,
      firstActiveNodes: first.activeNodes,
      lastActiveNodes: last.activeNodes,
      peakActiveNodes: peakNodes,
      firstConnections: first.activeConnections,
      lastConnections: last.activeConnections,
      lastListeners: last.activeListeners,
      totalReleases: last.releases,
      totalCandidates: last.candidates,
      suppressedCallbacks: last.suppressedCallbacks,
      finalCacheHitRate: last.cacheHitRate,
      peakHeapBytes: peakHeap,
      lastHeapBytes: last.heapBytes,
      firstHeapBytes: first.heapBytes,
      avgFrameMs: last.frameAvgMs,
      maxFrameMs: last.frameMaxMs,
      errorCount: this.errors.length,
    };
  }
}

export function readHeapBytes() {
  if (typeof performance !== 'undefined' && performance.memory?.usedJSHeapSize) {
    return performance.memory.usedJSHeapSize;
  }
  if (typeof process !== 'undefined' && process.memoryUsage) {
    return process.memoryUsage().heapUsed;
  }
  return 0;
}

const METRIC_FIELDS = [
  ['activeNodes', '活动节点'],
  ['activeConnections', '活动连接'],
  ['activeListeners', '活动监听器'],
  ['frameLastMs', '帧时间(ms)'],
  ['candidates', '候选释放数'],
  ['cacheHitRate', '缓存命中率'],
  ['suppressedCallbacks', '拦截回调'],
  ['heapBytes', '堆内存(B)'],
  ['errors', '异常数'],
];

export class MetricsRenderer {
  constructor(rootElement) {
    this.root = rootElement;
    this.rows = new Map();
    this._buildGrid();
  }

  _buildGrid() {
    const grid = document.createElement('div');
    grid.className = 'metric-grid';
    for (const [key, label] of METRIC_FIELDS) {
      const cell = document.createElement('div');
      cell.className = 'metric-cell';
      const name = document.createElement('span');
      name.className = 'metric-name';
      name.textContent = label;
      const value = document.createElement('span');
      value.className = 'metric-value';
      value.dataset.metric = key;
      cell.append(name, value);
      grid.append(cell);
      this.rows.set(key, value);
    }
    this.root.append(grid);
  }

  render(snapshot) {
    for (const [key, element] of this.rows) {
      const raw = snapshot?.[key];
      element.textContent = key === 'cacheHitRate'
        ? `${((raw ?? 0) * 100).toFixed(1)}%`
        : formatNumber(raw);
    }
  }
}

function formatNumber(value) {
  if (typeof value !== 'number') return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}
