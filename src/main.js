import { CONFIG, GameState, RhythmGame, normalizeSeed } from "./game-core.js";
import { DualTrackAudio } from "./audio.js";
import { StageRenderer } from "./renderer.js";

const elements = {
  canvas: document.querySelector("#stage"),
  clock: document.querySelector("#clock"),
  objective: document.querySelector("#objective"),
  objectiveDetail: document.querySelector("#objective-detail"),
  focusLabel: document.querySelector("#focus-label"),
  integrityText: document.querySelector("#integrity-text"),
  integrityBar: document.querySelector("#integrity-bar"),
  score: document.querySelector("#score"),
  multiplier: document.querySelector("#multiplier"),
  combo: document.querySelector("#combo"),
  focusBonus: document.querySelector("#focus-bonus"),
  offset: document.querySelector("#offset"),
  audioResources: document.querySelector("#audio-resources"),
  spectrumResources: document.querySelector("#spectrum-resources"),
  changeTime: document.querySelector("#change-time"),
  lastChange: document.querySelector("#last-change"),
  flashMessage: document.querySelector("#flash-message"),
  overlay: document.querySelector("#overlay"),
  overlayKicker: document.querySelector("#overlay-kicker"),
  overlayTitle: document.querySelector("#overlay-title"),
  overlayCopy: document.querySelector("#overlay-copy"),
  overlayActions: document.querySelector("#overlay-actions"),
  calibrationPanel: document.querySelector("#calibration-panel"),
  calibrationCount: document.querySelector("#calibration-count"),
  calibrationValue: document.querySelector("#calibration-value"),
  startButton: document.querySelector("#start-button"),
  calibrateButton: document.querySelector("#calibrate-button"),
  recordNote: document.querySelector("#record-note"),
  pauseButton: document.querySelector("#pause-button"),
  focusButton: document.querySelector("#focus-button"),
  recoverButton: document.querySelector("#recover-button"),
  replayButton: document.querySelector("#replay-button"),
  downloadButton: document.querySelector("#download-button"),
  importInput: document.querySelector("#import-input"),
  runMeta: document.querySelector("#run-meta")
};

const querySeed = new URLSearchParams(location.search).get("seed");
const initialSeed = normalizeSeed(querySeed ?? 0x20261116);
const STORAGE_KEY = "phase-split-last-record-v1";

const game = new RhythmGame({ seed: initialSeed });
const audio = new DualTrackAudio();
const renderer = new StageRenderer(elements.canvas, game, audio);

let lastRecord = loadRecord();
let mode = "live";
let runFinalized = false;
let lastCueMs = 0;
let previousFrame = performance.now();
let lastUiAt = 0;
let overlayState = null;
let flashMessage = "";
let flashShownAt = 0;
let lastFlashSeen = "";

function loadRecord() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.format === "phase-split-record" ? parsed : null;
  } catch {
    return null;
  }
}

function saveRecord(record) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage can be unavailable in private or embedded contexts.
  }
}

function seconds(value) {
  return (Math.max(0, value) / 1000).toFixed(3).padStart(6, "0");
}

function formatChangeTime(value) {
  return `${seconds(value)}s`;
}

function stateLabel(state) {
  return {
    [GameState.BOOT]: "BOOT / AUDIO LOCK",
    [GameState.READY]: "READY / INPUT MAP",
    [GameState.CALIBRATION]: "CALIBRATION / TAP K",
    [GameState.COUNTDOWN]: "COUNTDOWN / 3 SEC",
    [GameState.PLAYING]: "LIVE / DUAL TRACK",
    [GameState.PAUSED]: "PAUSED / CLOCK FROZEN",
    [GameState.SUCCESS]: "COMPLETE / 60 SEC",
    [GameState.FAILED]: "FAILED / SIGNAL LOST",
    [GameState.REPLAYING]: "REPLAY / DETERMINISTIC"
  }[state] || state;
}

