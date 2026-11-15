import {
  BASE,
  RESCUE_POINTS,
  TICK_MS,
  captureCheckpoint,
  createWorld,
  formatExactTime,
  getMissionView,
  hashState,
  releaseProtection,
  resetMission,
  restoreWorld,
  serializeWorld,
  setControl,
  stepWorld,
  triggerSideDisconnect,
} from "./sim.js";
import { SceneRenderer } from "./render.js";
import { TensionAudio } from "./audio.js";

const SAVE_KEY = "twin-cable-rescue.save.v1";
const SAVE_INTERVAL = 700;
const MAX_TIMELINE_FRAMES = 7200;
const FIXED_STEP = TICK_MS / 1000;
const FIXED_STEP_MS = TICK_MS;

const byId = (id) => document.getElementById(id);
const refs = {
  scene: byId("scene"),
  stage: document.querySelector(".stage"),
  statusText: byId("statusText"),
  missionClock: byId("missionClock"),
  progressValue: byId("progressValue"),
  durabilityValue: byId("durabilityValue"),
  durabilityMeter: byId("durabilityMeter"),
  leftTensionValue: byId("leftTensionValue"),
  rightTensionValue: byId("rightTensionValue"),
  leftTensionMeter: byId("leftTensionMeter"),
  rightTensionMeter: byId("rightTensionMeter"),
  leftLengthValue: byId("leftLengthValue"),
  rightLengthValue: byId("rightLengthValue"),
  leftTempValue: byId("leftTempValue"),
  rightTempValue: byId("rightTempValue"),
  leftWinchState: byId("leftWinchState"),
  rightWinchState: byId("rightWinchState"),
  safetyValue: byId("safetyValue"),
  safetyMeter: byId("safetyMeter"),
  p1Hint: byId("p1Hint"),
  p2Hint: byId("p2Hint"),
  missionTrack: byId("missionTrack"),
  targetLabel: byId("targetLabel"),
  windValue: byId("windValue"),
  windArrow: byId("windArrow"),
  noticeText: byId("noticeText"),
  captureHud: byId("captureHud"),
  captureValue: byId("captureValue"),
  protectionBanner: byId("protectionBanner"),
  protectionTitle: byId("protectionTitle"),
  protectionDetail: byId("protectionDetail"),
  releaseProtection: byId("releaseProtection"),
  sharedStateLabel: byId("sharedStateLabel"),
  frameCounter: byId("frameCounter"),
  audioToggle: byId("audioToggle"),
  audioLabel: byId("audioLabel"),
  helpButton: byId("helpButton"),
  helpModal: byId("helpModal"),
  helpClose: byId("helpClose"),
  disconnectTest: byId("disconnectTest"),
  loadReplay: byId("loadReplay"),
  loadDemoReplay: byId("loadDemoReplay"),
  exportReplay: byId("exportReplay"),
  replayToggle: byId("replayToggle"),
  replayIcon: byId("replayIcon"),
  replayLabel: byId("replayLabel"),
  replayStep: byId("replayStep"),
  replaySpeed: byId("replaySpeed"),
  replayScrubber: byId("replayScrubber"),
  replayTime: byId("replayTime"),
  replayDuration: byId("replayDuration"),
  replayProof: byId("replayProof"),
  eventList: byId("eventList"),
  conflictList: byId("conflictList"),
  conflictCountValue: byId("conflictCountValue"),
  eventCountValue: byId("eventCountValue"),
  finalHashValue: byId("finalHashValue"),
  recordLight: byId("recordLight"),
  saveState: byId("saveState"),
  restartMission: byId("restartMission"),
};

const pressedControls = new Map();
const renderer = new SceneRenderer(refs.scene);
const audio = new TensionAudio();

let savedWorld = null;
try {
  const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
  if (saved?.world) savedWorld = restoreWorld(saved.world);
} catch (error) {
  console.warn("存档读取失败", error);
}

