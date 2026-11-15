import {
  STAGE_LABELS,
  TICK_SECONDS,
  createInitialState,
  getSystemsSafe,
  stepSimulation
} from "./simulation.js";
import {
  ReplayController,
  createTimeline,
  frameFromState,
  inspectOrderConflict,
  recordConflict,
  recordFrame,
  recordInput
} from "./timeline.js";
import { createFailureDemo, createSuccessDemo } from "./demo.js";
import { clearStorage, loadFromStorage, saveToStorage } from "./persistence.js";
import { FlightRenderer } from "./renderer.js";
import { FlightAudio } from "./audio.js";

const $ = (selector) => document.querySelector(selector);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pad = (value) => String(value).padStart(2, "0");
const formatTime = (seconds) => `${pad(Math.floor(seconds / 60))}:${pad(Math.floor(seconds % 60))}.${Math.floor((seconds % 1) * 10)}`;

const restored = loadFromStorage(window.localStorage);
let state = restored?.state || createInitialState();
let timeline = restored?.timeline || createTimeline(state);
let mode = state.mode === "debug" ? "debug" : "duo";
state.mode = mode;

const demos = {
  success: createSuccessDemo(),
  failure: createFailureDemo()
};
const renderer = new FlightRenderer($("#flight-canvas"));
const audio = new FlightAudio();
const heldActions = new Set();
const pendingOrderSources = [];
let tickChangedSides = new Set();
let inputSequence = timeline.inputs?.length || 0;
let lastFrameTick = -1;
let lastDomUpdate = 0;
let lastSaveAt = 0;
let accumulator = 0;
let replay = null;
let replayTimeline = null;
let replayLabel = "LIVE";
let highlightedConflict = null;
let lastAlertText = "";
let lastConflictRecordedAt = -10;
let saveTimer = null;

const elements = {
  stage: $("#mission-stage"),
  time: $("#mission-time"),
  safety: $("#system-safety"),
  alertStrip: $("#shared-alert-strip"),
  alertText: $("#shared-alert-text"),
  debugBadge: $("#debug-badge"),
  modeButton: $("#mode-button"),
  audioButton: $("#audio-button"),
  saveButton: $("#save-button"),
  resetButton: $("#reset-button"),
  leftRpm: $("#left-rpm"),
  leftRpmBar: $("#left-rpm-bar"),
  leftFuel: $("#left-fuel"),
  leftFuelBar: $("#left-fuel-bar"),
  leftThrust: $("#left-thrust"),
  leftEgt: $("#left-egt"),
  leftDurability: $("#left-durability"),
  leftStatus: $("#left-status-label"),
  leftThrottle: $("#left-throttle"),
  leftThrottleOutput: $("#left-throttle-output"),
  leftFuelPump: $("#left-fuel-pump"),
  leftPumpOutput: $("#left-pump-output"),
  rightPressure: $("#right-pressure"),
  rightPressureBar: $("#right-pressure-bar"),
  rightGear: $("#right-gear"),
  rightGearDetail: $("#right-gear-detail"),
  rightGearBar: $("#right-gear-bar"),
  rightPump: $("#right-pump"),
  rightTemp: $("#right-temp"),
  rightDurability: $("#right-durability"),
  rightStatus: $("#right-status-label"),
  rightHydraulic: $("#right-hydraulic"),
  rightHydraulicOutput: $("#right-hydraulic-output"),
  gearToggle: $("#gear-toggle"),
  gearHandleLabel: $("#gear-handle-label"),
  attitude: $("#attitude-value"),
  altitude: $("#altitude-value"),
  speed: $("#speed-value"),
  progress: $("#progress-label"),
  progressFill: $("#progress-fill"),
  director: $("#director-hint"),
  missionResult: $("#mission-result"),
  resultEyebrow: $("#result-eyebrow"),
  resultTitle: $("#result-title"),
  resultCopy: $("#result-copy"),
  replayBadge: $("#replay-frame-badge"),
  conflictOverlay: $("#conflict-overlay"),
  replayHash: $("#replay-hash"),
  replayIntegrity: $("#replay-integrity-label"),
  replayTime: $("#replay-time"),
  replayScrub: $("#replay-scrub"),
  replayPlay: $("#replay-play"),
  exitReplay: $("#exit-replay"),
  conflictCount: $("#conflict-count"),
  conflictCard: $("#conflict-card"),
  collisionCard: $("#collision-card"),
  eventList: $("#event-list"),
  timelineCount: $("#timeline-count"),
  stageStep: $("#stage-step"),
  checkTakeoff: $("#check-takeoff"),
  checkGear: $("#check-gear"),
  checkPattern: $("#check-pattern"),
  checkLanding: $("#check-landing"),
  modeHelp: $("#mode-help")
};

