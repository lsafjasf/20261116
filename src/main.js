import { AudioEngine, DEFAULT_PARAMS, previewPlan, renderPreview } from "./audio-engine.js";
import {
  BEACON_COUNT,
  IceGame,
  createLevel,
} from "./game.js";
import { clamp, distance2D as distance, downloadBlob, formatTime, seededRandom } from "./utils.js";

const $ = (selector) => document.querySelector(selector);
const CANVAS_FONT = "'IBM Plex Mono', 'Noto Sans SC', sans-serif";
const dom = {
  canvas: $("#stage"),
  sparkline: $("#sparkline"),
  seedLabel: $("#seedLabel"),
  seedInput: $("#seedInput"),
  timeLabel: $("#timeLabel"),
  beaconLabel: $("#beaconLabel"),
  stageCopy: $("#stageCopy"),
  enterButton: $("#enterButton"),
  pauseButton: $("#pauseButton"),
  soundButton: $("#soundButton"),
  statusPill: $("#statusPill"),
  missionHint: $("#missionHint"),
  progressFill: $("#progressFill"),
  materialLabel: $("#materialLabel"),
  dangerLabel: $("#dangerLabel"),
  targetLabel: $("#targetLabel"),
  beatLabel: $("#beatLabel"),
  diagScheduler: $("#diagScheduler"),
  diagPlayback: $("#diagPlayback"),
  diagNodes: $("#diagNodes"),
  diagVoices: $("#diagVoices"),
  diagListeners: $("#diagListeners"),
  diagTails: $("#diagTails"),
  diagClock: $("#diagClock"),
  diagPeak: $("#diagPeak"),
  healthScheduler: $("#healthScheduler"),
  healthResources: $("#healthResources"),
  healthPlayback: $("#healthPlayback"),
  statusbarAudio: $("#audioState"),
  audioDot: $("#audioDot"),
  footerMessage: $("#footerMessage"),
  snapshotButton: $("#snapshotButton"),
  restoreButton: $("#restoreButton"),
  snapshotStatus: $("#snapshotStatus"),
  checkReport: $("#checkReport"),
  resultPanel: $("#resultPanel"),
  resultKicker: $("#resultKicker"),
  resultTitle: $("#resultTitle"),
  resultBody: $("#resultBody"),
  resultStats: $("#resultStats"),
  replayButton: $("#replayButton"),
  newRunButton: $("#newRunButton"),
};

const controlIds = {
  masterGain: ["#masterGain", "#masterGainValue", (value) => `${Math.round(value * 100)}%`],
  pingGain: ["#pingGain", "#pingGainValue", (value) => `${Math.round(value * 100)}%`],
  echoScale: ["#echoScale", "#echoScaleValue", (value) => `${value.toFixed(2)}×`],
  reverbMix: ["#reverbMix", "#reverbMixValue", (value) => `${Math.round(value * 100)}%`],
  bpm: ["#bpm", "#bpmValue", (value) => `${Math.round(value)} BPM`],
};

const params = { ...DEFAULT_PARAMS };
const game = new IceGame(initialSeed());
const audio = new AudioEngine(params);
const controls = { forward: false, back: false, turnLeft: false, turnRight: false };
let currentSeed = game.level.seed;
let snapshot = null;
let muted = false;
let lastFrameTime = performance.now();
let lastTelemetryAt = 0;
let checkInFlight = false;
let lastExport = null;
let sparklineHistory = [];

class InputController {
  constructor() {
    this.keys = new Set();
    this.bound = false;
    this.listenerCount = 0;
    this.active = false;
  }

  attach() {
    if (this.bound) return false;
    this.bound = true;
    window.addEventListener("keydown", (event) => this.onKeyDown(event));
    window.addEventListener("keyup", (event) => this.onKeyUp(event));
    window.addEventListener("blur", () => this.interrupt("window-blur"));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.interrupt("visibility-hidden");
    });
    this.listenerCount = 4;
    return true;
  }

  onKeyDown(event) {
    if (!this.active || isTextInput(event.target)) return;
    const action = keyToAction(event.code);
    if (action) {
      event.preventDefault();
      this.keys.add(event.code);
      controls[action] = true;
    }
    if (event.code === "Space" || event.code === "KeyP") {
      event.preventDefault();
      if (!event.repeat) togglePause();
    }
  }

  onKeyUp(event) {
    const action = keyToAction(event.code);
    if (action) {
      event.preventDefault();
      this.keys.delete(event.code);
      controls[action] = [...this.keys].some((code) => keyToAction(code) === action);
    }
  }

  press(code) {
    this.keys.add(code);
    const action = keyToAction(code);
    if (action) controls[action] = true;
  }

  interrupt(reason = "manual") {
    const hadInput = [...Object.values(controls)].some(Boolean) || this.keys.size > 0;
    this.keys.clear();
    for (const key of Object.keys(controls)) controls[key] = false;
    for (const button of document.querySelectorAll("[data-hold]")) button.classList.remove("active");
    if (hadInput && game.phase === "playing") pauseRun(`输入中断：${reason}`);
    return { cleared: true, hadInput, reason };
  }

  reset() {
    this.keys.clear();
    for (const key of Object.keys(controls)) controls[key] = false;
  }
}

function keyToAction(code) {
  if (code === "KeyW" || code === "ArrowUp") return "forward";
  if (code === "KeyS" || code === "ArrowDown") return "back";
  if (code === "KeyA" || code === "ArrowLeft") return "turnLeft";
  if (code === "KeyD" || code === "ArrowRight") return "turnRight";
  return null;
}

function isTextInput(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
}

function initialSeed() {
  const fromUrl = new URLSearchParams(window.location.search).get("seed");
  const stored = window.localStorage.getItem("ice-echo-seed");
  return (fromUrl || stored || "FROST-042").trim().toUpperCase().slice(0, 28);
}

const input = new InputController();

function syncParamControls() {
  for (const [key, [, outputSelector, formatter]] of Object.entries(controlIds)) {
    const inputElement = document.querySelector(controlIds[key][0]);
    const output = document.querySelector(outputSelector);
    const sliderValue = key === "masterGain" || key === "pingGain" || key === "reverbMix"
      ? Math.round(params[key] * 100)
      : key === "echoScale"
        ? Math.round(params[key] * 100)
        : Math.round(params[key]);
    inputElement.value = String(sliderValue);
    output.textContent = formatter(params[key]);
  }
}