let world = savedWorld || createWorld();
const restoredFromSave = !!savedWorld;
let lastFrameTime = performance.now();
let simulationAccumulator = 0;
let lastSaveAt = 0;
let previousEventCount = world.events.length;
let lastUiTick = -1;
let modalOpen = false;

const replay = {
  active: false,
  playing: false,
  index: 0,
  cursor: 0,
  speed: 1,
  frames: [],
  expectedHash: world.finalHash,
  lastProof: "等待回放",
  source: "live",
};
let demoRecording = null;

function saveGame(force = false) {
  const now = performance.now();
  if (!force && now - lastSaveAt < SAVE_INTERVAL) return;
  lastSaveAt = now;
  try {
    captureCheckpoint(world);
    const trimAt = Math.max(0, world.timeline.length - MAX_TIMELINE_FRAMES);
    if (trimAt > 0) {
      world.timeline.splice(0, trimAt);
      world.timeline.forEach((frame, index) => {
        frame.index = index;
      });
    }
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      world: serializeWorld(world),
    }));
    refs.saveState.textContent = "已存档";
  } catch (error) {
    refs.saveState.textContent = "存储受限";
    console.warn("存档失败", error);
  }
}

function setPressed(player, control, pressed) {
  if (replay.active || modalOpen) {
    setControl(world, player, control, false);
    return;
  }
  if (world.phase !== "active") {
    setControl(world, player, control, false);
    return;
  }
  setControl(world, player, control, pressed);
  updateControlButtons();
}

function updateControlButtons() {
  document.querySelectorAll(".hold-key").forEach((button) => {
    const player = button.dataset.player;
    const control = button.dataset.control;
    button.classList.toggle(
      "active",
      !!world.controls[player]?.[control] && !replay.active,
    );
  });
}

function releaseAllControls() {
  for (const player of ["p1", "p2"]) {
    for (const control of Object.keys(world.controls[player])) {
      setControl(world, player, control, false);
    }
  }
  pressedControls.clear();
  updateControlButtons();
}

function replayView(frame) {
  const state = frame.state;
  const points = Array.isArray(state.points)
    ? state.points
    : RESCUE_POINTS.map(() => "waiting");
  return {
    ...state,
    t: frame.t,
    controls: frame.inputs,
    leftLength: state.leftCable,
    rightLength: state.rightCable,
    target: RESCUE_POINTS[state.targetIndex] || null,
    totalPoints: RESCUE_POINTS.length,
    frameHash: frame.hash,
    points,
  };
}

function currentView() {
  if (replay.active && replay.frames[replay.index]) {
    return replayView(replay.frames[replay.index]);
  }
  return {
    ...getMissionView(world),
    t: world.timeMs,
    frameHash: world.finalHash,
  };
}

