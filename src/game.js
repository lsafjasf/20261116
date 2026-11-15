import {
  LIMITS,
  MISSION_SECONDS,
  PHASE,
  PHASE_LABELS,
  TICK_HZ,
  DT,
  axisTelemetry,
  createSimulation,
  hashState,
  makeReplayRecord,
  restoreSnapshot,
  runReplay,
  setCommands,
  snapshotState,
  step,
} from "./sim.js";
import { autopilotCommands } from "./autopilot.js";
import { AudioEngine } from "./audio.js";
import { SpaceRenderer } from "./renderer.js";

const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(window.location.search);
const requestedSeed = params.get("seed");
const sessionSeed = requestedSeed || "K7-DEMO-01";

const dom = {
  canvas: $("#space-canvas"),
  seed: $("#seed-display"),
  phaseLabel: $("#phase-label"),
  phaseCode: $("#phase-code"),
  phaseDot: $("#phase-dot"),
  objectiveTitle: $("#objective-title"),
  objectiveCopy: $("#objective-copy"),
  holdMeter: $("#hold-meter"),
  holdReadout: $("#hold-readout"),
  clock: $("#mission-clock"),
  propellant: $("#res-propellant"),
  power: $("#res-power"),
  latches: $("#res-latches"),
  hull: $("#res-hull"),
  barPropellant: $("#bar-propellant"),
  barPower: $("#bar-power"),
  dockSteps: [...document.querySelectorAll(".dock-step")],
  bearing: $("#axis-bearing"),
  pitch: $("#axis-pitch"),
  throttle: $("#axis-throttle"),
  bearingState: $("#axis-bearing-state"),
  pitchState: $("#axis-pitch-state"),
  throttleState: $("#axis-throttle-state"),
  axisCards: [...document.querySelectorAll(".axis-card")],
  eventLatest: $("#event-latest"),
  eventTime: $("#event-time"),
  eventList: $("#event-list"),
  targetTag: $("#target-tag"),
  portNumber: $("#port-number"),
  modeSelect: $("#mode-select"),
  modeName: $("#mode-name"),
  modeHint: $("#mode-hint"),
  audioButton: $("#audio-button"),
  pauseButton: $("#pause-button"),
  restartButton: $("#restart-button"),
  recoverButton: $("#recover-button"),
  replayButton: $("#replay-button"),
  exportButton: $("#export-button"),
  importButton: $("#import-button"),
  importFile: $("#import-file"),
  hash: $("#hash-display"),
  overlay: $("#overlay"),
  overlayKicker: $("#overlay-kicker"),
  overlayTitle: $("#overlay-title"),
  overlayCopy: $("#overlay-copy"),
  overlayPrimary: $("#overlay-primary"),
  overlaySecondary: $("#overlay-secondary"),
};

const renderer = new SpaceRenderer(dom.canvas);
const audio = new AudioEngine();
const keys = new Set();

let state = createSimulation(sessionSeed);
let checkpoint = snapshotState(state);
let checkpointTick = 0;
let paused = false;
let mode = "solo";
let audioEnabled = true;
let autopilotEnabled = false;
let commandOverride = null;
let accumulator = 0;
let lastFrame = performance.now();
let lastRenderedChangeTick = -1;
let hashCounter = 0;
let replaySession = null;
let liveState = state;
let overlayPinned = false;
let pendingReplayRecord = null;

const MODE_COPY = {
  solo: {
    name: "单人调试",
    hint: "A/D 方位 · W/S 俯仰 · ↑/↓ 推进",
  },
  crew: {
    name: "三人协作",
    hint: "P1 A/D · P2 W/S · P3 ↑/↓",
  },
};

const AXIS_LABELS = {
  WAIT: "WAIT",
  HOLD: "IN",
  OUT: "OUT",
};

function viewState() {
  return replaySession ? replaySession.state : state;
}

function isViewingReplay() {
  return Boolean(replaySession);
}

function setMode(nextMode) {
  mode = nextMode === "crew" ? "crew" : "solo";
  dom.modeSelect.value = mode;
  dom.modeName.textContent = MODE_COPY[mode].name;
  dom.modeHint.textContent = MODE_COPY[mode].hint;
  if (isViewingReplay()) {
    dom.modeName.textContent = "确定性回放";
    dom.modeHint.textContent = "输入记录按 tick 重放 · B 退出";
  }
}

