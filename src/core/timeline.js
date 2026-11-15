import { ERROR, TRACKS, TRACK_IDS } from './constants.js';

const trackKind = (trackId) => TRACKS.find((track) => track.id === trackId)?.kind ?? trackId;

let uidSequence = 0;
const nextUid = () => `split-${Date.now().toString(36)}-${(uidSequence += 1)}`;

export class TimelineModel {
  constructor({ projectId, name, totalDurationMs, clips = [], issues = [], ingestStats = null, outlierDiagnostics = {} }) {
    this.schemaVersion = 1;
    this.projectId = projectId;
    this.name = name;
    this.totalDurationMs = totalDurationMs;
    this.clips = clips;
    this.ingestIssues = issues;
    this.ingestStats = ingestStats;
    this.outlierDiagnostics = outlierDiagnostics;
    this.filter = { trackId: 'all', kinds: new Set(), keyword: '' };
    this.playheadMs = 0;
    this.zoomPxPerSecond = 20;
    this.dataVersion = 1;
    this.editLog = [];
    this.markers = this.computeMarkers();
    this.lastRejected = null;
  }

  bumpVersion(edit) {
    this.dataVersion += 1;
    this.editLog.push({ version: this.dataVersion, at: new Date().toISOString(), ...edit });
  }

  computeMarkers() {
    const overlaps = [];
    const gaps = [];
    const outOfBounds = [];
    for (const trackId of TRACK_IDS) {
      const trackClips = this.clips
        .filter((clip) => clip.trackId === trackId)
        .sort((a, b) => a.startMs - b.startMs || a.uid.localeCompare(b.uid));
      for (let i = 0; i < trackClips.length - 1; i += 1) {
        const current = trackClips[i];
        const following = trackClips[i + 1];
        if (current.endMs > following.startMs) {
          overlaps.push({
            trackId,
            startMs: following.startMs,
            endMs: Math.min(current.endMs, following.endMs),
            between: [current.uid, following.uid],
          });
        }
      }
      let cursor = 0;
      for (const clip of trackClips) {
        if (clip.startMs > cursor) {
          gaps.push({ trackId, startMs: cursor, endMs: clip.startMs, gapMs: clip.startMs - cursor });
        }
        cursor = Math.max(cursor, clip.endMs);
      }
      if (cursor < this.totalDurationMs) {
        gaps.push({ trackId, startMs: cursor, endMs: this.totalDurationMs, gapMs: this.totalDurationMs - cursor });
      }
      for (const clip of trackClips) {
        if (clip.startMs < 0 || clip.endMs > this.totalDurationMs) {
          outOfBounds.push({ trackId, uid: clip.uid, startMs: clip.startMs, endMs: clip.endMs });
        }
      }
    }
    const gapMsTotal = gaps.reduce((sum, gap) => sum + gap.gapMs, 0);
    return {
      overlaps,
      gaps,
      outOfBounds,
      gapMsTotal,
      overlapCount: overlaps.length,
      gapCount: gaps.length,
      outOfBoundsCount: outOfBounds.length,
    };
  }

  findClip(uid) {
    return this.clips.find((clip) => clip.uid === uid) ?? null;
  }

  wouldOverlap(trackId, startMs, endMs, ignoreUid) {
    return this.clips.some(
      (clip) =>
        clip.trackId === trackId &&
        clip.uid !== ignoreUid &&
        startMs < clip.endMs &&
        endMs > clip.startMs,
    );
  }

  moveClip(uid, startMs, trackIdOverride = null) {
    const clip = this.findClip(uid);
    if (!clip) return { ok: false, code: ERROR.CLIP_NOT_FOUND };
    const targetTrack = trackIdOverride ?? clip.trackId;
    const normalizedStart = Math.round(startMs);
    if (normalizedStart < 0 || normalizedStart + clip.durationMs > this.totalDurationMs) {
      this.lastRejected = { uid, requestedStartMs: normalizedStart, code: ERROR.OUT_OF_BOUNDS };
      return { ok: false, code: ERROR.OUT_OF_BOUNDS };
    }
    if (this.wouldOverlap(targetTrack, normalizedStart, normalizedStart + clip.durationMs, uid)) {
      this.lastRejected = { uid, requestedStartMs: normalizedStart, trackId: targetTrack, code: ERROR.OVERLAP_BLOCKED };
      return { ok: false, code: ERROR.OVERLAP_BLOCKED };
    }
    const from = { startMs: clip.startMs, trackId: clip.trackId };
    clip.startMs = normalizedStart;
    clip.endMs = normalizedStart + clip.durationMs;
    clip.trackId = targetTrack;
    this.markers = this.computeMarkers();
    this.bumpVersion({ type: 'move', uid, from, to: { startMs: normalizedStart, trackId: targetTrack } });
    return { ok: true, clip };
  }

  splitClip(uid, atMs) {
    const clip = this.findClip(uid);
    if (!clip) return { ok: false, code: ERROR.CLIP_NOT_FOUND };
    if (atMs <= clip.startMs || atMs >= clip.endMs) {
      return { ok: false, code: ERROR.SPLIT_OUTSIDE_CLIP };
    }
    const left = { ...clip, uid: nextUid(), clipId: `${clip.clipId}-L`, name: `${clip.name} · 左`, startMs: clip.startMs, durationMs: atMs - clip.startMs, endMs: atMs };
    const right = { ...clip, uid: nextUid(), clipId: `${clip.clipId}-R`, name: `${clip.name} · 右`, startMs: atMs, durationMs: clip.endMs - atMs, endMs: clip.endMs };
    const index = this.clips.findIndex((item) => item.uid === uid);
    this.clips.splice(index, 1, left, right);
    this.markers = this.computeMarkers();
    this.bumpVersion({ type: 'split', sourceUid: uid, pieces: [left.uid, right.uid], atMs });
    return { ok: true, clips: [left, right] };
  }