function currentFrame() {
  return replay ? replay.frame : frameFromState(state, currentOrder());
}

function currentOrder() {
  const first = pendingOrderSources[0];
  return first === "right" ? "right-first" : "left-first";
}

function queueSource(source) {
  if (!pendingOrderSources.includes(source)) pendingOrderSources.push(source);
  if (!tickChangedSides.has(source)) tickChangedSides.add(source);
}

function syncRange(input, value) {
  if (document.activeElement !== input) input.value = String(Math.round(value));
}

function setControl(source, action, value, { record = true } = {}) {
  if (replay) return false;
  if (state.stage === "SUCCESS" || state.stage === "FAILED") return false;
  const controls = source === "left" ? state.controls.left : state.controls.right;
  if (action === "gearLever") {
    if (controls.gearLever === value) return false;
    controls.gearLever = value;
  } else {
    const bounded = clamp(Math.round(value), 0, 100);
    if (controls[action] === bounded) return false;
    controls[action] = bounded;
  }
  queueSource(source);
  if (record) {
    recordInput(timeline, state, {
      source,
      action,
      value: controls[action],
      sequence: ++inputSequence
    });
  }
  return true;
}

function changeControl(source, action, delta) {
  if (action === "gearLever") {
    const current = source === "right" ? state.controls.right.gearLever : "DOWN";
    return setControl(source, action, current === "UP" ? "DOWN" : "UP");
  }
  const controls = source === "left" ? state.controls.left : state.controls.right;
  return setControl(source, action, (controls[action] || 0) + delta);
}

function applyHeldInputs(dt) {
  const map = mode === "debug"
    ? {
        leftUp: "KeyW",
        leftDown: "KeyS",
        fuelUp: "KeyD",
        fuelDown: "KeyA",
        hydraulicUp: "ArrowRight",
        hydraulicDown: "ArrowLeft"
      }
    : {
        leftUp: "KeyW",
        leftDown: "KeyS",
        fuelUp: "KeyE",
        fuelDown: "KeyQ",
        hydraulicUp: "ArrowUp",
        hydraulicDown: "ArrowDown"
      };
  if (heldActions.has(map.leftUp)) changeControl("left", "throttle", 46 * dt);
  if (heldActions.has(map.leftDown)) changeControl("left", "throttle", -46 * dt);
  if (heldActions.has(map.fuelUp)) changeControl("left", "fuelPump", 34 * dt);
  if (heldActions.has(map.fuelDown)) changeControl("left", "fuelPump", -34 * dt);
  if (heldActions.has(map.hydraulicUp)) changeControl("right", "hydraulic", 42 * dt);
  if (heldActions.has(map.hydraulicDown)) changeControl("right", "hydraulic", -42 * dt);
}

function resolveKey(code) {
  if (mode === "debug") {
    if (code === "Space") return { type: "gear" };
    if (["KeyW", "KeyS", "KeyA", "KeyD", "ArrowLeft", "ArrowRight"].includes(code)) {
      return { type: "hold", code };
    }
    return null;
  }
  if (code === "KeyG") return { type: "gear" };
  if (["KeyW", "KeyS", "KeyQ", "KeyE", "ArrowUp", "ArrowDown"].includes(code)) {
    return { type: "hold", code };
  }
  return null;
}

function systemsSafeFrame(frame) {
  return (
    frame.left.damage < 75 &&
    frame.right.damage < 75 &&
    frame.shared.hull > 35 &&
    frame.left.fuel > 1
  );
}

function gearText(frame) {
  if (frame.right.gearPosition > 0.96) return { main: "DOWN", detail: "锁定" };
  if (frame.right.gearPosition < 0.04) return { main: "UP", detail: "锁定" };
  return {
    main: "MOVE",
    detail: frame.right.gearPosition > 0.5 ? "收起中" : "放下中"
  };
}