function commandsFromKeys() {
  const yaw = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
  const pitch = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
  const throttle = (keys.has("ArrowUp") ? 1 : 0) - (keys.has("ArrowDown") ? 1 : 0);
  return { yaw, pitch, throttle };
}

function applyCheckpointIfNeeded(previousPhase, previousDock, current) {
  if (current.phase === PHASE.APPROACH && previousDock === 1 && current.dockNumber === 2) {
    checkpoint = snapshotState(current);
    checkpointTick = current.tick;
    return;
  }
  if (previousPhase === PHASE.TRANSFER && current.phase === PHASE.APPROACH) {
    checkpoint = snapshotState(current);
    checkpointTick = current.tick;
  }
}

function advanceOneTick(target = state) {
  if (target.phase === PHASE.FAILED || target.phase === PHASE.COMPLETE) {
    return;
  }
  const previousPhase = target.phase;
  const previousDock = target.dockNumber;
  const commands = autopilotEnabled
    ? autopilotCommands(target)
    : commandOverride || commandsFromKeys();
  setCommands(target, commands);
  step(target);
  if (!isViewingReplay()) {
    applyCheckpointIfNeeded(previousPhase, previousDock, target);
  }
}

function frame(timestamp) {
  const rawDelta = Math.min(0.1, Math.max(0, (timestamp - lastFrame) / 1000));
  lastFrame = timestamp;

  if (replaySession) {
    if (!replaySession.paused && !replaySession.finished) {
      replaySession.accumulator += rawDelta * replaySession.speed;
      while (replaySession.accumulator >= DT && !replaySession.finished) {
        advanceReplayTick();
        replaySession.accumulator -= DT;
      }
    }
  } else if (!paused) {
    accumulator += rawDelta;
    let guard = 0;
    while (accumulator >= DT && guard < 8) {
      advanceOneTick();
      accumulator -= DT;
      guard += 1;
    }
  }

  const current = viewState();
  const geometry = renderer.draw(current, {
    paused: paused || (replaySession && replaySession.paused),
    replay: isViewingReplay(),
    now: timestamp,
  });
  positionTargetTag(geometry, current);
  updateInterface(current, timestamp);

  if (paused && !isViewingReplay()) {
    audio.setPaused(true);
  } else {
    audio.setPaused(false);
    audio.update(current);
  }
  requestAnimationFrame(frame);
}

function positionTargetTag(geometry, current) {
  dom.targetTag.style.left = `${Math.round(geometry.port.x - 15)}px`;
  dom.targetTag.style.top = `${Math.round(geometry.port.y - 57)}px`;
  dom.portNumber.textContent = current.dockNumber === 1 ? "01" : "02";
}

function formatClock(seconds) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = Math.floor(safe % 60);
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function objectiveFor(current) {
  if (current.phase === PHASE.FAILED) {
    return {
      title: "回合已中止",
      copy: current.failure || "模块失去安全姿态。恢复检查点后重新建立三轴稳定。",
    };
  }
  if (current.phase === PHASE.COMPLETE) {
    return {
      title: "双接口任务完成",
      copy: "两次锁扣闭合且已越过 12 m 安全线。导出回放可复核最终状态哈希。",
    };
  }
  if (current.phase === PHASE.RETREATING) {
    return {
      title: "撤离至安全线",
      copy: `保持后退速度不超过 0.65 m/s，距离达到 ${LIMITS.safeRetreat.toFixed(1)} m 即完成撤离。`,
    };
  }
  if (current.phase === PHASE.TRANSFER) {
    return {
      title: "机械臂转场",
      copy: "一号接口已锁定。等待转场完成，期间补加推进剂与主电力。",
    };
  }
  if (current.phase === PHASE.LATCHING) {
    return {
      title: "锁扣闭合中",
      copy: "两秒保持已确认，姿控冻结。锁扣完成前不要松开操作席位。",
    };
  }
  if (current.phase === PHASE.HOLD) {
    return {
      title: "保持三轴容差",
      copy: "方位、俯仰与推进速度必须同时停在青色区间。任何一轴出窗都会清零计时。",
    };
  }
  return {
    title: `对准${current.dockNumber === 1 ? "一" : "二"}号接口`,
    copy: "三轴同时进入青色容差窗，稳定保持 2.00 秒。任一轴过冲都会触发碰撞。",
  };
}

