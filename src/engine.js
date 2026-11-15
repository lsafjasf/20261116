/*
 * Pure deterministic diagnostic engine: no DOM, no AudioContext.
 * All acoustics are math so the same seed + input record always yields
 * the same observable snapshot and final hash.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./rng'), require('./hash'));
  } else {
    root.AudioDiag = root.AudioDiag || {};
    root.AudioDiag.Engine = factory(root.AudioDiag, root.AudioDiag);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (rngUtil, hashUtil) {
  'use strict';

  const mulberry32 = rngUtil.mulberry32;
  const shuffle = rngUtil.shuffle;
  const mixSeed32 = rngUtil.mixSeed32;
  const noise2 = rngUtil.noise2;
  const hashObject = hashUtil.hashObject;

  const STATES = ['normal', 'loose', 'friction', 'overload'];
  const STATE_LABEL = {
    normal: '正常', loose: '松动', friction: '摩擦', overload: '过载'
  };
  const BANDS = [125, 500, 2000, 8000];
  const TICK_MS = 100;
  const RECOVERY_TICKS = 30;
  const MAX_MISTAKES = 4;
  const CLARITY_OK = 0.45;
  const SWEET_RADIUS = 0.9;
  const CLIP_GAIN = 3.0;
  const FILTER_MIN = 100, FILTER_MAX = 8000;
  const GAIN_MIN = 0.25, GAIN_MAX = 6.0;

  /* Per-state band base amplitudes (RMS), envelope, rhythm Hz and jitter. */
  const STATE_PROFILE = {
    normal:   { bands: [0.50, 0.34, 0.16, 0.06], env: 'sine',  rhythm: 12, jitter: 0.05, pulse: 0.35 },
    loose:    { bands: [0.55, 0.30, 0.10, 0.05], env: 'pulse', rhythm: 6,  jitter: 0.12, pulse: 0.90 },
    friction: { bands: [0.14, 0.26, 0.42, 0.18], env: 'rough', rhythm: 0,  jitter: 0.20, pulse: 0.5 },
    overload: { bands: [0.60, 0.55, 0.45, 0.25], env: 'swell', rhythm: 2,  jitter: 0.08, pulse: 0.45 }
  };

  const FSM = {
    menu:     ['running', 'closed_fail', 'closed_win'],
    running:  ['paused', 'recovery', 'closed_fail', 'closed_win'],
    paused:   ['running', 'menu'],
    recovery: ['running', 'closed_fail'],
    closed_fail: ['menu'],
    closed_win: ['menu']
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function envelope(kind, phase, jitter, pulse, seedA, tickIndex) {
    if (kind === 'pulse') {
      const duty = clamp(pulse, 0.1, 0.9);
      return phase < duty ? 1 : 0.3;
    }
    if (kind === 'rough') {
      const base = 0.72 + 0.24 * noise2(seedA, tickIndex);
      return clamp(base + (noise2(seedA * 3 + 7, tickIndex) * jitter), 0.25, 1);
    }
    if (kind === 'swell') {
      return 0.45 + 0.55 * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase));
    }
    return 0.6 + 0.4 * Math.sin(2 * Math.PI * phase);
  }

  function Engine(options) {
    options = options || {};
    this.host = options.host || null;
    this.initialSeed = options.seed == null ? (Date.now() & 0xffffffff) : options.seed >>> 0;
    this.time = 0;
    this.tickIndex = 0;
    this.totalTicks = 0;
    this.records = [];
    this.lastTransition = null;
    this._resetRun(this.initialSeed, true);
  }

  Engine.prototype._resetRun = function (seed, freshEngine) {
    const rng = mulberry32(mixSeed32(seed));
    this.seed = seed >>> 0;
    this.rngState = this.seed >>> 0;
    this.fsm = 'menu';
    this.elapsedMs = 0;
    this.tickIndex = 0;
    this.mistakes = 0;
    this.solvedCount = 0;
    this.recoveryLeft = 0;
    this.lastRejection = null;
    this.listener = { x: 0, y: 0 };
    this.filters = { hpf: 0, lpf: FILTER_MAX };
    this.gain = 1.0;
    this.clipped = false;
    this.clipEnergy = 0;
    this.runId = (this.runId || 0) + 1;
    if (!freshEngine) this.records = [];
    const assignment = shuffle(rng, STATES);
    const positions = [
      { x: 0, y: 3 }, { x: 3, y: 0 }, { x: 0, y: -3 }, { x: -3, y: 0 }
    ];
    this.devices = assignment.map((state, i) => {
      const profile = STATE_PROFILE[state];
      return {
        id: i,
        name: 'D' + (i + 1),
        state,
        pos: positions[i],
        rhythm: Math.max(0, profile.rhythm + (rng() - 0.5) * profile.jitter * profile.rhythm),
        phase0: rng(),
        ampScale: 0.85 + rng() * 0.3,
        profile,
        solved: false,
        solvedAt: null,
        attempts: 0
      };
    });
    this.metrics = this._computeMetrics();
    this._transition('menu', 'init');
  };

  Engine.prototype._transition = function (to, reason) {
    const from = this.fsm;
    this.fsm = to;
    this.lastTransition = { tick: this.tickIndex, time: this.elapsedMs, from, to, reason };
    if (this.host && this.host.onState) this.host.onState(to, this);
  };

  Engine.prototype._frozen = function () {
    return this.fsm === 'paused' || this.fsm === 'closed_fail' ||
      this.fsm === 'closed_win' || this.fsm === 'menu';
  };

  Engine.prototype._record = function (type, data) {
    this._logSeq = (this._logSeq || 0) + 1;
    this.records.push({ tick: this.tickIndex, totalTick: this.totalTicks, type, data: data || {} });
  };

  Engine.prototype.tick = function () {
    if (this.fsm === 'menu' || this.fsm === 'paused' ||
        this.fsm === 'closed_fail' || this.fsm === 'closed_win') {
      return this;
    }
    this.tickIndex++;
    this.totalTicks++;
    this.elapsedMs += TICK_MS;
    this._record('tick', {});
    if (this.fsm === 'recovery') {
      this.recoveryLeft--;
      if (this.recoveryLeft <= 0) this._transition('running', 'recovery_done');
    }
    this.metrics = this._computeMetrics();
    if (this.host && this.host.onTick) this.host.onTick(this);
    return this;
  };

  Engine.prototype.start = function () {
    if (this.fsm !== 'menu') return this;
    this._record('start', { seed: this.seed });
    this._transition('running', 'start');
    this.metrics = this._computeMetrics();
    return this;
  };

  Engine.prototype.pause = function () {
    if (this.fsm !== 'running' && this.fsm !== 'recovery') return this;
    this._record('pause', {});
    this._transition('paused', 'user_pause');
    return this;
  };

  Engine.prototype.resume = function () {
    if (this.fsm !== 'paused') return this;
    this._record('resume', {});
    const backTo = this.recoveryLeft > 0 ? 'recovery' : 'running';
    this._transition(backTo, 'user_resume');
    return this;
  };

  Engine.prototype.moveListener = function (x, y) {
    if (this._frozen()) return this;
    const nx = clamp(Number(x) || 0, -5, 5);
    const ny = clamp(Number(y) || 0, -5, 5);
    if (Math.abs(nx - this.listener.x) < 1e-9 && Math.abs(ny - this.listener.y) < 1e-9) return this;
    this._record('move', { x: nx, y: ny });
    this.listener = { x: nx, y: ny };
    this.metrics = this._computeMetrics();
    if (this.host && this.host.onMove) this.host.onMove(nx, ny);
    return this;
  };

  Engine.prototype.setFilter = function (kind, value) {
    if (this._frozen()) return this;
    const v = Math.round(clamp(Number(value) || 0, 0, FILTER_MAX));
    if (kind === 'hpf') this.filters.hpf = clamp(v, 0, FILTER_MAX - 50);
    else this.filters.lpf = clamp(v, FILTER_MIN, FILTER_MAX);
    if (this.filters.hpf >= this.filters.lpf) this.filters.lpf = clamp(this.filters.hpf + 100, FILTER_MIN, FILTER_MAX);
    this._record('filter', { kind, value: kind === 'hpf' ? this.filters.hpf : this.filters.lpf });
    this.metrics = this._computeMetrics();
    if (this.host && this.host.onFilter) this.host.onFilter(this.filters);
    return this;
  };

  Engine.prototype.setGain = function (value) {
    if (this._frozen()) return this;
    const g = clamp(Number(value) || 0, GAIN_MIN, GAIN_MAX);
    this.gain = Math.round(g * 100) / 100;
    this._record('gain', { value: this.gain });
    this.metrics = this._computeMetrics();
    if (this.host && this.host.onGain) this.host.onGain(this.gain, this.clipped);
    return this;
  };

  Engine.prototype.submitDiagnosis = function (deviceId, state) {
    if (this._frozen()) return { accepted: false, reason: 'frozen' };
    const device = this.devices[deviceId];
    if (!device || STATES.indexOf(state) < 0) return { accepted: false, reason: 'bad_input' };
    if (device.solved) return { accepted: false, reason: 'already_solved' };
    const detail = this.metrics.detail[deviceId];
    const wrongPosition = detail.dist > SWEET_RADIUS;
    const lowConfidence = detail.clarity < CLARITY_OK;
    this._record('submit', { deviceId, state });
    device.attempts++;
    if (wrongPosition || lowConfidence) {
      this.lastRejection = {
        deviceId, tick: this.tickIndex,
        reasons: [wrongPosition ? 'wrong_position' : null, lowConfidence ? 'low_confidence' : null].filter(Boolean)
      };
      this._enterRecovery('rejected_' + (wrongPosition ? 'position' : 'confidence'));
      return { accepted: false, reason: this.lastRejection.reasons.join('+'), clarity: detail.clarity, dist: detail.dist };
    }
    if (state !== device.state) {
      this.mistakes++;
      this.lastRejection = { deviceId, tick: this.tickIndex, reasons: ['wrong_state'] };
      this._record('mistake', { deviceId, expected: device.state, given: state });
      if (this.mistakes >= MAX_MISTAKES) {
        this._transition('closed_fail', 'mistakes_exhausted');
        return { accepted: false, reason: 'case_failed', mistakes: this.mistakes };
      }
      this._enterRecovery('wrong_state');
      return { accepted: false, reason: 'wrong_state', mistakes: this.mistakes };
    }
    device.solved = true;
    device.solvedAt = this.tickIndex;
    this.solvedCount++;
    this._record('solved', { deviceId, state });
    this.metrics = this._computeMetrics();
    if (this.solvedCount === this.devices.length) {
      this._transition('closed_win', 'all_solved');
    }
    return { accepted: true, solved: this.solvedCount };
  };

  Engine.prototype._enterRecovery = function (reason) {
    this.recoveryLeft = RECOVERY_TICKS;
    this.gain = 1.0;
    this.filters = { hpf: 0, lpf: FILTER_MAX };
    this.metrics = this._computeMetrics();
    this._transition('recovery', reason);
  };

  Engine.prototype.restart = function (newSeed, keepLog) {
    const seed = newSeed == null ? (mixSeed32(this.seed ^ (this.runId * 2654435761 >>> 0))) : newSeed >>> 0;
    this._resetRun(seed, true);
    if (keepLog) this._record('restart', { seed });
    else this.records = [];
    if (this.host && this.host.onRestart) this.host.onRestart(this);
    return this;
  };

  Engine.prototype.exportRecord = function () {
    return { seed: this.initialSeed, tickMs: TICK_MS, records: this.records.slice() };
  };

  Engine.prototype.snapshot = function () {
    return {
      seed: this.seed,
      runId: this.runId,
      fsm: this.fsm,
      tick: this.tickIndex,
      elapsedMs: this.elapsedMs,
      mistakes: this.mistakes,
      solvedCount: this.solvedCount,
      recoveryLeft: this.recoveryLeft,
      listener: this.listener,
      filters: this.filters,
      gain: this.gain,
      clipped: this.clipped,
      devices: this.devices.map((d) => ({
        id: d.id, state: d.state, rhythm: d.rhythm, phase0: d.phase0,
        ampScale: d.ampScale, solved: d.solved, solvedAt: d.solvedAt, attempts: d.attempts
      })),
      detail: this.metrics.detail.map((d) => ({
        id: d.id, focus: round4(d.focus), snr: round4(d.snr),
        clarity: round4(d.clarity), dist: round4(d.dist), angle: round4(d.angle)
      })),
      spectrum: this.metrics.spectrum.map((s) => ({ fc: s.fc, level: round2(s.level), noise: round2(s.noise) })),
      spl: this.metrics.spl.map((s) => ({ id: s.id, l: round2(s.l), r: round2(s.r) }))
    };
  };

  Engine.prototype.stateHash = function () {
    return hashObject(this.snapshot());
  };

  function round2(v) { return Math.round(v * 100) / 100; }
  function round4(v) { return Math.round(v * 10000) / 10000; }

  Engine.replay = function (record, host) {
    const engine = new Engine({ seed: record.seed, host: host || null });
    let cursor = 0;
    let guard = 0;
    while (cursor < record.records.length && guard++ < 200000) {
      const rec = record.records[cursor];
      while (engine.totalTicks < (rec.totalTick || 0)) {
        engine.tick();
      }
      applyRecord(engine, rec);
      cursor++;
    }
    return engine;
  };

  function applyRecord(engine, rec) {
    const d = rec.data;
    switch (rec.type) {
      case 'start': engine.start(); break;
      case 'pause': engine.pause(); break;
      case 'resume': engine.resume(); break;
      case 'move': engine.moveListener(d.x, d.y); break;
      case 'filter': engine.setFilter(d.kind, d.value); break;
      case 'gain': engine.setGain(d.value); break;
      case 'submit': engine.submitDiagnosis(d.deviceId, d.state); break;
      case 'restart': engine.restart(d.seed, true); break;
      default: break;
    }
  }

  Engine.STATES = STATES;
  Engine.STATE_LABEL = STATE_LABEL;
  Engine.BANDS = BANDS;
  Engine.TICK_MS = TICK_MS;
  Engine.SWEET_RADIUS = SWEET_RADIUS;
  Engine.CLARITY_OK = CLARITY_OK;
  Engine.GAIN_MIN = GAIN_MIN;
  Engine.GAIN_MAX = GAIN_MAX;
  Engine.CLIP_GAIN = CLIP_GAIN;
  function filterFactor(band, hpf, lpf) {
    const high = hpf <= 0 ? 1 : 1 / (1 + Math.pow(hpf / band, 2));
    const low = 1 / (1 + Math.pow(band / lpf, 2));
    return high * low;
  }

  Engine.prototype._deviceBandRaw = function (device, bandIndex, t) {
    const p = device.profile;
    const phase = (t * device.rhythm + device.phase0) % 1;
    const env = envelope(p.env, phase, p.jitter, p.pulse, device.id * 97 + bandIndex, this.tickIndex);
    const jitterGain = 1 + (noise2(device.id * 13 + bandIndex, this.tickIndex) * p.jitter);
    return p.bands[bandIndex] * env * device.ampScale * jitterGain;
  };

  Engine.prototype._computeMetrics = function () {
    const t = this.tickIndex * TICK_MS / 1000;
    const perDevice = this.devices.map((d) => {
      const dx = d.pos.x - this.listener.x;
      const dy = d.pos.y - this.listener.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const att = 1 / (1 + 0.55 * dist * dist);
      const raw = BANDS.map((_, bi) => this._deviceBandRaw(d, bi, t));
      return { id: d.id, dist, att, raw };
    });

    const bands = BANDS.map((fc, bi) => {
      let sig = 0, noiseFloor = 0;
      perDevice.forEach((m) => {
        const v = m.raw[bi] * m.att;
        sig += v * v;
        noiseFloor += (0.012 * m.att) * (0.012 * m.att);
      });
      const factor = filterFactor(fc, this.filters.hpf, this.filters.lpf);
      const pre = Math.sqrt(sig) * factor;
      const noise = Math.sqrt(noiseFloor) * factor;
      const scaled = pre * this.gain;
      const limited = Math.tanh(scaled);
      const clip = Math.max(0, scaled - 0.95);
      return { fc, factor, pre, noise, scaled, limited, clip };
    });

    this.clipEnergy = bands.reduce((s, b) => s + b.clip * b.clip, 0) / bands.length;
    this.clipped = this.gain > CLIP_GAIN || this.clipEnergy > 0.02;
    const distortionNoise = this.clipped
      ? 0.05 + 0.12 * (this.gain - CLIP_GAIN) + this.clipEnergy * 1.2
      : 0;

    const devices = perDevice.map((m) => {
      let sig2 = 0, bandEnergy = BANDS.map(() => 0);
      m.raw.forEach((r, bi) => {
        const f = bands[bi].factor;
        const e = r * m.att * f * this.gain;
        bandEnergy[bi] = e;
        sig2 += e * e;
      });
      return { id: m.id, dist: m.dist, att: m.att, sig2, bandEnergy };
    });

    const totalSig2 = devices.reduce((s, d) => s + d.sig2, 0);
    const enrichedNoise = bands.reduce((s, b) => {
      return s + Math.pow(b.noise * this.gain + distortionNoise, 2);
    }, 0);

    const detail = devices.map((d) => {
      const focus = totalSig2 > 0 ? d.sig2 / totalSig2 : 0.25;
      const noiseEnergy = enrichedNoise + distortionNoise * distortionNoise * BANDS.length * 4;
      const snr = totalSig2 > 0 ? 10 * Math.log10((d.sig2 + 1e-9) / (noiseEnergy + 1e-9)) : 0;
      const rhythmFactor = 0.7 + 0.3 * (this.devices[d.id].profile.env === 'rough' ? 0.6 : 1);
      const gainPenalty = 1 / (1 + distortionNoise * 6);
      const clarity = clamp(
        focus * 1.35 * (1 - 1 / (1 + Math.max(0, snr) / 6)) * rhythmFactor * gainPenalty, 0, 1
      );
      const angle = Math.atan2(
        this.devices[d.id].pos.y - this.listener.y,
        this.devices[d.id].pos.x - this.listener.x
      );
      return { id: d.id, focus, snr, clarity, angle, dist: d.dist, bandEnergy: d.bandEnergy };
    });

    const spl = detail.map((d) => {
      const base = 20 * Math.log10(Math.sqrt(d.sig2 + 1e-9));
      const l = clamp(60 + base + Math.sin(d.angle) * 2.5, 20, 120);
      const r = clamp(60 + base - Math.sin(d.angle) * 2.5, 20, 120);
      return { id: d.id, l, r };
    });

    const spectrum = bands.map((b) => ({
      fc: b.fc,
      level: clamp(20 * Math.log10(b.limited + 1e-6) + 90, 0, 100),
      noise: clamp(20 * Math.log10(b.noise * this.gain + distortionNoise + 1e-6) + 90, 0, 100)
    }));

    return {
      t, bands, detail, spl, spectrum,
      noiseFloorDb: clamp(20 * Math.log10(Math.sqrt(enrichedNoise + 1e-9)) + 80, 0, 100)
    };
  };

  return Engine;
});
