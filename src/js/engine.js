import { SAMPLE_RATE, TIMELINE_SECONDS, clamp, dbToGain, interpPoints } from './util.js';
import { getAutomation } from './project.js';

const STOP_RAMP_SECONDS = 0.02;

export class PlaybackEngine {
  constructor(host, project, sources) {
    this.host = host;
    this.project = project;
    this.sources = sources;
    this.status = 'idle';
    this.playhead = 0;
    this._nodes = new Set();
    this._run = null;
    this._frameUnsub = null;
    this._statusListeners = new Set();
    this._playheadListeners = new Set();
  }

  get activeNodeCount() {
    return this._nodes.size;
  }

  onStatus(callback) {
    this._statusListeners.add(callback);
    return () => this._statusListeners.delete(callback);
  }

  onPlayhead(callback) {
    this._playheadListeners.add(callback);
    return () => this._playheadListeners.delete(callback);
  }

  _setStatus(status) {
    this.status = status;
    for (const callback of this._statusListeners) callback(status);
  }

  _setPlayhead(time) {
    this.playhead = clamp(time, 0, TIMELINE_SECONDS);
    for (const callback of this._playheadListeners) callback(this.playhead);
  }

  _ensureFrameLoop() {
    if (this._frameUnsub) return;
    this._frameUnsub = this.host.requestFrame(() => this._tick());
  }

  _tick() {
    if (!this._run || this.status !== 'playing') return;
    const time = this._run.offset + this.host.currentTime - this._run.startTime;
    this._setPlayhead(time);
    if (time >= TIMELINE_SECONDS) {
      this.stop();
    }
  }

  start(fromTime = this.playhead) {
    if (this.status === 'destroyed') {
      return Promise.reject(new Error('Engine has been destroyed'));
    }
    if (this.status === 'playing' && this._run) {
      return this._run.ready;
    }
    const ready = this._buildGraph(clamp(fromTime, 0, TIMELINE_SECONDS));
    this._run = { ready, offset: clamp(fromTime, 0, TIMELINE_SECONDS), startTime: this.host.currentTime };
    this._ensureFrameLoop();
    this._setStatus('playing');
    return ready;
  }

  pause() {
    if (this.status !== 'playing') return;
    this._setPlayhead(this._run.offset + this.host.currentTime - this._run.startTime);
    this._teardown();
    this._setStatus('paused');
  }

  stop() {
    if (this.status === 'destroyed') return;
    if (!this._run) {
      this._setPlayhead(0);
      this._setStatus('idle');
      return;
    }
    const now = this.host.currentTime;
    const endAt = now + STOP_RAMP_SECONDS;
    for (const node of this._nodes) {
      if (node.kind === 'master' && node.gain) {
        node.gain.cancelScheduledValues?.(now);
        node.gain.setValueAtTime(node.gain.value, now);
        node.gain.linearRampToValueAtTime(0, endAt);
      }
      if (node.kind === 'source' && !node.stopped) {
        node.stopped = true;
        node.stop(endAt);
      }
    }
    this._teardown(endAt);
    this._setPlayhead(0);
    this._setStatus('idle');
  }

  seek(time) {
    const target = clamp(time, 0, TIMELINE_SECONDS);
    if (this.status === 'playing') {
      this.pause();
      this._setPlayhead(target);
    } else {
      this._setPlayhead(target);
    }
  }

  _buildGraph(fromTime) {
    const master = this.host.createGain('master');
    master.gain.value = 1;
    const compressor = this.host.createDynamicsCompressor('compressor');
    master.connect(compressor);
    compressor.connect(this.host.destination || { kind: 'destination' });
    this._nodes.add(master);
    this._nodes.add(compressor);

    for (const clip of this.project.clips) {
      const sourceBuffer = this.sources[clip.sourceId];
      const source = this.host.createBufferSource('source');
      source.buffer = sourceBuffer;
      const fadeGain = this.host.createGain('fadeGain');
      const clipGain = this.host.createGain('clipGain');
      const panner = this.host.createStereoPanner('panner');
      panner.pan.value = clip.pan;
      source.connect(fadeGain);
      fadeGain.connect(clipGain);
      clipGain.connect(panner);
      panner.connect(master);
      for (const node of [source, fadeGain, clipGain, panner]) this._nodes.add(node);
      this._scheduleClip(clip, source, fadeGain, clipGain, fromTime);
    }
    return Promise.resolve();
  }

  _scheduleClip(clip, source, fadeGain, clipGain, fromTime) {
    const now = this.host.currentTime;
    const clipEnd = clip.start + clip.duration;
    const playStart = Math.max(fromTime, clip.start);
    if (playStart >= clipEnd) return;
    const sourceOffset = clip.offset + playStart - clip.start;
    const remaining = clipEnd - playStart;
    const startAt = now;
    const stopAt = now + remaining;

    fadeGain.gain.setValueAtTime(0, startAt);
    fadeGain.gain.linearRampToValueAtTime(1, startAt + 0.03);
    clipGain.gain.setValueAtTime(dbToGain(clip.gainDb), startAt);

    const automation = getAutomation(this.project, clip.id);
    if (automation && automation.points.length) {
      const first = automation.points[0];
      const startDb = interpPoints(automation.points, playStart);
      clipGain.gain.setValueAtTime(dbToGain(clip.gainDb + startDb), startAt);
      for (const point of automation.points) {
        if (point.time > playStart && point.time < clipEnd) {
          clipGain.gain.linearRampToValueAtTime(
            dbToGain(clip.gainDb + point.value),
            startAt + (point.time - playStart),
          );
        }
      }
      if (first.time > clipEnd) {
        clipGain.gain.linearRampToValueAtTime(
          dbToGain(clip.gainDb + first.value),
          stopAt,
        );
      }
    }

    source.onended = () => {
      this._nodes.delete(source);
    };
    source.start(startAt, sourceOffset);
    source.stop(stopAt);
  }

  _teardown(closeAt = this.host.currentTime) {
    const run = this._run;
    this._run = null;
    const nodes = [...this._nodes];
    this._nodes.clear();
    for (const node of nodes) {
      try {
        if (node.kind === 'source' && !node.stopped) {
          node.stopped = true;
          node.stop(closeAt);
        }
        node.onended = null;
        node.disconnect?.();
        node.close?.();
      } catch {
        // Node may already be gone; teardown must never throw.
      }
    }
    if (run) this._setPlayhead(this.playhead);
  }

  destroy() {
    if (this.status === 'destroyed') return;
    if (this._run) this._teardown();
    if (this._frameUnsub) {
      this._frameUnsub();
      this._frameUnsub = null;
    }
    this._statusListeners.clear();
    this._playheadListeners.clear();
    this._setPlayhead(0);
    this._setStatus('destroyed');
  }
}