function directorHint(frame) {
  if (frame.stage === "PREFLIGHT") return "P1 将推力推到 65% 以上，开始起飞滑跑。";
  if (frame.stage === "TAKEOFF") return `滑跑中 ${frame.speed.toFixed(0)} / 64 m/s，保持推力与液压。`;
  if (frame.stage === "AIRBORNE") {
    if (frame.altitude < 58) return "继续爬升；高度超过 55 m 后 P2 再收起落架。";
    if (frame.right.gearLever !== "UP") return "已达安全高度：P2 现在收起落架。";
    return "起落架收起中，等待绕飞检查阶段。";
  }
  if (frame.stage === "PATTERN") {
    return `绕飞保持 10 秒，剩余 ${Math.max(0, 10 - frame.mission.orbitSeconds).toFixed(1)} 秒。`;
  }
  if (frame.stage === "APPROACH") {
    if (frame.right.gearPosition < 0.96) return "P2 放起落架；P1 将推力降至 35%–45%。";
    return "着陆构型已建立，保持轻推力，等待接地。";
  }
  if (frame.stage === "SUCCESS") return "两套系统安全，完整任务闭环已完成。";
  return "任务终止：检查碰撞记录与时间线诊断。";
}

function eventPresentation(event) {
  if (event.type === "input") {
    const sourceName = event.source === "left" ? "L" : "R";
    const actionNames = {
      throttle: "THR",
      fuelPump: "FUEL",
      hydraulic: "HYD",
      gearLever: "GEAR"
    };
    return {
      source: sourceName,
      label: actionNames[event.action] || event.action,
      text: `${event.action} → ${event.value}`,
      className: event.source
    };
  }
  if (event.type === "collision") {
    return {
      source: "碰撞",
      label: "CRASH",
      text: `${event.object} · ${event.reason} · ${event.x}, ${event.y}`,
      className: "collision"
    };
  }
  if (event.type === "conflict") {
    return {
      source: "顺序",
      label: "ORDER",
      text: `T+${event.t.toFixed(2)}s · X ${event.position.x} / ALT ${event.position.altitude}`,
      className: "conflict"
    };
  }
  if (event.type === "stage") {
    return {
      source: "阶段",
      label: "STAGE",
      text: event.stageLabel || event.stage,
      className: ""
    };
  }
  if (event.type === "mode") {
    return {
      source: "模式",
      label: "MODE",
      text: event.mode === "debug" ? "单人调试" : "双人协作",
      className: ""
    };
  }
  return { source: "--", label: event.type, text: event.text || "", className: "" };
}

function renderConflictCard(activeTimeline, frame) {
  const conflicts = activeTimeline?.conflicts || [];
  const conflict = highlightedConflict || conflicts[conflicts.length - 1];
  elements.conflictCount.textContent = `${conflicts.length} 冲突`;
  if (!conflict) {
    elements.conflictCard.className = "conflict-card";
    elements.conflictCard.innerHTML =
      "<strong>尚未发现顺序敏感动作</strong><p>同一 tick 的左右输入会做 L→R / R→L 双序比较。</p>";
    return;
  }
  elements.conflictCard.className = "conflict-card has-conflict";
  const actualOrder = conflict.actualOrder === "right-first" ? "R→L" : "L→R";
  const alternateOrder = conflict.alternateOrder === "right-first" ? "R→L" : "L→R";
  const objects = conflict.objects
    .map((object) => `${object.label} X ${object.x.toFixed(2)} / Y ${object.y.toFixed(2)}`)
    .join(" · ");
  const delta = conflict.delta || {};
  elements.conflictCard.innerHTML = `
    <strong>顺序冲突 T+${conflict.t.toFixed(2)}s</strong>
    <span class="coordinate-line">动作顺序 ${actualOrder} ⇄ ${alternateOrder}</span>
    <span class="coordinate-line">对象位置 ${objects}</span>
    <span class="coordinate-line">动作位置 X ${conflict.position.x.toFixed(2)} / ALT ${conflict.position.altitude.toFixed(2)} · ΔRPM ${(delta.rpm || 0).toFixed(2)}</span>
    <button type="button" class="coordinates-button" data-seek-tick="${conflict.tick}">定位冲突</button>
  `;
}

