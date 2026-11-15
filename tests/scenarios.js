import { buildProject } from '../src/core/factory.js';
import { SAMPLE_A, SAMPLE_B } from '../src/core/sampleData.js';
import { exportReport, verifyRoundTrip } from '../src/core/report.js';
import { TimelineModel } from '../src/core/timeline.js';
import { ERROR, EXPORT_SCOPE, ISSUE, TRACKS } from '../src/core/constants.js';
import { assert, assertEqual } from './assert.js';

const s = (seconds) => seconds * 1000;

export function runAllScenarios() {
  const results = [];
  const test = (name, fn) => {
    try {
      const detail = fn() ?? null;
      results.push({ name, ok: true, detail });
    } catch (error) {
      results.push({ name, ok: false, error: error.message, detail: error.detail ?? null });
      throw error;
    }
  };

  test('样例A：空值/重复/异常值入库统计', () => {
    const { model, ingested } = buildProject(SAMPLE_A);
    assertEqual(ingested.stats.inputCount, 22, '原始记录数应为 22');
    assertEqual(ingested.stats.acceptedCount, 15, '接受片段应为 15');
    assertEqual(ingested.stats.quarantinedCount, 5, '隔离记录应为 5');
    assertEqual(ingested.stats.duplicateCount, 2, '完全重复应丢弃 2 条');
    assertEqual(ingested.stats.clampedCount, 1, '越界裁剪应为 1 条');
    assertEqual(ingested.stats.outlierCount, 2, '离群时长应为 2 条（偏短 a2 与偏长 a4）');
    const nullIssue = ingested.issues.find((item) => item.code === ISSUE.NULL_RECORD);
    const duplicateIssue = ingested.issues.find((item) => item.code === ISSUE.DUPLICATE_RECORD);
    const invalidTrack = ingested.issues.find((item) => item.code === ISSUE.INVALID_TRACK);
    assert(nullIssue && duplicateIssue && invalidTrack, '空值/重复/坏轨道问题均应被记录');
    const clamped = model.findClip('video-1:v4');
    assertEqual(clamped.endMs, s(120), 'v4 末端应裁剪到总时长');
    assertEqual(clamped.durationMs, s(30), 'v4 裁剪后时长为 30s');
    const outlier = model.findClip('audio-a:a4');
    assert(outlier.outlier === true, 'a4 应被标记为时长离群');
    assert(model.findClip('audio-a:a2').outlier === true, 'a2 相对中位数偏短也应标记离群');
    assert(!model.findClip('video-1:v5'), '负时长片段应被隔离');
    return { decisions: ingested.decisions, stats: ingested.stats, outlierDiagnostics: ingested.outlierDiagnostics };
  });

  test('样例B：NaN/Infinity/undefined/负起点处理', () => {
    const { model, ingested } = buildProject(SAMPLE_B);
    assertEqual(ingested.stats.inputCount, 18, '样例B 原始记录数应为 18');
    assertEqual(ingested.stats.acceptedCount, 11, '样例B 接受片段应为 11');
    assertEqual(ingested.stats.duplicateCount, 1, '样例B 完全重复应丢弃 1 条');
    assertEqual(ingested.stats.quarantinedCount, 6, '样例B 隔离记录应为 6 条');
    assertEqual(ingested.stats.clampedCount, 1, '样例B 越界裁剪应为 1 条（q3）');
    assertEqual(ingested.stats.outlierCount, 2, '样例B 离群时长应为 2 条（超长 q1 与 300ms 的 q2）');
    const codes = ingested.issues.map((item) => item.code);
    for (const code of [ISSUE.INVALID_VALUE, ISSUE.NON_POSITIVE_DURATION, ISSUE.NEGATIVE_START, ISSUE.DUPLICATE_RECORD, ISSUE.CLAMPED_TO_TOTAL, ISSUE.DURATION_OUTLIER]) {
      assert(codes.includes(code), `样例B 应包含问题类型 ${code}`);
    }
    assert(!model.clips.some((clip) => !Number.isFinite(clip.startMs) || !Number.isFinite(clip.durationMs)), '模型内不得残留非有限数值');
    const shortClip = model.findClip('audio-a:q2');
    assert(shortClip.outlier === true, '300ms 音效应判定为时长离群');
    assert(model.findClip('audio-a:q1').outlier === true, '45s 背景音应判定为时长离群');
    const clamped = model.findClip('audio-a:q3');
    assertEqual(clamped.endMs, s(60), '越界音效应裁剪到 60s');
    return { stats: ingested.stats, decisions: ingested.decisions };
  });

  test('总时长检查：每轨空洞/占用/越界', () => {
    const { model } = buildProject(SAMPLE_A);
    const check = model.totalDurationCheck();
    assertEqual(check.totalDurationMs, s(120), '总时长应为 120s');
    assertEqual(check.clipCount, 15, '检查应覆盖全部 15 个对象');
    for (const row of check.perTrack) {
      assert(row.occupiedMs + row.gapMs === s(120), `轨道 ${row.trackId} 占用+空洞应等于总时长`);
      assert(row.gapSegments >= 1, `轨道 ${row.trackId} 应至少有一个空洞段`);
    }
    return check;
  });

  test('五段实际编辑：移动×3 + 分割×2', () => {
    const { model } = buildProject(SAMPLE_A);
    const edits = [];
    let result = model.moveClip('sub-a:s3', s(62));
    assert(result.ok, '编辑1 移动 s3 应成功');
    edits.push({ edit: 1, ...result.clip ? { uid: result.clip.uid, startMs: result.clip.startMs } : {} });
    result = model.moveClip('audio-b:b2', s(40));
    assert(result.ok, '编辑2 移动 b2 应成功');
    edits.push({ edit: 2, uid: result.clip.uid, startMs: result.clip.startMs });
    result = model.moveClip('sub-b:e2', s(35));
    assert(result.ok, '编辑3 移动 e2 应成功');
    edits.push({ edit: 3, uid: result.clip.uid, startMs: result.clip.startMs });
    result = model.splitClip('video-1:v2', s(32));
    assert(result.ok, '编辑4 分割 v2 应成功');
    edits.push({ edit: 4, pieces: result.clips.map((clip) => ({ uid: clip.uid, durationMs: clip.durationMs })) });
    assertEqual(result.clips[0].durationMs + result.clips[1].durationMs, s(30), '分割总时长守恒');
    result = model.splitClip('video-1:v4', s(100));
    assert(result.ok, '编辑5 分割 v4 应成功');
    edits.push({ edit: 5, pieces: result.clips.map((clip) => ({ uid: clip.uid, durationMs: clip.durationMs })) });
    assertEqual(model.clips.length, 17, '五段编辑后对象数应为 17');
    assertEqual(model.dataVersion, 6, '初始版本1 + 5 次编辑 => 版本6');
    assertEqual(model.editLog.length, 5, '编辑日志应记录 5 条');
    return { edits, markers: model.markers, dataVersion: model.dataVersion };
  });

  test('非法重叠被阻止且模型保持不变', () => {
    const { model } = buildProject(SAMPLE_A);
    const beforeCount = model.clips.length;
    const beforeChecksumVersion = model.dataVersion;
    const v3 = model.findClip('video-1:v3');
    const originalStart = v3.startMs;
    const result = model.moveClip('video-1:v3', s(5));
    assertEqual(result.ok, false, '拖到 v1 上必须被阻止');
    assertEqual(result.code, ERROR.OVERLAP_BLOCKED, '错误码应为 OVERLAP_BLOCKED');
    assertEqual(v3.startMs, originalStart, '被阻止后片段位置不变');
    assertEqual(model.clips.length, beforeCount, '被阻止后对象数量不变');
    assertEqual(model.dataVersion, beforeChecksumVersion, '被阻止后数据版本不变');
    assert(model.lastRejected.code === ERROR.OVERLAP_BLOCKED, '应保留拒绝原因供调试面板展示');
    const markers = model.markers;
    assertEqual(markers.overlapCount, 0, '入库后同轨重叠标记应为 0（重叠只能来自被禁止的操作）');
    return { rejected: model.lastRejected };
  });

  test('播放头跳转：画面/音频/字幕同步', () => {
    const { model } = buildProject(SAMPLE_A);
    const frame = model.setPlayhead(s(22));
    assert(frame.video.some((clip) => clip.uid === 'video-1:v2'), '22s 画面应命中 v2');
    assert(frame.audio.some((clip) => clip.uid === 'audio-a:a1'), '22s 音频应命中 a1');
    assert(frame.subtitles.some((clip) => clip.trackId === 'sub-b' && clip.text.includes('page 12')), '22s 字幕应命中英文字幕 e2');
    assertEqual(frame.playheadMs, s(22), '播放头应为 22s');
    const late = model.setPlayhead(s(110));
    assert(late.video.some((clip) => clip.uid === 'video-1:v4'), '110s 画面仍命中 v4');
    assert(late.audio.some((clip) => clip.uid === 'audio-a:a4'), '110s 音频仍命中 a4');
    assert(late.subtitles.length === 0, '110s 三组字幕均已结束，应返回空字幕集合');
    const clamped = model.setPlayhead(s(999));
    assertEqual(clamped.playheadMs, s(120), '超出范围的播放头应被夹取');
    return { frame22s: frame, frame110s: late, clamped };
  });

  test('筛选与视图数据同步更新', () => {
    const { model } = buildProject(SAMPLE_A);
    model.setFilter({ trackId: 'all', kinds: new Set(['subtitle']), keyword: '' });
    const subtitleClips = model.visibleClips();
    assert(subtitleClips.every((clip) => clip.trackId.startsWith('sub-')), '类型筛选只保留字幕');
    assertEqual(subtitleClips.length, 6, '字幕对象应为 6');
    model.setFilter({ trackId: 'all', kinds: new Set(), keyword: '教材' });
    const keywordClips = model.visibleClips();
    assert(keywordClips.every((clip) => `${clip.name}${clip.text}`.includes('教材')), '关键字筛选应命中名称或文本');
    assertEqual(model.dataVersion, 3, '两次筛选后版本应为 3');
    return { filter: model.filterSummary(), visibleCount: keywordClips.length };
  });

  test('导出报告：数量与关键数值前后一致', () => {
    const { model } = buildProject(SAMPLE_A);
    model.moveClip('sub-a:s3', s(62));
    model.splitClip('video-1:v2', s(32));
    const report = exportReport(model, EXPORT_SCOPE.ALL);
    assertEqual(report.beforeExport.count, report.exported.count, '导出前后对象数量一致');
    assertEqual(report.beforeExport.checksum, report.exported.checksum, '导出前后关键数值校验和一致');
    assert(report.consistency.objectCountConsistent && report.consistency.keyValuesConsistent, '一致性断言应全部通过');
    assertEqual(report.exportScope, EXPORT_SCOPE.ALL, '导出口径应为全量');
    assert(Array.isArray(report.clips) && report.clips.length === model.clips.length, '报告应包含全部对象摘要');
    model.setFilter({ trackId: 'all', kinds: new Set(['audio']), keyword: '' });
    const filteredReport = exportReport(model, EXPORT_SCOPE.FILTERED);
    assertEqual(filteredReport.exported.count, model.visibleClips().length, '筛选口径导出数量与视图一致');
    assert(filteredReport.exported.count < report.exported.count, '筛选导出应少于全量导出');
    return { report, filteredCount: filteredReport.exported.count };
  });

  test('工程保存/重新载入：位置、播放头、筛选与版本不变', () => {
    const { model } = buildProject(SAMPLE_A);
    model.moveClip('sub-a:s3', s(62));
    model.splitClip('video-1:v2', s(32));
    model.setFilter({ trackId: 'audio-a', kinds: new Set(), keyword: '麦克风' });
    model.setPlayhead(s(47));
    const serialized = JSON.parse(JSON.stringify(model.toJSON()));
    const restored = TimelineModel.fromJSON(serialized);
    const verification = verifyRoundTrip(model, restored);
    assert(verification.objectCountConsistent, '重载后对象数量一致');
    assert(verification.keyValuesConsistent, '重载后关键数值一致');
    assert(verification.playheadConsistent, '重载后播放头一致');
    assert(verification.filterConsistent, '重载后当前筛选一致');
    assert(verification.dataVersionConsistent, '重载后数据版本一致');
    assertEqual(restored.findClip('sub-a:s3').startMs, s(62), '重载后 s3 位置不变');
    assertEqual(restored.totalDurationCheck().gapCount, model.totalDurationCheck().gapCount, '重载后空洞标记一致');
    return { verification, serialized };
  });

  test('调试中间状态可观测', () => {
    const { ingested } = buildProject(SAMPLE_B);
    assert(Array.isArray(ingested.decisions) && ingested.decisions.length === SAMPLE_B.records.length, '每条输入都应有逐条判定');
    assert(Object.keys(ingested.outlierDiagnostics).length <= TRACKS.length, '应产出每轨离群诊断');
    const { model } = buildProject(SAMPLE_A);
    model.moveClip('audio-b:b2', s(40));
    assert(model.editLog.at(-1).type === 'move', '编辑日志可追踪最后一步');
    return { sampleBDecisions: ingested.decisions, diagnostics: ingested.outlierDiagnostics };
  });

  test('重叠/空洞标记可被计算并随数据更新', () => {
    const { model } = buildProject(SAMPLE_A);
    assertEqual(model.markers.overlapCount, 0, '正常入库不应存在同轨重叠');
    const clip = model.findClip('video-1:v1');
    const originalStart = clip.startMs;
    clip.startMs = s(25);
    clip.endMs = clip.startMs + clip.durationMs;
    model.markers = model.computeMarkers();
    assertEqual(model.markers.overlapCount, 1, '构造同轨重叠后应检出 1 处重叠标记');
    const overlap = model.markers.overlaps[0];
    assertEqual(overlap.trackId, 'video-1', '重叠标记应定位到视频轨');
    assert(overlap.between.includes('video-1:v1') && overlap.between.includes('video-1:v2'), '标记应给出冲突片段对');
    clip.startMs = originalStart;
    clip.endMs = clip.startMs + clip.durationMs;
    model.markers = model.computeMarkers();
    assertEqual(model.markers.overlapCount, 0, '冲突解除后重叠标记应消失');
    assert(model.markers.gapCount >= TRACKS.length, '每条轨道都应至少报告尾段空洞');
    return { overlap, gapCount: model.markers.gapCount };
  });

  return results;
}