function updateOverlay() {
  const state = game.state;
  const calibration = state === GameState.CALIBRATION;
  elements.calibrationPanel.hidden = !calibration;
  elements.calibrationCount.textContent = String(game.calibrationSamples.length);
  elements.calibrationValue.textContent = `${game.calibrationOffset} ms`;

  if (state === GameState.COUNTDOWN || state === GameState.PLAYING || state === GameState.REPLAYING) {
    elements.overlay.classList.add("hidden");
  } else {
    elements.overlay.classList.remove("hidden");
  }

  if (overlayState === state && !calibration) return;
  overlayState = state;
  elements.overlayKicker.textContent = stateLabel(state);
  elements.startButton.hidden = false;
  elements.calibrateButton.hidden = false;

  if (state === GameState.BOOT || state === GameState.READY) {
    elements.overlayTitle.textContent = "两套节拍，一条时间线";
    elements.overlayCopy.textContent = "低频轨用 F，高频轨用 J。空格切换监听焦点，P 暂停。交叉音符会穿过声像中心。";
    elements.startButton.textContent = "开始演出";
    elements.calibrateButton.textContent = "校准延迟";
    elements.recordNote.textContent = lastRecord
      ? `已载入 ${lastRecord.inputs.length} 条输入 · HASH ${lastRecord.finalHash?.slice(0, 8) || "未完成"}`
      : "每局结束自动保存 seed、输入记录与最终状态哈希。";
  } else if (state === GameState.CALIBRATION) {
    elements.overlayTitle.textContent = "对齐你的设备延迟";
    elements.overlayCopy.textContent = "点击声每 600ms 一次。跟随声音敲 K，五拍后自动应用中位偏移；也可提前完成。";
    elements.startButton.textContent = "完成校准";
    elements.calibrateButton.textContent = "取消";
    elements.recordNote.textContent = "偏移会从判定时刻中扣除，并写入可回放记录。";
  } else if (state === GameState.PAUSED) {
    elements.overlayTitle.textContent = "时间线已冻结";
    elements.overlayCopy.textContent = "曲目时钟、输入判定与音频输出均已暂停。恢复后从同一毫秒继续。";
    elements.startButton.textContent = "继续演出";
    elements.calibrateButton.textContent = "重新开始";
    elements.recordNote.textContent = `当前 ${seconds(game.songMs)} / 60.000 秒 · 输入 ${game.inputLog.length} 条`;
  } else if (state === GameState.SUCCESS) {
    const match = mode === "replay" ? game.replayHashMatches() : null;
    elements.overlayTitle.textContent = mode === "replay"
      ? (match ? "回放完成 · 哈希一致" : "回放完成 · 哈希不一致")
      : "六十秒曲目完成";
    elements.overlayCopy.textContent = `分数 ${game.score.toLocaleString()} · 最大连击 ${game.maxCombo} · 完整度 ${game.integrity}% · 漏拍 ${game.misses}`;
    elements.startButton.textContent = "重新开始";
    elements.calibrateButton.textContent = "回放记录";
    elements.recordNote.textContent = `FINAL HASH ${game.hashState()} · SEED ${game.seed}`;
  } else if (state === GameState.FAILED) {
    elements.overlayTitle.textContent = "同步完整度归零";
    elements.overlayCopy.textContent = "失败恢复会清空计时、输入、粒子与音频声部，并从原始 seed 重建节拍序列。";
    elements.startButton.textContent = "失败恢复";
    elements.calibrateButton.textContent = "重新开始";
    elements.recordNote.textContent = `FAIL HASH ${game.hashState()} · 已保存 ${game.inputLog.length} 条输入`;
  }
}

