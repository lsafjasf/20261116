import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProject } from '../src/core/factory.js';
import { SAMPLE_A, SAMPLE_B } from '../src/core/sampleData.js';
import { exportReport, verifyRoundTrip } from '../src/core/report.js';
import { TimelineModel } from '../src/core/timeline.js';
import { ERROR, EXPORT_SCOPE } from '../src/core/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const artifactDir = resolve(here, '../artifacts');
mkdirSync(artifactDir, { recursive: true });
const s = (seconds) => seconds * 1000;
const snapshots = [];
const snapshot = (stage, model, extra = {}) => {
  snapshots.push({
    stage,
    dataVersion: model.dataVersion,
    playheadMs: model.playheadMs,
    clipCount: model.clips.length,
    markers: model.markers,
    durationCheck: model.totalDurationCheck(),
    ...extra,
  });
};

const { model } = buildProject(SAMPLE_A);
snapshot('01-ingested', model, { ingestStats: model.ingestStats });

const fiveEdits = [
  () => model.moveClip('sub-a:s3', s(62)),
  () => model.moveClip('audio-b:b2', s(40)),
  () => model.moveClip('sub-b:e2', s(35)),
  () => model.splitClip('video-1:v2', s(32)),
  () => model.splitClip('video-1:v4', s(100)),
];
const editResults = [];
fiveEdits.forEach((edit, index) => {
  const result = edit();
  if (!result.ok) throw new Error(`第 ${index + 1} 段编辑失败: ${result.code}`);
  editResults.push({ edit: index + 1, dataVersion: model.dataVersion, result });
  snapshot(`0${index + 2}-edit-${index + 1}`, model, { lastEdit: model.editLog.at(-1) });
});

const targetClip = model.findClip('video-1:v3');
const beforeIllegal = { startMs: targetClip.startMs, dataVersion: model.dataVersion, clipCount: model.clips.length };
const illegal = model.moveClip('video-1:v3', s(5));
const afterIllegal = { startMs: targetClip.startMs, dataVersion: model.dataVersion, clipCount: model.clips.length };
if (illegal.ok || illegal.code !== ERROR.OVERLAP_BLOCKED) throw new Error('非法重叠未被阻止');
if (JSON.stringify(beforeIllegal) !== JSON.stringify(afterIllegal)) throw new Error('阻止非法重叠后模型发生变化');
snapshot('07-illegal-overlap-blocked', model, { rejected: model.lastRejected, beforeIllegal, afterIllegal });

model.setFilter({ trackId: 'all', kinds: new Set(['audio']), keyword: '' });
const filteredClips = model.visibleClips().map((clip) => clip.uid);
snapshot('08-filter-audio', model, { activeFilter: model.filterSummary(), filteredClips });

const frame22 = model.setPlayhead(s(22));
const frame75 = model.setPlayhead(s(75));
snapshot('09-playhead-sync', model, { frame22s: frame22, frame75s: frame75 });

const reportAll = exportReport(model, EXPORT_SCOPE.ALL);
const reportFiltered = exportReport(model, EXPORT_SCOPE.FILTERED);
snapshot('10-export', model, {
  exportScope: reportAll.exportScope,
  beforeExport: reportAll.beforeExport,
  exported: reportAll.exported,
  consistency: reportAll.consistency,
  filteredExportCount: reportFiltered.exported.count,
});

const projectFile = model.toJSON();
writeFileSync(resolve(artifactDir, 'project-sample-a.saved.json'), JSON.stringify(projectFile, null, 2));
const restored = TimelineModel.fromJSON(JSON.parse(JSON.stringify(projectFile)));
const roundTrip = verifyRoundTrip(model, restored);
snapshot('11-reload', restored, { roundTrip });

const { model: modelB } = buildProject(SAMPLE_B);
const sampleBSummary = {
  sampleId: SAMPLE_B.sampleId,
  ingestStats: modelB.ingestStats,
  issues: modelB.ingestIssues,
  durationCheck: modelB.totalDurationCheck(),
};

writeFileSync(resolve(artifactDir, 'export-report-all.json'), JSON.stringify(reportAll, null, 2));
writeFileSync(resolve(artifactDir, 'export-report-filtered.json'), JSON.stringify(reportFiltered, null, 2));
writeFileSync(resolve(artifactDir, 'demo-snapshots.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  sampleA: snapshots,
  sampleB: sampleBSummary,
  fiveEdits: editResults,
  illegalOverlap: { request: { uid: 'video-1:v3', requestedStartMs: s(5) }, rejected: model.lastRejected, beforeIllegal, afterIllegal },
  playhead: { at22s: frame22, at75s: frame75 },
  roundTrip,
}, null, 2));

const checks = [
  ['五段编辑全部成功', editResults.length === 5],
  ['非法重叠被阻止', illegal.code === ERROR.OVERLAP_BLOCKED],
  ['阻止后对象数量不变', beforeIllegal.clipCount === afterIllegal.clipCount],
  ['阻止后数据版本不变', beforeIllegal.dataVersion === afterIllegal.dataVersion],
  ['全量导出数量一致', reportAll.consistency.objectCountConsistent],
  ['全量导出关键数值一致', reportAll.consistency.keyValuesConsistent],
  ['筛选导出与视图数量一致', reportFiltered.exported.count === filteredClips.length],
  ['重载对象数量一致', roundTrip.objectCountConsistent],
  ['重载关键数值一致', roundTrip.keyValuesConsistent],
  ['重载播放头/筛选/版本一致', roundTrip.playheadConsistent && roundTrip.filterConsistent && roundTrip.dataVersionConsistent],
];

console.log('演示运行完成');
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
console.log(`对象数: 入库 ${snapshots[0].clipCount} -> 编辑后 ${beforeIllegal.clipCount}；导出版本 v${reportAll.dataVersion}`);
console.log(`产物目录: ${artifactDir}`);
if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
