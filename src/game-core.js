export const GameState = Object.freeze({
  BOOT: "BOOT",
  READY: "READY",
  CALIBRATION: "CALIBRATION",
  COUNTDOWN: "COUNTDOWN",
  PLAYING: "PLAYING",
  PAUSED: "PAUSED",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  REPLAYING: "REPLAYING"
});

export const CONFIG = Object.freeze({
  durationMs: 60_000,
  countdownMs: 3_000,
  beatMs: 500,
  firstBeatMs: 750,
  perfectWindowMs: 65,
  goodWindowMs: 115,
  missWindowMs: 180,
  missIntegrity: 12,
  strayIntegrity: 7,
  calmIntegrity: 2,
  blurMs: 1_200,
  maxMultiplier: 8,
  calibrationMinMs: -180,
  calibrationMaxMs: 180,
  calibrationSamples: 5,
  version: 1
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const roundMs = (value) => Math.round(value * 1000) / 1000;

export function normalizeSeed(seed) {
  const number = Number(seed);
  if (!Number.isFinite(number)) return 0x20261116;
  return Number(number) >>> 0;
}

export function clampCalibration(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return roundMs(clamp(number, CONFIG.calibrationMinMs, CONFIG.calibrationMaxMs));
}

export function hashString(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder().encode(String(text));
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

function mulberry32(seed) {
  let value = normalizeSeed(seed);
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let result = Math.imul(value ^ (value >>> 15), 1 | value);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function createChart(seed) {
  const normalizedSeed = normalizeSeed(seed);
  const random = mulberry32(normalizedSeed);
  const notes = [];
  let previousLane = 0;
  let runLength = 0;

  for (let index = 0; index < 119; index += 1) {
    let lane = random() < 0.5 ? 0 : 1;
    if (lane === previousLane && runLength >= 2) lane = 1 - lane;
    runLength = lane === previousLane ? runLength + 1 : 1;
    previousLane = lane;
    notes.push({
      index,
      lane,
      timeMs: CONFIG.firstBeatMs + index * CONFIG.beatMs,
      freq: lane === 0
        ? 84 + Math.floor(random() * 9) * 8
        : 320 + Math.floor(random() * 9) * 24,
      cross: false,
      pan: lane === 0 ? -0.86 : 0.86
    });
  }

  let cursor = 12 + Math.floor(random() * 9);
  while (cursor < notes.length) {
    const phraseLength = 3 + Math.floor(random() * 3);
    for (let offset = 0; offset < phraseLength && cursor + offset < notes.length; offset += 1) {
      notes[cursor + offset].cross = true;
    }
    cursor += 24 + Math.floor(random() * 19);
  }

  for (const note of notes) {
    note.pan = note.cross ? -note.pan : note.pan;
  }

  const chartDigest = hashString(
    notes.map((note) => `${note.timeMs}:${note.lane}:${note.freq}:${note.cross ? 1 : 0}`).join("|")
  );
  return { notes, chartDigest, rngState: Math.floor(random() * 0xffffffff) >>> 0 };
}

const ALLOWED_TRANSITIONS = Object.freeze({
  BOOT: ["READY", "CALIBRATION"],
  READY: ["CALIBRATION", "COUNTDOWN", "REPLAYING"],
  CALIBRATION: ["READY"],
  COUNTDOWN: ["PLAYING", "PAUSED", "READY"],
  PLAYING: ["PAUSED", "SUCCESS", "FAILED", "READY"],
  PAUSED: ["COUNTDOWN", "PLAYING", "READY"],
  SUCCESS: ["READY", "REPLAYING"],
  FAILED: ["READY", "REPLAYING"],
  REPLAYING: ["SUCCESS", "FAILED", "READY"]
});

export class RhythmGame {
  constructor({ seed = 0x20261116, calibrationOffset = 0 } = {}) {
    this.seed = normalizeSeed(seed);
    this.calibrationOffset = clampCalibration(calibrationOffset);
    this.events = [];
    this._resetCore(this.seed);
    this.state = GameState.BOOT;
    this.lastChange = {
      seq: 0,
      type: "boot",
      message: "音频图尚未启动",
      atMs: 0
    };
  }

  _resetCore(seed) {
    const chart = createChart(seed);
    this.seed = normalizeSeed(seed);
    this.notes = chart.notes;
    this.chartDigest = chart.chartDigest;
    this.rngState = chart.rngState;
    this.results = new Array(this.notes.length).fill(null);
    this.state = GameState.READY;
    this.songMs = 0;
    this.countdownElapsed = 0;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.multiplier = 1;
    this.integrity = 100;
    this.focus = 0;
    this.focusToggles = 0;
    this.focusAlignedHits = 0;
    this.hits = { perfect: 0, good: 0, late: 0 };
    this.misses = 0;
    this.strays = 0;
    this.blurLane = null;
    this.blurUntil = 0;
    this.inputLog = [];
    this.calibrationSamples = [];
    this.pausedFrom = null;
    this.replayQueue = [];
    this.replayCursor = 0;
    this.replaySpeed = 1;
    this.replayExpectedHash = null;
    this.changeSeq = 0;
    this.lastChange = {
      seq: 0,
      type: "reset",
      message: "计时、资源与随机序列已复位",
      atMs: 0
    };
    this.events = [];
  }

  ready() {
    if (this.state === GameState.BOOT) {
      this._transition(GameState.READY, "音频待命，可以校准或开始", "ready");
    }
    return this.state;
  }

  _change(type, message, atMs = this.songMs) {
    this.changeSeq += 1;
    this.lastChange = {
      seq: this.changeSeq,
      type,
      message,
      atMs: roundMs(atMs)
    };
  }

  _transition(next, message, type) {
    const allowed = ALLOWED_TRANSITIONS[this.state] || [];
    if (!allowed.includes(next)) {
      throw new Error(`Illegal state transition ${this.state} -> ${next}`);
    }
    this.state = next;
    this._change(type || next.toLowerCase(), message);
    this.events.push({ type: "state", state: next, atMs: this.songMs });
  }

  restart(seed = this.seed) {
    const nextSeed = normalizeSeed(seed);
    this._resetCore(nextSeed);
    this._change("restart", "计时、音画资源与随机序列全部复位", 0);
    this.events.push({ type: "state", state: GameState.READY, atMs: 0 });
    return this.state;
  }

  recover() {
    if (this.state !== GameState.FAILED) return false;
    this._resetCore(this.seed);
    this._change("recovered", "失败恢复：完整度、计时与随机序列已复位", 0);
    this.events.push({ type: "state", state: GameState.READY, atMs: 0 });
    return true;
  }

  setCalibrationOffset(value) {
    this.calibrationOffset = clampCalibration(value);
    this._change("calibration", `校准偏移设为 ${this.calibrationOffset} ms`, 0);
    return this.calibrationOffset;
  }

  startCalibration() {
    if (this.state === GameState.BOOT) this.ready();
    if (this.state !== GameState.READY) return false;
    this.calibrationSamples = [];
    this._transition(GameState.CALIBRATION, "跟随点击声敲击 K 进行延迟校准", "calibrating");
    return true;
  }

  addCalibrationSample(deltaMs) {
    if (this.state !== GameState.CALIBRATION) return false;
    const delta = Number(deltaMs);
    if (!Number.isFinite(delta)) return false;
    this.calibrationSamples.push(roundMs(clamp(delta, -400, 400)));
    this._change(
      "calibration-sample",
      `校准采样 ${this.calibrationSamples.length}/${CONFIG.calibrationSamples}`,
      0
    );
    if (this.calibrationSamples.length >= CONFIG.calibrationSamples) {
      this.finishCalibration();
    }
    return true;
  }

  finishCalibration() {
    if (this.state !== GameState.CALIBRATION) return this.calibrationOffset;
    if (this.calibrationSamples.length) {
      this.calibrationOffset = clampCalibration(median(this.calibrationSamples));
    }
    this._transition(GameState.READY, `校准完成：${this.calibrationOffset} ms`, "calibrated");
    return this.calibrationOffset;
  }

  cancelCalibration() {
    if (this.state !== GameState.CALIBRATION) return false;
    this.calibrationSamples = [];
    this._transition(GameState.READY, "已取消校准", "calibration-cancelled");
    return true;
  }

  begin() {
    if (this.state === GameState.BOOT) this.ready();
    if (this.state !== GameState.READY) return false;
    this.songMs = 0;
    this.countdownElapsed = 0;
    this._transition(GameState.COUNTDOWN, "三秒后进入六十秒曲目", "countdown");
    return true;
  }

  pause() {
    if (this.state !== GameState.COUNTDOWN && this.state !== GameState.PLAYING) return false;
    this.pausedFrom = this.state;
    this._transition(GameState.PAUSED, "演出暂停：时钟与音频已冻结", "paused");
    return true;
  }

  resume() {
    if (this.state !== GameState.PAUSED) return false;
    const destination = this.pausedFrom || GameState.PLAYING;
    this.pausedFrom = null;
    this._transition(destination, "演出恢复：时钟与音频继续", "resumed");
    return true;
  }

  advance(deltaMs) {
    const rawDelta = Number(deltaMs);
    const delta = Number.isFinite(rawDelta) ? clamp(rawDelta, 0, 10_000) : 0;
    if (this.state === GameState.COUNTDOWN) {
      this.countdownElapsed += delta;
      if (this.countdownElapsed < CONFIG.countdownMs) return this.state;
      const overflow = this.countdownElapsed - CONFIG.countdownMs;
      this._transition(GameState.PLAYING, "曲目开始：低频左轨，高频右轨", "playing");
      this._advanceCore(this.songMs + overflow);
    } else if (this.state === GameState.PLAYING) {
      this._advanceCore(this.songMs + delta);
    } else if (this.state === GameState.REPLAYING) {
      this._advanceReplay(delta * this.replaySpeed);
    }
    return this.state;
  }

  _nextMissDeadline(limit) {
    let best = null;
    for (let index = 0; index < this.notes.length; index += 1) {
      if (this.results[index]) continue;
      const deadline = this.notes[index].timeMs + CONFIG.missWindowMs;
      if (deadline < limit && (best === null || deadline < best.deadline)) {
        best = { index, deadline };
      }
    }
    return best;
  }

  _advanceCore(targetMs) {
    if (this.state !== GameState.PLAYING && this.state !== GameState.REPLAYING) return;
    const target = clamp(Number(targetMs) || 0, 0, CONFIG.durationMs);
    if (target < this.songMs) return;

    while (
      this.songMs < target &&
      (this.state === GameState.PLAYING || this.state === GameState.REPLAYING)
    ) {
      const miss = this._nextMissDeadline(target);
      if (!miss) {
        this.songMs = target;
        break;
      }
      this.songMs = Math.max(this.songMs, roundMs(miss.deadline));
      this._recordMiss(miss.index);
    }

    if (
      this.songMs >= CONFIG.durationMs &&
      (this.state === GameState.PLAYING || this.state === GameState.REPLAYING)
    ) {
      this.songMs = CONFIG.durationMs;
      this._transition(GameState.SUCCESS, "六十秒曲目完成", "success");
      this.events.push({ type: "complete", atMs: this.songMs, score: this.score });
    }
  }

  pressLane(lane) {
    if (this.state !== GameState.PLAYING && this.state !== GameState.REPLAYING) return false;
    const normalizedLane = lane === 1 ? 1 : 0;
    this._recordInput({ type: "hit", lane: normalizedLane, at: roundMs(this.songMs) });
    this._applyHit(normalizedLane);
    return true;
  }

  toggleFocus({ record = true } = {}) {
    if (
      this.state !== GameState.PLAYING &&
      this.state !== GameState.REPLAYING &&
      this.state !== GameState.COUNTDOWN
    ) {
      return false;
    }
    this.focus = 1 - this.focus;
    this.focusToggles += 1;
    if (record) {
      this._recordInput({ type: "focus", at: roundMs(this.songMs) });
    }
    const label = this.focus === 0 ? "低频轨" : "高频轨";
    this._change("focus", `监听焦点切换至${label}`, this.songMs);
    this.events.push({ type: "focus", lane: this.focus, atMs: this.songMs });
    return true;
  }

  _recordInput(input) {
    this.inputLog.push({
      type: input.type,
      ...(input.type === "hit" ? { lane: input.lane } : {}),
      at: roundMs(input.at)
    });
  }

  _applyHit(lane) {
    const judgedAt = roundMs(this.songMs - this.calibrationOffset);
    let bestIndex = -1;
    let bestDelta = Infinity;
    for (let index = 0; index < this.notes.length; index += 1) {
      const note = this.notes[index];
      if (this.results[index] || note.lane !== lane) continue;
      const delta = judgedAt - note.timeMs;
      if (Math.abs(delta) <= CONFIG.missWindowMs && Math.abs(delta) < Math.abs(bestDelta)) {
        bestIndex = index;
        bestDelta = delta;
      }
    }

    if (bestIndex < 0) {
      this._applyStray(lane);
      return;
    }

    const absolute = Math.abs(bestDelta);
    let kind = "late";
    let base = 30;
    if (absolute <= CONFIG.perfectWindowMs) {
      kind = "perfect";
      base = 100;
    } else if (absolute <= CONFIG.goodWindowMs) {
      kind = "good";
      base = 70;
    }

    const focusAligned = lane === this.focus;
    if (focusAligned) this.focusAlignedHits += 1;
    const focusFactor = focusAligned ? 1.25 : 0.7;
    this.score += Math.round(base * this.multiplier * focusFactor);
    this.combo += 1;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.multiplier = Math.min(CONFIG.maxMultiplier, 1 + Math.floor(this.combo / 4));
    this.hits[kind] += 1;
    this.integrity = Math.min(100, this.integrity + (kind === "perfect" ? 1 : 0));
    this.results[bestIndex] = {
      kind,
      delta: roundMs(bestDelta),
      atMs: roundMs(this.songMs),
      lane
    };
    const laneLabel = lane === 0 ? "低频" : "高频";
    this._change(
      "hit",
      `${kind.toUpperCase()} · ${laneLabel}轨 ${bestDelta >= 0 ? "+" : ""}${Math.round(bestDelta)} ms`,
      this.songMs
    );
    this.events.push({
      type: "hit",
      lane,
      judgment: kind,
      delta: roundMs(bestDelta),
      note: this.notes[bestIndex],
      atMs: this.songMs,
      focusAligned
    });
  }

  _applyStray(lane) {
    this.strays += 1;
    this.misses += 1;
    this.combo = 0;
    this.multiplier = 1;
    this.integrity = Math.max(0, this.integrity - CONFIG.strayIntegrity);
    this.blurLane = 1 - lane;
    this.blurUntil = roundMs(this.songMs + CONFIG.blurMs);
    this._change("stray", `错拍：${lane === 0 ? "低频" : "高频"}轨无目标，对侧音轨模糊`, this.songMs);
    this.events.push({
      type: "miss",
      cause: "stray",
      lane: this.blurLane,
      atMs: this.songMs
    });
    if (this.integrity <= 0) {
      this._transition(GameState.FAILED, "同步完整度归零，演出失败", "failed");
    }
  }

  _recordMiss(index) {
    const note = this.notes[index];
    if (!note || this.results[index]) return;
    this.results[index] = {
      kind: "miss",
      delta: null,
      atMs: roundMs(this.songMs),
      lane: note.lane
    };
    this.misses += 1;
    this.combo = 0;
    this.multiplier = 1;
    this.integrity = Math.max(0, this.integrity - CONFIG.missIntegrity);
    this.blurLane = 1 - note.lane;
    this.blurUntil = roundMs(this.songMs + CONFIG.blurMs);
    const laneLabel = note.lane === 0 ? "低频" : "高频";
    this._change("miss", `漏拍：${laneLabel}轨，对侧音轨模糊`, this.songMs);
    this.events.push({
      type: "miss",
      cause: "deadline",
      lane: this.blurLane,
      note,
      atMs: this.songMs
    });
    if (this.integrity <= 0) {
      this._transition(GameState.FAILED, "同步完整度归零，演出失败", "failed");
    }
  }

  startReplay(record, { speed = 20 } = {}) {
    if (!record || !Array.isArray(record.inputs)) {
      throw new Error("Replay record is missing an input list");
    }
    const seed = normalizeSeed(record.seed);
    const offset = clampCalibration(record.calibrationOffset);
    this._resetCore(seed);
    this.calibrationOffset = offset;
    this.replayQueue = record.inputs
      .filter((input) => input && (input.type === "hit" || input.type === "focus"))
      .map((input) => ({
        type: input.type,
        ...(input.type === "hit" ? { lane: input.lane === 1 ? 1 : 0 } : {}),
        at: roundMs(clamp(Number(input.at) || 0, 0, CONFIG.durationMs))
      }))
      .sort((a, b) => a.at - b.at);
    this.replayCursor = 0;
    this.replaySpeed = clamp(Number(speed) || 1, 0.25, 60);
    this.replayExpectedHash = record.finalHash || null;
    this._transition(
      GameState.REPLAYING,
      `确定性回放：${this.replayQueue.length} 条输入 · ${this.replaySpeed}×`,
      "replay"
    );
    this.events.push({ type: "replay-start", atMs: 0 });
    return true;
  }

  _advanceReplay(advanceMs) {
    const target = clamp(this.songMs + Math.max(0, advanceMs), 0, CONFIG.durationMs);
    while (
      this.replayCursor < this.replayQueue.length &&
      this.state === GameState.REPLAYING
    ) {
      const input = this.replayQueue[this.replayCursor];
      if (input.at > target) break;
      this.replayCursor += 1;
      this._advanceCore(input.at);
      if (this.state !== GameState.REPLAYING) break;
      this._recordInput(input);
      if (input.type === "hit") {
        this._applyHit(input.lane);
      } else {
        this.toggleFocus({ record: false });
      }
    }
    if (this.state === GameState.REPLAYING) this._advanceCore(target);
  }

  finishReplay() {
    if (this.state !== GameState.REPLAYING) return this.state;
    this._advanceReplay(CONFIG.durationMs);
    return this.state;
  }

  replayHashMatches() {
    if (!this.replayExpectedHash) return null;
    if (this.state !== GameState.SUCCESS && this.state !== GameState.FAILED) return null;
    return this.hashState() === this.replayExpectedHash;
  }

  hashState() {
    const results = this.results.map((result) => result && [
      result.kind,
      result.delta,
      result.atMs,
      result.lane
    ]);
    return hashString(JSON.stringify({
      version: CONFIG.version,
      chartDigest: this.chartDigest,
      rngState: this.rngState,
      seed: this.seed,
      calibrationOffset: this.calibrationOffset,
      state: this.state,
      songMs: roundMs(this.songMs),
      score: this.score,
      combo: this.combo,
      maxCombo: this.maxCombo,
      multiplier: this.multiplier,
      integrity: this.integrity,
      focus: this.focus,
      focusToggles: this.focusToggles,
      focusAlignedHits: this.focusAlignedHits,
      hits: this.hits,
      misses: this.misses,
      strays: this.strays,
      blurLane: this.blurLane,
      blurUntil: this.blurUntil,
      results,
      inputs: this.inputLog
    }));
  }

  exportRecord() {
    const final = this.state === GameState.SUCCESS || this.state === GameState.FAILED;
    return {
      format: "phase-split-record",
      version: CONFIG.version,
      seed: this.seed,
      calibrationOffset: this.calibrationOffset,
      chartDigest: this.chartDigest,
      inputs: this.inputLog.map((input) => ({ ...input })),
      finalState: final ? this.state : null,
      finalHash: final ? this.hashState() : null
    };
  }

  getTarget() {
    for (let index = 0; index < this.notes.length; index += 1) {
      if (!this.results[index]) return this.notes[index];
    }
    return null;
  }

  getObjective() {
    const target = this.getTarget();
    if (this.state === GameState.BOOT) {
      return { title: "启动音频，准备演出", detail: "校准可减少设备延迟误差。" };
    }
    if (this.state === GameState.READY) {
      return { title: "锁定六十秒时间线", detail: "按开始演出；或先做 5 次延迟校准。" };
    }
    if (this.state === GameState.CALIBRATION) {
      return {
        title: `校准采样 ${this.calibrationSamples.length}/5`,
        detail: "跟随点击声敲击 K；完成后自动采用中位偏移。"
      };
    }
    if (this.state === GameState.COUNTDOWN) {
      const remaining = Math.max(1, Math.ceil((CONFIG.countdownMs - this.countdownElapsed) / 1000));
      return { title: `准备 ${remaining}`, detail: "空格可提前切换监听焦点。" };
    }
    if (this.state === GameState.PAUSED) {
      return { title: "演出已暂停", detail: "按 P 或暂停按钮继续；计时与音频保持冻结。" };
    }
    if (this.state === GameState.SUCCESS) {
      return { title: "六十秒曲目完成", detail: "可回放输入记录并核对最终状态哈希。" };
    }
    if (this.state === GameState.FAILED) {
      return { title: "同步断裂", detail: "失败恢复会复位完整度、计时和随机序列。" };
    }
    if (this.state === GameState.REPLAYING) {
      return {
        title: `确定性回放 ${Math.min(100, Math.round(this.songMs / 600))}%`,
        detail: `按 ${this.replaySpeed}× 重演 ${this.replayQueue.length} 条输入。`
      };
    }
    if (!target) {
      return { title: "曲目收尾", detail: "保持同步直到 60.000 秒。" };
    }
    const lane = target.lane === 0 ? "低频轨" : "高频轨";
    const key = target.lane === 0 ? "F" : "J";
    const eta = Math.max(0, target.timeMs - (this.songMs - this.calibrationOffset));
    const crossing = target.cross ? " · 交叉声像" : "";
    return {
      title: `${lane} · 按 ${key}`,
      detail: `${(eta / 1000).toFixed(2)}s 后抵达${crossing}${target.lane === this.focus ? " · 焦点已锁定" : " · 焦点在另一轨"}`
    };
  }

  getSnapshot() {
    const target = this.getTarget();
    return {
      state: this.state,
      songMs: roundMs(this.songMs),
      countdownElapsed: roundMs(this.countdownElapsed),
      score: this.score,
      combo: this.combo,
      maxCombo: this.maxCombo,
      multiplier: this.multiplier,
      integrity: this.integrity,
      focus: this.focus,
      focusToggles: this.focusToggles,
      focusAlignedHits: this.focusAlignedHits,
      hits: { ...this.hits },
      misses: this.misses,
      strays: this.strays,
      blurLane: this.blurLane,
      blurUntil: this.blurUntil,
      blurActive: this.blurLane !== null && this.songMs < this.blurUntil,
      seed: this.seed,
      calibrationOffset: this.calibrationOffset,
      chartDigest: this.chartDigest,
      noteCount: this.notes.length,
      resolvedCount: this.results.filter(Boolean).length,
      target: target ? { ...target } : null,
      objective: this.getObjective(),
      lastChange: { ...this.lastChange },
      inputCount: this.inputLog.length,
      replay: this.state === GameState.REPLAYING
        ? {
            cursor: this.replayCursor,
            total: this.replayQueue.length,
            speed: this.replaySpeed,
            expectedHash: this.replayExpectedHash,
            matches: this.replayHashMatches()
          }
        : null
    };
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  peekRandomSequence(count = 4) {
    let state = this.rngState;
    const values = [];
    for (let index = 0; index < count; index += 1) {
      state = (state + 0x6d2b79f5) | 0;
      let result = Math.imul(state ^ (state >>> 15), 1 | state);
      result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
      values.push(((result ^ (result >>> 14)) >>> 0) / 4_294_967_296);
    }
    return values;
  }
}