function renderCollisionCard(activeTimeline, frame) {
  const collisions = activeTimeline?.collisions || [];
  const collision = collisions[collisions.length - 1] || frame?.collision;
  if (!collision) {
    elements.collisionCard.className = "collision-card";
    elements.collisionCard.innerHTML = "<strong>碰撞结果</strong><p>尚无碰撞。</p>";
    return;
  }
  elements.collisionCard.className = "collision-card has-collision";
  elements.collisionCard.innerHTML = `
    <strong>碰撞 T+${Number(collision.t || collision.time).toFixed(2)}s · ${collision.object}</strong>
    <span class="coordinate-line">${collision.reason} · 损伤 ${collision.damage}%</span>
    <span class="coordinate-line">对象位置 X ${Number(collision.x).toFixed(2)} / Y ${Number(collision.y).toFixed(2)}</span>
  `;
}

function renderEvents(activeTimeline) {
  const events = activeTimeline?.events || [];
  elements.timelineCount.textContent = `${events.length} events`;
  if (events.length === 0) {
    elements.eventList.innerHTML = '<li class="event-empty">等待左右两侧输入…</li>';
    return;
  }
  elements.eventList.innerHTML = events
    .slice(-14)
    .reverse()
    .map((event) => {
      const row = eventPresentation(event);
      return `<li class="${row.className}"><time>T+${Number(event.t || 0).toFixed(2)}</time><b>${row.label}</b><span>${row.text}</span></li>`;
    })
    .join("");
}

function updateChecklist(frame) {
  const mission = frame.mission || {};
  const checks = [
    [elements.checkTakeoff, mission.takeoff],
    [elements.checkGear, mission.gearRetracted],
    [elements.checkPattern, mission.orbitSeconds >= 10],
    [elements.checkLanding, mission.landed]
  ];
  let activeAssigned = false;
  for (const [element, done] of checks) {
    element.classList.toggle("done", Boolean(done));
    element.classList.remove("active");
    if (!done && !activeAssigned) {
      element.classList.add("active");
      activeAssigned = true;
    }
  }
  const step = checks.filter(([, done]) => done).length + 1;
  elements.stageStep.textContent = `STEP ${pad(Math.min(step, 4))}`;
}

function updateReplayControls() {
  const active = Boolean(replay);
  elements.replayBadge.hidden = !active;
  elements.exitReplay.hidden = !active;
  elements.replayPlay.textContent = replay?.playing ? "❚❚" : "▶";
  elements.replayPlay.setAttribute("aria-label", replay?.playing ? "暂停回放" : "播放回放");
  if (replay) {
    elements.replayTime.textContent = `T+${replay.frame.t.toFixed(2)}`;
    elements.replayScrub.value = String(Math.round(replay.progress * 1000));
    elements.replayHash.textContent = replay.finalHash;
    elements.replayIntegrity.textContent = replay.verifyFinalUnchanged() ? "READ-ONLY ✓" : "CHECK FAILED";
  } else {
    elements.replayTime.textContent = "LIVE";
    elements.replayScrub.value = "0";
    elements.replayHash.textContent = "LIVE";
    elements.replayIntegrity.textContent = "只读校验";
  }
  for (const button of document.querySelectorAll("[data-speed]")) {
    button.classList.toggle("active", Number(button.dataset.speed) === (replay?.speed || 1));
  }
}

function updateConflictOverlay(frame, activeTimeline) {
  const conflicts = activeTimeline?.conflicts || [];
  const conflict =
    (highlightedConflict &&
    frame.t >= highlightedConflict.t - 0.05 &&
    frame.t <= highlightedConflict.t + 3.2
      ? highlightedConflict
      : null) ||
    conflicts.find((item) => frame.t >= item.t - 0.05 && frame.t <= item.t + 3.2);
  if (!conflict || frame.t < conflict.t - 0.05) {
    elements.conflictOverlay.hidden = true;
    return;
  }
  elements.conflictOverlay.hidden = false;
  const objects = conflict.objects
    .map((object) => `${object.label} <code>(${object.x.toFixed(2)}, ${object.y.toFixed(2)})</code>`)
    .join("<br />");
  elements.conflictOverlay.innerHTML = `
    <strong>ORDER CONFLICT · T+${conflict.t.toFixed(2)}s</strong>
    动作顺序 <code>${conflict.actualOrder === "right-first" ? "R→L" : "L→R"} ⇄ ${conflict.alternateOrder === "right-first" ? "R→L" : "L→R"}</code><br />
    动作位置 <code>X ${conflict.position.x.toFixed(2)} / ALT ${conflict.position.altitude.toFixed(2)}</code><br />
    ${objects}
  `;
}