function setAxisState(index, ok, telemetryValue, threshold) {
  const card = dom.axisCards[index];
  const readout = [dom.bearingState, dom.pitchState, dom.throttleState][index];
  card.classList.toggle("in-tolerance", ok);
  card.classList.toggle("out-of-tolerance", !ok);
  card.classList.toggle("danger", Math.abs(telemetryValue) > threshold);
  readout.textContent = ok ? AXIS_LABELS.HOLD : AXIS_LABELS.OUT;
}

function updateEventFeed(current) {
  if (dom.eventLatest.dataset.tick === `${current.lastChange?.tick}-${current.lastChange?.text}`) {
    return;
  }
  const latest = current.lastChange;
  if (!latest) {
    return;
  }
  dom.eventLatest.dataset.tick = `${latest.tick}-${latest.text}`;
  dom.eventLatest.textContent = latest.text;
  dom.eventLatest.className = `event-latest ${latest.tone}`;
  dom.eventTime.textContent = `T+${formatClock(latest.elapsed)}.${Math.floor((latest.elapsed % 1) * 10)}`;
  const items = current.changeLog
    .slice(-4)
    .reverse()
    .map((entry) => {
      const stamp = `T+${formatClock(entry.elapsed)}`;
      return `<li><time>${stamp}</time><span>${entry.text}</span></li>`;
    })
    .join("");
  dom.eventList.innerHTML = items;
}

function updateInterface(current, timestamp) {
  const telemetry = axisTelemetry(current);
  const objective = objectiveFor(current);
  dom.seed.textContent = current.seed;
  dom.phaseLabel.textContent = PHASE_LABELS[current.phase];
  dom.phaseCode.textContent = current.phase.toUpperCase();
  dom.phaseDot.style.background =
    current.phase === PHASE.FAILED
      ? "#ff655f"
      : current.phase === PHASE.COMPLETE
        ? "#66efc6"
        : current.phase === PHASE.HOLD
          ? "#ffb55e"
          : "#66efc6";
  dom.phaseDot.style.boxShadow = `0 0 14px ${dom.phaseDot.style.background}`;
  dom.objectiveTitle.textContent = objective.title;
  dom.objectiveCopy.textContent = objective.copy;
  dom.holdMeter.style.width = `${Math.min(100, (current.holdTime / 2) * 100)}%`;
  dom.holdReadout.textContent = `${current.holdTime.toFixed(2)} / 2.00 s`;
  dom.clock.textContent = formatClock(MISSION_SECONDS - current.elapsed);
  dom.clock.style.color = MISSION_SECONDS - current.elapsed < 30 ? "#ff655f" : "";

  const propellant = current.resources.propellant;
  const power = current.resources.power;
  dom.propellant.textContent = `${propellant.toFixed(0)}%`;
  dom.power.textContent = `${power.toFixed(0)}%`;
  dom.latches.textContent = `${current.resources.latchCharges} / 2`;
  dom.hull.textContent = `${current.resources.hull.toFixed(0)}%`;
  dom.barPropellant.style.width = `${propellant}%`;
  dom.barPower.style.width = `${power}%`;
  dom.barPropellant.style.background = propellant < 20 ? "#ff655f" : "";
  dom.barPower.style.background = power < 20 ? "#ff655f" : "";

  dom.bearing.textContent = `${telemetry.bearing >= 0 ? "+" : ""}${telemetry.bearing.toFixed(2)}°`;
  dom.pitch.textContent = `${telemetry.pitch >= 0 ? "+" : ""}${telemetry.pitch.toFixed(2)}°`;
  dom.throttle.textContent = `${telemetry.axialSpeed >= 0 ? "+" : ""}${telemetry.axialSpeed.toFixed(2)} m/s`;
  setAxisState(0, telemetry.bearingIn, telemetry.bearing, LIMITS.bearingDeg * 2.5);
  setAxisState(1, telemetry.pitchIn, telemetry.pitch, LIMITS.pitchDeg * 2.5);
  setAxisState(2, telemetry.rangeIn && telemetry.speedIn, telemetry.axialSpeed, LIMITS.axialSpeed * 4);

  dom.dockSteps.forEach((element, index) => {
    element.classList.remove("active", "done");
    if (index === 0 && current.latchCount >= 1) element.classList.add("done");
    if (index === 1 && current.latchCount >= 2) element.classList.add("done");
    if (index === 2 && current.phase === PHASE.COMPLETE) element.classList.add("done");
    const expectedStep =
      current.latchCount === 0 ? 0 : current.latchCount === 1 ? 1 : current.phase === PHASE.RETREATING ? 2 : 2;
    if (index === expectedStep && !element.classList.contains("done")) {
      element.classList.add("active");
    }
  });

  updateEventFeed(current);
  if (current.lastChange && current.lastChange.tick !== lastRenderedChangeTick) {
    lastRenderedChangeTick = current.lastChange.tick;
    if (!isViewingReplay()) {
      audio.cue(current.lastChange.tone);
    }
  }

  hashCounter += 1;
  if (hashCounter % 12 === 0 || current.phase === PHASE.FAILED || current.phase === PHASE.COMPLETE) {
    dom.hash.textContent = hashState(current);
  }

  dom.recoverButton.disabled = !(current.phase === PHASE.FAILED && checkpointTick >= 0);
  dom.replayButton.innerHTML = isViewingReplay()
    ? "<kbd>B</kbd> 退出回放"
    : "<kbd>B</kbd> 回放";
  dom.pauseButton.innerHTML =
    paused || (replaySession && replaySession.paused)
      ? "<kbd>P</kbd> 继续"
      : "<kbd>P</kbd> 暂停";
  dom.modeName.textContent = isViewingReplay() ? "确定性回放" : MODE_COPY[mode].name;
  dom.modeHint.textContent = isViewingReplay() ? "输入记录按 tick 重放 · B 退出" : MODE_COPY[mode].hint;
  updateOverlay(current);
  void timestamp;
}