function setParamsFromControls() {
  for (const key of Object.keys(controlIds)) {
    const slider = document.querySelector(controlIds[key][0]);
    const raw = Number(slider.value);
    params[key] = key === "masterGain" || key === "pingGain" || key === "reverbMix"
      ? raw / 100
      : key === "echoScale"
        ? raw / 100
        : raw;
    document.querySelector(controlIds[key][1]).textContent = controlIds[key][2](params[key]);
  }
  audio.setParams(params);
  if (muted && audio.graph) audio.graph.master.gain.setTargetAtTime(0, audio.context.currentTime, 0.02);
}

async function startRun({ seed = currentSeed, restart = false, force = false } = {}) {
  if (checkInFlight && !force) return false;
  const normalized = String(seed || "FROST-042").trim().toUpperCase().slice(0, 28) || "FROST-042";
  const sameSeed = normalized === currentSeed;
  const previousSignature = sameSeed ? createLevel(currentSeed).signature : null;
  input.reset();
  if (audio.status === "running" || audio.status === "paused" || audio.status === "stopping") {
    await audio.stop(restart ? "same-seed-restart" : "new-run");
  }
  game.reset(normalized);
  currentSeed = normalized;
  dom.seedInput.value = normalized;
  dom.seedLabel.textContent = normalized;
  window.localStorage.setItem("ice-echo-seed", normalized);
  const history = new URLSearchParams(window.location.search);
  history.set("seed", normalized);
  window.history.replaceState(null, "", `${window.location.pathname}?${history.toString()}`);

  game.start();
  audio.attachGame(game);
  audio.setParams(params);
  await audio.start();
  if (muted && audio.graph && audio.context) {
    audio.graph.master.gain.setValueAtTime(0, audio.context.currentTime);
  }
  input.active = true;
  dom.stageCopy.classList.add("hidden");
  dom.resultPanel.hidden = true;
  dom.pauseButton.disabled = false;
  inputsEnabled(true);
  syncParamControls();
  setFooter(`种子 ${normalized} 已启动。左右声像定位，转向让声音居中。`);
  updateHUD(true);
  return {
    started: true,
    seed: normalized,
    sameSeed,
    levelSignature: game.level.signature,
    previousSignature,
  };
}

async function restartSameSeed() {
  return startRun({ seed: currentSeed, restart: true });
}

async function newRun() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = seededRandom(`${Date.now()}-${Math.random()}`, "new-seed");
  let seed = "";
  for (let index = 0; index < 7; index += 1) seed += alphabet[Math.floor(random() * alphabet.length)];
  currentSeed = `ICE-${seed}`;
  snapshot = null;
  dom.restoreButton.disabled = true;
  return startRun({ seed: currentSeed });
}

function inputsEnabled(enabled) {
  input.active = enabled;
  if (!enabled) input.reset();
}

async function pauseRun(reason = "manual") {
  if (game.phase !== "playing") return false;
  game.pause();
  await audio.pause();
  dom.pauseButton.textContent = "继续";
  setFooter(`已暂停${reason ? ` · ${reason}` : ""}。声音与调度已停止，恢复后从当前节拍继续。`);
  updateHUD(true);
  return true;
}

async function resumeRun() {
  if (game.phase !== "paused") return false;
  game.resume();
  await audio.resume();
  dom.pauseButton.textContent = "暂停";
  setFooter("继续。监听器已恢复，调度器已重新建立单一路径。");
  updateHUD(true);
  return true;
}

async function togglePause() {
  if (game.phase === "playing") return pauseRun();
  if (game.phase === "paused") return resumeRun();
  return false;
}

function setFooter(message) {
  dom.footerMessage.textContent = message;
}