function updateMissionResult(frame) {
  const finished = frame.stage === "SUCCESS" || frame.stage === "FAILED";
  const replayFinished = replay && replay.cursor >= replay.frames.length - 1 && finished;
  if ((!replay && !finished) || (replay && !replayFinished)) {
    elements.missionResult.hidden = true;
    return;
  }
  elements.missionResult.hidden = false;
  const failed = frame.stage === "FAILED";
  elements.missionResult.classList.toggle("failed", failed);
  elements.resultEyebrow.textContent = failed
    ? "MISSION FAILED"
    : replay
      ? "REPLAY COMPLETE / MISSION COMPLETE"
      : "MISSION COMPLETE";
  elements.resultTitle.textContent = failed ? "任务失败" : replay ? "回放完成 · 安全降落" : "安全降落";
  elements.resultCopy.textContent = failed
    ? frame.mission.failureReason || "系统安全阈值失守。"
    : `用时 ${formatTime(frame.t)}，机体耐久 ${frame.shared.hull.toFixed(0)}%，双系统保持安全。`;
}

function updateDom(frame, force = false) {
  const now = performance.now();
  if (!force && now - lastDomUpdate < 64) return;
  lastDomUpdate = now;
  const activeTimeline = replay ? replayTimeline : timeline;

  elements.stage.textContent = STAGE_LABELS[frame.stage] || frame.stage;
  elements.time.textContent = formatTime(frame.t);
  const safe = frame.stage === "FAILED" ? false : systemsSafeFrame(frame);
  elements.safety.textContent = frame.stage === "FAILED" ? "FAIL" : safe ? "SAFE" : "UNSAFE";
  elements.safety.className = safe ? "safe" : "unsafe";
  elements.debugBadge.hidden = mode !== "debug" || Boolean(replay);
  elements.modeButton.textContent = mode === "debug" ? "单人调试" : "双人模式";
  elements.modeButton.classList.toggle("active", mode === "debug");

  const alerts = frame.shared?.alerts || [];
  const danger = alerts.find((alert) => alert.level === "danger");
  const warning = danger || alerts.find((alert) => alert.level === "warn") || alerts.find((alert) => alert.level === "info");
  const alertMessage = warning
    ? alertMessageFor(warning)
    : frame.stage === "SUCCESS"
      ? "双侧系统安全，任务完成。"
      : frame.stage === "FAILED"
        ? "任务已终止，请查看碰撞结果。"
        : "两套系统正常，共享告警通道在线。";
  elements.alertText.textContent = alertMessage;
  elements.alertStrip.classList.toggle("danger", Boolean(danger) || frame.stage === "FAILED");
  if (alertMessage !== lastAlertText) {
    if (danger) audio.alert();
    lastAlertText = alertMessage;
  }

  elements.leftRpm.textContent = Math.round(frame.left.rpm).toString();
  elements.leftFuel.textContent = frame.left.fuel.toFixed(1);
  elements.leftThrust.textContent = frame.left.thrust.toFixed(0);
  elements.leftEgt.textContent = frame.left.temperature.toFixed(0);
  elements.leftRpmBar.style.width = `${clamp(frame.left.rpm / 3400, 0, 1) * 100}%`;
  elements.leftFuelBar.style.width = `${frame.left.fuel}%`;
  elements.leftDurability.textContent = `耐久 ${(100 - frame.left.damage).toFixed(0)}%`;
  elements.leftThrottleOutput.textContent = `${Math.round(frame.left.throttle)}%`;
  elements.leftPumpOutput.textContent = `${Math.round(frame.left.fuelPump)}%`;
  elements.leftStatus.textContent =
    frame.left.damage >= 75
      ? "左发失效"
      : frame.left.temperature > 110
        ? "左发过热"
        : frame.left.fuel < 18
          ? "燃油偏低"
          : frame.left.rpm > 100
            ? "发动机运转"
            : "发动机待机";

  elements.rightPressure.textContent = frame.right.pressure.toFixed(0);
  elements.rightPump.textContent = frame.right.pump.toFixed(0);
  elements.rightTemp.textContent = frame.right.temperature.toFixed(0);
  elements.rightPressureBar.style.width = `${clamp(frame.right.pressure, 0, 100)}%`;
  elements.rightGearBar.style.width = `${clamp(frame.right.gearPosition, 0, 1) * 100}%`;
  elements.rightDurability.textContent = `耐久 ${(100 - frame.right.damage).toFixed(0)}%`;
  elements.rightHydraulicOutput.textContent = `${Math.round(frame.right.hydraulic)}%`;
  const gear = gearText(frame);
  elements.rightGear.textContent = gear.main;
  elements.rightGearDetail.textContent = gear.detail;
  elements.gearHandleLabel.textContent = frame.right.gearLever;
  elements.gearToggle.classList.toggle(
    "unsafe",
    frame.stage === "APPROACH" && frame.right.gearPosition < 0.96
  );
  elements.rightStatus.textContent =
    frame.right.damage >= 75
      ? "液压失效"
      : frame.right.pressure > 94
        ? "液压超压"
        : frame.right.pressure < 32
          ? "压力不足"
          : frame.right.pressure > 0
            ? "液压在线"
            : "液压待机";

  syncRange(elements.leftThrottle, frame.left.throttle);
  syncRange(elements.leftFuelPump, frame.left.fuelPump);
  syncRange(elements.rightHydraulic, frame.right.hydraulic);
  elements.attitude.textContent = `${frame.pitch >= 0 ? "+" : ""}${frame.pitch.toFixed(1)}°`;
  elements.altitude.textContent = `${Math.round(frame.altitude)} m`;
  elements.speed.textContent = `${Math.round(frame.speed)} m/s`;
  elements.progress.textContent = `${Math.round(frame.progress)}%`;
  elements.progressFill.style.width = `${frame.progress}%`;
  elements.director.textContent = directorHint(frame);
  elements.modeHelp.textContent =
    mode === "debug"
      ? "单人调试：W/S 推力 · A/D 燃油泵 · ←/→ 液压 · Space 起落架。两舱输入仍写入同一时间线。"
      : "双人：P1 使用 W/S · Q/E，P2 使用 ↑/↓ · G。两侧输入会进入同一时间线。";

  updateChecklist(frame);
  updateReplayControls();
  updateConflictOverlay(frame, activeTimeline);
  updateMissionResult(frame);
  renderConflictCard(activeTimeline, frame);
  renderCollisionCard(activeTimeline, frame);
  renderEvents(activeTimeline);
}

