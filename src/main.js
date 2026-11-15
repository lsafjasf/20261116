import { TICK_MS, EXIT_ACTION_RADIUS, FAILURE_LABELS, SCAN_COST } from "./config.js";
import { AudioEngine } from "./audio.js";
import { createGame, isTerminal } from "./game.js";
import { Renderer } from "./render.js";

const $ = (id) => document.getElementById(id);
const canvas = $("gameCanvas");
const renderer = new Renderer(canvas);
const audio = new AudioEngine();

function seedFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return params.get("seed") || "20261116";
}

let currentSeed = seedFromLocation();
let game = createGame(currentSeed, { recording: true });
let mode = "normal";
let replaySession = null;
let lastFrame = performance.now();
let tickAccumulator = 0;
let replayAccumulator = 0;
let announcedTerminal = false;
let toastTimer = 0;
let audioPulseTimer = 0;
let lastHudSignature = "";
const keys = new Set();

function formatClock(milliseconds) {
  const totalTenths = Math.floor(milliseconds / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

function toast(message, isError = false) {
  const element = $("toast");
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element.classList.remove("show"), 2800);
}

function syncSeedInput() {
  $("seedInput").value = String(currentSeed);
}

function announceTerminalOnce() {
  if (mode === "replay" || !isTerminal(game.state.status) || announcedTerminal) return;
  announcedTerminal = true;
  if (game.state.status === "SUCCESS") {
    toast("任务成功。真实地图已解封，可保存记录或回放。");
  } else {
    const label = FAILURE_LABELS[game.state.failureReason] ?? "任务失败";
    toast(`任务结束：${label}。可紧急回收或重新开始。`, true);
  }
}

function drainAudio() {
  const events = game.drainAudioEvents();
  for (const event of events) audio.playEvent(event);
  if (events.length > 0) {
    const pulse = $("audioPulse");
    pulse.classList.add("active");
    clearTimeout(audioPulseTimer);
    audioPulseTimer = window.setTimeout(() => pulse.classList.remove("active"), 700);
  }
}

async function ensureAudio() {
  try {
    await audio.init();
  } catch (error) {
    console.warn("Audio initialization failed", error);
    toast("浏览器未启用音频，视觉模式继续运行。", true);
  }
}

function statusLabel(status) {
  return (
    {
      READY: "待命",
      RUNNING: "监听中",
      PAUSED: "已暂停",
      SUCCESS: "已脱出",
      FAILED: "任务失败",
    }[status] ?? status
  );
}

function objectiveFor(state) {
  if (state.status === "READY") {
    return [
      "寻找三个出口中的正确出口",
      "先发射一次声呐，确认近处岩壁材质。",
    ];
  }
  if (state.status === "PAUSED") {
    return ["声场已冻结", "继续下潜后计时与巡逻源才会恢复。"];
  }
  if (state.status === "SUCCESS") {
    return ["从正确出口脱出", "真实地图已解封。保存记录可验证确定性回放。"];
  }
  if (state.status === "FAILED") {
    return [
      "任务终止",
      `${FAILURE_LABELS[state.failureReason] ?? "未知故障"}。${
        state.recoveries > 0 ? "可紧急回收一次。" : "回收次数已耗尽。"
      }`,
    ];
  }
  const exit = game.nearestExit();
  if (exit && exit.distance <= EXIT_ACTION_RADIUS) {
    return ["已抵达裂隙，提交出口", `当前是 ${exit.name}。提交后将显示真实地图。`];
  }
  if (state.scanCount === 0) {
    return ["发射首次主动声呐", "回波只在波前接触岩壁、出口或声源后返回。"];
  }
  if (state.exposure > 60) {
    return ["压低暴露值，避开巡逻源", "停止主动扫描，借助被动声源方位转移。"];
  }
  return [
    "辨认三个出口并避开巡逻源",
    `扫描 ${state.scanCount} 次；主动扫描会暴露位置并消耗电量。`,
  ];
}

function updateHud() {
  const state = game.state;
  const diagnostics = game.getDiagnostics();
  const [objective, detail] = objectiveFor(state);
  $("objective").textContent = objective;
  $("objectiveDetail").textContent = detail;
  $("statusPill").textContent = mode === "replay" ? "回放中" : statusLabel(state.status);
  $("statusPill").dataset.status = state.status;
  $("timer").textContent = formatClock(diagnostics.elapsedMs);
  $("resourceTick").textContent = `T+${formatClock(diagnostics.elapsedMs).slice(0, 5)}`;
  $("modeLabel").textContent = mode === "replay" ? "确定性回放" : statusLabel(state.status);
  $("batteryValue").textContent = `${Math.ceil(state.battery)}%`;
  $("batteryBar").style.width = `${Math.max(0, state.battery)}%`;
  const exposure = Math.round(state.exposure);
  $("exposureValue").textContent = `${exposure}%`;
  $("exposureBar").style.width = `${Math.max(0, state.exposure)}%`;
  $("hullValue").textContent = `${Math.ceil(state.hull)}%`;
  $("hullBar").style.width = `${Math.max(0, state.hull)}%`;
  $("recoveryValue").textContent = String(state.recoveries);
  $("cooldownValue").textContent =
    state.scanCooldown > 0 ? `${(state.scanCooldown * 0.05).toFixed(1)}s` : "就绪";
  $("lastChange").textContent = state.lastChange;
  $("changeTime").textContent =
    state.status === "READY" ? "RESET" : `T+${formatClock(diagnostics.elapsedMs).slice(0, 5)}`;
  $("flowValue").textContent = `${state.current.name} · ${state.current.strength.toFixed(2)}`;
  const scanSummary = state.lastScan
    ? `最近回波 ${state.lastScan.count} 路：${Object.entries(state.lastScan.materialSummary)
        .filter(([, count]) => count > 0)
        .map(([key, count]) => `${
          {
            basalt: "玄武岩",
            granite: "花岗岩",
            shale: "页岩",
            crystal: "石英脉",
            gate: "出口",
            patrol: "巡逻源",
          }[key] ?? key
        } ${count}`)
        .join(" · ")}`
    : "尚无声呐回波。";
  $("lastScanSummary").textContent = scanSummary;
  $("hashReadout").textContent = `STATE HASH ${diagnostics.hash} · REC ${diagnostics.recordEvents}`;

  const running = state.status === "RUNNING" && mode === "normal";
  const nearest = game.nearestExit();
  $("scanBtn").disabled =
    !running || state.scanCooldown > 0 || state.battery < SCAN_COST;
  $("submitBtn").disabled =
    !running || !nearest || nearest.distance > EXIT_ACTION_RADIUS;
  $("pauseBtn").disabled = !(
    (state.status === "RUNNING" || state.status === "PAUSED") &&
    mode === "normal"
  );
  $("pauseBtn").textContent = state.status === "PAUSED" ? "继续" : "暂停";
  $("recoverBtn").disabled =
    !(state.status === "FAILED" && state.recoveries > 0) || mode !== "normal";
  $("replayBtn").disabled = !isTerminal(state.status) || mode === "replay";
  $("downloadBtn").disabled = mode === "replay";
  $("loadRecordBtn").disabled = mode === "replay";
  $("newSeedBtn").disabled = mode === "replay";
  $("seedInput").disabled = mode === "replay";
  $("muteBtn").disabled = false;

  const audioState = audio.debugState();
  $("audioState").textContent = audioState.available
    ? audioState.muted
      ? "WEB AUDIO / MUTED"
      : audioState.paused
        ? "WEB AUDIO / PAUSED"
        : "WEB AUDIO / SYNTH"
    : "WEB AUDIO / STANDBY";

  const signature = [
    diagnostics.hash,
    mode,
    state.lastChange,
    audioState.activeSources,
  ].join("|");
  if (signature !== lastHudSignature) {
    lastHudSignature = signature;
  }

  Object.assign(document.body.dataset, {
    status: state.status,
    mode,
    tick: String(state.tick),
    timer: String(diagnostics.elapsedMs),
    battery: String(diagnostics.battery),
    exposure: String(diagnostics.exposure),
    rng: String(diagnostics.rngState),
    hash: diagnostics.hash,
    audioReset: String(audioState.resetCount),
    audioEvents: String(audioState.eventsPlayed),
    visualClock: String(state.visualClock),
  });
  Object.assign(canvas.dataset, {
    status: state.status,
    hash: diagnostics.hash,
    timer: String(diagnostics.elapsedMs),
    battery: String(diagnostics.battery),
    rng: String(diagnostics.rngState),
  });
  announceTerminalOnce();
}

let sourceRecord = null;

async function startGame() {
  if (game.state.status === "PAUSED") {
    game.resume();
    audio.setPaused(false);
    drainAudio();
    return;
  }
  if (game.state.status !== "READY") return;
  await ensureAudio();
  game.start();
  announcedTerminal = false;
  $("startOverlay").classList.add("hidden");
  audio.setPaused(false);
  drainAudio();
  toast("下潜开始。首次扫描只会在物体表面产生回波。");
}

function togglePause() {
  if (game.state.status === "RUNNING") {
    game.pause();
    audio.setPaused(true);
  } else if (game.state.status === "PAUSED") {
    game.resume();
    audio.setPaused(false);
  }
  drainAudio();
}

function doScan() {
  if (mode !== "normal" || game.state.status !== "RUNNING") return;
  const result = game.scan();
  drainAudio();
  if (!result.ok && result.reason === "too_far") {
    toast("尚未接近出口裂隙。", true);
  }
}

function doSubmit() {
  if (mode !== "normal" || game.state.status !== "RUNNING") return;
  const result = game.submitExit();
  drainAudio();
  if (!result.ok && result.reason === "too_far") {
    toast("必须靠近一个出口裂隙才能提交。", true);
  }
}

function doRecover() {
  if (mode !== "normal") return;
  const result = game.recover();
  drainAudio();
  if (result.ok) {
    $("startOverlay").classList.add("hidden");
    audio.setPaused(false);
    toast("紧急回收成功：已回到最近安全航点。");
  } else if (result.reason === "no_recovery") {
    toast("回收次数已耗尽。", true);
  }
}

async function restartRun() {
  game.restart();
  mode = "normal";
  replaySession = null;
  sourceRecord = null;
  announcedTerminal = false;
  tickAccumulator = 0;
  replayAccumulator = 0;
  audio.reset();
  audio.setPaused(false);
  $("startOverlay").classList.remove("hidden");
  syncSeedInput();
  toast("系统复位：计时器、资源、音画状态与随机序列全部清零。");
  updateHud();
}

async function newSeedGame() {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  currentSeed = String(random[0]);
  game = createGame(currentSeed, { recording: true });
  mode = "normal";
  replaySession = null;
  sourceRecord = null;
  announcedTerminal = false;
  tickAccumulator = 0;
  replayAccumulator = 0;
  audio.reset();
  audio.setPaused(false);
  $("startOverlay").classList.remove("hidden");
  syncSeedInput();
  toast(`新航次 seed：${currentSeed}`);
  updateHud();
}

function setSeedFromInput() {
  if (mode === "replay") return;
  const value = $("seedInput").value.trim();
  if (!value) {
    syncSeedInput();
    return;
  }
  currentSeed = value;
  game = createGame(currentSeed, { recording: true });
  mode = "normal";
  replaySession = null;
  sourceRecord = null;
  announcedTerminal = false;
  tickAccumulator = 0;
  replayAccumulator = 0;
  audio.reset();
  audio.setPaused(false);
  $("startOverlay").classList.remove("hidden");
  syncSeedInput();
  toast(`已装载 seed：${currentSeed}`);
  updateHud();
}

function beginReplay(recordOverride = null) {
  if (mode === "replay") return;
  if (!recordOverride && !isTerminal(game.state.status)) return;
  const record = recordOverride ?? sourceRecord ?? game.exportRecord();
  if (!Array.isArray(record.events) || !Number.isFinite(Number(record.seed))) {
    toast("回放记录格式无效。", true);
    return;
  }
  sourceRecord = record;
  const replayedGame = createGame(record.seed, { recording: false });
  if (
    record.worldSignature &&
    replayedGame.exportRecord().worldSignature !== record.worldSignature
  ) {
    toast("回放记录与 seed 的世界签名不一致。", true);
    return;
  }
  game = replayedGame;
  game.start({ log: false });
  mode = "replay";
  replaySession = {
    events: record.events,
    index: 0,
    record,
  };
  replayAccumulator = 0;
  tickAccumulator = 0;
  announcedTerminal = false;
  $("startOverlay").classList.add("hidden");
  audio.reset();
  audio.setPaused(false);
  toast(`回放 ${record.events.length} 个输入事件；结束后哈希将与记录比对。`);
  updateHud();
}

async function loadReplayFile(file) {
  if (!file || mode === "replay") return;
  try {
    const data = JSON.parse(await file.text());
    currentSeed = String(data.seed);
    syncSeedInput();
    beginReplay(data);
  } catch (error) {
    console.error(error);
    toast("无法读取回放记录，请选择本游戏保存的 JSON。", true);
  }
}

function downloadRecord() {
  const record = sourceRecord ?? game.exportRecord();
  const payload = {
    ...record,
    exportedAt: new Date().toISOString(),
    diagnostics: game.getDiagnostics(),
    audio: audio.debugState(),
    visual: {
      mode,
      status: game.state.status,
      visualClock: game.state.visualClock,
      pulseCount: game.state.pulses.length,
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `abyss-seed-${record.seed}-${record.finalTick}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast("记录已保存，可用于同 seed 确定性重放。");
}

function movementInput() {
  let dx = 0;
  let dy = 0;
  if (keys.has("ArrowLeft") || keys.has("KeyA")) dx -= 1;
  if (keys.has("ArrowRight") || keys.has("KeyD")) dx += 1;
  if (keys.has("ArrowUp") || keys.has("KeyW")) dy -= 1;
  if (keys.has("ArrowDown") || keys.has("KeyS")) dy += 1;
  return { dx, dy };
}

function stepReplay(deltaMs) {
  if (mode !== "replay" || !replaySession) return;
  replayAccumulator += deltaMs;
  let budget = 5;
  while (
    replaySession.index < replaySession.events.length &&
    replayAccumulator >= 20 &&
    budget > 0
  ) {
    const event = replaySession.events[replaySession.index];
    try {
      game.applyRecordedEvent(event);
    } catch (error) {
      console.error("Replay failed", error);
      toast(`回放中断：${error.message}`, true);
      mode = "review";
      replaySession = null;
      return;
    }
    replaySession.index += 1;
    replayAccumulator -= 20;
    budget -= 1;
    drainAudio();
  }
  if (replaySession && replaySession.index >= replaySession.events.length) {
    const expected = replaySession.record.finalHash;
    const actual = game.getHash();
    mode = "review";
    replaySession = null;
    announcedTerminal = false;
    if (expected && expected === actual) {
      toast(`回放完成，最终状态哈希一致：${actual}`);
    } else {
      toast("回放完成，但状态哈希与保存记录不一致。", true);
    }
    announcedTerminal = true;
  }
}

function frame(now) {
  const deltaMs = Math.min(150, now - lastFrame);
  lastFrame = now;

  if (mode === "normal" && game.state.status === "RUNNING") {
    tickAccumulator += deltaMs;
    let safety = 8;
    while (tickAccumulator >= TICK_MS && safety > 0) {
      game.tick(movementInput());
      tickAccumulator -= TICK_MS;
      safety -= 1;
      if (game.state.status !== "RUNNING") break;
    }
    drainAudio();
  } else {
    tickAccumulator = 0;
  }
  if (mode === "replay") stepReplay(deltaMs);
  if (mode !== "replay") {
    const expectedMute =
      game.state.status === "PAUSED" || game.state.status === "READY";
    if (audio.paused !== expectedMute) audio.setPaused(expectedMute);
  }

  audio.setAmbient(
    game.state.current.strength,
    game.state.exposure,
    game.state.status,
  );
  renderer.render(game, audio.debugState());
  updateHud();
  requestAnimationFrame(frame);
}

$("startBtn").addEventListener("click", () => {
  startGame().catch((error) => {
    console.error(error);
    toast("启动失败，请查看控制台。", true);
  });
});
$("scanBtn").addEventListener("click", doScan);
$("submitBtn").addEventListener("click", doSubmit);
$("pauseBtn").addEventListener("click", togglePause);
$("recoverBtn").addEventListener("click", doRecover);
$("restartBtn").addEventListener("click", () => {
  restartRun().catch((error) => console.error(error));
});
$("replayBtn").addEventListener("click", () => beginReplay());
$("downloadBtn").addEventListener("click", downloadRecord);
$("loadRecordBtn").addEventListener("click", () => $("recordFile").click());
$("recordFile").addEventListener("change", () => {
  loadReplayFile($("recordFile").files?.[0]).finally(() => {
    $("recordFile").value = "";
  });
});
$("newSeedBtn").addEventListener("click", () => {
  newSeedGame().catch((error) => console.error(error));
});
$("seedInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    setSeedFromInput();
    $("seedInput").blur();
  }
});
$("muteBtn").addEventListener("click", async () => {
  await ensureAudio();
  audio.setMuted(!audio.muted);
  $("muteIcon").textContent = audio.muted ? "静" : "声";
  toast(audio.muted ? "声音已关闭。" : "声音已开启。");
  updateHud();
});

const movementCodes = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
]);

window.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return;
  }
  if (movementCodes.has(event.code)) {
    event.preventDefault();
    keys.add(event.code);
    return;
  }
  if (event.repeat) return;
  if (event.code === "Space") {
    event.preventDefault();
    if (game.state.status === "READY") startGame();
    else doScan();
  } else if (event.code === "KeyE") {
    event.preventDefault();
    doSubmit();
  } else if (event.code === "KeyP") {
    event.preventDefault();
    togglePause();
  } else if (event.code === "KeyR") {
    event.preventDefault();
    restartRun().catch((error) => console.error(error));
  } else if (event.code === "KeyC") {
    event.preventDefault();
    doRecover();
  } else if (event.code === "KeyL") {
    event.preventDefault();
    beginReplay();
  } else if (event.code === "KeyM") {
    event.preventDefault();
    $("muteBtn").click();
  }
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});

window.addEventListener("blur", () => keys.clear());

let audioArmed = false;
document.addEventListener(
  "pointerdown",
  async () => {
    if (audioArmed) return;
    audioArmed = true;
    await ensureAudio();
  },
  { once: true },
);

document.addEventListener("visibilitychange", () => {
  if (document.hidden && game.state.status === "RUNNING" && mode === "normal") {
    game.pause();
    audio.setPaused(true);
    drainAudio();
  }
});

if ("ResizeObserver" in window) {
  const observer = new ResizeObserver(() => renderer.resize());
  observer.observe(canvas);
}

syncSeedInput();
updateHud();
requestAnimationFrame(frame);

window.__ABYSS__ = {
  get game() {
    return game;
  },
  get mode() {
    return mode;
  },
  get seed() {
    return currentSeed;
  },
  get sourceRecord() {
    return sourceRecord;
  },
  start: startGame,
  restart: restartRun,
  pause: togglePause,
  scan: doScan,
  submit: doSubmit,
  recover: doRecover,
  replay: beginReplay,
  download: downloadRecord,
  setSeed(seed) {
    $("seedInput").value = String(seed);
    setSeedFromInput();
  },
  snapshot() {
    return {
      seed: currentSeed,
      mode,
      state: game.state,
      diagnostics: game.getDiagnostics(),
      worldSignature: game.exportRecord().worldSignature,
      audio: audio.debugState(),
      replayEvents: replaySession?.events.length ?? 0,
      replayIndex: replaySession?.index ?? 0,
    };
  },
};