function collectReplayEvents() {
  const frames = replay.frames.slice(0, replay.index + 1);
  const seen = new Set();
  const events = [];
  for (const frame of frames) {
    for (const event of frame.events || []) {
      const key = event.seq ?? `${event.type}-${event.t}-${event.player}-${event.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  return events;
}

function currentEventFeed() {
  return replay.active ? collectReplayEvents() : world.events.slice();
}

function statusTitle(view) {
  if (view.phase === "protected") return "断索保护锁定";
  if (view.phase === "failed") return "吊篮结构失效";
  if (view.phase === "complete") return "三处救援完成";
  if (view.carrying) return "载伤员返航";
  if (view.status === "grabbing") return "双人抓取中";
  if (view.status === "traversing") return "吊篮横移中";
  return "等待双人协作";
}

function stateLabel(view) {
  if (view.phase === "protected") return "FAIL-SAFE";
  if (view.phase === "failed") return "FAILED";
  if (view.phase === "complete") return "COMPLETE";
  if (view.carrying) return "RETURN";
  if (view.status === "grabbing") return "CAPTURE";
  if (view.status === "traversing") return "TRAVERSE";
  return "READY";
}

function winchLabel(state) {
  if (state === "severed") return "OPEN";
  if (state === "brake") return "BRAKE";
  return "LIVE";
}

function eventLabel(event) {
  if (event.type === "INPUT") {
    return `${event.player === "p1" ? "P1" : "P2"} ${event.label}`;
  }
  if (event.type === "COLLISION") {
    return `${event.reason === "cliff" ? "崖壁撞击" : "收绳超速"} · ` +
      `${event.side === "left" ? "左索" : "右索"}`;
  }
  if (event.type === "GRAB") return `完成抓取 · ${event.object}`;
  if (event.type === "RESCUE_COMPLETE") return `移交伤员 · ${event.rescued}/3`;
  if (event.type === "MISSION_COMPLETE") return "任务完成 · 三人获救";
  if (event.type === "MISSION_FAILED") return "任务失败 · 结构失效";
  if (event.type === "SIDE_DISCONNECT") {
    return `${event.side === "left" ? "左" : "右"}索断开 · 保护启动`;
  }
  if (event.type === "PROTECTION_RESET") return "保护复位";
  return event.type;
}

function eventClass(event) {
  if (event.type === "COLLISION" || event.type === "MISSION_FAILED") return "collision";
  if (event.type === "SIDE_DISCONNECT") return "collision";
  if (["GRAB", "RESCUE_COMPLETE", "MISSION_COMPLETE", "PROTECTION_RESET"].includes(event.type)) {
    return "milestone";
  }
  if (event.type === "INPUT") return event.player;
  return "";
}

function makeEventRow(event) {
  const row = document.createElement("li");
  row.className = `event-row ${eventClass(event)}`;
  const time = document.createElement("time");
  time.textContent = formatExactTime(event.t);
  const dot = document.createElement("i");
  const label = document.createElement("span");
  label.textContent = eventLabel(event);
  row.append(time, dot, label);
  return row;
}

function makeConflictCard(event) {
  const card = document.createElement("article");
  card.className = "conflict-card";
  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = `${event.reason === "cliff" ? "崖壁撞击" : "右索超速"} · 动作冲突`;
  const time = document.createElement("time");
  time.textContent = formatExactTime(event.t);
  header.append(title, time);

  const order = document.createElement("p");
  order.textContent = event.orderText || "双人动作叠加";
  const position = document.createElement("p");
  const x = event.position?.x ?? event.x;
  const y = event.position?.y ?? event.y;
  const left = event.position?.leftCable ?? event.leftLength;
  const right = event.position?.rightCable ?? event.rightLength;
  position.innerHTML = `吊篮 <b>(${Number(x).toFixed(1)}, ${Number(y).toFixed(1)})</b>` +
    ` · 左索 <b>${Number(left).toFixed(1)}px</b>` +
    ` · 右索 <b>${Number(right).toFixed(1)}px</b>`;
  card.append(header, order, position);
  return card;
}

let lastEventSignature = "";
let lastConflictSignature = "";

function updateEventFeed(view) {
  const events = currentEventFeed();
  const signature = `${events.length}:${events.at(-1)?.seq || ""}:${replay.active}:${replay.index}`;
  if (signature !== lastEventSignature) {
    lastEventSignature = signature;
    const recent = events.slice(-6).reverse();
    refs.eventList.replaceChildren();
    if (recent.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty-event";
      empty.textContent = "系统待命，操作将记录在同一时间线。";
      refs.eventList.append(empty);
    } else {
      recent.forEach((event) => refs.eventList.append(makeEventRow(event)));
    }
  }

  const conflicts = events.filter(
    (event) => event.type === "COLLISION" && event.conflict,
  );
  const conflictSignature = `${conflicts.length}:${conflicts.at(-1)?.seq || ""}:${replay.index}`;
  if (conflictSignature !== lastConflictSignature) {
    lastConflictSignature = conflictSignature;
    refs.conflictList.replaceChildren();
    if (conflicts.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-event";
      empty.textContent = "若双人动作顺序叠加导致危险，将标出精确时刻与吊篮位置。";
      refs.conflictList.append(empty);
    } else {
      conflicts.slice(-3).reverse().forEach((event) => {
        refs.conflictList.append(makeConflictCard(event));
      });
    }
  }
  refs.conflictCountValue.textContent = String(conflicts.length);
  refs.eventCountValue.textContent = String(events.length);
}

function updateUi(view) {
  const leftTension = Number(view.leftTension) || 0;
  const rightTension = Number(view.rightTension) || 0;
  const durability = Number(view.durability) || 0;
  const safety = Number(view.safety?.strain) || 0;

  refs.statusText.textContent = statusTitle(view);
  refs.missionClock.textContent = formatExactTime(view.t || 0);
  refs.progressValue.textContent = String(view.rescued || 0);
  refs.durabilityValue.textContent = String(Math.round(durability));
  refs.durabilityMeter.style.width = `${Math.max(0, durability)}%`;
  refs.durabilityMeter.style.background = durability < 35
    ? "var(--red)"
    : durability < 65
      ? "var(--amber)"
      : "var(--green)";

  refs.leftTensionValue.textContent = String(Math.round(leftTension));
  refs.rightTensionValue.textContent = String(Math.round(rightTension));
  refs.leftTensionMeter.style.width = `${Math.min(100, leftTension)}%`;
  refs.rightTensionMeter.style.width = `${Math.min(100, rightTension)}%`;
  refs.leftTensionMeter.style.background = leftTension > 82
    ? "linear-gradient(90deg, rgba(241,111,99,.3), var(--red))"
    : "";
  refs.rightTensionMeter.style.background = rightTension > 82
    ? "linear-gradient(90deg, rgba(241,111,99,.3), var(--red))"
    : "";
  refs.leftLengthValue.textContent = ((Number(view.leftLength) || 0) / 10).toFixed(1);
  refs.rightLengthValue.textContent = ((Number(view.rightLength) || 0) / 10).toFixed(1);
  refs.leftTempValue.textContent = String(Math.round(Number(view.leftTemperature) || 0));
  refs.rightTempValue.textContent = String(Math.round(Number(view.rightTemperature) || 0));
  refs.leftWinchState.textContent = winchLabel(view.leftWinch);
  refs.rightWinchState.textContent = winchLabel(view.rightWinch);
  refs.safetyValue.textContent = `${Math.round(safety)}%`;
  refs.safetyMeter.style.width = `${clamp(safety, 0, 100)}%`;

  if (view.phase === "protected") {
    refs.p1Hint.textContent = "总制动锁定 · 输入冻结";
    refs.p2Hint.textContent = "安全绳承载 · 保护锁定";
  } else if (view.phase === "failed" || view.phase === "complete") {
    refs.p1Hint.textContent = view.phase === "failed" ? "结构失效 · 卷扬机停机" : "任务完成 · 卷扬机停机";
    refs.p2Hint.textContent = view.phase === "failed" ? "记录已封存" : "全员安全 · 记录已封存";
  } else {
    refs.p1Hint.textContent = view.controls?.p1?.up
      ? "收绳上升中"
      : view.controls?.p1?.down
        ? "放绳下降中"
        : "W/S 调整吊篮高度";
    refs.p2Hint.textContent = view.controls?.p2?.safety
      ? "安全绳已锁紧"
      : view.controls?.p2?.left || view.controls?.p2?.right
        ? "摆臂横移中"
        : "A/D 对位 · SPACE 锁绳";
  }

  const points = view.points || [];
  refs.missionTrack.querySelectorAll(".mission-node").forEach((node, index) => {
    node.classList.remove("active", "carried", "rescued");
    node.classList.add(points[index] || "waiting");
  });

  const target = RESCUE_POINTS[view.targetIndex];
  refs.targetLabel.textContent = target && !view.carrying
    ? `${target.name} · ${target.y}m`
    : view.carrying
      ? "返航 · 左侧平台"
      : view.phase === "complete"
        ? "任务完成"
        : "待命";
  const windSpeed = Math.round((Number(view.wind?.pressure) || 0) * 46);
  refs.windValue.textContent = String(windSpeed);
  refs.windArrow.textContent = view.wind?.direction < 0 ? "←" : "→";
  refs.windArrow.style.transform = `scaleX(${0.75 + (Number(view.wind?.pressure) || 0) * 0.5})`;
  refs.noticeText.textContent = view.notice || "";

  const capture = clamp(Number(view.captureProgress) || 0, 0, 1);
  refs.captureHud.classList.toggle("visible", capture > 0.015);
  refs.captureValue.textContent = `${Math.round(capture * 100)}%`;
  refs.sharedStateLabel.textContent = stateLabel(view);
  refs.frameCounter.textContent = replay.active
    ? String(replay.index + 1)
    : String(world.timeline.length);

  const protection = view.protection;
  refs.protectionBanner.hidden = !protection;
  if (protection) {
    refs.protectionTitle.textContent =
      `${protection.side === "left" ? "左侧" : "右侧"}断索 · 全制动保护生效`;
    refs.protectionDetail.textContent =
      `断索侧张力 0 kN · 剩留侧 ${Math.round(protection.survivingTension)} kN · ` +
      `安全绳负载转移 · 吊篮锁止`;
  }

  refs.stage.classList.toggle("failed", view.phase === "failed");
  refs.stage.classList.toggle("complete", view.phase === "complete");
  refs.restartMission.hidden = !["failed", "complete"].includes(view.phase) || replay.active;
  refs.finalHashValue.textContent = view.frameHash || world.finalHash || "—";
  updateEventFeed(view);
  updateControlButtons();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function updateReplayProof(outcome = "idle") {
  replay.lastProof = outcome;
  if (!replay.active) {
    refs.replayProof.textContent = "等待回放";
    refs.replayProof.className = "replay-proof";
    return;
  }
  if (outcome === "match") {
    refs.replayProof.textContent = "终态一致 ✓";
    refs.replayProof.className = "replay-proof match";
    return;
  }
  if (outcome === "mismatch") {
    refs.replayProof.textContent = "终态不一致";
    refs.replayProof.className = "replay-proof mismatch";
    return;
  }
  if (outcome === "running") {
    refs.replayProof.textContent = "只读播放中";
  } else {
    refs.replayProof.textContent = "只读 · 暂停";
  }
  refs.replayProof.className = "replay-proof";
}

function syncReplayUi(view) {
  refs.replayToggle.disabled = replay.frames.length === 0;
  refs.replayStep.disabled = replay.frames.length === 0 || replay.index >= replay.frames.length - 1;
  refs.replayScrubber.disabled = replay.frames.length < 2;
  refs.replayScrubber.max = String(Math.max(0, replay.frames.length - 1));
  refs.replayScrubber.value = String(replay.index);
  refs.replayTime.textContent = formatExactTime(view?.t || 0);
  refs.replayDuration.textContent = formatExactTime(
    replay.frames.at(-1)?.t || world.timeline.at(-1)?.t || 0,
  );
  refs.replayIcon.textContent = replay.playing ? "❚❚" : "▶";
  refs.replayLabel.textContent = replay.playing ? "暂停" : "播放";
  refs.loadReplay.textContent = replay.active ? "退出回放" : "载入本局回放";
  refs.loadDemoReplay.disabled = !demoRecording || replay.active;
  refs.disconnectTest.disabled = replay.active;
  refs.recordLight.className = replay.active
    ? "record-light replay"
    : "record-light";
}

function enterReplay(autoPlay = true, forceDemo = false) {
  let frames = !forceDemo && world.timeline.length >= 2
    ? world.timeline.slice()
    : null;
  let expectedHash = world.finalHash;
  let source = "live";
  if ((forceDemo || !frames) && demoRecording?.timeline?.length >= 2) {
    frames = demoRecording.timeline;
    expectedHash = demoRecording.finalHash;
    source = "demo";
  }
  if (!frames || frames.length < 2) {
    refs.noticeText.textContent = demoRecording
      ? "回放数据尚未载入，请稍后重试"
      : "至少完成一次操作后才能载入回放";
    return false;
  }
  releaseAllControls();
  replay.active = true;
  replay.playing = autoPlay;
  replay.index = 0;
  replay.cursor = 0;
  replay.speed = Number(refs.replaySpeed.value) || 1;
  replay.frames = frames;
  replay.expectedHash = expectedHash;
  replay.source = source;
  replay.lastProof = "只读播放中";
  refs.replayScrubber.value = "0";
  updateReplayProof(autoPlay ? "running" : "idle");
  syncReplayUi(replayView(replay.frames[0]));
  updateEventFeed(replayView(replay.frames[0]));
  if (source === "demo") {
    refs.noticeText.textContent = "范例回放 · 完整成功救援 · 只读时间线";
  }
  return true;
}

function exitReplay() {
  replay.active = false;
  replay.playing = false;
  replay.frames = [];
  replay.index = 0;
  replay.cursor = 0;
  replay.source = "live";
  updateReplayProof();
  syncReplayUi(getMissionView(world));
  lastEventSignature = "";
  lastConflictSignature = "";
  updateUi(currentView());
}

function finishReplay() {
  const lastFrame = replay.frames.at(-1);
  const matches = !!lastFrame && lastFrame.hash === replay.expectedHash;
  replay.playing = false;
  replay.lastProof = matches ? "match" : "mismatch";
  updateReplayProof(matches ? "match" : "mismatch");
  syncReplayUi(replayView(lastFrame));
}

function updateReplay(dt) {
  if (!replay.active) return;
  if (replay.playing && replay.frames.length > 1) {
    replay.cursor += dt * 20 * replay.speed;
    if (replay.cursor >= replay.frames.length - 1) {
      replay.cursor = replay.frames.length - 1;
      replay.index = replay.frames.length - 1;
      finishReplay();
    } else {
      replay.index = Math.floor(replay.cursor);
    }
    refs.replayScrubber.value = String(replay.index);
  }
  syncReplayUi(replayView(replay.frames[replay.index]));
}

function stepReplay() {
  if (!replay.active) {
    if (!enterReplay(false)) return;
  }
  if (replay.index < replay.frames.length - 1) {
    replay.index += 1;
    replay.cursor = replay.index;
    replay.playing = false;
    updateReplayProof("idle");
  }
  syncReplayUi(replayView(replay.frames[replay.index]));
}

function toggleReplayPlayback() {
  if (!replay.active) {
    enterReplay(true);
    return;
  }
  if (replay.index >= replay.frames.length - 1) {
    replay.index = 0;
    replay.cursor = 0;
    replay.playing = true;
    updateReplayProof("running");
  } else {
    replay.playing = !replay.playing;
    updateReplayProof(replay.playing ? "running" : "idle");
  }
  syncReplayUi(replayView(replay.frames[replay.index]));
}

function scrubReplay() {
  if (!replay.active) enterReplay(false);
  replay.playing = false;
  replay.index = clamp(Number(refs.replayScrubber.value) || 0, 0, replay.frames.length - 1);
  replay.cursor = replay.index;
  updateReplayProof("idle");
  syncReplayUi(replayView(replay.frames[replay.index]));
}

async function toggleAudio() {
  try {
    if (audio.enabled) {
      await audio.disable();
      refs.audioToggle.setAttribute("aria-pressed", "false");
      refs.audioLabel.textContent = "启用双声部";
    } else {
      await audio.enable();
      refs.audioToggle.setAttribute("aria-pressed", "true");
      refs.audioLabel.textContent = "双声部已启用";
    }
  } catch (error) {
    refs.audioLabel.textContent = "音频不可用";
    console.warn("Web Audio 启动失败", error);
  }
}

let audioGestureConsumed = false;
async function ensureAudioFromGesture() {
  if (audioGestureConsumed || audio.enabled) return;
  audioGestureConsumed = true;
  try {
    await audio.enable();
    refs.audioToggle.setAttribute("aria-pressed", "true");
    refs.audioLabel.textContent = "双声部已启用";
  } catch {
    // Browsers may require a second explicit gesture; the toggle remains available.
  }
}

function consumeNewEvents() {
  if (world.events.length <= previousEventCount) return;
  const fresh = world.events.slice(previousEventCount);
  previousEventCount = world.events.length;
  let saveNow = false;
  for (const event of fresh) {
    if (event.type === "COLLISION") {
      audio.impact(clamp((event.severity || 200) / 260, 0.5, 1.6));
      saveNow = true;
    }
    if (["MISSION_COMPLETE", "MISSION_FAILED", "SIDE_DISCONNECT"].includes(event.type)) {
      saveNow = true;
    }
  }
  if (saveNow) saveGame(true);
}

function toggleHelp(force) {
  const show = typeof force === "boolean" ? force : refs.helpModal.hidden;
  refs.helpModal.hidden = !show;
  modalOpen = show;
  if (show) {
    releaseAllControls();
    refs.helpClose.focus();
  } else {
    refs.helpButton.focus();
  }
}

function restartMission() {
  exitReplay();
  world = createWorld(world.seed + 1);
  previousEventCount = 0;
  simulationAccumulator = 0;
  lastEventSignature = "";
  lastConflictSignature = "";
  saveGame(true);
  updateUi(currentView());
}

function exportTimeline() {
  captureCheckpoint(world);
  const payload = {
    exportedAt: new Date().toISOString(),
    title: "双索山崖绞车统一时间线",
    finalHash: world.finalHash,
    world: serializeWorld(world),
    timeline: world.timeline,
    events: world.events,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `twin-cable-timeline-${Date.now()}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  refs.noticeText.textContent = "统一时间线已导出";
}

const KEY_BINDINGS = {
  KeyW: ["p1", "up"],
  KeyS: ["p1", "down"],
  KeyA: ["p2", "left"],
  KeyD: ["p2", "right"],
  Space: ["p2", "safety"],
};

document.addEventListener("keydown", (event) => {
  if (event.code === "Escape" && !refs.helpModal.hidden) {
    event.preventDefault();
    toggleHelp(false);
    return;
  }
  if (event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement ||
    event.target instanceof HTMLTextAreaElement) {
    return;
  }
  if (modalOpen) return;
  if (event.code === "KeyR" && ["failed", "complete"].includes(world.phase)) {
    event.preventDefault();
    restartMission();
    return;
  }
  const binding = KEY_BINDINGS[event.code];
  if (!binding) return;
  event.preventDefault();
  if (event.repeat) return;
  ensureAudioFromGesture();
  setPressed(binding[0], binding[1], true);
});

document.addEventListener("keyup", (event) => {
  const binding = KEY_BINDINGS[event.code];
  if (!binding) return;
  event.preventDefault();
  setPressed(binding[0], binding[1], false);
});

document.querySelectorAll(".hold-key").forEach((button) => {
  const release = () => {
    setPressed(button.dataset.player, button.dataset.control, false);
  };
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    ensureAudioFromGesture();
    button.setPointerCapture?.(event.pointerId);
    setPressed(button.dataset.player, button.dataset.control, true);
  });
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("lostpointercapture", release);
  button.addEventListener("contextmenu", (event) => event.preventDefault());
});