function alertMessageFor(alert) {
  const suffix = alert.level === "danger" ? " · 立即处置" : "";
  return `${alert.text}${suffix}`;
}

function recordStageTransition(stage) {
  timeline.events.push({
    type: "stage",
    t: Number(state.time.toFixed(3)),
    tick: state.tick,
    stage,
    stageLabel: STAGE_LABELS[stage] || stage
  });
}

function stepLive() {
  if (replay || state.stage === "SUCCESS" || state.stage === "FAILED") return;
  applyHeldInputs(TICK_SECONDS);
  const order = currentOrder();
  if (tickChangedSides.size === 2 && state.time - lastConflictRecordedAt > 0.45) {
    const conflict = inspectOrderConflict(state, [...tickChangedSides]);
    if (conflict) {
      recordConflict(timeline, conflict, order);
      lastConflictRecordedAt = state.time;
    }
  }

  const previousStage = state.stage;
  const result = stepSimulation(state, TICK_SECONDS, { order, mode });
  state = result.state;
  if (state.stage !== previousStage) recordStageTransition(state.stage);
  recordFrame(timeline, state, { order, collision: result.collision });
  if (result.collision) audio.collision();
  pendingOrderSources.length = 0;
  tickChangedSides.clear();

  if (state.stage === "SUCCESS" || state.stage === "FAILED") {
    saveNow();
    updateDom(currentFrame(), true);
  }
}

function saveNow() {
  try {
    saveToStorage(window.localStorage, state, timeline, {
      replayMode: replay ? "view" : "live",
      selectedDemo: replayLabel
    });
    lastSaveAt = performance.now();
    elements.saveButton.textContent = "已保存";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      elements.saveButton.textContent = "保存";
    }, 900);
    return true;
  } catch {
    elements.saveButton.textContent = "保存失败";
    return false;
  }
}

