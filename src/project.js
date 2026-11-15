// Project snapshot: serialize / restore / compare engine params + recording.

export const PROJECT_VERSION = 1;

export function snapshotProject(engine, recorder) {
  return {
    version: PROJECT_VERSION,
    keys: engine.keys.map((k) => ({ ...k })),
    recording: recorder.recording
      ? {
          duration: recorder.recording.duration,
          events: recorder.recording.events.map((e) => ({
            ...e,
            params: e.params ? { ...e.params } : undefined,
          })),
        }
      : null,
  };
}

export function restoreProject(engine, recorder, snap) {
  if (!snap || snap.version !== PROJECT_VERSION) {
    throw new Error('restoreProject: unsupported snapshot');
  }
  engine.applyPreset(snap.keys);
  recorder.stopPlayback();
  recorder.recording = snap.recording
    ? {
        duration: snap.recording.duration,
        events: snap.recording.events.map((e) => ({
          ...e,
          params: e.params ? { ...e.params } : undefined,
        })),
      }
    : null;
  recorder.playhead = 0;
}

// Deep-ish compare used by verification. Returns list of human-readable diffs.
export function diffProjects(a, b, { floatTolerance = 1e-9 } = {}) {
  const diffs = [];
  const cmp = (path, x, y) => {
    if (typeof x === 'number' && typeof y === 'number') {
      if (Math.abs(x - y) > floatTolerance) diffs.push(`${path}: ${x} != ${y}`);
    } else if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) diffs.push(`${path}: length ${x.length} != ${y.length}`);
      else x.forEach((v, i) => cmp(`${path}[${i}]`, v, y[i]));
    } else if (x && y && typeof x === 'object' && typeof y === 'object') {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of keys) cmp(`${path}.${k}`, x[k], y[k]);
    } else if (x !== y) {
      diffs.push(`${path}: ${JSON.stringify(x)} != ${JSON.stringify(y)}`);
    }
  };
  cmp('keys', a.keys, b.keys);
  cmp('recording', a.recording, b.recording);
  return diffs;
}

// Extract comparable musical features: beat points (note-on times), per-note
// pan/gain, and export duration — used to prove snapshot fidelity.
export function musicalFeatures(snap) {
  const onsets = snap.recording
    ? snap.recording.events.filter((e) => e.type === 'on').map((e) => e.t)
    : [];
  const pans = snap.keys.map((k) => k.pan);
  const gains = snap.keys.map((k) => k.gain);
  const duration = snap.recording ? snap.recording.duration : 0;
  return { onsets, pans, gains, duration };
}