  setFilter(nextFilter) {
    this.filter = {
      trackId: nextFilter.trackId ?? this.filter.trackId,
      kinds: nextFilter.kinds ?? this.filter.kinds,
      keyword: nextFilter.keyword ?? this.filter.keyword,
    };
    this.dataVersion += 1;
    this.editLog.push({ version: this.dataVersion, at: new Date().toISOString(), type: 'filter', filter: this.filterSummary() });
  }

  filterSummary() {
    return {
      trackId: this.filter.trackId,
      kinds: [...this.filter.kinds],
      keyword: this.filter.keyword,
    };
  }

  setZoom(pxPerSecond) {
    this.zoomPxPerSecond = pxPerSecond;
  }

  setPlayhead(playheadMs) {
    const clamped = Math.max(0, Math.min(this.totalDurationMs, Math.round(playheadMs)));
    this.playheadMs = clamped;
    return this.frameAt(clamped);
  }

  frameAt(playheadMs = this.playheadMs) {
    const active = this.clips
      .filter((clip) => playheadMs >= clip.startMs && playheadMs < clip.endMs)
      .map((clip) => ({
        uid: clip.uid,
        trackId: clip.trackId,
        name: clip.name,
        text: clip.text,
        clipStartMs: clip.startMs,
        clipEndMs: clip.endMs,
        offsetMs: playheadMs - clip.startMs,
      }));
    const subtitles = active
      .filter((clip) => clip.trackId.startsWith('sub-'))
      .map((clip) => ({ trackId: clip.trackId, text: clip.text, name: clip.name }));
    return {
      playheadMs,
      video: active.filter((clip) => clip.trackId === 'video-1'),
      audio: active.filter((clip) => clip.trackId.startsWith('audio-')),
      subtitles,
      active,
    };
  }

  visibleClips() {
    const { trackId, kinds, keyword } = this.filter;
    return this.clips.filter((clip) => {
      if (trackId !== 'all' && clip.trackId !== trackId) return false;
      if (kinds.size > 0 && !kinds.has(trackKind(clip.trackId))) return false;
      if (keyword && !`${clip.name} ${clip.text}`.toLowerCase().includes(keyword.toLowerCase())) return false;
      return true;
    });
  }

  totalDurationCheck() {
    const perTrack = TRACK_IDS.map((trackId) => {
      const trackClips = this.clips.filter((clip) => clip.trackId === trackId);
      const occupiedMs = trackClips.reduce((sum, clip) => sum + clip.durationMs, 0);
      const trackGaps = this.markers.gaps.filter((gap) => gap.trackId === trackId);
      return {
        trackId,
        clipCount: trackClips.length,
        occupiedMs,
        gapMs: this.totalDurationMs - occupiedMs,
        gapSegments: trackGaps.length,
        coversTimeline: occupiedMs === this.totalDurationMs && this.markers.overlaps.every((overlap) => overlap.trackId !== trackId),
      };
    });
    return {
      totalDurationMs: this.totalDurationMs,
      dataVersion: this.dataVersion,
      clipCount: this.clips.length,
      sumDurationMs: this.clips.reduce((sum, clip) => sum + clip.durationMs, 0),
      overlapCount: this.markers.overlapCount,
      gapCount: this.markers.gapCount,
      gapMsTotal: this.markers.gapMsTotal,
      outOfBoundsCount: this.markers.outOfBoundsCount,
      perTrack,
    };
  }

  toJSON() {
    return {
      schemaVersion: this.schemaVersion,
      projectId: this.projectId,
      name: this.name,
      totalDurationMs: this.totalDurationMs,
      dataVersion: this.dataVersion,
      filter: this.filterSummary(),
      playheadMs: this.playheadMs,
      zoomPxPerSecond: this.zoomPxPerSecond,
      clips: this.clips.map(({ uid, clipId, trackId, name, text, startMs, durationMs, outlier, robustZ }) => ({
        uid, clipId, trackId, name, text, startMs, durationMs, endMs: startMs + durationMs, outlier, robustZ,
      })),
      markers: this.markers,
      ingestStats: this.ingestStats,
      ingestIssues: this.ingestIssues,
      outlierDiagnostics: this.outlierDiagnostics,
      editLog: this.editLog,
      savedAt: new Date().toISOString(),
    };
  }

  static fromJSON(data) {
    const model = new TimelineModel({
      projectId: data.projectId,
      name: data.name,
      totalDurationMs: data.totalDurationMs,
      clips: data.clips.map((clip) => ({ ...clip, endMs: clip.startMs + clip.durationMs })),
      issues: data.ingestIssues ?? [],
      ingestStats: data.ingestStats ?? null,
      outlierDiagnostics: data.outlierDiagnostics ?? {},
    });
    model.dataVersion = data.dataVersion;
    model.editLog = data.editLog ?? [];
    model.playheadMs = data.playheadMs ?? 0;
    model.zoomPxPerSecond = data.zoomPxPerSecond ?? 20;
    model.filter = { trackId: data.filter?.trackId ?? 'all', kinds: new Set(data.filter?.kinds ?? []), keyword: data.filter?.keyword ?? '' };
    model.markers = model.computeMarkers();
    return model;
  }
}
