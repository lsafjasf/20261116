import { WINDOWS, STATIONS } from './constants.mjs';
import { cleanDataset } from './clean-data.mjs';
import { computeWindowStats, clampCursor, cursorReadout } from './view-model.mjs';

export class Store {
  constructor(datasets, initialDatasetId = 'A') {
    this.datasets = datasets;
    this.listeners = [];
    this.debugLog = [];
    this.setDataset(initialDatasetId, { silent: true });
    this.windowId = 'FULL';
    this.window = WINDOWS.FULL;
    this.cursorHour = 12;
    this.selectedStations = STATIONS.map((s) => s.id);
    this.manualMarks = [];
    this.recompute({ reason: 'init' });
  }

  subscribe(fn) {
    this.listeners.push(fn);
  }

  pushDebug(event, detail) {
    this.debugLog.push({ t: Date.now(), event, detail });
    if (this.debugLog.length > 200) this.debugLog.shift();
  }

  emit() {
    for (const fn of this.listeners) fn(this.snapshot());
  }

  setDataset(id, opts = {}) {
    this.dataset = this.datasets[id];
    this.clean = cleanDataset(this.dataset);
    this.manualMarks = [];
    if (!opts.silent) this.recompute({ reason: 'dataset', datasetId: id });
  }

  setWindow(windowId) {
    this.windowId = windowId;
    this.window = WINDOWS[windowId];
    const before = this.cursorHour;
    this.cursorHour = clampCursor(this.cursorHour, this.window);
    this.recompute({ reason: 'window', windowId, cursorClamped: before !== this.cursorHour });
  }

  setCursor(hour) {
    const next = clampCursor(hour, this.window);
    if (next === this.cursorHour) return;
    this.cursorHour = next;
    this.recompute({ reason: 'cursor', cursorHour: next });
  }

  toggleStation(stationId) {
    const has = this.selectedStations.includes(stationId);
    if (has && this.selectedStations.length === 1) return; // 至少保留一个
    this.selectedStations = has
      ? this.selectedStations.filter((id) => id !== stationId)
      : [...this.selectedStations, stationId].sort();
    this.recompute({ reason: 'station-filter', selectedStations: this.selectedStations });
  }

  toggleManualMark(stationId, field, hour) {
    const idx = this.manualMarks.findIndex(
      (m) => m.stationId === stationId && m.field === field && m.hour === hour);
    if (idx >= 0) {
      this.manualMarks.splice(idx, 1);
    } else {
      const slot = this.clean.byStation[stationId][hour];
      const value = slot.values[field];
      if (value !== null) this.manualMarks.push({ stationId, field, hour, value });
    }
    this.recompute({ reason: 'manual-mark', marks: this.manualMarks.length });
  }

  recompute(debugContext) {
    const stats = computeWindowStats(this.clean, this.window);
    const readout = cursorReadout(this.clean, this.cursorHour);
    this.stats = stats;
    this.readout = readout;
    this.pushDebug('recompute', {
      ...debugContext,
      window: { id: this.windowId, start: this.window.start, end: this.window.end },
      cursorHour: this.cursorHour,
      validCounts: Object.fromEntries(
        Object.entries(stats.perStation).map(([sid, e]) => [sid, {
          tempC: e.fields.tempC.count, precipMm: e.fields.precipMm.count,
          windDirDeg: e.fields.windDirDeg.count
        }])),
      gapCount: stats.gaps.length,
      peakCount: stats.peaks.length
    });
    if (this.listeners.length > 0) this.emit();
  }

  snapshot() {
    return {
      dataset: this.dataset, clean: this.clean,
      windowId: this.windowId, window: this.window,
      cursorHour: this.cursorHour,
      selectedStations: [...this.selectedStations],
      stats: this.stats, readout: this.readout,
      manualMarks: this.manualMarks,
      debugLog: this.debugLog
    };
  }
}
