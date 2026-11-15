// Central store. A single recompute() path keeps canvas, metrics, status bar,
// debug panel and export payloads permanently in sync.

import { generateSample } from './engine.js';
import { cleanSeries, DEFAULT_RULES } from './cleaning.js';
import {
  WINDOWS,
  splitWindows,
  evaluateWindow,
  buildDataVersion,
  buildExportScope,
  buildCleaningLog,
  buildProject
} from './metrics.js';

const STORAGE_KEY = 'ts-cleaning-monitor/project/v1';

export function createStore() {
  const samples = {
    sampleA: generateSample('sampleA'),
    sampleB: generateSample('sampleB')
  };

  const store = {
    samples,
    sampleId: 'sampleA',
    windowId: 'W1',
    rulesByWindow: {
      W1: { ...DEFAULT_RULES },
      W2: { ...DEFAULT_RULES }
    },
    revision: 0,
    listeners: new Set(),

    // Derived data refreshed atomically by recompute().
    sample: null,
    seriesIds: [],
    rawRows: [],
    pipeline: null,
    cleanedRows: [],
    windows: null,
    windowRows: [],
    windowEvaluation: null,
    dataVersion: '',
    exportScope: null,

    get rules() {
      return this.rulesByWindow[this.windowId];
    },

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },

    notify() {
      for (const listener of this.listeners) listener(this);
    },

    recompute() {
      this.revision += 1;
      this.sample = this.samples[this.sampleId];
      this.seriesIds = this.sample.seriesIds;
      this.rawRows = this.sample.rows;
      this.pipeline = cleanSeries(this.sample, this.rules);
      this.cleanedRows = this.pipeline.cleanedRows;
      this.windows = splitWindows(this.cleanedRows);
      this.windowRows = this.windows[this.windowId];
      this.windowEvaluation = evaluateWindow(
        this.cleanedRows,
        this.windowRows,
        this.seriesIds
      );
      this.dataVersion = buildDataVersion(
        this.sampleId,
        this.pipeline.rules,
        this.cleanedRows
      );
      this.exportScope = buildExportScope(this);
      this.persist();
      this.notify();
    },

    setSample(sampleId) {
      if (!this.samples[sampleId] || sampleId === this.sampleId) return;
      this.sampleId = sampleId;
      this.recompute();
    },

    setWindow(windowId) {
      if (!WINDOWS.some((item) => item.id === windowId)) return;
      this.windowId = windowId;
      this.recompute();
    },

    patchRules(patch) {
      this.rulesByWindow[this.windowId] = {
        ...this.rulesByWindow[this.windowId],
        ...patch
      };
      this.recompute();
    },

    resetRules() {
      this.rulesByWindow[this.windowId] = { ...DEFAULT_RULES };
      this.recompute();
    },

    cleaningLog() {
      return buildCleaningLog(this);
    },

    project() {
      return buildProject(this);
    },

    persist() {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            sampleId: this.sampleId,
            windowId: this.windowId,
            rulesByWindow: this.rulesByWindow,
            revision: this.revision
          })
        );
      } catch {
        // Storage can be unavailable in private mode; export still works.
      }
    },

    restore() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        const saved = JSON.parse(raw);
        this.sampleId = saved.sampleId || this.sampleId;
        this.windowId = saved.windowId || this.windowId;
        for (const windowId of WINDOWS.map((item) => item.id)) {
          this.rulesByWindow[windowId] = {
            ...DEFAULT_RULES,
            ...(saved.rulesByWindow?.[windowId] || {})
          };
        }
        return true;
      } catch {
        return false;
      }
    },

    loadProject(project) {
      if (project?.format !== 'ts-cleaning-monitor/project') {
        throw new Error('无法识别的工程文件格式');
      }
      if (project.samples) this.samples = project.samples;
      this.sampleId = project.sampleId;
      this.windowId = project.activeWindow || 'W1';
      for (const windowId of WINDOWS.map((item) => item.id)) {
        this.rulesByWindow[windowId] = {
          ...DEFAULT_RULES,
          ...(project.rulesByWindow?.[windowId] || {})
        };
      }
      this.recompute();
    }
  };

  store.restore();
  store.recompute();
  return store;
}