function showOverlay({ kicker, kickerColor, title, copy, primary, primaryAction, secondary, secondaryAction }) {
  dom.overlay.hidden = false;
  dom.overlayKicker.textContent = kicker;
  dom.overlayKicker.style.color = kickerColor || "var(--amber)";
  dom.overlayTitle.textContent = title;
  dom.overlayCopy.textContent = copy;
  dom.overlayPrimary.textContent = primary;
  dom.overlayPrimary.dataset.action = primaryAction;
  dom.overlaySecondary.hidden = !secondary;
  dom.overlaySecondary.textContent = secondary || "";
  dom.overlaySecondary.dataset.action = secondaryAction || "";
}

function updateOverlay(current) {
  if (overlayPinned) {
    return;
  }
  if (replaySession) {
    if (replaySession.finished) {
      showOverlay({
        kicker: "REPLAY COMPLETE",
        kickerColor: "var(--blue)",
        title: "回放结束",
        copy: `最终状态哈希 ${hashState(replaySession.state)}。该结果由 seed 与 ${replaySession.record.inputLog.length} 条输入记录按固定 60 Hz 重放得到。`,
        primary: "退出回放",
        primaryAction: "exit-replay",
      });
    } else if (replaySession.paused) {
      showOverlay({
        kicker: "REPLAY PAUSED",
        kickerColor: "var(--blue)",
        title: "回放暂停",
        copy: "确定性时间轴已冻结，当前画面仍可检查轨道与误差锥。",
        primary: "继续回放",
        primaryAction: "resume-replay",
      });
    } else {
      dom.overlay.hidden = true;
    }
    return;
  }
  if (current.phase === PHASE.FAILED) {
    showOverlay({
      kicker: "ROUND ABORTED",
      kickerColor: "var(--red)",
      title: "对接中止",
      copy: `${current.failure || "碰撞中止"}。最近检查点 T+${formatClock(checkpointTick * DT)}，恢复后计时、资源与随机序列会同步回退。`,
      primary: "恢复检查点",
      primaryAction: "recover",
      secondary: "重新开始",
      secondaryAction: "restart",
    });
    return;
  }
  if (current.phase === PHASE.COMPLETE) {
    showOverlay({
      kicker: "MISSION COMPLETE",
      kickerColor: "var(--teal)",
      title: "两次锁定，安全撤离",
      copy: `用时 ${current.elapsed.toFixed(1)} 秒，剩余推进剂 ${current.resources.propellant.toFixed(1)}%。最终哈希 ${hashState(current)}。`,
      primary: "重新开始",
      primaryAction: "restart",
      secondary: "导出回放",
      secondaryAction: "export",
    });
    return;
  }
  if (paused) {
    const recovered = Boolean(current.lastChange?.text?.startsWith("失败恢复"));
    showOverlay({
      kicker: recovered ? "CHECKPOINT RESTORED" : "SIMULATION PAUSED",
      kickerColor: "var(--amber)",
      title: recovered ? "检查点已恢复" : "任务暂停",
      copy: recovered
        ? "计时、物理状态、资源与 seeded 随机序列均已回退。确认后继续任务。"
        : "固定步长、任务计时、推进剂与电力消耗均已冻结。",
      primary: "继续任务",
      primaryAction: "resume",
      secondary: "重新开始",
      secondaryAction: "restart",
    });
    return;
  }
  dom.overlay.hidden = true;
}

