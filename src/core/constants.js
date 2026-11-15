export const SCHEMA_VERSION = 1;

export const MS_PER_SECOND = 1000;

export const TRACKS = [
  { id: 'video-1', kind: 'video', label: '视频轨 V1' },
  { id: 'audio-a', kind: 'audio', label: '音频轨 A1' },
  { id: 'audio-b', kind: 'audio', label: '音频轨 A2' },
  { id: 'sub-a', kind: 'subtitle', label: '字幕 S1' },
  { id: 'sub-b', kind: 'subtitle', label: '字幕 S2' },
  { id: 'sub-c', kind: 'subtitle', label: '字幕 S3' },
];

export const TRACK_IDS = TRACKS.map((track) => track.id);

export const ISSUE = {
  NULL_RECORD: 'null-record',
  INVALID_TRACK: 'invalid-track',
  INVALID_VALUE: 'invalid-value',
  NEGATIVE_START: 'negative-start',
  NON_POSITIVE_DURATION: 'non-positive-duration',
  DUPLICATE_RECORD: 'duplicate-record',
  DUPLICATE_ID: 'duplicate-id',
  CLAMPED_TO_TOTAL: 'clamped-to-total',
  DURATION_OUTLIER: 'duration-outlier',
};

export const ERROR = {
  OVERLAP_BLOCKED: 'OVERLAP_BLOCKED',
  OUT_OF_BOUNDS: 'OUT_OF_BOUNDS',
  CLIP_NOT_FOUND: 'CLIP_NOT_FOUND',
  SPLIT_OUTSIDE_CLIP: 'SPLIT_OUTSIDE_CLIP',
};

export const EXPORT_SCOPE = {
  ALL: 'all-clips',
  FILTERED: 'filtered-only',
};