function finishRun() {
  if (game.phase !== "won" && game.phase !== "failed") return;
  inputsEnabled(false);
  dom.pauseButton.disabled = true;
  dom.pauseButton.textContent = "暂停";
  audio.stop(game.phase === "won" ? "success" : "failure");
  const won = game.phase === "won";
  dom.resultKicker.textContent = won ? "RUN COMPLETE / SAFE RETURN" : "RUN TERMINATED / FRACTURE";
  dom.resultTitle.textContent = won ? "你回到了入口。" : "裂隙吞掉了回声。";
  dom.resultBody.textContent = won
    ? "三个声标均已回收，路径已在冰面上显影。结算后会保留本轮声场参数，可同 seed 复核。"
    : "你偏离了安全回响范围。真实路径已揭示：薄冰断层在声音到达前就截断了反射。";
  dom.resultStats.innerHTML = [
    ["用时", formatTime(game.elapsed)],
    ["声标", `${game.collected.length} / ${BEACON_COUNT}`],
    ["材质", game.currentMaterial.name],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
  dom.resultPanel.hidden = false;
  setFooter(won ? "成功：全部声标已回收并安全返回入口。真实路径已显示。" : "失败：错误方向接近危险裂隙。真实路径已显示。");
  updateHUD(true);
}

function updateHUD(force = false) {
  const reading = game.reading();
  const collected = game.collected.length;
  const statusMap = {
    idle: ["待机", "idle"],
    playing: ["探索中", "playing"],
    paused: ["已暂停", "paused"],
    won: ["成功", "won"],
    failed: ["失败", "failed"],
    stopped: ["已停止", "idle"],
  };
  const [statusText, statusClass] = statusMap[game.phase] || statusMap.idle;
  dom.statusPill.textContent = statusText;
  dom.statusPill.className = `status-pill ${statusClass}`;
  dom.progressFill.style.width = `${(collected / BEACON_COUNT) * 100}%`;
  dom.timeLabel.textContent = formatTime(game.elapsed);
  dom.beaconLabel.textContent = `${collected} / ${BEACON_COUNT}`;
  dom.seedLabel.textContent = currentSeed;
  dom.materialLabel.textContent = game.currentMaterial.name;
  dom.targetLabel.textContent = reading.target.name;
  dom.beatLabel.textContent = String(audio.beat);
  const dangerPercent = Math.round(game.danger * 100);
  dom.dangerLabel.textContent = game.danger > 0.72 ? `临界 ${dangerPercent}%` : game.danger > 0.28 ? `警告 ${dangerPercent}%` : "安全";
  dom.dangerLabel.classList.toggle("danger", game.danger > 0.28);
  if (game.phase === "idle") {
    dom.missionHint.textContent = "启动声音，寻找三个冰层声标。";
  } else if (game.phase === "paused") {
    dom.missionHint.textContent = "时间已冻结。音频上下文挂起，所有活动声源与调度计时器均已清除。";
  } else if (game.phase === "won") {
    dom.missionHint.textContent = "全部声标已找到，安全返回入口。";
  } else if (game.phase === "failed") {
    dom.missionHint.textContent = "错误方向触发了薄冰断层。安全路线只能在结算后查看。";
  } else if (collected === BEACON_COUNT) {
    dom.missionHint.textContent = "三个声标已锁定。跟随入口回响返回原点。";
  } else {
    dom.missionHint.textContent = `正在追踪${reading.target.name}；声像偏移 ${reading.pan > 0 ? "右" : reading.pan < 0 ? "左" : "中"} ${Math.round(Math.abs(reading.pan) * 100)}%，距离回声 ${reading.distance.toFixed(1)} m。`;
  }
  if (force) updateDiagnostics();
}

function updateDiagnostics() {
  const diagnostics = audio.diagnostics();
  const levels = audio.getLevels();
  const totalListeners = audio.listenerCount + input.listenerCount;
  dom.diagScheduler.textContent = diagnostics.schedulerRunning ? "运行 · 1 路" : diagnostics.status === "paused" ? "挂起" : "停止";
  dom.diagScheduler.className = diagnostics.schedulerRunning ? "ok" : diagnostics.status === "paused" ? "warn" : "";
  dom.diagPlayback.textContent = diagnostics.contextState;
  dom.diagPlayback.className = ["running", "suspended"].includes(diagnostics.contextState) ? "ok" : diagnostics.status === "paused" ? "warn" : "bad";
  dom.diagNodes.textContent = String(diagnostics.activeNodes);
  dom.diagNodes.className = diagnostics.activeNodes > 32 ? "warn" : "ok";
  dom.diagVoices.textContent = String(diagnostics.voices);
  dom.diagVoices.className = diagnostics.voices > 12 ? "warn" : "";
  dom.diagListeners.textContent = String(totalListeners);
  dom.diagListeners.className = totalListeners > 6 ? "bad" : "ok";
  dom.diagTails.textContent = String(diagnostics.voices);
  dom.diagTails.className = diagnostics.voices === 0 ? "ok" : "";
  dom.diagClock.textContent = `${diagnostics.clock.toFixed(2)}s`;
  dom.diagPeak.textContent = Number.isFinite(diagnostics.peakDb) ? `${diagnostics.peakDb.toFixed(1)} dB` : "−∞ dB";

  const schedulerOk = diagnostics.schedulerRunning || ["paused", "stopped", "idle", "destroyed"].includes(diagnostics.status);
  const resourcesOk = diagnostics.activeNodes < 48 && diagnostics.voices < 18;
  const playbackOk = ["running", "suspended", "idle", "stopped", "destroyed"].includes(diagnostics.contextState)
    && !diagnostics.lastError;
  setHealth(dom.healthScheduler, schedulerOk, diagnostics.schedulerRunning ? "ok" : "warn");
  setHealth(dom.healthResources, resourcesOk, resourcesOk ? "ok" : "bad");
  setHealth(dom.healthPlayback, playbackOk, playbackOk ? "ok" : "bad");

  const stateNames = {
    idle: "音频待机",
    running: "音频运行",
    paused: "音频挂起",
    stopping: "正在淡出",
    stopped: "音频已停止",
    destroyed: "音频节点已销毁",
  };
  dom.statusbarAudio.textContent = stateNames[diagnostics.status] || diagnostics.status;
  dom.audioDot.className = `status-dot ${diagnostics.status === "running" ? "live" : diagnostics.status === "paused" ? "warn" : diagnostics.status === "destroyed" ? "bad" : ""}`;
  dom.soundButton.setAttribute("aria-pressed", String(!muted));
  dom.soundButton.textContent = muted ? "声音 · 静音" : "声音 · 开";

  sparklineHistory.push(clamp(levels.peak, 0, 1));
  if (sparklineHistory.length > 90) sparklineHistory.shift();
  drawSparkline();
}

function setHealth(element, ok, className) {
  element.className = className || (ok ? "ok" : "bad");
}

function drawStage() {
  const context = dom.canvas.getContext("2d");
  const width = dom.canvas.width;
  const height = dom.canvas.height;
  context.clearRect(0, 0, width, height);
  const background = context.createRadialGradient(width * 0.5, height * 0.43, 10, width * 0.5, height * 0.5, width * 0.7);
  background.addColorStop(0, "#0b2b35");
  background.addColorStop(0.48, "#071c25");
  background.addColorStop(1, "#030d12");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  drawIceTexture(context, width, height);

  if (game.phase === "won" || game.phase === "failed") {
    drawReveal(context, width, height);
    return;
  }
  drawListeningView(context, width, height);
}

function drawIceTexture(context, width, height) {
  const random = seededRandom(game.level.seed, "visual-v1");
  context.save();
  context.globalAlpha = 0.15;
  for (let index = 0; index < 42; index += 1) {
    const x = random() * width;
    const length = 40 + random() * 210;
    const tilt = (random() - 0.5) * 50;
    context.beginPath();
    context.moveTo(x, -12);
    context.lineTo(x + tilt, length);
    context.strokeStyle = index % 4 === 0 ? "#8fece7" : "#537d89";
    context.lineWidth = index % 4 === 0 ? 0.7 : 0.35;
    context.stroke();
  }
  const fog = context.createRadialGradient(width * 0.5, height * 0.48, 0, width * 0.5, height * 0.48, width * 0.42);
  fog.addColorStop(0, "rgba(112, 233, 226, 0.055)");
  fog.addColorStop(1, "rgba(112, 233, 226, 0)");
  context.globalAlpha = 1;
  context.fillStyle = fog;
  context.fillRect(0, 0, width, height);
  context.restore();
}

function drawListeningView(context, width, height) {
  const reading = game.reading();
  const centerX = width * 0.5;
  const centerY = height * 0.43;
  const radius = Math.min(width, height) * 0.16;
  const pulse = (performance.now() / 1000) % (60 / params.bpm);
  const pulsePhase = clamp(pulse / (60 / params.bpm), 0, 1);
  context.save();
  context.translate(centerX, centerY);
  context.strokeStyle = "rgba(144, 244, 238, 0.12)";
  context.lineWidth = 1;
  for (let ring = 1; ring <= 3; ring += 1) {
    context.beginPath();
    context.arc(0, 0, radius * (ring / 3), 0, Math.PI * 2);
    context.stroke();
  }
  context.beginPath();
  context.arc(0, 0, radius * (0.55 + pulsePhase * 0.45), 0, Math.PI * 2);
  context.strokeStyle = `rgba(144, 244, 238, ${0.2 * (1 - pulsePhase)})`;
  context.lineWidth = 2;
  context.stroke();

  for (let tick = 0; tick < 32; tick += 1) {
    const angle = (tick / 32) * Math.PI * 2;
    const inner = radius * (tick % 4 === 0 ? 0.88 : 0.94);
    context.beginPath();
    context.moveTo(Math.sin(angle) * inner, -Math.cos(angle) * inner);
    context.lineTo(Math.sin(angle) * radius * 1.04, -Math.cos(angle) * radius * 1.04);
    context.strokeStyle = tick === 0 ? "rgba(207, 255, 251, 0.8)" : "rgba(144, 244, 238, 0.2)";
    context.lineWidth = tick === 0 ? 2 : 0.7;
    context.stroke();
  }

  context.save();
  context.rotate(reading.relative);
  const targetColor = game.danger > 0.3 ? "#ffc477" : "#cffffb";
  context.shadowColor = targetColor;
  context.shadowBlur = 16;
  context.beginPath();
  context.moveTo(0, -radius * 0.94);
  context.lineTo(-9, -radius * 0.72);
  context.lineTo(9, -radius * 0.72);
  context.closePath();
  context.fillStyle = targetColor;
  context.fill();
  context.restore();

  context.beginPath();
  context.arc(0, 0, 7, 0, Math.PI * 2);
  context.fillStyle = "#d5fffb";
  context.shadowColor = "#90f4ee";
  context.shadowBlur = 18;
  context.fill();
  context.shadowBlur = 0;
  context.beginPath();
  context.moveTo(0, -radius * 0.28);
  context.lineTo(-4, radius * 0.06);
  context.lineTo(4, radius * 0.06);
  context.closePath();
  context.fillStyle = "rgba(144, 244, 238, 0.4)";
  context.fill();
  context.restore();

  drawPanRail(context, width, height, reading.pan);
  drawLevelMeter(context, width, height);
  if (game.phase === "paused") drawPauseVeil(context, width, height);
}

function drawPanRail(context, width, height, pan) {
  const railWidth = Math.min(320, width * 0.42);
  const y = height * 0.67;
  const x = width * 0.5 - railWidth / 2;
  context.save();
  context.fillStyle = "rgba(2, 12, 17, 0.48)";
  context.fillRect(x - 16, y - 18, railWidth + 32, 48);
  context.strokeStyle = "rgba(144, 244, 238, 0.16)";
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x + railWidth, y);
  context.stroke();
  context.fillStyle = "rgba(144, 244, 238, 0.1)";
  for (let tick = 0; tick <= 12; tick += 1) {
    const tickX = x + (tick / 12) * railWidth;
    context.fillRect(tickX - 0.5, y - (tick % 3 === 0 ? 5 : 2), 1, tick % 3 === 0 ? 10 : 4);
  }
  const markerX = x + ((pan + 1) / 2) * railWidth;
  context.beginPath();
  context.arc(markerX, y, 5, 0, Math.PI * 2);
  context.fillStyle = "#90f4ee";
  context.shadowColor = "#90f4ee";
  context.shadowBlur = 14;
  context.fill();
  context.shadowBlur = 0;
  context.fillStyle = "rgba(170, 210, 214, 0.68)";
  context.font = `9px ${CANVAS_FONT}`;
  context.textAlign = "left";
  context.fillText("L", x - 13, y + 4);
  context.textAlign = "right";
  context.fillText("R", x + railWidth + 13, y + 4);
  context.textAlign = "center";
  context.fillStyle = "rgba(120, 169, 177, 0.58)";
  context.fillText("STEREO IMAGE", width * 0.5, y - 27);
  context.restore();
}