function setMode(nextMode) {
  mode = nextMode === "debug" ? "debug" : "duo";
  state.mode = mode;
  timeline.events.push({
    type: "mode",
    t: Number(state.time.toFixed(3)),
    tick: state.tick,
    mode
  });
  heldActions.clear();
  pendingOrderSources.length = 0;
  tickChangedSides.clear();
  updateDom(currentFrame(), true);
  saveNow();
}

function resetFlight() {
  const nextMode = mode;
  state = createInitialState();
  state.mode = nextMode;
  timeline = createTimeline(state, { label: "实时任务" });
  replay = null;
  replayTimeline = null;
  replayLabel = "LIVE";
  highlightedConflict = null;
  heldActions.clear();
  pendingOrderSources.length = 0;
  tickChangedSides.clear();
  accumulator = 0;
  inputSequence = 0;
  clearStorage(window.localStorage);
  saveNow();
  updateDom(currentFrame(), true);
}

function enterReplay(sourceTimeline, label) {
  if (!sourceTimeline || sourceTimeline.frames.length < 2) {
    elements.saveButton.textContent = "无可回放帧";
    setTimeout(() => {
      elements.saveButton.textContent = "保存";
    }, 1100);
    return false;
  }
  replayTimeline = sourceTimeline;
  replay = new ReplayController(sourceTimeline.frames);
  replayLabel = label;
  highlightedConflict = sourceTimeline.conflicts[0] || null;
  heldActions.clear();
  pendingOrderSources.length = 0;
  tickChangedSides.clear();
  updateDom(currentFrame(), true);
  return true;
}

function exitReplay() {
  replay = null;
  replayTimeline = null;
  replayLabel = "LIVE";
  highlightedConflict = null;
  updateDom(currentFrame(), true);
}

function seekReplayTick(tick) {
  if (!replay) return;
  const index = replay.frames.findIndex((frame) => frame.tick >= Number(tick));
  replay.cursor = index < 0 ? replay.frames.length - 1 : index;
  replay.pause();
  updateDom(currentFrame(), true);
}

function handleKeyDown(event) {
  const action = resolveKey(event.code);
  if (!action) return;
  if (
    event.target === elements.leftThrottle ||
    event.target === elements.leftFuelPump ||
    event.target === elements.rightHydraulic ||
    event.target === elements.replayScrub
  ) {
    if (event.code.startsWith("Arrow")) return;
  }
  event.preventDefault();
  if (replay) return;
  const source =
    mode === "debug"
      ? event.code === "ArrowLeft" || event.code === "ArrowRight" || event.code === "Space"
        ? "right"
        : "left"
      : event.code === "ArrowUp" || event.code === "ArrowDown" || event.code === "KeyG"
        ? "right"
        : "left";
  if (action.type === "gear") {
    changeControl("right", "gearLever", 1);
    return;
  }
  if (!heldActions.has(event.code)) {
    queueSource(source);
    heldActions.add(event.code);
  }
}

function handleKeyUp(event) {
  if (!resolveKey(event.code)) return;
  heldActions.delete(event.code);
}

function loop(now) {
  const delta = Math.min(0.12, (now - (loop.lastTime || now)) / 1000);
  loop.lastTime = now;
  if (replay) {
    const previousTick = replay.frame.tick;
    replay.advance(delta);
    if (replay.frame.tick !== previousTick || replay.playing) updateDom(currentFrame(), true);
  } else {
    accumulator = Math.min(0.25, accumulator + delta);
    while (accumulator >= TICK_SECONDS && state.stage !== "SUCCESS" && state.stage !== "FAILED") {
      stepLive();
      accumulator -= TICK_SECONDS;
    }
    if (now - lastSaveAt > 2200 && state.stage !== "SUCCESS" && state.stage !== "FAILED") {
      saveNow();
    }
    updateDom(currentFrame());
  }

  const frame = currentFrame();
  if (frame.tick !== lastFrameTick || replay?.playing || renderer.needsRedraw) {
    lastFrameTick = frame.tick;
    const activeTimeline = replay ? replayTimeline : timeline;
    const conflict =
      (highlightedConflict &&
      frame.t >= highlightedConflict.t - 0.05 &&
      frame.t <= highlightedConflict.t + 3.2
        ? highlightedConflict
        : null) ||
      activeTimeline?.conflicts.find(
        (item) => frame.t >= item.t - 0.05 && frame.t <= item.t + 3.2
      );
    renderer.draw(frame, { replay: Boolean(replay), conflict });
  }
  audio.update(frame);
  requestAnimationFrame(loop);
}