refs.audioToggle.addEventListener("click", toggleAudio);
refs.helpButton.addEventListener("click", () => toggleHelp(true));
refs.helpClose.addEventListener("click", () => toggleHelp(false));
refs.helpModal.addEventListener("click", (event) => {
  if (event.target === refs.helpModal) toggleHelp(false);
});
refs.disconnectTest.addEventListener("click", () => {
  if (world.phase !== "active" || replay.active) return;
  triggerSideDisconnect(world, "right");
  consumeNewEvents();
  saveGame(true);
  updateUi(currentView());
});
refs.releaseProtection.addEventListener("click", () => {
  if (releaseProtection(world)) {
    consumeNewEvents();
    saveGame(true);
    updateUi(currentView());
  }
});
refs.loadReplay.addEventListener("click", () => {
  if (replay.active) exitReplay();
  else enterReplay(true);
});
refs.loadDemoReplay.addEventListener("click", () => {
  if (replay.active) exitReplay();
  else enterReplay(true, true);
});
refs.replayToggle.addEventListener("click", toggleReplayPlayback);
refs.replayStep.addEventListener("click", stepReplay);
refs.replaySpeed.addEventListener("change", () => {
  replay.speed = Number(refs.replaySpeed.value) || 1;
});
refs.replayScrubber.addEventListener("input", scrubReplay);
refs.restartMission.addEventListener("click", restartMission);
refs.exportReplay.addEventListener("click", exportTimeline);