function drawLevelMeter(context, width, height) {
  const levels = audio.getLevels();
  const meterWidth = Math.min(width * 0.34, 310);
  const startX = width * 0.5 - meterWidth / 2;
  const barHeight = 14;
  const leftY = height - 84;
  const segmentCount = 28;
  const segmentGap = 3;
  const segmentWidth = (meterWidth - segmentGap * (segmentCount - 1)) / segmentCount;
  const drawBar = (value, y, label) => {
    for (let index = 0; index < segmentCount; index += 1) {
      const threshold = index / segmentCount;
      const active = value > threshold * 0.55;
      const color = threshold > 0.86 ? "#ff7783" : threshold > 0.68 ? "#ffc477" : "#90f4ee";
      context.fillStyle = active ? color : "rgba(100, 164, 169, 0.06)";
      context.globalAlpha = active ? 0.45 + threshold * 0.55 : 1;
      context.fillRect(startX + index * (segmentWidth + segmentGap), y, segmentWidth, barHeight);
    }
    context.globalAlpha = 1;
    context.fillStyle = "rgba(179, 218, 220, 0.7)";
    context.font = `9px ${CANVAS_FONT}`;
    context.textAlign = "left";
    context.fillText(label, startX, y - 8);
  };
  drawBar(clamp(levels.left * 3.2, 0, 1), leftY, "L / RMS");
  drawBar(clamp(levels.right * 3.2, 0, 1), leftY + barHeight + 18, "R / RMS");
}

function drawPauseVeil(context, width, height) {
  context.save();
  context.fillStyle = "rgba(3, 13, 18, 0.38)";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "rgba(230, 250, 248, 0.88)";
  context.font = `500 12px ${CANVAS_FONT}`;
  context.textAlign = "center";
  context.fillText("AUDIO CONTEXT SUSPENDED", width / 2, height * 0.35);
  context.fillStyle = "rgba(135, 167, 174, 0.7)";
  context.font = `10px ${CANVAS_FONT}`;
  context.fillText("按 P / Space 或点击“继续”恢复", width / 2, height * 0.35 + 22);
  context.restore();
}

