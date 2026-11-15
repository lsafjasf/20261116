import { Simulation, SCENARIOS, LIMITS, VERIFY_SECONDS } from "./simulation.js";
import { SceneRenderer } from "./renderer.js";
import { AudioEngine } from "./audio.js";

const $ = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pct = (value) => `${clamp(value, 0, 100)}%`;
const formatWindow = (seconds) => {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
};

const refs = {
  canvas: $("scene"),
  bladeGrid: $("bladeGrid"),
  windowCard: $("windowCard"),
  windowClock: $("windowClock"),
  windowBar: $("windowBar"),
  windowMargin: $("windowMargin"),
  windowState: $("windowState"),
  sceneWindowState: $("sceneWindowState"),
  sceneStage: $("sceneStage"),
  sceneProgressLabel: $("sceneProgressLabel"),
  sceneProgressBar: $("sceneProgressBar"),
  simClock: $("simClock"),
  clockState: $("clockState"),
  clockNote: $("clockNote"),
  pauseButton: $("pauseButton"),
  pauseLabel: $("pauseLabel"),
  pauseGlyph: document.querySelector(".pause-glyph"),
  stepButton: $("stepButton"),
  resumeButton: $("resumeButton"),
  replayButton: $("replayButton"),
  replayBanner: $("replayBanner"),
  replayClock: $("replayClock"),
  exitReplay: $("exitReplay"),
  windValue: $("windValue"),
  windMeter: $("windMeter"),
  swayValue: $("swayValue"),
  swayMeter: $("swayMeter"),
  tempValue: $("tempValue"),
  humidityValue: $("humidityValue"),
  humidityMeter: $("humidityMeter"),
  contactValue: $("contactValue"),
  contactMeter: $("contactMeter"),
  sanderState: $("sanderState"),
  sanderTemp: $("sanderTemp"),
  lampState: $("lampState"),
  lampVoltage: $("lampVoltage"),
  platformState: $("platformState"),
  platformGap: $("platformGap"),
  logStream: $("logStream"),
  eventCount: $("eventCount"),
  faultPanel: $("faultPanel"),
  faultEmpty: $("faultEmpty"),
  faultContent: $("faultContent"),
  faultState: $("faultState"),
  faultCode: $("faultCode"),
  faultTitle: $("faultTitle"),
  faultTime: $("faultTime"),
  faultCause: $("faultCause"),
  marginGrid: $("marginGrid"),
  responseList: $("responseList"),
  verifyCard: $("verifyCard"),
  verifyState: $("verifyState"),
  verifyBar: $("verifyBar"),
  verifyMeta: $("verifyMeta"),
  soundButton: $("soundButton"),
  soundLabel: $("soundLabel"),
  scenarioCode: $("scenarioCode"),
  seedValue: $("seedValue"),
  statusSummary: $("statusSummary"),
  toastStack: $("toastStack"),
  statusDot: document.querySelector(".status-dot"),
};

const PLATFORM_LABELS = {
  transit: "进场中",
  contact: "接触作业",
  hold: "安全保持",
  retract: "紧急回撤",
  return: "回收中",
  docked: "安全回收",
  stowed: "收纳锁定",
};

const STAGE_SHORT = {
  travel: "进场",
  sand: "打磨",
  coat: "补涂",
  dry: "固化",
  light: "灯光",
  recover: "回收",
  complete: "完成",
  aborted: "中止",
};

const MARGIN_ITEMS = [
  ["windowSec", "风窗余量", "s", 12],
  ["swayM", "失稳余量", "m", 0],
  ["contactM", "接触余量", "m", 0],
  ["humidityRH", "湿度余量", "%RH", 0],
  ["motorC", "主轴温升余量", "°C", 0],
  ["windMs", "风速余量", "m/s", 0],
];

const renderer = new SceneRenderer(refs.canvas);
const audio = new AudioEngine();
const query = new URLSearchParams(window.location.search);
let scenarioId = SCENARIOS[query.get("scenario")] ? query.get("scenario") : "normal";
let sim = new Simulation(scenarioId);
let speed = [1, 2, 4].includes(Number(query.get("speed"))) ? Number(query.get("speed")) : 2;
sim.setSpeed(speed);
let lastFrameWall = performance.now();
let lastUiWall = 0;
let lastScenarioId = null;
let lastLogLength = -1;
let lastStatusSignature = "";
let lastFaultSignature = "";
let lastNotifiedFaultId = null;
let lastOutcome = null;
let replay = null;
let audioEnabled = false;
let chimePlayed = false;

