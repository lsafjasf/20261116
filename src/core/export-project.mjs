import { EXPORT_SPEC } from './constants.mjs';

export function countObjects(value) {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countObjects(item), 1);
  }
  if (value && typeof value === 'object') {
    return 1 + Object.values(value).reduce((sum, v) => sum + countObjects(v), 0);
  }
  return 0;
}

// 确定性哈希（FNV-1a），字段顺序固定，保证同一数据导出前后校验和一致
export function checksum(value) {
  const json = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// state: { dataset, clean, windowId, window, cursorHour, selectedStations,
//          stats, readout, manualMarks }
export function buildReport(state) {
  const { dataset, clean } = state;
  const slotList = [...clean.slots.values()].map((s) => ({
    stationId: s.stationId, hour: s.hour, values: { ...s.values }, reasons: { ...s.reasons }
  }));

  const filteredPeaks = state.stats.peaks
    .filter((p) => state.selectedStations.includes(p.stationId));

  const dataPayload = {
    spec: EXPORT_SPEC,
    dataVersion: dataset.version,
    datasetId: dataset.id,
    baseDate: dataset.baseDate,
    filters: {
      windowId: state.windowId,
      windowStart: state.window.start,
      windowEnd: state.window.end,
      cursorHour: state.cursorHour,
      selectedStations: [...state.selectedStations].sort()
    },
    audit: clean.audit,
    quarantine: clean.quarantine.map((q) => ({ ...q })),
    slots: slotList,
    windowStats: state.stats.perStation,
    peaks: filteredPeaks.map((p) => ({ ...p })),
    manualMarks: state.manualMarks.map((m) => ({ ...m })),
    readout: state.readout.filter((r) => state.selectedStations.includes(r.stationId))
  };

  return {
    ...dataPayload,
    integrity: {
      objectCount: countObjects(dataPayload),
      slotCount: slotList.length,
      peakCount: filteredPeaks.length,
      checksum: checksum(dataPayload)
    }
  };
}

export function saveProject(state) {
  return JSON.stringify({
    projectSpec: 'meteo-timeline-project/v1',
    savedAt: new Date().toISOString(),
    state: {
      datasetId: state.dataset.id,
      windowId: state.windowId,
      cursorHour: state.cursorHour,
      selectedStations: [...state.selectedStations].sort(),
      manualMarks: state.manualMarks.map((m) => ({ ...m }))
    }
  }, null, 2);
}

export function loadProject(json) {
  const parsed = JSON.parse(json);
  if (parsed.projectSpec !== 'meteo-timeline-project/v1') {
    throw new Error('工程文件口径不匹配');
  }
  return parsed.state;
}