function updateUI(force = false) {
  const now = performance.now();
  if (!force && now - lastUiAt < 45) return;
  lastUiAt = now;
  const snapshot = game.getSnapshot();
  elements.clock.textContent = seconds(snapshot.songMs);
  elements.objective.textContent = snapshot.objective.title;
  elements.objectiveDetail.textContent = snapshot.objective.detail;
  elements.focusLabel.textContent = snapshot.focus === 0 ? "低频轨" : "高频轨";
  elements.integrityText.textContent = `${snapshot.integrity}%`;
  elements.integrityBar.style.width = `${snapshot.integrity}%`;
  elements.score.textContent = String(snapshot.score).padStart(6, "0");
  elements.multiplier.textContent = `×${snapshot.multiplier}`;
  elements.combo.textContent = String(snapshot.combo);
  elements.focusBonus.textContent = snapshot.focusAlignedHits
    ? `${snapshot.focusAlignedHits} 次 +25%`
    : "待命";
  elements.offset.textContent = `${snapshot.calibrationOffset} ms`;
  const audioResources = audio.resources();
  const visualResources = renderer.resources();
  elements.audioResources.textContent = `${audioResources.status} · ${audioResources.activeVoices}v`;
  elements.spectrumResources.textContent = `${audioResources.spectrumBins} bins · ${visualResources.particles}p`;
  elements.changeTime.textContent = formatChangeTime(snapshot.lastChange.atMs);
  elements.lastChange.textContent = snapshot.lastChange.message;
  if (flashMessage !== lastFlashSeen) {
    lastFlashSeen = flashMessage;
    flashShownAt = now;
  }
  const showFlash = Boolean(flashMessage) && now - flashShownAt < 1_800;
  elements.flashMessage.hidden = !showFlash;
  elements.flashMessage.textContent = showFlash ? flashMessage : "";
  document.body.classList.toggle("is-low", snapshot.integrity <= 24);
  document.body.classList.toggle("is-paused", snapshot.state === GameState.PAUSED);
  document.body.classList.toggle("is-replay", mode === "replay");

  elements.pauseButton.disabled = ![
    GameState.COUNTDOWN,
    GameState.PLAYING,
    GameState.PAUSED
  ].includes(snapshot.state);
  elements.pauseButton.innerHTML = snapshot.state === GameState.PAUSED
    ? "继续 <kbd>P</kbd>"
    : "暂停 <kbd>P</kbd>";
  elements.focusButton.disabled = ![
    GameState.COUNTDOWN,
    GameState.PLAYING
  ].includes(snapshot.state);
  elements.recoverButton.disabled = snapshot.state !== GameState.FAILED;
  elements.replayButton.disabled = !lastRecord || [
    GameState.PLAYING,
    GameState.COUNTDOWN,
    GameState.PAUSED,
    GameState.REPLAYING
  ].includes(snapshot.state);
  elements.downloadButton.disabled = !lastRecord;
  const hash = lastRecord?.finalHash || "--";
  elements.runMeta.textContent = `SEED ${snapshot.seed} · 记录 ${lastRecord?.inputs.length ?? 0} 条 · HASH ${hash}`;
  updateOverlay();
}

async function ensureAudio() {
  try {
    await audio.init();
    return true;
  } catch (error) {
    flashMessage = `音频启动失败：${error.message}`;
    updateUI(true);
    return false;
  }
}

function resetPresentation(seed = game.seed) {
  audio.reset();
  renderer.reset(seed);
  lastCueMs = 0;
  previousFrame = performance.now();
}

async function startLive({ restart = false } = {}) {
  if (!(await ensureAudio())) return false;
  if (restart || game.state !== GameState.READY) {
    game.restart(initialSeed);
  } else {
    game.ready();
  }
  resetPresentation(game.seed);
  await audio.resume();
  audio.setFocus(game.focus, true);
  mode = "live";
  runFinalized = false;
  flashMessage = "演出启动：双轨输入已解锁";
  game.begin();
  updateUI(true);
  return true;
}

async function restartAndStart() {
  game.restart(initialSeed);
  await startLive();
}

async function startCalibrationFlow() {
  if (!(await ensureAudio())) return false;
  game.ready();
  if (!game.startCalibration()) return false;
  resetPresentation(game.seed);
  await audio.startCalibration();
  audio.setFocus(game.focus, true);
  flashMessage = "校准节拍启动：跟随点击敲 K";
  updateUI(true);
  return true;
}

function finishCalibrationFlow() {
  if (game.state !== GameState.CALIBRATION) return;
  audio.stopCalibration();
  game.finishCalibration();
  flashMessage = `校准完成：${game.calibrationOffset} ms`;
  overlayState = null;
  updateUI(true);
}

