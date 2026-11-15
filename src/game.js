// Game state machine: timing, judgment, pause/resume, snapshots and listeners.

import { AudioEngine } from './audio.js';
import { generateChart } from './chart.js';
import {
  DIFFICULTIES, LANES, DEFAULT_PARAMS, STORAGE_KEY, SNAPSHOT_VERSION, JUDGE_TIERS,
} from './config.js';

const LEAD_IN = 1.0; // seconds between start() and the first chart time origin

export class Game {
  constructor(canvas, params = {}) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.state = 'idle'; // idle | countdown | running | paused | finished
    this.chart = null;
    this.audio = null;
    this.startCtxTime = 0;       // audio-clock time mapped to chart t=0
    this.pauseStartedAt = null;  // audio clock when suspend began
    this.pausedDuration = 0;     // accumulated suspended time, audio clock
    this.counts = { perfect: 0, good: 0, miss: 0 };
    this.hitEvents = [];         // diagnostic record of every judgment
    this.rafId = 0;
    this.listenerCount = 0;
    this.inputAttached = false;
    this.boundKeyDown = (e) => this._onKeyDown(e);
    this._onFinish = null;
    this._lastFrameSongTime = 0;
  }

  get offsetSec() {
    return this.params.offsetMs / 1000;
  }

  get windows() {
    return DIFFICULTIES[this.params.difficulty].windows;
  }

  // Song time in chart coordinates. While suspended the audio clock is
  // frozen, so this naturally freezes too — no manual drift compensation.
  get songTime() {
    if (!this.audio || !this.audio.ctx) return 0;
    return this.audio.ctx.currentTime - this.startCtxTime;
  }

  get activeNodeCount() {
    return this.audio ? this.audio.activeNodeCount : 0;
  }

  get audioState() {
    return this.audio ? this.audio.state : 'none';
  }

  // Diagnostic: RMS level at the master bus. While drums are playing this is
  // clearly non-zero; after destroy() the graph no longer exists, so callers
  // can prove that no tail keeps ringing.
  attachMeter() {
    if (!this.audio || this.meter) return;
    const analyser = this.audio.ctx.createAnalyser();
    analyser.fftSize = 512;
    this.audio._register(analyser);
    this.audio.master.connect(analyser);
    this.meter = analyser;
    this.meterBuf = new Float32Array(analyser.fftSize);
  }

  readMeterRms() {
    if (!this.meter || !this.audio || this.audio.state === 'closed') return null;
    this.meter.getFloatTimeDomainData(this.meterBuf);
    let sum = 0;
    for (const v of this.meterBuf) sum += v * v;
    return Math.sqrt(sum / this.meterBuf.length);
  }

  // Idempotent guard makes double start() calls harmless and testable.
  async start() {
    if (this.state === 'running' || this.state === 'countdown') return false;
    if (this.audio) await this._teardownAudio();
    this._resetRun();
    this.state = 'countdown';
    this.audio = new AudioEngine(this.params);
    await this.audio.init();
    this._attachInput();
    this.startCtxTime = this.audio.ctx.currentTime + LEAD_IN;
    this.pausedDuration = 0;
    this.audio.startScheduler(this.chart, this.startCtxTime);
    this.state = 'running';
    this._loop();
    return true;
  }

  _resetRun() {
    this.chart = generateChart(this.params);
    this.counts = { perfect: 0, good: 0, miss: 0 };
    this.hitEvents = [];
    this.pauseStartedAt = null;
    this.pausedDuration = 0;
    this._lastFrameSongTime = 0;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  // Restart destroys everything first, then starts a brand new engine —
  // this guarantees no stale scheduled nodes or duplicated listeners.
  async restart() {
    await this.stop();
    return this.start();
  }

  async pause() {
    if (this.state !== 'running') return false;
    this.state = 'paused';
    this.pauseStartedAt = this.audio.ctx.currentTime;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    await this.audio.suspend();
    return true;
  }

  async resume() {
    if (this.state !== 'paused') return false;
    const suspendedFor = this.audio.ctx.currentTime - this.pauseStartedAt;
    this.pausedDuration += suspendedFor;
    await this.audio.resume();
    // Scheduler was stopped on suspend; restart it; already-scheduled notes
    // are preserved in the suspended context and fire at the same song time.
    this.audio.startScheduler(this.chart, this.startCtxTime);
    this.state = 'running';
    this._loop();
    return true;
  }

  // Full stop: silence, node teardown and listener removal.
  async stop() {
    this.state = 'idle';
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    await this._teardownAudio();
    this._detachInput();
  }

  async _teardownAudio() {
    if (!this.audio) return;
    const engine = this.audio;
    this.audio = null;
    this.meter = null;
    this.meterBuf = null;
    await engine.destroy();
  }

  _attachInput() {
    // Keydown auto-repeat must not register multiple hits.
    if (this.inputAttached) return;
    window.addEventListener('keydown', this.boundKeyDown);
    this.inputAttached = true;
    this.listenerCount = 1;
  }

  _detachInput() {
    if (this.inputAttached) {
      window.removeEventListener('keydown', this.boundKeyDown);
      this.inputAttached = false;
      this.listenerCount = 0;
    }
  }

  setOffsetMs(offsetMs) {
    this.params.offsetMs = offsetMs;
  }

  updateParams(patch) {
    this.params = { ...this.params, ...patch };
    if (this.audio) {
      this.audio.params = this.params;
      if (this.audio.master) this.audio.master.gain.value = this.params.masterGain;
    }
  }

  _onKeyDown(event) {
    if (event.repeat) return;
    if (event.code === 'Space') {
      event.preventDefault();
      if (this.state === 'running') this.pause();
      else if (this.state === 'paused') this.resume();
      return;
    }
    if (this.state !== 'running') return;
    const lane = LANES.find((item) => item.key === event.key.toLowerCase());
    if (!lane) return;
    event.preventDefault();
    this._judgeLane(lane.id, this.audio.ctx.currentTime);
  }

  // Input time is an absolute audio-clock value; offset shifts the point in
  // song time the player is considered to be aiming at.
  _judgeLane(laneId, inputCtxTime) {
    const inputSongTime = inputCtxTime - this.startCtxTime + this.offsetSec;
    const candidates = this.chart.notes.filter(
      (note) => !note.judged && note.lane === laneId,
    );
    let best = null;
    let bestAbs = Infinity;
    for (const note of candidates) {
      const delta = Math.abs(inputSongTime - note.time);
      if (delta < bestAbs) {
        bestAbs = delta;
        best = note;
      }
    }
    const missWindow = DIFFICULTIES[this.params.difficulty].missWindow;
    if (!best || bestAbs > missWindow) {
      this.audio.playHit('miss', laneId);
      this.hitEvents.push({
        lane: laneId, tier: 'miss', deltaSec: null,
        inputSongTime: Number(inputSongTime.toFixed(4)),
      });
      return;
    }
    const signedDelta = inputSongTime - best.time;
    const tier = Math.abs(signedDelta) <= this.windows.perfect ? 'perfect' : 'good';
    best.judged = true;
    best.tier = tier;
    best.hitInputTime = inputCtxTime;
    this.counts[tier] += 1;
    this.hitEvents.push({
      id: best.id, lane: laneId, tier,
      deltaSec: Number(signedDelta.toFixed(4)),
      inputSongTime: Number(inputSongTime.toFixed(4)),
      targetTime: best.time,
    });
    this.audio.playHit(tier, laneId);
  }

  _autoMiss(nowSongTime) {
    const missWindow = DIFFICULTIES[this.params.difficulty].missWindow;
    for (const note of this.chart.notes) {
      if (!note.judged && nowSongTime - note.time > missWindow) {
        note.judged = true;
        note.tier = 'miss';
        this.counts.miss += 1;
        this.hitEvents.push({
          id: note.id, lane: note.lane, tier: 'miss',
          deltaSec: null, inputSongTime: null, targetTime: note.time,
        });
      }
    }
  }

  _loop() {
    if (this.state !== 'running') return;
    const now = this.songTime;
    this._lastFrameSongTime = now;
    this._autoMiss(now);
    this._render(now);
    if (now >= this.chart.duration + 0.5) {
      this._finish();
      return;
    }
    this.rafId = requestAnimationFrame(() => this._loop());
  }

  async _finish() {
    this.state = 'finished';
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this._onFinish) this._onFinish(this.result());
    // Keep the engine alive briefly so the final scheduled drum is audible,
    // then tear everything down automatically.
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (this.state === 'finished') {
      await this._teardownAudio();
      this._detachInput();
    }
  }

  result() {
    const total = JUDGE_TIERS.reduce((sum, tier) => sum + this.counts[tier], 0);
    return {
      counts: { ...this.counts },
      total,
      maxCombo: this._maxCombo(),
      chartDuration: this.chart ? this.chart.duration : 0,
      params: { ...this.params },
    };
  }

  _maxCombo() {
    let combo = 0;
    let maxCombo = 0;
    for (const event of this.hitEvents) {
      if (event.tier === 'miss') {
        combo = 0;
      } else {
        combo += 1;
        maxCombo = Math.max(maxCombo, combo);
      }
    }
    return maxCombo;
  }

  // Test/automation hook: inject a lane hit using the live audio clock.
  simulateLane(laneId, whenCtx) {
    if (this.state !== 'running' || !this.audio) return false;
    this._judgeLane(laneId, whenCtx ?? this.audio.ctx.currentTime);
    return true;
  }

  _render(now) {
    const g = this.ctx2d;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const judgeRadius = Math.min(w, h) * 0.12;
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#0d1117';
    g.fillRect(0, 0, w, h);

    // Four radial tracks and the circular judgment line.
    for (const lane of LANES) {
      const x = cx + Math.cos(lane.angle) * judgeRadius;
      const y = cy + Math.sin(lane.angle) * judgeRadius;
      g.strokeStyle = 'rgba(120,160,255,0.25)';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(lane.angle) * Math.min(w, h) * 0.46,
               cy + Math.sin(lane.angle) * Math.min(w, h) * 0.46);
      g.stroke();
      g.fillStyle = 'rgba(120,160,255,0.9)';
      g.font = 'bold 20px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(lane.label, x, y);
    }
    g.strokeStyle = '#58a6ff';
    g.lineWidth = 4;
    g.beginPath();
    g.arc(cx, cy, judgeRadius, 0, Math.PI * 2);
    g.stroke();

    // Notes travel from outside toward the judgment circle.
    const approach = this.params.approachTime;
    for (const note of this.chart.notes) {
      if (note.judged) continue;
      const eta = note.time - now;
      if (eta > approach || eta < -0.3) continue;
      const progress = 1 - Math.max(0, eta) / approach; // 0 far -> 1 at line
      const radius = judgeRadius + progress * (Math.min(w, h) * 0.34);
      const lane = LANES[note.lane];
      const nx = cx + Math.cos(lane.angle) * radius;
      const ny = cy + Math.sin(lane.angle) * radius;
      g.fillStyle = ['#f85149', '#d29922', '#3fb950', '#a371f7'][note.lane];
      g.beginPath();
      g.arc(nx, ny, 12, 0, Math.PI * 2);
      g.fill();
    }

    g.fillStyle = '#e6edf3';
    g.font = '16px sans-serif';
    g.textAlign = 'left';
    g.fillText(`state: ${this.state}  t=${now.toFixed(2)}s`, 12, 24);
  }

  // ---- Snapshots: persist parameters plus derived chart/runtime evidence ----
  takeSnapshot() {
    return {
      version: SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      params: { ...this.params },
      beatPoints: this.chart
        ? this.chart.notes.slice(0, 8).map((note) => ({
            id: note.id, lane: note.lane, time: Number(note.time.toFixed(4)),
            beat: note.beat,
          }))
        : [],
      chartNoteCount: this.chart ? this.chart.notes.length : 0,
      chartDuration: this.chart ? this.chart.duration : 0,
      runtime: {
        state: this.state,
        activeNodes: this.activeNodeCount,
        audioState: this.audioState,
        listeners: this.listenerCount,
        pausedDuration: this.pausedDuration,
      },
      pans: LANES.map((lane) => ({ lane: lane.id, pan: lane.pan, drum: lane.drum })),
      gains: {
        master: this.params.masterGain,
        drum: this.params.drumGain,
        hit: this.params.hitGain,
        liveMaster: this.audio && this.audio.master
          ? this.audio.master.gain.value : null,
      },
      result: this.state === 'finished' ? this.result() : null,
    };
  }

  saveSnapshot() {
    const snapshot = this.takeSnapshot();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    return snapshot;
  }

  static loadSnapshot() {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  // Restore parameters from a snapshot and regenerate the identical chart.
  restoreSnapshot(snapshot) {
    const source = snapshot || Game.loadSnapshot();
    if (!source) return false;
    this.updateParams(source.params);
    this.chart = generateChart(this.params);
    return true;
  }
}