function currentView() {
  return sim.getView();
}

function frame(now) {
  const delta = Math.min(0.1, Math.max(0, (now - lastFrameWall) / 1000));
  lastFrameWall = now;
  let view;

  if (replay) {
    view = updateReplay(delta);
    renderer.draw(view, now);
    if (now - lastUiWall > 28) {
      updateInterface(view, true);
      lastUiWall = now;
    }
    requestAnimationFrame(frame);
    return;
  }

  sim.advance(delta);
  view = currentView();
  renderer.draw(view, now);
  audio.update(view);
  if (now - lastUiWall > 38) {
    updateInterface(view, false);
    lastUiWall = now;
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

function updateInterface(view, isReplay) {
  if (view.scenario.id !== lastScenarioId) {
    buildBladeCards(view);
    refs.logStream.innerHTML = "";
    lastLogLength = -1;
    lastScenarioId = view.scenario.id;
  }
  updateBladeCards(view);
  updateWindow(view);
  updateMission(view, isReplay);
  updateTelemetry(view);
  updateFaultPanel(view);
  updateControls(view, isReplay);
  updateLogs(view, isReplay);

  refs.scenarioCode.textContent = view.scenario.code;
  refs.seedValue.textContent = view.scenario.seed;
  updateStatus(view, isReplay);

  if (!isReplay) {
    notifyChanges(view);
    audio.update(view);
  }
}

function buildBladeCards(view) {
  refs.bladeGrid.innerHTML = view.blades
    .map(
      (blade) => `
        <article class="blade-card" data-blade="${blade.id}">
          <div class="blade-top">
            <div class="blade-id">
              <strong>${blade.label}</strong>
              <span>DAMAGE ${Math.round(blade.damage * 100)}%</span>
            </div>
            <span class="blade-percent">0%</span>
          </div>
          <div class="blade-track"><i></i></div>
          <div class="blade-meta">
            <span class="blade-stage-label">待维修</span>
            <span class="blade-severity">SEV ${blade.damage.toFixed(2)}</span>
          </div>
          <div class="blade-stages">
            <span data-stage="sand"></span>
            <span data-stage="coat"></span>
            <span data-stage="dry"></span>
            <span data-stage="light"></span>
          </div>
          <div class="blade-damage"><i></i><span>涂层损伤待处理</span></div>
        </article>`,
    )
    .join("");
}

function updateBladeCards(view) {
  view.blades.forEach((blade) => {
    const card = refs.bladeGrid.querySelector(`[data-blade="${blade.id}"]`);
    if (!card) return;
    const hasActiveFault =
      Boolean(view.currentFaultId) && view.mission.bladeIndex === blade.id - 1 && !view.terminal;
    card.classList.toggle("is-active", blade.active);
    card.classList.toggle("is-complete", blade.repaired);
    card.classList.toggle("is-warning", hasActiveFault);
    card.querySelector(".blade-percent").textContent = `${blade.percent}%`;
    card.querySelector(".blade-track i").style.width = pct(blade.percent);

    let stageLabel = "待维修";
    if (blade.repaired) stageLabel = "三阶段复位";
    else if (blade.active) stageLabel = STAGE_SHORT[view.mission.stage] || view.mission.stage;
    card.querySelector(".blade-stage-label").textContent = stageLabel;
    card.querySelector(".blade-damage span").textContent = blade.repaired ? "涂层修复已验证" : "涂层损伤待处理";
    card.querySelectorAll(".blade-stages [data-stage]").forEach((stageEl) => {
      const key = stageEl.dataset.stage;
      const value = blade.stages[key] || 0;
      stageEl.classList.toggle("done", value >= 0.999);
      stageEl.classList.toggle("current", blade.active && view.mission.stage === key && value < 0.999);
    });
  });
}

function updateWindow(view) {
  const state = view.window.state;
  refs.windowCard.classList.toggle("is-warning", state === "warning");
  refs.windowCard.classList.toggle("is-critical", state === "critical" || state === "closed");
  refs.windowState.textContent = state === "open" ? "OPEN" : state === "warning" ? "LOW" : state === "critical" ? "CRITICAL" : "CLOSED";
  refs.windowClock.textContent = formatWindow(view.window.remaining);
  refs.windowBar.style.width = pct(view.window.ratio * 100);
  refs.windowMargin.textContent = `${view.window.remaining.toFixed(1)} s`;

  let sceneState = `OPEN · ${Math.ceil(view.window.remaining)}s`;
  if (view.mission.status === "complete") sceneState = "OPEN · MISSION COMPLETE";
  else if (view.mission.status === "aborted_safe") sceneState = "ABORT · PLATFORM SAFE";
  else if (state === "warning") sceneState = `MARGIN LOW · ${Math.ceil(view.window.remaining)}s`;
  else if (state === "critical" || state === "closed") sceneState = `CLOSING · ${Math.ceil(view.window.remaining)}s`;
  refs.sceneWindowState.textContent = sceneState;
  refs.sceneWindowState.classList.toggle("is-warning", state === "warning");
  refs.sceneWindowState.classList.toggle("is-critical", state === "critical" || state === "closed");
}

function updateMission(view, isReplay) {
  const mission = view.mission;
  let stageText = mission.stageLabel;
  if (mission.status === "fault_hold") stageText = `故障保持 · ${mission.stageLabel}`;
  else if (mission.status === "verifying") {
    const remaining = view.verification?.remaining ?? VERIFY_SECONDS;
    stageText = `稳定观察 · ${remaining.toFixed(1)}s`;
  } else if (mission.status === "aborting") stageText = "平台失稳中止 · 紧急回撤";
  else if (mission.status === "complete") stageText = "任务完成 · 平台安全回收";
  else if (mission.status === "aborted_safe") stageText = "作业中止 · 平台安全收纳";
  else if (mission.status === "failed") stageText = "任务锁定 · 需要人工接管";
  if (isReplay) stageText = `故障回放 · ${stageText}`;
  refs.sceneStage.textContent = stageText;

  const stage = mission.stage;
  let progress = mission.stageProgress || 0;
  if (mission.status === "complete") progress = 1;
  if (mission.status === "aborted_safe") progress = 0;
  refs.sceneProgressBar.style.width = pct(progress * 100);
  refs.sceneProgressBar.style.background =
    view.currentFaultId || mission.status === "aborted_safe" || mission.status === "failed" ? "var(--red)" : "";
  refs.sceneProgressLabel.textContent = `${mission.activeBlade} / ${STAGE_SHORT[stage] || stage} · ${Math.round(progress * 100)}%`;

  refs.simClock.textContent = `T+ ${view.t.toFixed(2).padStart(7, "0")}s`;
  const clockState = isReplay
    ? "REPLAY"
    : view.currentFaultId
      ? "FAULT"
      : !view.running
        ? "PAUSED"
        : mission.status === "verifying"
          ? "VERIFY"
          : mission.status === "complete"
            ? "DONE"
            : mission.status === "aborted_safe"
              ? "SAFE"
              : "RUNNING";
  refs.clockState.textContent = clockState;
  refs.clockState.classList.toggle("is-paused", clockState === "PAUSED" || clockState === "REPLAY");
  refs.clockState.classList.toggle("is-fault", clockState === "FAULT");

  if (isReplay) {
    refs.clockNote.textContent = "历史帧回放 · 不推进仿真状态";
  } else if (view.verification?.status === "running") {
    refs.clockNote.textContent = `固定稳定观察 ${view.verification.remaining.toFixed(1)} s · 已采样 ${view.verification.samples}`;
  } else if (view.currentFaultId) {
    refs.clockNote.textContent = "故障联锁保持 · 仿真时钟仍在推进";
  } else {
    refs.clockNote.textContent = "固定步长 50 ms · 种子驱动的可重复时钟";
  }
}

function updateTelemetry(view) {
  const env = view.env;
  const platform = view.platform;
  refs.windValue.textContent = env.wind.toFixed(1);
  refs.windMeter.style.width = pct((env.wind / 26) * 100);
  refs.windMeter.style.background = env.wind > LIMITS.wind ? "var(--red)" : env.wind > 13 ? "var(--amber)" : "";

  refs.swayValue.textContent = platform.sway.toFixed(2);
  refs.swayMeter.style.width = pct((platform.sway / (LIMITS.sway * 1.5)) * 100);
  refs.swayMeter.style.background =
    platform.sway > LIMITS.sway ? "var(--red)" : platform.sway > LIMITS.contact ? "var(--amber)" : "var(--cyan)";

  refs.tempValue.textContent = env.temp.toFixed(1);
  refs.humidityValue.textContent = env.humidity.toFixed(0);
  refs.humidityMeter.style.width = pct(env.humidity);
  refs.humidityMeter.style.background = env.dryOk ? "var(--green)" : "var(--red)";

  refs.contactValue.textContent = platform.contactMargin.toFixed(2);
  refs.contactValue.style.color = platform.contactMargin < 0 ? "var(--red)" : "var(--ink)";
  refs.contactMeter.style.width = pct(((platform.contactMargin + 0.6) / 1.4) * 100);
  refs.contactMeter.style.background = platform.contactMargin < 0 ? "var(--red)" : "var(--cyan)";

  refs.sanderState.textContent = view.equipment.sander.state;
  refs.sanderTemp.textContent = `${view.equipment.sander.temp.toFixed(1)}°C`;
  refs.sanderTemp.style.color = view.equipment.sander.temp > 80 ? "var(--red)" : "";
  refs.lampState.textContent = view.equipment.lamp.state;
  refs.lampVoltage.textContent = `${view.equipment.lamp.voltage.toFixed(1)}V`;
  refs.platformState.textContent = PLATFORM_LABELS[platform.mode] || platform.mode;
  refs.platformGap.textContent = platform.gap < 0.16 ? "接触" : `${platform.gap.toFixed(2)}m`;
  refs.platformGap.style.color = platform.mode === "retract" ? "var(--red)" : "";
}

function updateFaultPanel(view) {
  const fault = view.fault;
  if (!fault) {
    refs.faultEmpty.hidden = false;
    refs.faultContent.hidden = true;
    refs.faultState.textContent = "NOMINAL";
    refs.faultState.className = "fault-state";
    lastFaultSignature = "";
    return;
  }

  refs.faultEmpty.hidden = true;
  refs.faultContent.hidden = false;
  const verification = view.verification?.faultId === fault.id ? view.verification : fault.verification;
  let faultState = "ACTIVE";
  let stateClass = "is-fault";
  if (fault.active && fault.kind === "INSTABILITY") faultState = "ABORT";
  else if (verification?.status === "running") {
    faultState = "VERIFY";
    stateClass = "is-verify";
  } else if (verification?.status === "passed") {
    faultState = fault.kind === "INSTABILITY" ? "SAFE / PASS" : "RECOVERED";
    stateClass = "is-pass";
  } else if (verification?.status === "failed") {
    faultState = "FAILED";
    stateClass = "is-fault";
  } else if (!fault.active) {
    faultState = "RECOVERED";
    stateClass = "is-pass";
  }
  refs.faultState.textContent = faultState;
  refs.faultState.className = `fault-state ${stateClass}`;

  refs.faultCode.textContent = fault.id;
  refs.faultTitle.textContent = fault.title;
  refs.faultTime.textContent = `T+${fault.time.toFixed(2)}s · ${fault.blade}/${fault.stageLabel}`;
  refs.faultCause.textContent = fault.cause;

  const marginSignature = `${fault.id}|${Object.values(fault.margin).join("|")}`;
  if (refs.marginGrid.dataset.signature !== marginSignature) {
    refs.marginGrid.dataset.signature = marginSignature;
    refs.marginGrid.innerHTML = MARGIN_ITEMS.map(([key, label, unit, criticalAt]) => {
      const value = fault.margin[key];
      const breach = value <= criticalAt;
      const formatted = unit === "°C" ? value.toFixed(1) : unit === "s" ? value.toFixed(1) : value.toFixed(2);
      return `<div class="margin-item${breach ? " is-breach" : ""}"><span>${label}</span><b>${formatted} ${unit}</b></div>`;
    }).join("");
  }

  const responseSignature = `${fault.id}|${fault.response.length}`;
  if (refs.responseList.dataset.signature !== responseSignature) {
    refs.responseList.dataset.signature = responseSignature;
    refs.responseList.innerHTML = fault.response.length
      ? fault.response
          .map(
            (item) =>
              `<div class="response-item"><time>T+${item.at.toFixed(2)}s</time><span><b style="color:var(--muted);font-weight:400">${item.source}</b> · ${item.message}</span></div>`,
          )
          .join("")
      : `<div class="response-item"><time>待响应</time><span>正在等待自动安全动作回执。</span></div>`;
  }

  refs.verifyCard.classList.toggle("is-pass", verification?.status === "passed");
  let verifyLabel = "等待安全状态";
  let verifyWidth = 0;
  let verifyMessage = `固定观察窗 ${VERIFY_SECONDS.toFixed(1)} s · 安全阈值通过后启动`;
  if (verification?.status === "running") {
    const duration = verification.duration || VERIFY_SECONDS;
    const remaining = view.verification?.remaining ?? Math.max(0, verification.endsAt - view.t);
    const progress = clamp((duration - remaining) / duration, 0, 1);
    verifyLabel = `观察中 ${remaining.toFixed(1)}s`;
    verifyWidth = progress * 100;
    verifyMessage = `${verification.samples || 0} 采样 · 最大摆幅跳变 ${(verification.maxDelta?.sway || 0).toFixed(3)} m · 阈值检查中`;
  } else if (verification?.status === "passed") {
    verifyLabel = "PASS · 无连锁错误";
    verifyWidth = 100;
    verifyMessage = `${(verification.duration || VERIFY_SECONDS).toFixed(1)} s / ${verification.samples} 采样 · 摆幅Δ${(verification.maxDelta?.sway || 0).toFixed(3)}m · 风速Δ${(verification.maxDelta?.wind || 0).toFixed(2)}m/s · 无状态跳变`;
  } else if (verification?.status === "failed") {
    verifyLabel = "FAIL · 状态异常";
    verifyWidth = 100;
    verifyMessage = (verification.violations || []).map((item) => item.message).join("；") || "观察窗检测到异常。";
  }
  refs.verifyState.textContent = verifyLabel;
  refs.verifyBar.style.width = pct(verifyWidth);
  refs.verifyMeta.textContent = verifyMessage;
}

function updateControls(view, isReplay) {
  const disabled = Boolean(isReplay);
  refs.pauseButton.disabled = disabled || view.terminal;
  refs.stepButton.disabled = disabled || view.running || view.terminal;
  refs.resumeButton.disabled = disabled || view.running || view.terminal;
  refs.replayButton.disabled = disabled || sim.faults.length === 0;
  refs.pauseLabel.textContent = view.running ? "暂停" : "继续";
  refs.pauseGlyph.classList.toggle("is-play", !view.running);
  if (view.terminal) {
    refs.pauseLabel.textContent = "已结束";
    refs.pauseGlyph.classList.add("is-play");
  }
  if (isReplay) {
    refs.pauseLabel.textContent = "回放中";
    refs.pauseGlyph.classList.remove("is-play");
  }
  document.querySelectorAll(".speed-switch button").forEach((button) => {
    button.classList.toggle("is-active", Number(button.dataset.speed) === sim.speed);
    button.disabled = disabled;
  });
}

function updateLogs(view, isReplay) {
  if (isReplay) return;
  if (view.logs.length === lastLogLength) return;
  const wasNearBottom = refs.logStream.scrollTop + refs.logStream.clientHeight >= refs.logStream.scrollHeight - 18;
  lastLogLength = view.logs.length;
  const entries = view.logs.slice(-100);
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = `log-entry is-${entry.level}`;
    const time = document.createElement("time");
    time.textContent = `T+${entry.t.toFixed(2)}`;
    const source = document.createElement("span");
    source.className = "log-source";
    source.textContent = entry.source;
    const message = document.createElement("span");
    message.className = "log-message";
    message.textContent = `${entry.title} · ${entry.message}`;
    row.append(time, source, message);
    fragment.append(row);
  }
  refs.logStream.replaceChildren(fragment);
  refs.eventCount.textContent = `${String(view.eventCount).padStart(3, "0")} EVENTS`;
  if (wasNearBottom) refs.logStream.scrollTop = refs.logStream.scrollHeight;
}

function updateStatus(view, isReplay) {
  const signature = `${view.mission.status}|${view.currentFaultId}|${view.verification?.status}|${isReplay}`;
  const hasAlert = Boolean(view.currentFaultId) || view.mission.status === "failed";
  refs.statusDot.classList.toggle("is-alert", hasAlert);
  if (signature === lastStatusSignature) return;
  lastStatusSignature = signature;
  if (isReplay) {
    refs.statusSummary.textContent = "失败回放 · 仿真状态已冻结";
  } else if (view.currentFaultId) {
    refs.statusSummary.textContent = `安全联锁 · ${view.fault?.title || "故障"} · 风窗余量 ${view.window.remaining.toFixed(1)}s`;
  } else if (view.mission.status === "verifying") {
    refs.statusSummary.textContent = `恢复稳定观察 · ${view.verification?.remaining?.toFixed(1) || VERIFY_SECONDS}s`;
  } else if (view.mission.status === "complete") {
    refs.statusSummary.textContent = `修复成功 · 三片叶片完成 · 平台安全回收 · 风窗余量 ${view.window.remaining.toFixed(1)}s`;
  } else if (view.mission.status === "aborted_safe") {
    refs.statusSummary.textContent = "平台失稳中止 · 安全观察通过 · 平台已收纳";
  } else if (view.mission.status === "failed") {
    refs.statusSummary.textContent = "任务失败 · 联锁锁定 · 需要人工接管";
  } else if (!view.running) {
    refs.statusSummary.textContent = `仿真暂停 · T+${view.t.toFixed(2)}s · 风窗余量 ${view.window.remaining.toFixed(1)}s`;
  } else {
    refs.statusSummary.textContent = `${view.mission.stageLabel} · ${view.mission.activeBlade} · 风窗余量 ${view.window.remaining.toFixed(1)}s`;
  }
}

let lastVerificationNotice = null;

function notifyChanges(view) {
  if (view.currentFaultId && view.currentFaultId !== lastNotifiedFaultId) {
    lastNotifiedFaultId = view.currentFaultId;
    const fault = view.fault;
    toast(
      `安全联锁 ${fault.id}`,
      `${fault.title} · T+${fault.time.toFixed(2)}s · 风窗余 ${fault.margin.windowSec.toFixed(1)}s · 系统已回撤工具并保持平台。`,
      "error",
    );
  }

  if (view.fault?.verification?.status === "passed") {
    const key = `${view.fault.id}:passed`;
    if (lastVerificationNotice !== key) {
      lastVerificationNotice = key;
      toast(
        "稳定观察通过",
        `${view.fault.id} 恢复后连续观察 ${VERIFY_SECONDS.toFixed(1)}s，无连锁错误或状态跳变。`,
        "success",
      );
    }
  }

  if (view.terminal && view.outcome && view.outcome !== lastOutcome) {
    lastOutcome = view.outcome;
    if (view.outcome === "success") {
      toast(
        "修复成功",
        `三处修复完成，平台已安全回收，风窗余量 ${view.window.remaining.toFixed(1)}s。`,
        "success",
      );
      if (!chimePlayed) {
        chimePlayed = true;
        audio.chime();
      }
    } else if (view.outcome === "safe_abort") {
      toast(
        "平台安全回收",
        `单次失稳中止已完成，稳定观察通过；平台处于收纳锁定状态。`,
        "info",
      );
    } else if (view.outcome === "verification_failure") {
      toast("稳定观察失败", "恢复后检测到状态异常，任务已锁定。", "error");
    } else if (view.outcome === "window_failure") {
      toast("风窗关闭", "作业窗口耗尽，平台未完成安全回收。", "error");
    }
  }
}

function toast(title, message, type = "info") {
  const element = document.createElement("div");
  element.className = `toast is-${type}`;
  const heading = document.createElement("b");
  heading.textContent = title;
  const body = document.createElement("span");
  body.textContent = message;
  element.append(heading, body);
  refs.toastStack.append(element);
  window.setTimeout(() => {
    element.style.opacity = "0";
    element.style.transform = "translateX(10px)";
    element.style.transition = "opacity 180ms ease, transform 180ms ease";
    window.setTimeout(() => element.remove(), 200);
  }, 5600);
}

function updateReplay(delta) {
  if (!replay) return currentView();
  replay.elapsed += delta * replay.rate;
  const targetT = replay.startT + replay.elapsed;
  while (replay.index + 1 < replay.frames.length && replay.frames[replay.index + 1].t <= targetT) {
    replay.index += 1;
  }
  const frame = replay.frames[replay.index];
  const offset = frame.t - replay.faultTime;
  refs.replayClock.textContent = `${offset >= -0.05 ? "−0.0" : offset.toFixed(1)}s`;
  if (replay.index >= replay.frames.length - 1 && !replay.ended) {
    replay.ended = true;
    refs.replayClock.textContent = "−0.0s · FAULT";
  }
  return frame;
}

function startFailureReplay() {
  if (!sim.faults.length) {
    toast("无可用故障", "当前场景尚未产生故障记录。", "info");
    return;
  }
  const fault = sim.faults[sim.faults.length - 1];
  const frames = sim.getFaultReplay(fault.id, 8);
  if (frames.length < 2) {
    toast("回放缓存不足", "故障前历史帧尚未满足回放窗口。", "info");
    return;
  }
  replay = {
    frames,
    index: 0,
    elapsed: 0,
    rate: 1.4,
    startT: frames[0].t,
    faultTime: fault.time,
    wasRunning: sim.running,
    ended: false,
  };
  refs.toastStack.replaceChildren();
  if (sim.running) sim.pause("failure-replay");
  refs.replayBanner.hidden = false;
  refs.replayClock.textContent = `${(frames[0].t - fault.time).toFixed(1)}s`;
  updateInterface(frames[0], true);
}

function stopReplay(resume = true) {
  if (!replay) return;
  const wasRunning = replay.wasRunning;
  replay = null;
  refs.replayBanner.hidden = true;
  if (resume && wasRunning) sim.resume();
  updateInterface(currentView(), false);
}

function loadScenario(id) {
  if (!SCENARIOS[id]) return;
  if (replay) {
    replay = null;
    refs.replayBanner.hidden = true;
  }
  scenarioId = id;
  sim = new Simulation(id);
  sim.speed = speed;
  lastScenarioId = null;
  lastLogLength = -1;
  lastStatusSignature = "";
  lastFaultSignature = "";
  lastNotifiedFaultId = null;
  lastVerificationNotice = null;
  lastOutcome = null;
  chimePlayed = false;
  audio.lastFaultId = null;
  refs.marginGrid.dataset.signature = "";
  refs.responseList.dataset.signature = "";
  document.querySelectorAll(".scenario-tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.scenario === id);
  });
  toast(`场景 ${SCENARIOS[id].code}`, SCENARIOS[id].description, "info");
  updateInterface(currentView(), false);
}