function cancelCalibrationFlow() {
  audio.stopCalibration();
  game.cancelCalibration();
  flashMessage = "校准已取消";
  updateUI(true);
}

async function togglePause() {
  if (game.state === GameState.PAUSED) {
    game.resume();
    await audio.resume();
    flashMessage = "演出恢复：时钟继续";
  } else if (game.pause()) {
    await audio.pause();
    flashMessage = "演出暂停：音频与时钟冻结";
  }
  updateUI(true);
}

async function recoverFlow() {
  if (!game.recover()) return false;
  resetPresentation(game.seed);
  mode = "live";
  runFinalized = false;
  flashMessage = "失败恢复完成：资源与随机序列已复位";
  await audio.resume();
  updateUI(true);
  return true;
}

function toggleFocus() {
  if (!game.toggleFocus()) return;
  audio.setFocus(game.focus);
  flashMessage = `监听焦点：${game.focus === 0 ? "低频轨" : "高频轨"}`;
  updateUI(true);
}

function pressLane(lane) {
  if (!game.pressLane(lane)) return;
  drainGameEvents();
  updateUI(true);
}

function triggerCrossedCues(fromMs, toMs) {
  if (game.state !== GameState.PLAYING || mode !== "live") return;
  for (let index = 0; index < game.notes.length; index += 1) {
    const note = game.notes[index];
    if (note.timeMs <= fromMs || note.timeMs > toMs) continue;
    if (!game.results[index]) {
      audio.triggerNote(note, "cue");
      renderer.burst("cue", note.lane, 0.28);
    }
  }
}

function drainGameEvents() {
  const events = game.drainEvents();
  const replayBurstLimit = mode === "replay" && events.length > 24;
  events.forEach((event, index) => {
    if (event.type === "hit") {
      if (!replayBurstLimit || index % 4 === 0) {
        audio.triggerNote(event.note, event.judgment);
        renderer.burst("hit", event.lane, event.judgment === "perfect" ? 1.2 : 0.7);
      }
    } else if (event.type === "miss") {
      renderer.burst("miss", event.lane, 1);
      flashMessage = event.cause === "stray" ? "错拍：对侧音轨模糊" : "漏拍：对侧音轨模糊";
    } else if (event.type === "focus") {
      audio.setFocus(event.lane);
    }
  });
  if (events.length) updateUI(true);
}

function maybeFinalize() {
  if (runFinalized) return null;
  if (game.state !== GameState.SUCCESS && game.state !== GameState.FAILED) return null;
  runFinalized = true;
  const record = game.exportRecord();
  if (mode === "live") {
    lastRecord = record;
    saveRecord(record);
  }
  overlayState = null;
  if (mode === "replay") {
    flashMessage = game.replayHashMatches()
      ? `回放完成：哈希一致 ${record.finalHash}`
      : "回放完成：哈希不一致，请检查记录";
  } else {
    flashMessage = game.state === GameState.SUCCESS
      ? `曲目完成：${record.finalHash}`
      : `演出失败：记录与哈希已保存 ${record.finalHash}`;
  }
  updateUI(true);
  return record;
}

async function startReplayFlow(record = lastRecord) {
  if (!record || !(await ensureAudio())) return false;
  resetPresentation(record.seed);
  mode = "replay";
  runFinalized = false;
  try {
    game.startReplay(record, { speed: 20 });
  } catch (error) {
    flashMessage = `无法回放：${error.message}`;
    updateUI(true);
    return false;
  }
  await audio.resume();
  audio.setFocus(game.focus, true);
  flashMessage = `回放启动：${record.inputs.length} 条输入 · 20×`;
  updateUI(true);
  return true;
}

