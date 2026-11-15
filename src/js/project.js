import { TIMELINE_SECONDS, clamp } from './util.js';

export const PROJECT_VERSION = 1;

export function createDefaultProject() {
  return {
    version: PROJECT_VERSION,
    bpm: 96,
    masterGainDb: 0,
    clips: [
      {
        id: 'rain',
        sourceId: 'rain',
        start: 0,
        offset: 0,
        duration: 20,
        fadeIn: 0.8,
        fadeOut: 1.2,
        gainDb: 0,
        pan: -0.2,
      },
      {
        id: 'machine',
        sourceId: 'machine',
        start: 6,
        offset: 0,
        duration: 12,
        fadeIn: 1.0,
        fadeOut: 1.5,
        gainDb: -3,
        pan: 0.15,
      },
      {
        id: 'voice',
        sourceId: 'voice',
        start: 10,
        offset: 0,
        duration: 9,
        fadeIn: 1.2,
        fadeOut: 1.0,
        gainDb: -2,
        pan: 0.35,
      },
    ],
    automation: [
      {
        trackId: 'rain',
        points: [
          { time: 2, value: 0 },
          { time: 15, value: -9 },
        ],
      },
    ],
  };
}

export function getClip(project, clipId) {
  return project.clips.find((clip) => clip.id === clipId) || null;
}

export function getAutomation(project, trackId) {
  return project.automation.find((entry) => entry.trackId === trackId) || null;
}

export function moveClip(project, clipId, start) {
  const clip = getClip(project, clipId);
  if (!clip) return;
  clip.start = clamp(Number(start), 0, TIMELINE_SECONDS - clip.duration);
}

export function setClipFade(project, clipId, kind, seconds) {
  const clip = getClip(project, clipId);
  if (!clip) return;
  const maxFade = clip.duration / 2;
  clip[kind] = clamp(Number(seconds), 0, maxFade);
}

export function setClipGain(project, clipId, gainDb) {
  const clip = getClip(project, clipId);
  if (!clip) return;
  clip.gainDb = clamp(Number(gainDb), -48, 12);
}

export function setClipPan(project, clipId, pan) {
  const clip = getClip(project, clipId);
  if (!clip) return;
  clip.pan = clamp(Number(pan), -1, 1);
}

export function setAutomationPoints(project, trackId, points) {
  let entry = getAutomation(project, trackId);
  if (!entry) {
    entry = { trackId, points: [] };
    project.automation.push(entry);
  }
  entry.points = points
    .map((point) => ({
      time: clamp(Number(point.time), 0, TIMELINE_SECONDS),
      value: clamp(Number(point.value), -48, 12),
    }))
    .sort((a, b) => a.time - b.time);
}

export function beatTimes(project) {
  const period = 60 / project.bpm;
  const times = [];
  for (let time = 0; time <= TIMELINE_SECONDS + 1e-9; time += period) {
    times.push(Number(time.toFixed(6)));
  }
  return times;
}

export function serializeProject(project) {
  return JSON.stringify(project, null, 2);
}

export function parseProject(text) {
  const project = JSON.parse(text);
  if (project.version !== PROJECT_VERSION) {
    throw new Error(`Unsupported project version ${project.version}`);
  }
  if (!Array.isArray(project.clips) || project.clips.length === 0) {
    throw new Error('Project has no clips');
  }
  for (const clip of project.clips) {
    if (
      typeof clip.start !== 'number' ||
      typeof clip.duration !== 'number' ||
      clip.start < 0 ||
      clip.duration <= 0
    ) {
      throw new Error(`Invalid clip ${clip.id}`);
    }
  }
  return project;
}

function rounded(number) {
  return Number(number.toFixed(6));
}

export function takeSnapshot(project) {
  return {
    bpm: project.bpm,
    masterGainDb: rounded(project.masterGainDb),
    beats: beatTimes(project).map(rounded),
    clips: project.clips.map((clip) => ({
      id: clip.id,
      start: rounded(clip.start),
      duration: rounded(clip.duration),
      fadeIn: rounded(clip.fadeIn),
      fadeOut: rounded(clip.fadeOut),
      gainDb: rounded(clip.gainDb),
      pan: rounded(clip.pan),
    })),
    automation: project.automation.map((entry) => ({
      trackId: entry.trackId,
      points: entry.points.map((point) => ({
        time: rounded(point.time),
        value: rounded(point.value),
      })),
    })),
  };
}

export function diffSnapshots(before, after) {
  const differences = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      differences.push(key);
    }
  }
  return differences;
}