async function toggleAudio() {
  if (!audio.started) {
    const started = await audio.start();
    if (!started) {
      toast("音频不可用", "浏览器未提供 Web Audio 或音频上下文启动失败。", "error");
      return;
    }
    audioEnabled = true;
  } else {
    audioEnabled = !audioEnabled;
    audio.setEnabled(audioEnabled);
  }
  refs.soundButton.setAttribute("aria-pressed", String(audioEnabled));
  refs.soundLabel.textContent = audioEnabled ? "音频开启" : "音频静音";
  if (audioEnabled) audio.update(currentView());
}

document.querySelectorAll(".scenario-tab").forEach((tab) => {
  tab.addEventListener("click", () => loadScenario(tab.dataset.scenario));
});

refs.pauseButton.addEventListener("click", () => {
  if (replay) return;
  if (sim.running) sim.pause("operator");
  else sim.resume();
  updateInterface(currentView(), false);
});

refs.stepButton.addEventListener("click", () => {
  if (replay) return;
  sim.stepOnce();
  updateInterface(currentView(), false);
});

refs.resumeButton.addEventListener("click", () => {
  if (replay) return;
  sim.resume();
  updateInterface(currentView(), false);
});

refs.replayButton.addEventListener("click", startFailureReplay);
refs.exitReplay.addEventListener("click", () => stopReplay(true));

document.querySelectorAll(".speed-switch button").forEach((button) => {
  button.addEventListener("click", () => {
    speed = Number(button.dataset.speed);
    sim.setSpeed(speed);
    updateInterface(currentView(), false);
  });
});

refs.soundButton.addEventListener("click", toggleAudio);

window.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  if (event.code === "Space") {
    event.preventDefault();
    if (!replay && !sim.terminal) refs.pauseButton.click();
  } else if (event.key.toLowerCase() === "n") {
    if (!replay && !sim.running && !sim.terminal) refs.stepButton.click();
  } else if (event.key.toLowerCase() === "r") {
    if (!replay && sim.faults.length) startFailureReplay();
  } else if (event.key.toLowerCase() === "m") {
    event.preventDefault();
    toggleAudio();
  }
});

document.querySelectorAll(".scenario-tab").forEach((tab) => {
  tab.classList.toggle("is-active", tab.dataset.scenario === scenarioId);
});
updateInterface(currentView(), false);
toast("仿真开始", `${SCENARIOS[scenarioId].name}场景已载入。可暂停、单步或切换故障场景。`, "info");