function drawReveal(context, width, height) {
  const mapCenterX = width * 0.65;
  const mapCenterY = height * 0.5;
  const scale = Math.min(width * 0.54, height * 0.7) / (2 * 19);
  const project = (point) => ({
    x: mapCenterX + point.x * scale,
    y: mapCenterY - point.z * scale,
  });
  context.save();
  const mapGlow = context.createRadialGradient(mapCenterX, mapCenterY, 0, mapCenterX, mapCenterY, 340);
  mapGlow.addColorStop(0, "rgba(63, 146, 153, 0.1)");
  mapGlow.addColorStop(1, "rgba(63, 146, 153, 0)");
  context.fillStyle = mapGlow;
  context.fillRect(0, 0, width, height);

  context.strokeStyle = "rgba(144, 244, 238, 0.07)";
  context.lineWidth = 0.7;
  for (let radius = 5; radius <= 19; radius += 4.5) {
    context.beginPath();
    context.arc(mapCenterX, mapCenterY, radius * scale, 0, Math.PI * 2);
    context.stroke();
  }
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 6) {
    context.beginPath();
    context.moveTo(mapCenterX, mapCenterY);
    context.lineTo(mapCenterX + Math.sin(angle) * 19 * scale, mapCenterY - Math.cos(angle) * 19 * scale);
    context.stroke();
  }

  for (const material of game.level.materialAnchors) {
    const position = project(material);
    context.beginPath();
    context.arc(position.x, position.y, material.radius * scale, 0, Math.PI * 2);
    context.fillStyle = `${material.color}0d`;
    context.fill();
    context.strokeStyle = `${material.color}2e`;
    context.setLineDash([3, 6]);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = `${material.color}99`;
    context.font = `8px ${CANVAS_FONT}`;
    context.textAlign = "center";
    context.fillText(material.name, position.x, position.y + material.radius * scale + 11);
  }

  for (const crevasse of game.level.crevasses) {
    const start = project({ x: crevasse.ax, z: crevasse.az });
    const end = project({ x: crevasse.bx, z: crevasse.bz });
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.strokeStyle = crevasse.wrongPath ? "rgba(255, 119, 131, 0.9)" : "rgba(255, 119, 131, 0.42)";
    context.lineWidth = crevasse.wrongPath ? 2.3 : 1.2;
    context.setLineDash(crevasse.wrongPath ? [5, 4] : [2, 5]);
    context.stroke();
    context.setLineDash([]);
    if (crevasse.wrongPath) {
      const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      context.fillStyle = "rgba(255, 145, 152, 0.85)";
      context.font = `8px ${CANVAS_FONT}`;
      context.textAlign = "center";
      context.fillText("FRACTURE", middle.x, middle.y - 8);
    }
  }

  if (game.trail.length > 1) {
    context.beginPath();
    game.trail.forEach((point, index) => {
      const position = project(point);
      if (index === 0) context.moveTo(position.x, position.y);
      else context.lineTo(position.x, position.y);
    });
    context.strokeStyle = game.phase === "won" ? "rgba(144, 244, 238, 0.82)" : "rgba(255, 196, 119, 0.72)";
    context.lineWidth = 1.7;
    context.shadowColor = game.phase === "won" ? "#90f4ee" : "#ffc477";
    context.shadowBlur = 9;
    context.stroke();
    context.shadowBlur = 0;
  }

  for (const beacon of game.level.beacons) {
    const position = project(beacon);
    const collected = game.collected.includes(beacon.id);
    context.save();
    context.translate(position.x, position.y);
    context.rotate(Math.PI / 4);
    context.fillStyle = collected ? "rgba(143, 240, 178, 0.9)" : "rgba(144, 244, 238, 0.4)";
    context.fillRect(-5, -5, 10, 10);
    context.restore();
    context.fillStyle = collected ? "#a9f5c1" : "rgba(175, 217, 220, 0.75)";
    context.font = `8px ${CANVAS_FONT}`;
    context.textAlign = "center";
    context.fillText(beacon.name, position.x, position.y - 12);
  }

  const entrance = project(game.level.entrance);
  context.beginPath();
  context.arc(entrance.x, entrance.y, 9, 0, Math.PI * 2);
  context.fillStyle = "#06151b";
  context.fill();
  context.strokeStyle = "#cffffb";
  context.lineWidth = 2;
  context.stroke();
  context.beginPath();
  context.arc(entrance.x, entrance.y, 3, 0, Math.PI * 2);
  context.fillStyle = "#cffffb";
  context.fill();
  context.fillStyle = "rgba(207, 255, 251, 0.8)";
  context.font = `8px ${CANVAS_FONT}`;
  context.fillText("ENTRY", entrance.x, entrance.y + 22);

  const player = project(game.player);
  context.beginPath();
  context.arc(player.x, player.y, 5, 0, Math.PI * 2);
  context.fillStyle = game.phase === "won" ? "#8ff0b2" : "#ff7783";
  context.shadowColor = context.fillStyle;
  context.shadowBlur = 13;
  context.fill();
  context.shadowBlur = 0;
  context.strokeStyle = "rgba(230, 250, 248, 0.7)";
  context.beginPath();
  context.moveTo(player.x, player.y);
  context.lineTo(player.x + Math.sin(game.player.yaw) * 16, player.y - Math.cos(game.player.yaw) * 16);
  context.stroke();

  context.fillStyle = "rgba(135, 167, 174, 0.75)";
  context.font = `9px ${CANVAS_FONT}`;
  context.textAlign = "right";
  context.fillText("TRUTH REVEALED / POST-RUN ONLY", width - 28, 34);
  context.restore();
}