function resetKeys() {
  keys.clear();
}

function restartMission() {
  overlayPinned = false;
  replaySession = null;
  liveState = createSimulation(sessionSeed);
  state = liveState;
  checkpoint = snapshotState(state);
  checkpointTick = 0;
  paused = false;
  autopilotEnabled = false;
  commandOverride = null;
  accumulator = 0;
  lastRenderedChangeTick = -1;
  audio.reset();
  resetKeys();
  dom.eventLatest.dataset.tick = "";
  dom.hash.textContent = hashState(state);
}

function recoverFromCheckpoint() {
  if (!state.failure) {
    return;
  }
  const restored = restoreSnapshot(checkpoint);
  restored.lastChange = {
    tick: restored.tick,
    elapsed: Number(restored.elapsed.toFixed(3)),
    text: "失败恢复：状态、资源与随机序列已回退至最近检查点",
    tone: "warn",
  };
  restored.changeLog.push(restored.lastChange);
  state = restored;
  liveState = state;
  replaySession = null;
  paused = true;
  autopilotEnabled = false;
  commandOverride = null;
  accumulator = 0;
  lastRenderedChangeTick = -1;
  resetKeys();
  audio.reset();
  audio.setPaused(true);
  dom.eventLatest.dataset.tick = "";
  overlayPinned = false;
}

function togglePause() {
  if (replaySession) {
    replaySession.paused = !replaySession.paused;
  } else if (state.phase !== PHASE.FAILED && state.phase !== PHASE.COMPLETE) {
    paused = !paused;
    accumulator = 0;
    audio.setPaused(paused);
  }
}

function replayEventsByTick(record) {
  const map = new Map();
  for (const event of record.inputLog) {
    const tick = Math.max(0, Math.floor(event.tick));
    if (!map.has(tick)) {
      map.set(tick, []);
    }
    map.get(tick).push(event);
  }
  return map;
}

function startReplay() {
  if (replaySession) {
    replaySession = null;
    resetKeys();
    return;
  }
  if (state.tick < 1) {
    return;
  }
  const record = makeReplayRecord(state, state.tick);
  startRecordReplay(record);
}

function startRecordReplay(record) {
  replaySession = {
    record,
    state: createSimulation(record.seed),
    eventsByTick: replayEventsByTick(record),
    accumulator: 0,
    speed: 2,
    paused: false,
    finished: record.endTick === 0,
  };
  liveState = state;
  paused = false;
  commandOverride = null;
  resetKeys();
  audio.reset();
}

function advanceReplayTick() {
  const session = replaySession;
  if (!session || session.finished) {
    return;
  }
  const events = session.eventsByTick.get(session.state.tick);
  if (events) {
    for (const event of events) {
      setCommands(session.state, event, false);
    }
  }
  step(session.state);
  if (session.state.tick >= session.record.endTick) {
    session.finished = true;
  }
}