window.addEventListener("blur", releaseAllControls);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    releaseAllControls();
    saveGame(true);
  } else {
    lastFrameTime = performance.now();
  }
});
window.addEventListener("beforeunload", () => saveGame(true));

function animationFrame(now) {
  const deltaSeconds = clamp((now - lastFrameTime) / 1000, 0, 0.08);
  lastFrameTime = now;

  if (replay.active) {
    updateReplay(deltaSeconds);
  } else if (world.phase === "active") {
    simulationAccumulator += deltaSeconds * 1000;
    let steps = 0;
    while (simulationAccumulator >= FIXED_STEP_MS && steps < 8) {
      stepWorld(world, FIXED_STEP);
      simulationAccumulator -= FIXED_STEP_MS;
      steps += 1;
    }
    if (steps > 0) {
      consumeNewEvents();
      saveGame();
    }
  } else {
    simulationAccumulator = 0;
  }

  const view = currentView();
  renderer.draw(view, now / 1000, replay.active ? "replay" : "live");
  updateUi(view);
  audio.update(view);
  requestAnimationFrame(animationFrame);
}

window.__WINCH_GAME__ = {
  getView: () => currentView(),
  getWorld: () => world,
  getTimeline: () => world.timeline,
  getEvents: () => world.events,
  getLiveFinalHash: () => world.finalHash,
  getReplayAudit: () => ({
    active: replay.active,
    playing: replay.playing,
    speed: replay.speed,
    index: replay.index,
    frameCount: replay.frames.length,
    expectedHash: replay.expectedHash,
    viewedHash: replay.frames.at(-1)?.hash || null,
    proof: replay.lastProof,
  }),
  getAudioState: () => ({
    enabled: audio.enabled,
    contextState: audio.context?.state || "closed",
    leftFrequency: audio.left?.oscillator.frequency.value || null,
    rightFrequency: audio.right?.oscillator.frequency.value || null,
    voices: audio.left && audio.right ? 2 : 0,
  }),
  setControl: (player, control, pressed) => {
    setPressed(player, control, pressed);
  },
  disconnect: (side = "right") => triggerSideDisconnect(world, side),
  releaseProtection: () => releaseProtection(world),
  enterReplay: (play = true, demo = false) => enterReplay(play, demo),
  exitReplay: () => exitReplay(),
  restart: () => restartMission(),
};

fetch("./assets/demo-replay.json")
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then((payload) => {
    if (Array.isArray(payload.timeline) && payload.timeline.length > 1) {
      demoRecording = payload;
      syncReplayUi(currentView());
    }
  })
  .catch((error) => {
    console.warn("范例回放不可用", error);
  });

refs.saveState.textContent = restoredFromSave ? "已恢复" : "就绪";
document.body.dataset.restored = restoredFromSave ? "true" : "false";
document.body.dataset.ready = "true";
refs.replaySpeed.value = "1";
updateUi(currentView());
updateReplayProof();
syncReplayUi(getMissionView(world));
if (restoredFromSave) {
  refs.noticeText.textContent = world.phase === "protected"
    ? "存档已恢复 · 断索保护仍锁定"
    : `存档已恢复 · 耐久 ${Math.round(world.durability)}% · 已救出 ${world.rescued}/3`;
}
requestAnimationFrame(animationFrame);
