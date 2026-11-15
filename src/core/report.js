import { EXPORT_SCOPE } from './constants.js';

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

export function checksum(value) {
  let hash = 2166136261;
  const text = stableStringify(value);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `0x${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

const clipDigest = (clip) => ({
  uid: clip.uid,
  trackId: clip.trackId,
  startMs: clip.startMs,
  endMs: clip.startMs + clip.durationMs,
  durationMs: clip.durationMs,
  outlier: Boolean(clip.outlier),
});

const summarize = (clips) => ({
  count: clips.length,
  totalDurationMs: clips.reduce((sum, clip) => sum + clip.durationMs, 0),
  minStartMs: clips.length ? Math.min(...clips.map((clip) => clip.startMs)) : 0,
  maxEndMs: clips.length ? Math.max(...clips.map((clip) => clip.startMs + clip.durationMs)) : 0,
  checksum: checksum(clips.map(clipDigest).sort((a, b) => a.uid.localeCompare(b.uid))),
});

export function exportReport(model, scope = EXPORT_SCOPE.ALL) {
  const allClips = model.clips;
  const filteredClips = model.visibleClips();
  const exportedClips = scope === EXPORT_SCOPE.FILTERED ? filteredClips : allClips;
  const before = summarize(allClips);
  const exported = summarize(exportedClips);
  const consistency = {
    objectCountConsistent:
      scope === EXPORT_SCOPE.ALL ? exported.count === before.count : exported.count === filteredClips.length,
    keyValuesConsistent:
      scope === EXPORT_SCOPE.ALL ? exported.checksum === before.checksum : exported.checksum === summarize(filteredClips).checksum,
    checksumBefore: before.checksum,
    checksumAfter: exported.checksum,
  };
  return {
    reportId: `report-${model.projectId}-v${model.dataVersion}`,
    generatedAt: new Date().toISOString(),
    exportScope: scope,
    exportScopeLabel: scope === EXPORT_SCOPE.ALL ? '全量导出（筛选不影响导出对象）' : '仅导出当前筛选结果',
    dataVersion: model.dataVersion,
    activeFilter: model.filterSummary(),
    totalDurationCheck: model.totalDurationCheck(),
    ingestStats: model.ingestStats,
    ingestIssues: model.ingestIssues,
    markers: model.markers,
    beforeExport: before,
    exported,
    consistency,
    clips: exportedClips.map(clipDigest),
  };
}

export function verifyRoundTrip(originalModel, restoredModel) {
  const left = summarize(originalModel.clips);
  const right = summarize(restoredModel.clips);
  return {
    objectCountConsistent: left.count === right.count,
    keyValuesConsistent: left.checksum === right.checksum,
    playheadConsistent: originalModel.playheadMs === restoredModel.playheadMs,
    filterConsistent: JSON.stringify(originalModel.filterSummary()) === JSON.stringify(restoredModel.filterSummary()),
    dataVersionConsistent: originalModel.dataVersion === restoredModel.dataVersion,
    before: left,
    after: right,
  };
}
