import { ISSUE, TRACK_IDS } from './constants.js';

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function mad(values, med) {
  const deviations = values.map((value) => Math.abs(value - med));
  return median(deviations);
}

const FALLBACK_RATIO = 1.5;

function detectOutliers(clips) {
  const byTrack = new Map();
  for (const clip of clips) {
    if (!byTrack.has(clip.trackId)) byTrack.set(clip.trackId, []);
    byTrack.get(clip.trackId).push(clip.durationMs);
  }
  const flagged = new Set();
  const diagnostics = {};
  for (const [trackId, durations] of byTrack) {
    const med = median(durations);
    const deviation = mad(durations, med);
    diagnostics[trackId] = { sampleSize: durations.length, medianMs: med, madMs: deviation };
    if (durations.length < 3) continue;
    for (const clip of clips.filter((item) => item.trackId === trackId)) {
      const ratio = clip.durationMs / med;
      clip.outlier = ratio >= FALLBACK_RATIO || ratio <= 1 / FALLBACK_RATIO;
      if (clip.outlier) {
        clip.robustZ = Number(ratio.toFixed(3));
        flagged.add(clip.uid);
      }
    }
  }
  return { flagged, diagnostics };
}

export function ingestRecords(rawInput) {
  const totalDurationMs = rawInput.totalDurationMs;
  const records = Array.isArray(rawInput.records) ? rawInput.records : [];
  const issues = [];
  const decisions = [];
  const accepted = [];
  const seenSignatures = new Set();
  const seenKeys = new Set();

  records.forEach((record, index) => {
    const base = { index, raw: record ?? null };
    if (record === null || record === undefined || typeof record !== 'object') {
      decisions.push({ ...base, decision: 'quarantined', reason: ISSUE.NULL_RECORD });
      issues.push({ index, code: ISSUE.NULL_RECORD, message: '空记录已隔离' });
      return;
    }
    if (!TRACK_IDS.includes(record.track)) {
      decisions.push({ ...base, decision: 'quarantined', reason: ISSUE.INVALID_TRACK });
      issues.push({ index, code: ISSUE.INVALID_TRACK, message: `未知轨道 ${String(record.track)}` });
      return;
    }
    if (!isFiniteNumber(record.startMs) || !isFiniteNumber(record.durationMs)) {
      decisions.push({ ...base, decision: 'quarantined', reason: ISSUE.INVALID_VALUE });
      issues.push({ index, code: ISSUE.INVALID_VALUE, message: `startMs/durationMs 非有限数值 (id=${String(record.id)})` });
      return;
    }
    if (record.startMs < 0) {
      decisions.push({ ...base, decision: 'quarantined', reason: ISSUE.NEGATIVE_START });
      issues.push({ index, code: ISSUE.NEGATIVE_START, message: `负起点已隔离 (id=${String(record.id)})` });
      return;
    }
    if (record.durationMs <= 0) {
      decisions.push({ ...base, decision: 'quarantined', reason: ISSUE.NON_POSITIVE_DURATION });
      issues.push({ index, code: ISSUE.NON_POSITIVE_DURATION, message: `非正时长已隔离 (id=${String(record.id)})` });
      return;
    }
    const signature = [record.track, record.startMs, record.durationMs, record.name ?? '', record.text ?? ''].join('|');
    if (seenSignatures.has(signature)) {
      decisions.push({ ...base, decision: 'dropped-duplicate', reason: ISSUE.DUPLICATE_RECORD });
      issues.push({ index, code: ISSUE.DUPLICATE_RECORD, message: `完全重复记录已丢弃 (id=${String(record.id)})` });
      return;
    }
    const key = `${record.track}#${record.id}`;
    if (seenKeys.has(key)) {
      decisions.push({ ...base, decision: 'quarantined', reason: ISSUE.DUPLICATE_ID });
      issues.push({ index, code: ISSUE.DUPLICATE_ID, message: `同轨重复 ID 已隔离 (id=${String(record.id)})` });
      return;
    }
    if (record.startMs >= totalDurationMs) {
      decisions.push({ ...base, decision: 'quarantined', reason: ISSUE.INVALID_VALUE });
      issues.push({ index, code: ISSUE.INVALID_VALUE, message: `起点超出总时长已隔离 (id=${String(record.id)})` });
      return;
    }

    const clip = {
      uid: `${record.track}:${record.id}`,
      clipId: String(record.id),
      trackId: record.track,
      name: String(record.name ?? record.id),
      text: typeof record.text === 'string' ? record.text : '',
      startMs: Math.round(record.startMs),
      durationMs: Math.round(record.durationMs),
      outlier: false,
    };
    let clamped = false;
    if (clip.startMs + clip.durationMs > totalDurationMs) {
      clip.durationMs = totalDurationMs - clip.startMs;
      clamped = true;
      issues.push({ index, code: ISSUE.CLAMPED_TO_TOTAL, message: `片段末端已裁剪到总时长 (id=${clip.clipId})` });
    }
    clip.endMs = clip.startMs + clip.durationMs;
    seenSignatures.add(signature);
    seenKeys.add(key);
    accepted.push(clip);
    decisions.push({ ...base, decision: 'accepted', reason: clamped ? ISSUE.CLAMPED_TO_TOTAL : 'ok', uid: clip.uid });
  });

  const outlierResult = detectOutliers(accepted);
  for (const uid of outlierResult.flagged) {
    const clip = accepted.find((item) => item.uid === uid);
    issues.push({ index: null, code: ISSUE.DURATION_OUTLIER, message: `时长离群 (id=${clip.clipId}, z=${clip.robustZ})` });
  }

  return {
    clips: accepted,
    issues,
    decisions,
    outlierDiagnostics: outlierResult.diagnostics,
    stats: {
      inputCount: records.length,
      acceptedCount: accepted.length,
      quarantinedCount: decisions.filter((item) => item.decision === 'quarantined').length,
      duplicateCount: decisions.filter((item) => item.decision === 'dropped-duplicate').length,
      clampedCount: issues.filter((item) => item.code === ISSUE.CLAMPED_TO_TOTAL).length,
      outlierCount: outlierResult.flagged.size,
    },
  };
}