function downloadReplay() {
  const current = isViewingReplay() ? replaySession.state : state;
  const record = isViewingReplay()
    ? replaySession.record
    : makeReplayRecord(current, current.tick);
  record.finalHash = hashState(current);
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `latch3-${current.seed}-${record.finalHash}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function pinValidationResult(record, replayedState, hash, match) {
  pendingReplayRecord = match ? record : null;
  overlayPinned = true;
  showOverlay({
    kicker: match ? "REPLAY VERIFIED" : "HASH MISMATCH",
    kickerColor: match ? "var(--teal)" : "var(--red)",
    title: match ? "确定性校验一致" : "哈希不一致",
    copy: match
      ? `Seed ${record.seed}，输入 ${record.inputLog.length} 条，重放 ${record.endTick} tick。记录哈希 ${record.finalHash}，重放哈希 ${hash}。`
      : `记录哈希 ${record.finalHash || "缺失"}，重放哈希 ${hash}。请检查 seed 或输入记录是否被修改。`,
    primary: "关闭",
    primaryAction: "unpin",
    secondary: match ? "退出并载入回放" : "重新开始",
    secondaryAction: match ? "exit-load-replay" : "restart",
  });
  dom.overlay.dataset.hash = hash;
  dom.overlay.dataset.replayed = String(Boolean(replayedState));
}

function pinError(title, copy) {
  overlayPinned = true;
  showOverlay({
    kicker: "IMPORT ERROR",
    kickerColor: "var(--red)",
    title,
    copy,
    primary: "关闭",
    primaryAction: "unpin",
  });
}

async function importReplay(file) {
  try {
    const text = await file.text();
    const record = JSON.parse(text);
    if (
      !record ||
      typeof record.seed !== "string" ||
      !Array.isArray(record.inputLog) ||
      !Number.isFinite(record.endTick)
    ) {
      throw new Error("回放记录缺少 seed、inputLog 或 endTick");
    }
    const replayed = runReplay(record.seed, record.inputLog, record.endTick);
    const hash = hashState(replayed);
    pinValidationResult(record, replayed, hash, hash === record.finalHash);
  } catch (error) {
    pinError("无法读取回放", error instanceof Error ? error.message : String(error));
  } finally {
    dom.importFile.value = "";
  }
}

function handleOverlayAction(action) {
  if (action === "restart") {
    restartMission();
  } else if (action === "recover") {
    recoverFromCheckpoint();
  } else if (action === "resume") {
    paused = false;
  } else if (action === "resume-replay" && replaySession) {
    replaySession.paused = false;
  } else if (action === "exit-replay") {
    replaySession = null;
    resetKeys();
  } else if (action === "export") {
    downloadReplay();
  } else if (action === "unpin") {
    overlayPinned = false;
    dom.overlay.hidden = true;
  } else if (action === "exit-load-replay") {
    overlayPinned = false;
    dom.overlay.hidden = true;
    if (pendingReplayRecord) {
      startRecordReplay(pendingReplayRecord);
      pendingReplayRecord = null;
    }
  }
}

async function toggleAudio() {
  audioEnabled = !audioEnabled;
  dom.audioButton.setAttribute("aria-pressed", String(audioEnabled));
  dom.audioButton.innerHTML = `<span class="button-icon">◉</span>${audioEnabled ? "音频开启" : "音频关闭"}`;
  await audio.ensure();
  audio.setEnabled(audioEnabled);
}

function handleKeyDown(event) {
  if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) {
    return;
  }
  const controlled = [
    "KeyA",
    "KeyD",
    "KeyW",
    "KeyS",
    "ArrowUp",
    "ArrowDown",
  ].includes(event.code);
  if (controlled) {
    event.preventDefault();
    if (!replaySession) {
      keys.add(event.code);
      commandOverride = null;
    }
  }
  if (event.repeat) {
    return;
  }
  if (event.code === "KeyP") {
    togglePause();
  } else if (event.code === "KeyR") {
    restartMission();
  } else if (event.code === "KeyY") {
    if (state.phase === PHASE.FAILED) {
      recoverFromCheckpoint();
    }
  } else if (event.code === "KeyB") {
    startReplay();
  } else if (event.code === "KeyM") {
    toggleAudio();
  }
}

dom.modeSelect.addEventListener("change", () => {
  setMode(dom.modeSelect.value);
  audio.ensure();
});
dom.audioButton.addEventListener("click", toggleAudio);
dom.pauseButton.addEventListener("click", togglePause);
dom.restartButton.addEventListener("click", restartMission);
dom.recoverButton.addEventListener("click", recoverFromCheckpoint);
dom.replayButton.addEventListener("click", startReplay);
dom.exportButton.addEventListener("click", downloadReplay);
dom.importButton.addEventListener("click", () => dom.importFile.click());
dom.importFile.addEventListener("change", () => {
  const file = dom.importFile.files?.[0];
  if (file) {
    importReplay(file);
  }
});
dom.overlayPrimary.addEventListener("click", () => {
  handleOverlayAction(dom.overlayPrimary.dataset.action);
});
dom.overlaySecondary.addEventListener("click", () => {
  handleOverlayAction(dom.overlaySecondary.dataset.action);
});
window.addEventListener("keydown", handleKeyDown);
window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});
window.addEventListener("blur", resetKeys);
window.addEventListener("pointerdown", () => audio.ensure(), { once: true });
window.addEventListener("keydown", () => audio.ensure(), { once: true });

window.__LATCH3__ = {
  getState: () => snapshotState(viewState()),
  getHash: () => hashState(viewState()),
  getCheckpointTick: () => checkpointTick,
  getRuntime: () => ({
    seed: viewState().seed,
    phase: viewState().phase,
    tick: viewState().tick,
    elapsed: viewState().elapsed,
    hash: hashState(viewState()),
    paused,
    replay: Boolean(replaySession),
    replayFinished: Boolean(replaySession?.finished),
    mode,
    autopilot: autopilotEnabled,
    checkpointTick,
    random: {
      nextDriftTick: viewState().nextDriftTick,
      driftSerial: viewState().driftSerial,
      portOffset: { ...viewState().portOffset },
      rngState: viewState().rngState,
    },
    audio: {
      enabled: audio.enabled,
      paused: audio.paused,
      context: audio.context?.state || "uninitialized",
      distanceBand: audio.distanceBand(viewState()),
    },
  }),
  getVisualState: () => {
    const current = viewState();
    const geometry = renderer.geometry(current);
    return {
      port: { x: Number(geometry.port.x.toFixed(2)), y: Number(geometry.port.y.toFixed(2)) },
      module: { x: Number(geometry.module.x.toFixed(2)), y: Number(geometry.module.y.toFixed(2)) },
      distancePixels: Number(geometry.distancePixels.toFixed(2)),
      audioBand: audio.distanceBand(current),
      phase: current.phase,
      axisSync: axisTelemetry(current).allIn,
    };
  },
  ensureAudio: async () => {
    await audio.ensure();
    audioEnabled = true;
    audio.setEnabled(true);
    audio.setPaused(false);
    return audio.context?.state || "unsupported";
  },
  setMode,
  setAutopilot: (enabled) => {
    autopilotEnabled = Boolean(enabled);
  },
  setCommands: (commands) => {
    setCommands(state, commands);
    commandOverride = { ...state.commands };
  },
  clearCommands: () => {
    commandOverride = null;
    setCommands(state, { yaw: 0, pitch: 0, throttle: 0 });
  },
  pause: () => {
    paused = true;
  },
  resume: () => {
    paused = false;
  },
  step: (count = 1) => {
    for (let index = 0; index < count; index += 1) {
      advanceOneTick();
    }
    return hashState(viewState());
  },
  advanceAutopilot: (count = TICK_HZ * 120) => {
    autopilotEnabled = true;
    commandOverride = null;
    for (let index = 0; index < count; index += 1) {
      if (state.phase === PHASE.FAILED || state.phase === PHASE.COMPLETE) break;
      advanceOneTick();
    }
    autopilotEnabled = false;
    return {
      state: snapshotState(state),
      hash: hashState(state),
    };
  },
  restart: () => {
    restartMission();
    return hashState(state);
  },
  recover: () => {
    recoverFromCheckpoint();
    return hashState(state);
  },
  togglePause,
  makeRecord: () => makeReplayRecord(state, state.tick),
  validateRecord: (record) => {
    const replayed = runReplay(record.seed, record.inputLog, record.endTick);
    return {
      hash: hashState(replayed),
      expected: record.finalHash,
      match: hashState(replayed) === record.finalHash,
      state: snapshotState(replayed),
    };
  },
  startRecordReplay,
  advanceReplayToEnd: () => {
    let guard = 0;
    while (replaySession && !replaySession.finished && guard < 200000) {
      advanceReplayTick();
      guard += 1;
    }
    return replaySession ? hashState(replaySession.state) : null;
  },
  exitReplay: () => {
    replaySession = null;
    resetKeys();
  },
};

setMode(params.get("mode") === "crew" ? "crew" : "solo");
dom.audioButton.setAttribute("aria-pressed", "true");
dom.seed.textContent = sessionSeed;
dom.hash.textContent = hashState(state);
updateInterface(state, performance.now());
requestAnimationFrame((timestamp) => {
  lastFrame = timestamp;
  requestAnimationFrame(frame);
});