function downloadLastRecord() {
  if (!lastRecord) return;
  const text = JSON.stringify(lastRecord, null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `phase-split-${lastRecord.seed}-${lastRecord.finalHash || "partial"}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function importRecord(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed?.format !== "phase-split-record" || !Array.isArray(parsed.inputs)) {
      throw new Error("记录格式不匹配");
    }
    lastRecord = parsed;
    saveRecord(parsed);
    flashMessage = `记录已导入：${parsed.inputs.length} 条输入`;
  } catch (error) {
    flashMessage = `导入失败：${error.message}`;
  }
  elements.importInput.value = "";
  overlayState = null;
  updateUI(true);
}

function primaryOverlayAction() {
  if (game.state === GameState.CALIBRATION) {
    finishCalibrationFlow();
  } else if (game.state === GameState.PAUSED) {
    togglePause();
  } else if (game.state === GameState.SUCCESS || game.state === GameState.FAILED) {
    restartAndStart();
  } else if (game.state === GameState.REPLAYING) {
    return;
  } else {
    startLive();
  }
}

function secondaryOverlayAction() {
  if (game.state === GameState.CALIBRATION) {
    cancelCalibrationFlow();
  } else if (game.state === GameState.PAUSED) {
    restartAndStart();
  } else if (game.state === GameState.SUCCESS || game.state === GameState.FAILED) {
    startReplayFlow();
  } else {
    startCalibrationFlow();
  }
}

function toggleReplayFromKeyboard() {
  if (!lastRecord) return;
  if ([GameState.PLAYING, GameState.COUNTDOWN, GameState.PAUSED, GameState.REPLAYING].includes(game.state)) {
    return;
  }
  startReplayFlow();
}

function handleKeydown(event) {
  if (event.repeat) return;
  const code = event.code;
  if (["Space", "KeyF", "KeyJ", "KeyK", "KeyP", "KeyR", "Escape", "Enter"].includes(code)) {
    if (code !== "Enter" || game.state === GameState.READY) event.preventDefault();
  }

  if (code === "KeyK" && game.state === GameState.CALIBRATION) {
    const delta = audio.tapCalibration();
    if (delta !== null) {
      game.addCalibrationSample(delta);
      flashMessage = `校准采样 ${game.calibrationSamples.length}/5 · ${Math.round(delta)} ms`;
      if (game.state === GameState.READY) audio.stopCalibration();
      overlayState = null;
      updateUI(true);
    }
    return;
  }

  if (code === "Space") {
    toggleFocus();
    return;
  }
  if (code === "KeyF") {
    pressLane(0);
    return;
  }
  if (code === "KeyJ") {
    pressLane(1);
    return;
  }
  if (code === "KeyP" || code === "Escape") {
    if ([GameState.COUNTDOWN, GameState.PLAYING, GameState.PAUSED].includes(game.state)) {
      togglePause();
    }
    return;
  }
  if (code === "KeyR") {
    toggleReplayFromKeyboard();
    return;
  }
  if (code === "Enter") {
    if (game.state === GameState.READY || game.state === GameState.BOOT) startLive();
    else if (game.state === GameState.FAILED) recoverFlow();
  }
}

function frame(now) {
  const delta = Math.min(100, Math.max(0, now - previousFrame));
  previousFrame = now;
  const before = game.songMs;
  if ([GameState.COUNTDOWN, GameState.PLAYING, GameState.REPLAYING].includes(game.state)) {
    game.advance(delta);
    triggerCrossedCues(before, game.songMs);
    drainGameEvents();
    maybeFinalize();
  }
  const snapshot = game.getSnapshot();
  if (snapshot.blurLane !== null) {
    audio.setBlur(snapshot.blurLane, snapshot.blurActive);
  }
  renderer.render(now);
  updateUI();
  requestAnimationFrame(frame);
}

elements.startButton.addEventListener("click", primaryOverlayAction);
elements.calibrateButton.addEventListener("click", secondaryOverlayAction);
elements.pauseButton.addEventListener("click", togglePause);
elements.focusButton.addEventListener("click", toggleFocus);
elements.recoverButton.addEventListener("click", recoverFlow);
elements.replayButton.addEventListener("click", () => startReplayFlow());
elements.downloadButton.addEventListener("click", downloadLastRecord);
elements.importInput.addEventListener("change", () => {
  const file = elements.importInput.files?.[0];
  if (file) importRecord(file);
});
document.addEventListener("keydown", handleKeydown);
document.addEventListener("visibilitychange", () => {
  if (document.hidden && [GameState.COUNTDOWN, GameState.PLAYING].includes(game.state)) {
    togglePause();
  }
});

async function debugPlayPerfectRoute() {
  await startLive({ restart: true });
  if (game.state === GameState.COUNTDOWN) game.advance(CONFIG.countdownMs);
  for (const note of game.notes) {
    game.advance(note.timeMs - game.songMs);
    if (game.focus !== note.lane) game.toggleFocus();
    game.pressLane(note.lane);
  }
  game.advance(CONFIG.durationMs - game.songMs);
  drainGameEvents();
  const record = maybeFinalize();
  updateUI(true);
  return {
    state: game.state,
    hash: game.hashState(),
    finalHash: record?.finalHash,
    inputs: game.inputLog.length,
    score: game.score,
    resources: { audio: audio.resources(), visual: renderer.resources() }
  };
}

async function debugPlayMistakeRoute() {
  await startLive({ restart: true });
  if (game.state === GameState.COUNTDOWN) game.advance(CONFIG.countdownMs);
  for (let index = 0; index < game.notes.length; index += 1) {
    const note = game.notes[index];
    if (index === 0) {
      game.advance(note.timeMs + CONFIG.missWindowMs + 1 - game.songMs);
      continue;
    }
    game.advance(note.timeMs - game.songMs);
    if (game.focus !== note.lane) game.toggleFocus();
    game.pressLane(note.lane);
  }
  game.advance(CONFIG.durationMs - game.songMs);
  drainGameEvents();
  const record = maybeFinalize();
  updateUI(true);
  return {
    state: game.state,
    hash: game.hashState(),
    finalHash: record?.finalHash,
    integrity: game.integrity,
    misses: game.misses,
    blurLane: game.blurLane,
    resources: { audio: audio.resources(), visual: renderer.resources() }
  };
}

async function debugTriggerFailure() {
  await startLive({ restart: true });
  if (game.state === GameState.COUNTDOWN) game.advance(CONFIG.countdownMs);
  game.advance(10_000);
  drainGameEvents();
  const record = maybeFinalize();
  updateUI(true);
  return {
    state: game.state,
    songMs: game.songMs,
    integrity: game.integrity,
    misses: game.misses,
    finalHash: record?.finalHash
  };
}

async function debugReplayNow(record = lastRecord) {
  if (!record) throw new Error("No record available");
  if (!(await ensureAudio())) throw new Error("Audio unavailable");
  resetPresentation(record.seed);
  mode = "replay";
  runFinalized = false;
  game.startReplay(record, { speed: 60 });
  await audio.resume();
  game.finishReplay();
  drainGameEvents();
  maybeFinalize();
  updateUI(true);
  return {
    state: game.state,
    hash: game.hashState(),
    expectedHash: record.finalHash,
    match: game.replayHashMatches(),
    inputs: game.inputLog.length
  };
}

function debugResetProbe() {
  const randomBefore = game.peekRandomSequence(5);
  const chartBefore = game.chartDigest;
  game.restart(initialSeed);
  resetPresentation(game.seed);
  runFinalized = false;
  mode = "live";
  const randomAfter = game.peekRandomSequence(5);
  updateUI(true);
  return {
    state: game.state,
    songMs: game.songMs,
    score: game.score,
    integrity: game.integrity,
    combo: game.combo,
    inputs: game.inputLog.length,
    chartStable: chartBefore === game.chartDigest,
    randomStable: JSON.stringify(randomBefore) === JSON.stringify(randomAfter),
    audio: audio.resources(),
    visual: renderer.resources()
  };
}

window.__phaseSplit = {
  game,
  audio,
  renderer,
  startLive,
  playPerfectRoute: debugPlayPerfectRoute,
  playMistakeRoute: debugPlayMistakeRoute,
  triggerFailure: debugTriggerFailure,
  replayNow: debugReplayNow,
  resetProbe: debugResetProbe,
  exportRecord: () => game.exportRecord(),
  hashState: () => game.hashState(),
  snapshot: () => game.getSnapshot(),
  resources: () => ({ audio: audio.resources(), visual: renderer.resources() }),
  getLastRecord: () => lastRecord
};

game.ready();
updateUI(true);
requestAnimationFrame(frame);