function drawSparkline() {
  const context = dom.sparkline.getContext("2d");
  const width = dom.sparkline.width;
  const height = dom.sparkline.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "rgba(144, 244, 238, 0.025)";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(144, 244, 238, 0.08)";
  context.lineWidth = 1;
  for (let line = 1; line < 4; line += 1) {
    context.beginPath();
    context.moveTo(0, (height / 4) * line);
    context.lineTo(width, (height / 4) * line);
    context.stroke();
  }
  if (sparklineHistory.length < 2) return;
  context.beginPath();
  sparklineHistory.forEach((value, index) => {
    const x = (index / (sparklineHistory.length - 1)) * width;
    const y = height - 4 - Math.sqrt(value) * (height - 8);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.strokeStyle = "#90f4ee";
  context.lineWidth = 1.4;
  context.stroke();
}

function cloneGameForSignature(state) {
  const clone = new IceGame(state.seed);
  clone.restoreState(state);
  return clone;
}

async function captureSnapshot() {
  const state = game.stateSnapshot();
  const signatureGame = cloneGameForSignature(state);
  const preview = await renderPreview(signatureGame, { ...params }, 6);
  snapshot = {
    gameState: state,
    params: { ...params },
    signature: preview.signature,
    duration: preview.duration,
    fileDuration: (preview.wav.size - 44) / (preview.sampleRate * preview.channels * 2),
    savedAt: new Date().toISOString(),
    restoreUsed: false,
  };
  dom.restoreButton.disabled = false;
  dom.restoreButton.textContent = "从快照恢复 · 1 次";
  dom.snapshotStatus.textContent = `已保存 ${snapshot.signature.length} 个节拍点；WAV ${snapshot.duration.toFixed(3)}s；声像/增益已锁定。`;
  return snapshot;
}

function comparePreview(before, after) {
  const eventDiffs = [];
  const length = Math.max(before.signature.length, after.signature.length);
  for (let index = 0; index < length; index += 1) {
    const first = before.signature[index];
    const second = after.signature[index];
    if (!first || !second) {
      eventDiffs.push(`节拍 ${index + 1} 缺失`);
      continue;
    }
    if (first.beat !== second.beat) eventDiffs.push(`节拍点 ${index + 1}: ${first.beat}→${second.beat}`);
    if (Math.abs(first.pan - second.pan) > 0.0002) eventDiffs.push(`声像 ${index + 1}: ${first.pan}→${second.pan}`);
    if (Math.abs(first.gain - second.gain) > 0.00002) eventDiffs.push(`增益 ${index + 1}: ${first.gain}→${second.gain}`);
  }
  if (Math.abs(before.duration - after.duration) > 0.002) {
    eventDiffs.push(`导出时长: ${before.duration.toFixed(3)}→${after.duration.toFixed(3)}s`);
  }
  const afterFileDuration = (after.wav.size - 44) / (after.sampleRate * after.channels * 2);
  if (Math.abs(before.fileDuration - afterFileDuration) > 0.002) {
    eventDiffs.push(`WAV 文件: ${before.fileDuration.toFixed(3)}→${afterFileDuration.toFixed(3)}s`);
  }
  return {
    pass: eventDiffs.length === 0,
    diffs: eventDiffs,
    beforeDuration: before.duration,
    afterDuration: after.duration,
    beforeFileDuration: before.fileDuration,
    afterFileDuration,
  };
}

async function restoreSnapshot() {
  if (!snapshot) return { pass: false, reason: "没有快照" };
  if (snapshot.restoreUsed) return { pass: false, reason: "该快照已恢复过一次" };
  snapshot.restoreUsed = true;
  dom.restoreButton.disabled = true;
  dom.restoreButton.textContent = "快照已恢复";
  input.reset();
  if (audio.status !== "destroyed") await audio.stop("snapshot-restore");
  Object.assign(params, snapshot.params);
  syncParamControls();
  game.restoreState(snapshot.gameState);
  currentSeed = game.level.seed;
  dom.seedLabel.textContent = currentSeed;
  audio.attachGame(game);
  audio.setParams(params);
  if (game.phase === "playing") {
    await audio.start();
    inputsEnabled(true);
  }
  const restoreState = game.stateSnapshot();
  const preview = await renderPreview(cloneGameForSignature(restoreState), { ...params }, 6);
  const comparison = comparePreview(snapshot, preview);
  if (comparison.pass) {
    dom.snapshotStatus.textContent = `快照恢复一致：${preview.signature.length} 个节拍点，声像/增益无漂移，WAV ${preview.duration.toFixed(3)}s。`;
  } else {
    dom.snapshotStatus.textContent = `快照存在差异：${comparison.diffs.slice(0, 3).join("；")}`;
  }
  updateHUD(true);
  return { pass: comparison.pass, comparison, preview };
}

async function exportWav() {
  const state = game.stateSnapshot();
  const preview = await renderPreview(cloneGameForSignature(state), { ...params }, 6);
  const filename = `ice-echo-${currentSeed.replace(/[^a-z0-9_-]+/gi, "-")}-${preview.duration.toFixed(2)}s.wav`;
  downloadBlob(preview.wav, filename);
  lastExport = {
    duration: preview.duration,
    fileDuration: (preview.wav.size - 44) / (preview.sampleRate * preview.channels * 2),
    bytes: preview.wav.size,
    filename,
    signature: preview.signature,
  };
  return lastExport;
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function reportCheck(type, pass, message) {
  const button = document.querySelector(`[data-check="${type}"]`);
  if (button) {
    button.classList.remove("running", "pass", "fail");
    button.classList.add(pass ? "pass" : "fail");
  }
  dom.checkReport.innerHTML = `<p class="${pass ? "pass" : "fail"}">${pass ? "PASS" : "FAIL"} · ${message}</p>`;
  setFooter(message);
  return { type, pass, message };
}

async function ensurePlayingAudio() {
  if (game.phase !== "playing") await startRun({ seed: currentSeed, restart: true, force: true });
  if (audio.status !== "running") {
    audio.attachGame(game);
    await audio.start();
  }
}

async function checkSameSeed() {
  const before = {
    seed: currentSeed,
    signature: game.level.signature,
    beacons: game.level.beacons.map((beacon) => [beacon.angle, beacon.distance]),
    wrongBearing: game.level.wrongBearing,
  };
  await startRun({ seed: currentSeed, restart: true, force: true });
  await wait(120);
  const after = {
    seed: currentSeed,
    signature: game.level.signature,
    beacons: game.level.beacons.map((beacon) => [beacon.angle, beacon.distance]),
    wrongBearing: game.level.wrongBearing,
  };
  const stable = before.seed === after.seed
    && before.signature === after.signature
    && JSON.stringify(before.beacons) === JSON.stringify(after.beacons)
    && before.wrongBearing === after.wrongBearing;
  return reportCheck(
    "seed",
    stable,
    stable
      ? `同 seed ${currentSeed} 重开后，3 个声标、错误方向与裂隙布局完全一致；节拍从 0 重新调度。`
      : "重开后布局签名发生变化。",
  );
}

async function checkPause() {
  await ensurePlayingAudio();
  const before = game.elapsed;
  await pauseRun("自动检查");
  const pausedAt = game.elapsed;
  const pausedDiag = audio.diagnostics();
  await wait(260);
  const frozen = Math.abs(game.elapsed - pausedAt) < 0.0001;
  const suspended = audio.context?.state === "suspended";
  const voicesCleared = pausedDiag.voices === 0 && pausedDiag.schedulerRunning === false;
  await resumeRun();
  await wait(180);
  const resumedDiag = audio.diagnostics();
  const advanced = game.elapsed > pausedAt;
  const pass = frozen && suspended && voicesCleared && advanced && resumedDiag.schedulerRunning && audio.context?.state === "running";
  return reportCheck(
    "pause",
    pass,
    pass
      ? `暂停冻结 ${before.toFixed(2)}s 状态，上下文 suspended，活动声源清零；恢复后时钟继续且仅 1 路调度。`
      : `暂停检查未通过：frozen=${frozen}, suspended=${suspended}, voicesCleared=${voicesCleared}, advanced=${advanced}。`,
  );
}

function checkWrongPath() {
  const probe = new IceGame(currentSeed);
  probe.start();
  probe.player.yaw = probe.level.wrongBearing;
  let minimum = Infinity;
  let closest = null;
  for (let step = 0; step < 720 && probe.phase === "playing"; step += 1) {
    probe.update(1 / 60, { forward: true });
    for (const crevasse of probe.level.crevasses) {
      const separation = distance(probe.player, { x: crevasse.ax, z: crevasse.az });
      if (separation < minimum) {
        minimum = separation;
        closest = crevasse;
      }
    }
  }
  const failedAtFracture = probe.phase === "failed"
    && probe.failureCause?.cause === "crevasse"
    && probe.failureCause?.hazardId === "false-path";
  const pass = failedAtFracture && probe.danger > 0.3;
  return reportCheck(
    "wrong",
    pass,
    pass
      ? `错误方向在 ${probe.elapsed.toFixed(2)}s 触发薄冰断层；最近裂隙 ${closest?.label || "—"}，危险值 ${Math.round(probe.danger * 100)}%。`
      : "错误方向未触发预期裂隙。",
  );
}

async function checkInputInterruption() {
  await ensurePlayingAudio();
  input.press("KeyW");
  await wait(120);
  const interrupt = input.interrupt("自动检查");
  await wait(180);
  const controlsClear = Object.values(controls).every((value) => !value);
  const keysClear = input.keys.size === 0;
  const diag = audio.diagnostics();
  const pausedClean = game.phase === "paused"
    && diag.voices === 0
    && diag.schedulerRunning === false
    && audio.context?.state === "suspended";
  await resumeRun();
  await wait(150);
  const resumed = audio.diagnostics();
  const noDuplicate = resumed.schedulerRunning && resumed.listenerCount === 1;
  const pass = interrupt.hadInput && controlsClear && keysClear && pausedClean && noDuplicate;
  return reportCheck(
    "interrupt",
    pass,
    pass
      ? "输入中断清除全部按键/触点并挂起音频；未残留脚步声源，恢复后调度器与上下文监听均保持单例。"
      : `输入中断检查未通过：hadInput=${interrupt.hadInput}, controls=${controlsClear}, paused=${pausedClean}, single=${noDuplicate}。`,
  );
}

async function checkDestroy() {
  await ensurePlayingAudio();
  await wait(90);
  const before = audio.diagnostics();
  const result = await audio.destroyGraph();
  await wait(40);
  const after = audio.diagnostics();
  const pass = after.activeNodes === 0
    && after.voices === 0
    && after.schedulerRunning === false
    && after.listenerCount === 0
    && after.contextState === "closed"
    && result.destroyed;
  audio.attachGame(game);
  if (game.phase === "playing") {
    await audio.start();
    await wait(100);
  }
  return reportCheck(
    "destroy",
    pass,
    pass
      ? `销毁前 ${before.activeNodes} 个节点/${before.voices} 个声源；销毁后节点、声源、调度计时器与上下文监听全部归零，context=closed。`
      : `节点销毁后仍有残留：nodes=${after.activeNodes}, voices=${after.voices}, listeners=${after.listenerCount}。`,
  );
}

async function checkDuplicateStart() {
  await ensurePlayingAudio();
  await wait(100);
  const before = audio.diagnostics();
  const first = await audio.start();
  const second = await audio.start();
  await wait(80);
  const after = audio.diagnostics();
  const pass = first.duplicate && second.duplicate
    && before.listenerCount === after.listenerCount
    && after.listenerCount === 1
    && after.schedulerRunning
    && after.ambientSources === 1
    && after.startCount === before.startCount;
  return reportCheck(
    "duplicate",
    pass,
    pass
      ? `连续启动 2 次均被识别为重复；上下文监听仍为 1，环境声源仍为 1，startCount 保持 ${after.startCount}。`
      : `重复启动产生了额外实例：listeners=${after.listenerCount}, ambient=${after.ambientSources}, starts=${after.startCount}。`,
  );
}

async function checkSnapshotRoundTrip() {
  await ensurePlayingAudio();
  await captureSnapshot();
  const result = await restoreSnapshot();
  return reportCheck(
    "snapshot",
    result.pass,
    result.pass
      ? `快照往返一致：6 个节拍点、声像、增益均无漂移；WAV 文件时长 ${result.comparison.afterFileDuration.toFixed(3)}s。`
      : `快照比对失败：${result.comparison?.diffs?.slice(0, 2).join("；") || result.reason}`,
  );
}

async function checkExport() {
  const exported = await exportWav();
  const pass = exported.duration > 0 && exported.fileDuration > 0 && exported.bytes > 44;
  return reportCheck(
    "export",
    pass,
    pass
      ? `已生成 ${exported.filename}；WAV 头时长 ${exported.fileDuration.toFixed(3)}s，${exported.bytes} bytes。`
      : "WAV 导出失败。",
  );
}

async function runCheck(type) {
  if (checkInFlight) return;
  checkInFlight = true;
  const button = document.querySelector(`[data-check="${type}"]`);
  button?.classList.add("running");
  dom.checkReport.innerHTML = `<p>正在运行 ${type} 检查…</p>`;
  try {
    if (type === "seed") await checkSameSeed();
    else if (type === "pause") await checkPause();
    else if (type === "wrong") checkWrongPath();
    else if (type === "interrupt") await checkInputInterruption();
    else if (type === "destroy") await checkDestroy();
    else if (type === "duplicate") await checkDuplicateStart();
    else if (type === "snapshot") await checkSnapshotRoundTrip();
    else if (type === "export") await checkExport();
  } catch (error) {
    audio.lastError = error.message;
    reportCheck(type, false, `检查异常：${error.message}`);
    console.error(error);
  } finally {
    button?.classList.remove("running");
    checkInFlight = false;
    updateHUD(true);
  }
}

let previousCollected = game.collected.length;

function animationFrame(now) {
  syncCanvasSize();
  const dt = Math.min(0.05, Math.max(0, (now - lastFrameTime) / 1000));
  lastFrameTime = now;
  const wasPlaying = game.phase === "playing";
  if (wasPlaying) {
    game.update(dt, controls);
    if (game.justStepped) audio.playFootstep(game.stepSide, game.currentMaterial);
    if (game.collected.length > previousCollected) {
      audio.playCollect(game.collected.length - 1);
      setFooter(`声标 ${game.collected.length} / ${BEACON_COUNT} 已回收。${game.collected.length === BEACON_COUNT ? "入口回响已激活。" : ""}`);
    }
  }
  if ((game.phase === "won" || game.phase === "failed") && dom.resultPanel.hidden) {
    finishRun();
  }
  previousCollected = game.collected.length;
  drawStage();
  if (now - lastTelemetryAt > 100) {
    lastTelemetryAt = now;
    updateHUD();
    updateDiagnostics();
  }
  window.requestAnimationFrame(animationFrame);
}

function syncCanvasSize() {
  const rect = dom.canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (dom.canvas.width !== width || dom.canvas.height !== height) {
    dom.canvas.width = width;
    dom.canvas.height = height;
  }
}

function bindEvents() {
  dom.enterButton.addEventListener("click", async () => {
    try {
      await startRun({ seed: dom.seedInput.value });
    } catch (error) {
      audio.lastError = error.message;
      setFooter(`无法启动 Web Audio：${error.message}`);
      updateDiagnostics();
    }
  });
  dom.seedInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") dom.enterButton.click();
  });
  dom.pauseButton.addEventListener("click", () => togglePause());
  dom.soundButton.addEventListener("click", () => {
    muted = !muted;
    if (audio.graph && audio.context) {
      const target = muted ? 0 : params.masterGain;
      audio.graph.master.gain.setTargetAtTime(target, audio.context.currentTime, 0.025);
    }
    updateDiagnostics();
  });
  for (const [key, [selector]] of Object.entries(controlIds)) {
    document.querySelector(selector).addEventListener("input", () => {
      setParamsFromControls();
      updateHUD();
      if (key === "bpm") setFooter(`节拍速度 ${Math.round(params.bpm)} BPM；调度前瞻会自动重排。`);
    });
  }
  for (const button of document.querySelectorAll("[data-hold]")) {
    const action = button.dataset.hold;
    const press = (event) => {
      event.preventDefault();
      if (!input.active) return;
      button.classList.add("active");
      controls[action] = true;
    };
    const release = (event) => {
      event.preventDefault();
      button.classList.remove("active");
      controls[action] = false;
    };
    button.addEventListener("pointerdown", press);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("pointerleave", release);
  }
  for (const button of document.querySelectorAll("[data-check]")) {
    button.addEventListener("click", () => runCheck(button.dataset.check));
  }
  dom.snapshotButton.addEventListener("click", async () => {
    try {
      await captureSnapshot();
      setFooter("参数快照已保存；恢复入口只可使用一次。");
    } catch (error) {
      dom.snapshotStatus.textContent = `保存失败：${error.message}`;
    }
  });
  dom.restoreButton.addEventListener("click", async () => {
    try {
      const result = await restoreSnapshot();
      if (!result.pass) setFooter(`快照恢复差异：${result.comparison?.diffs?.[0] || result.reason || "未知"}`);
    } catch (error) {
      dom.snapshotStatus.textContent = `恢复失败：${error.message}`;
    }
  });
  dom.replayButton.addEventListener("click", () => restartSameSeed());
  dom.newRunButton.addEventListener("click", () => newRun());
  window.addEventListener("beforeunload", () => {
    audio.clearSchedulerTimer();
    audio.stopAllVoices();
  });
}

syncParamControls();
input.attach();
bindEvents();
dom.seedInput.value = currentSeed;
dom.seedLabel.textContent = currentSeed;
dom.missionHint.textContent = "启动声音，寻找三个冰层声标。";
updateHUD(true);
window.requestAnimationFrame(animationFrame);

window.__iceEcho = {
  game,
  audio,
  input,
  controls,
  params,
  get snapshot() {
    return snapshot;
  },
  get lastExport() {
    return lastExport;
  },
  startRun,
  restartSameSeed,
  pauseRun,
  resumeRun,
  togglePause,
  runCheck,
  captureSnapshot,
  restoreSnapshot,
  exportWav,
  comparePreview,
  previewPlan,
  renderPreview,
  checks: {
    sameSeed: checkSameSeed,
    pause: checkPause,
    wrongPath: checkWrongPath,
    interruption: checkInputInterruption,
    destroy: checkDestroy,
    duplicateStart: checkDuplicateStart,
    snapshotRoundTrip: checkSnapshotRoundTrip,
    export: checkExport,
  },
  diagnostics() {
    return {
      game: {
        phase: game.phase,
        seed: game.level.seed,
        elapsed: game.elapsed,
        collected: [...game.collected],
        danger: game.danger,
        player: { ...game.player },
        material: game.currentMaterial.id,
      },
      audio: audio.diagnostics(),
      inputListeners: input.listenerCount,
      controls: { ...controls },
    };
  },
};

// Keep the module deterministic and inspectable for automated acceptance tests.
console.info("ICE ECHO ready", { seed: currentSeed, listeners: input.listenerCount });