window.addEventListener("keydown", handleKeyDown);
window.addEventListener("keyup", handleKeyUp);
window.addEventListener("blur", () => heldActions.clear());
window.addEventListener("pagehide", () => saveNow());

elements.modeButton.addEventListener("click", () => {
  setMode(mode === "debug" ? "duo" : "debug");
});

elements.audioButton.addEventListener("click", async () => {
  const enabled = await audio.toggle();
  elements.audioButton.textContent = enabled ? "声音 ON" : "声音 OFF";
  elements.audioButton.classList.toggle("active", Boolean(enabled));
  if (enabled) audio.update(currentFrame());
});

elements.saveButton.addEventListener("click", saveNow);
elements.resetButton.addEventListener("click", resetFlight);

elements.leftThrottle.addEventListener("input", (event) => {
  setControl("left", "throttle", Number(event.target.value));
  updateDom(currentFrame(), true);
});
elements.leftFuelPump.addEventListener("input", (event) => {
  setControl("left", "fuelPump", Number(event.target.value));
  updateDom(currentFrame(), true);
});
elements.rightHydraulic.addEventListener("input", (event) => {
  setControl("right", "hydraulic", Number(event.target.value));
  updateDom(currentFrame(), true);
});

for (const button of document.querySelectorAll("[data-source][data-action][data-delta]")) {
  button.addEventListener("click", () => {
    changeControl(button.dataset.source, button.dataset.action, Number(button.dataset.delta));
    updateDom(currentFrame(), true);
  });
}

elements.gearToggle.addEventListener("click", () => {
  changeControl("right", "gearLever", 1);
  updateDom(currentFrame(), true);
});

$("#load-success-demo").addEventListener("click", () => {
  enterReplay(demos.success.timeline, "成功样例回放");
});
$("#load-failure-demo").addEventListener("click", () => {
  enterReplay(demos.failure.timeline, "失败样例回放");
});
$("#load-current-replay").addEventListener("click", () => {
  enterReplay(timeline, "本局完整回放");
});
elements.exitReplay.addEventListener("click", exitReplay);

elements.replayPlay.addEventListener("click", () => {
  if (!replay) {
    if (!enterReplay(timeline, "本局完整回放")) return;
    replay.play();
  } else {
    replay.toggle();
  }
  updateDom(currentFrame(), true);
});

$("#replay-back").addEventListener("click", () => {
  if (!replay) return;
  replay.step(-1);
  updateDom(currentFrame(), true);
});

elements.replayPlay.addEventListener("dblclick", (event) => event.preventDefault());
$("#replay-step").addEventListener("click", () => {
  if (!replay) return;
  replay.step(1);
  updateDom(currentFrame(), true);
});

for (const button of document.querySelectorAll("[data-speed]")) {
  button.addEventListener("click", () => {
    if (!replay) return;
    replay.setSpeed(Number(button.dataset.speed));
    updateDom(currentFrame(), true);
  });
}

elements.replayScrub.addEventListener("input", (event) => {
  if (!replay && !enterReplay(timeline, "本局完整回放")) return;
  replay.seek(Number(event.target.value) / 1000);
  updateDom(currentFrame(), true);
});

elements.conflictCard.addEventListener("click", (event) => {
  const button = event.target.closest("[data-seek-tick]");
  if (!button) return;
  if (!replay) enterReplay(timeline, "本局完整回放");
  seekReplayTick(Number(button.dataset.seekTick));
});

$("#replay-result").addEventListener("click", () => {
  if (enterReplay(timeline, "本局完整回放")) {
    replay.cursor = 0;
    replay.pause();
    updateDom(currentFrame(), true);
  }
});

$("#new-result").addEventListener("click", resetFlight);

setInterval(() => {
  if (!replay) saveNow();
}, 1800);

window.__flightApp = {
  getState: () => structuredClone(state),
  getTimeline: () => timeline,
  getReplayFrame: () => (replay ? structuredClone(replay.frame) : null),
  getReplayFinal: () => (replay ? structuredClone(replay.final()) : null),
  getReplayHash: () => replay?.finalHash || null,
  getMode: () => mode,
  getAudioEnabled: () => audio.enabled,
  saveNow
};

updateDom(currentFrame(), true);
saveNow();
requestAnimationFrame(loop);
