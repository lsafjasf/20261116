import {
  CYCLE_MINUTES,
  BEARING_WARN_C,
  GATE_HEAD_LIMIT_M,
  GENERATION_TARGET_MWH,
  NAV_WINDOWS,
  SCENARIOS,
  STRATEGIES,
  TidalSimulation,
  clockLabel,
  formatMargin,
} from "./sim.js";
import { TidalRenderer } from "./renderer.js";
import { TidalAudio } from "./audio.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const TICK_MS = 74;
const EVENT_LABELS = {
  system: "SYSTEM",
  equipment: "PLANT",
  navigation: "NAV",
  safety: "INTERLOCK",
  fault: "FAULT",
  recovery: "RECOVERY",
  operation: "OP",
  result: "RESULT",
};

const renderer = new TidalRenderer($("#scene"));
const audio = new TidalAudio();

let scenarioKey = "normal";
let strategyKey = "balanced";
let sim = null;
let running = true;
let speed = 1;
let accumulator = 0;
let lastFrame = performance.now();
let lastRenderedTick = -1;
let lastRenderedLog = -1;
let lastIncidentCount = 0;
let lastResultShown = false;
let currentIncident = null;
let savedSim = null;
let replayMode = false;
let replayTarget = null;
let comparisonCache = null;
let uiForce = true;
let renderedEventSeq = -1;

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function createSimulation(nextScenario = scenarioKey, nextStrategy = strategyKey) {
  scenarioKey = nextScenario;
  strategyKey = nextStrategy;
  sim = new TidalSimulation({
    scenarioKey,
    strategyKey,
    seed: 605,
  });
  running = true;
  accumulator = 0;
  lastFrame = performance.now();
  lastIncidentCount = sim.incidents.length;
  lastResultShown = false;
  renderedEventSeq = -1;
  currentIncident = null;
  savedSim = null;
  replayMode = false;
  replayTarget = null;
  audio.lastAlarmKey = "";
  uiForce = true;
  closeIncidentDrawer();
  hideResult();
  $("#replay-banner").hidden = true;
  $("#replay-button").disabled = true;
}

function setRunning(next) {
  if (sim.ended) return;
  running = next;
  accumulator = 0;
  lastFrame = performance.now();
  updateUI(true);
}

function stepOnce() {
  if (sim.ended) return;
  sim.step();
  const newIncident = sim.incidents.at(-1);
  if (sim.incidents.length > lastIncidentCount) {
    lastIncidentCount = sim.incidents.length;
    if (newIncident && !newIncident.resolved) {
      running = false;
      audio.alarmOnce(`${newIncident.id}-${newIncident.tick}`, "fault");
      if (!replayMode) {
        openIncidentDrawer(newIncident);
      } else if (replayTarget !== null && sim.tick >= replayTarget - 1) {
        running = false;
      }
    }
  }
  if (replayMode && replayTarget !== null && sim.tick >= replayTarget) {
    running = false;
  }
  if (sim.ended) {
    running = false;
    showResult(sim.getResults());
  }
  updateUI();
}

function fastForward() {
  if (sim.ended) return;
  running = false;
  while (!sim.ended) {
    const count = sim.incidents.length;
    sim.step();
    if (sim.incidents.length > count) {
      const incident = sim.incidents.at(-1);
      lastIncidentCount = sim.incidents.length;
      if (incident && !incident.resolved) {
        audio.alarmOnce(`${incident.id}-${incident.tick}`, "fault");
        if (!replayMode) openIncidentDrawer(incident);
        break;
      }
    }
    if (replayMode && replayTarget !== null && sim.tick >= replayTarget) break;
  }
  if (sim.ended) showResult(sim.getResults());
  updateUI(true);
}

function frame(now) {
  const elapsed = Math.min(240, now - lastFrame);
  lastFrame = now;
  if (running && !sim.ended) {
    accumulator += (elapsed * speed) / TICK_MS;
    let steps = 0;
    while (accumulator >= 1 && steps < 36 && !sim.ended) {
      accumulator -= 1;
      steps += 1;
      stepOnce();
      if (!running) {
        accumulator = 0;
        break;
      }
    }
  }
  renderer.draw(sim, { replay: replayMode });
  audio.update(sim.state);
  if (lastRenderedTick !== sim.tick || lastRenderedLog !== sim.log.length || uiForce) {
    updateUI(true);
  }
  requestAnimationFrame(frame);
}

function updateUI(force = false) {
  if (!sim) return;
  const state = sim.state;
  lastRenderedTick = sim.tick;
  lastRenderedLog = sim.log.length;
  uiForce = false;

  $("#canvas-clock").textContent = state.clock;
  $("#phase-chip").textContent = state.tidePhase;
  $("#run-state").textContent = sim.ended
    ? "周期已结算"
    : running
      ? "周期运行中"
      : replayMode
        ? "回放暂停"
        : "仿真已暂停";
  $("#run-led").classList.toggle("is-paused", !running || sim.ended);
  $("#pause-icon").textContent = running ? "Ⅱ" : "▶";
  $("#pause-label").textContent = running ? "暂停" : "恢复";
  $("#pause-button").disabled = sim.ended;
  $("#step-button").disabled = sim.ended;
  $("#finish-button").disabled = sim.ended || replayMode;
  $("#replay-button").disabled = sim.incidents.length === 0 || replayMode;

  $("#tick-value").textContent = String(sim.tick).padStart(3, "0");
  $("#metric-sea").innerHTML = `${state.seaLevel.toFixed(2)} <small>m</small>`;
  $("#metric-basin").innerHTML = `${state.basinLevel.toFixed(2)} <small>m</small>`;
  $("#metric-head").innerHTML = `${state.head > 0 ? "+" : ""}${state.head.toFixed(2)} <small>m</small>`;
  $("#metric-direction").textContent =
    state.turbine.status === "reversing"
      ? `换向剩余 ${state.turbine.reverseLeft} min`
      : state.turbine.direction === "flood"
        ? "海 → 库 · 涨潮向"
        : "库 → 海 · 落潮向";
  $("#metric-flow").innerHTML = `${Math.abs(state.flow.total).toFixed(0)} <small>m³/s</small>`;
  $("#metric-gate").textContent = `泄水闸 ${Math.round(state.gate.opening * 100)}% · ${state.gate.reason}`;
  $("#metric-power").innerHTML = `${state.powerMW.toFixed(2)} <small>MW</small>`;
  $("#metric-turbine").textContent =
    state.turbine.status === "running"
      ? `转速 ${Math.round(state.turbine.speed * 100)}% · 并网`
      : state.turbine.status === "reversing"
        ? "机械换向中"
        : state.turbine.status === "fault"
          ? "故障联锁"
          : "涡轮隔离";
  $("#metric-pressure").innerHTML = `${formatMargin(state.gate.margin, "")} <small>m</small>`;
  $("#metric-pressure-limit").textContent = `限值 ${GATE_HEAD_LIMIT_M.toFixed(2)} m`;
  $("#metric-bearing").innerHTML = `${state.safety.maxBearing.toFixed(1)} <small>°C</small>`;
  $("#metric-bearing-limit").textContent = "限值 104 °C";
  $("#metric-hash").textContent = sim.stateHash;
  $("#metric-tide").textContent = state.tideTrend >= 0 ? "↗ 涨潮" : "↘ 落潮";
  $("#pressure-metric").classList.toggle(
    "is-danger",
    state.gate.interlocked ||
      (state.gate.margin < 0 && state.gate.opening > 0.005),
  );

  const energyRatio = state.energyMWh / GENERATION_TARGET_MWH;
  $("#energy-bar").style.width = `${Math.min(100, energyRatio * 100)}%`;
  $("#energy-bar").classList.toggle("is-complete", energyRatio >= 1);
  $("#goal-energy-text").textContent =
    `${state.energyMWh.toFixed(1)} / ${GENERATION_TARGET_MWH.toFixed(1)} MWh`;
  $("#goal-nav-text").textContent =
    `${state.counts.onTimeNav} / ${NAV_WINDOWS.length} 准点` +
    (state.counts.delayedNav ? ` · ${state.counts.delayedNav} 延误` : "");
  $("#goal-safety-text").textContent = safetySummary();
  $("#gate-damage-value").textContent = `${state.gate.damage.toFixed(1)}%`;
  $("#audit-value").textContent = sim.audit.finished
    ? sim.audit.passed ? "通过" : "失败"
    : sim.audit.active
      ? `${sim.audit.elapsed}/${sim.audit.required}`
      : "未触发";
  updateNavSlots();
  updateGoalStatus();
  updateEventList(force);
  updateIncidentDrawer();
}

function safetySummary() {
  const unresolved = sim.incidents.find((incident) => !incident.resolved);
  if (unresolved) return `联锁 · ${unresolved.title}`;
  if (sim.ended) return sim.getResults().equipmentSafe ? "安全闭环" : "未闭环";
  if (sim.audit.active) return `长稳校验 ${sim.audit.elapsed}/${sim.audit.required}`;
  if (sim.audit.finished) return sim.audit.passed ? "长稳通过" : "长稳失败";
  if (sim.state.safety.maxBearing >= BEARING_WARN_C) return "轴承接近限值";
  if (sim.state.gate.margin < 0) return "压差高 · 闸门闭锁";
  return "余量正常";
}

function updateNavSlots() {
  sim.navWindows.forEach((window, index) => {
    const node = $(`#nav-slot-${index}`);
    if (!node) return;
    node.className = "";
    const label = index === 0 ? "首班" : "返程";
    if (window.status === "completed") {
      node.textContent = `${label} ✓ ${clockLabel(window.completedTick)}`;
      node.classList.add("is-done");
    } else if (window.status === "delayed" || window.delayed || window.status === "missed") {
      node.textContent = `${label} 延误`;
      node.classList.add("is-delayed");
    } else if (window.status === "active" || sim.tick >= window.requestTick) {
      node.textContent = `${label} 作业中`;
      node.classList.add("is-live");
    } else {
      node.textContent = `${label} ${clockLabel(window.deadlineTick)}`;
    }
  });
}

function updateGoalStatus() {
  const badge = $("#goal-status");
  badge.className = "status-badge";
  if (sim.ended) {
    const result = sim.getResults();
    badge.textContent = result.success ? "达标" : "未达标";
    badge.classList.add(result.success ? "success" : "danger");
  } else if (sim.incidents.some((incident) => !incident.resolved)) {
    badge.textContent = "联锁";
    badge.classList.add("danger");
  } else if (sim.audit.active) {
    badge.textContent = `长稳 ${sim.audit.elapsed}/${sim.audit.required}`;
    badge.classList.add("neutral");
  } else {
    badge.textContent = "进行中";
    badge.classList.add("neutral");
  }
}

function updateEventList(force = false) {
  const lastSeq = sim.log.at(-1)?.seq ?? 0;
  if (!force && renderedEventSeq === lastSeq) return;
  renderedEventSeq = lastSeq;
  $("#log-count").textContent = `${sim.log.length} 条`;
  const rows = [...sim.log].reverse().slice(0, 14).map((event) => `
    <div class="event-row" data-severity="${event.severity}">
      <span class="event-time">${event.clock}</span>
      <i class="event-mark"></i>
      <span class="event-copy">
        <strong>${escapeHtml(event.title)}</strong>
        <span>${escapeHtml(event.detail)}</span>
      </span>
      <span class="event-kind">${EVENT_LABELS[event.kind] ?? event.kind}</span>
    </div>
  `).join("");
  $("#event-list").innerHTML = rows;
}

function openIncidentDrawer(incident) {
  currentIncident = incident;
  updateIncidentDrawer();
  $("#drawer-backdrop").hidden = false;
  $("#incident-drawer").hidden = false;
}

function closeIncidentDrawer() {
  $("#drawer-backdrop").hidden = true;
  $("#incident-drawer").hidden = true;
}

function updateIncidentDrawer() {
  if ($("#incident-drawer").hidden || !currentIncident) return;
  const incident = sim.incidents.find((item) => item.id === currentIncident.id) ?? currentIncident;
  currentIncident = incident;
  $("#incident-title").textContent = incident.title;
  $("#incident-clock").textContent = incident.clock;
  $("#incident-tick").textContent = `T+${String(incident.tick).padStart(3, "0")}`;
  $("#incident-value").textContent = `${incident.value} ${incident.unit}`;
  $("#incident-limit").textContent = `${incident.limit} ${incident.unit}`;
  $("#incident-margin").textContent = formatMargin(incident.margin, ` ${incident.unit}`);
  $("#incident-response").textContent = incident.response;
  $("#incident-evidence").textContent =
    `${incident.thresholdText} · 状态哈希 ${incident.stateHash} · ` +
    `${incident.type === "equipment" ? "全站负荷 0.00 MW" : "闸门开度 0%"}`;
  const recoverButton = $("#recover-incident");
  recoverButton.disabled = incident.resolved || sim.ended;
  recoverButton.textContent = incident.resolved
    ? incident.auditPassed === null
      ? "已复位 · 校验中"
      : incident.auditPassed ? "已复位 · 长稳通过" : "已复位 · 长稳失败"
    : "检修并复位";
  $("#replay-incident").disabled = replayMode;
}

function showResult(result) {
  if (lastResultShown || replayMode) return;
  lastResultShown = true;
  const toast = $("#result-toast");
  toast.hidden = false;
  toast.classList.toggle("is-failure", !result.success);
  $("#result-eyebrow").textContent = result.success ? "CYCLE COMPLETE" : "CYCLE REVIEW";
  $("#result-title").textContent = result.success ? "潮周期任务达成" : "潮周期任务未达成";
  const summary = result.success
    ? "设备安全、两次通航准点、发电量达标。"
    : [
        !result.equipmentSafe ? "设备安全未闭环" : "",
        !result.navigationPassed ? "通航未全部准点" : "",
        !result.energyPassed ? "发电量未达标" : "",
      ].filter(Boolean).join("；");
  $("#result-copy").textContent =
    `${result.energyMWh.toFixed(1)} MWh · 通航 ${result.onTimeNav}/2 · ` +
    `事故 ${result.incidents} 起。${summary}`;
}

function hideResult() {
  $("#result-toast").hidden = true;
}

function updateStrategyPanel() {
  const strategy = STRATEGIES[strategyKey];
  $$("#strategy-switch button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.strategy === strategyKey);
  });
  $("#policy-code").textContent = strategyKey === "balanced" ? "POL-A" : "POL-B";
  $("#fact-lead").textContent = `${strategy.reverseLead} min`;
  $("#fact-nav").textContent = strategyKey === "balanced"
    ? `提前 ${strategy.navLead} min`
    : `延后 ${strategy.navHold} min`;
  $("#fact-gate").textContent = `${Math.round(strategy.gateCap * 100)}%`;
  $("#strategy-copy").textContent = strategyKey === "balanced"
    ? "在通航请求前 34 分钟停机均压，换向提前量 24 分钟，优先守住通航与闸门余量。"
    : "通航请求后继续满发 17 分钟，换向只留 9 分钟提前量，用电量换调度弹性。";
}

function updateScenarioTabs() {
  $$(".scenario-tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.scenario === scenarioKey);
  });
}

function simulateComparisonSide(nextStrategy) {
  const side = new TidalSimulation({
    scenarioKey,
    strategyKey: nextStrategy,
    seed: 605,
  });
  while (!side.ended) {
    side.step();
    const unresolved = side.incidents.find((incident) => !incident.resolved);
    if (unresolved && side.tick < 650) side.recoverIncident();
  }
  return side;
}

function comparisonCard(side, strategy) {
  const result = side.getResults();
  const safety = result.equipmentSafe ? "闭环" : "未闭环";
  const nav = `${result.onTimeNav}/2`;
  const detail = result.success
    ? `电量 ${result.energyMWh.toFixed(2)} MWh，通航全部准点，状态哈希 ${result.stateHash}。`
    : [
        !result.energyPassed ? `电量 ${result.energyMWh.toFixed(2)} MWh 未达标` : "",
        !result.navigationPassed ? `通航仅 ${result.onTimeNav}/2 准点` : "",
        !result.equipmentSafe ? "设备安全未闭环" : "",
      ].filter(Boolean).join("；");
  return `
    <article class="compare-card ${result.success ? "is-winner" : "is-failed"} ${strategy.key === "power" ? "is-power" : ""}">
      <div class="compare-head">
        <strong>${escapeHtml(strategy.name)}</strong>
        <span>${result.success ? "达标" : "未达标"}</span>
      </div>
      <div class="compare-stats">
        <span>电量<strong>${result.energyMWh.toFixed(1)}</strong></span>
        <span>通航<strong>${nav}</strong></span>
        <span>安全<strong>${safety}</strong></span>
      </div>
      <p class="compare-detail">${escapeHtml(detail)}</p>
      <div class="compare-verdict">
        <span>事故 ${result.incidents} 起</span>
        <span>闸损 ${result.gateDamage.toFixed(1)}%</span>
        <span>峰值 ${result.maxBearing.toFixed(1)}°C</span>
      </div>
    </article>
  `;
}

function renderComparison() {
  const safe = simulateComparisonSide("balanced");
  const power = simulateComparisonSide("power");
  comparisonCache = { safe, power };
  const safeResult = safe.getResults();
  const powerResult = power.getResults();
  const safeCard = comparisonCard(safe, STRATEGIES.balanced);
  const powerCard = comparisonCard(power, STRATEGIES.power);
  let summary = "";
  if (safeResult.success && !powerResult.success) {
    summary = `稳航协同达标；电量冲刺多 ${(powerResult.energyMWh - safeResult.energyMWh).toFixed(2)} MWh，但通航 ${powerResult.onTimeNav}/2。`;
  } else if (!safeResult.success && powerResult.success) {
    summary = `电量冲刺达标；稳航协同因电量差 ${(safeResult.targetMWh - safeResult.energyMWh).toFixed(2)} MWh 未闭环。`;
  } else if (safeResult.success && powerResult.success) {
    const winner = safeResult.energyMWh >= powerResult.energyMWh ? "稳航协同" : "电量冲刺";
    summary = `两种策略均达标；${winner}电量更高，安全余量见上方卡片。`;
  } else {
    summary = "两种策略均未完整达标，请检查通航截止、发电目标与恢复校验。";
  }
  $("#compare-grid").innerHTML = `
    ${safeCard}
    ${powerCard}
    <div class="compare-summary">${escapeHtml(SCENARIOS[scenarioKey].name)} · ${escapeHtml(summary)}</div>
  `;
}

function startReplay(incident) {
  if (!incident || replayMode) return;
  savedSim = sim;
  const targetTick = Math.max(0, incident.tick - 8);
  const replay = new TidalSimulation({
    scenarioKey: sim.scenarioKey,
    strategyKey: sim.strategyKey,
    seed: sim.seed,
    commandTrack: sim.commandTrack,
  });
  replay.runTo(targetTick);
  sim = replay;
  replayMode = true;
  replayTarget = incident.tick + 4;
  running = false;
  lastIncidentCount = replay.incidents.length;
  lastResultShown = false;
  renderedEventSeq = -1;
  closeIncidentDrawer();
  hideResult();
  $("#replay-banner").hidden = false;
  $("#replay-button").disabled = true;
  uiForce = true;
  updateUI(true);
}

function exitReplay() {
  if (!replayMode || !savedSim) return;
  sim = savedSim;
  savedSim = null;
  replayMode = false;
  replayTarget = null;
  running = false;
  lastIncidentCount = sim.incidents.length;
  renderedEventSeq = -1;
  $("#replay-banner").hidden = true;
  uiForce = true;
  updateUI(true);
}

async function toggleAudio() {
  const button = $("#audio-toggle");
  if (!audio.enabled) {
    const enabled = await audio.enable();
    if (!enabled) {
      $("#audio-label").textContent = "音频不可用";
      return;
    }
    audio.setMuted(false);
    button.classList.add("is-on");
    $("#audio-label").textContent = "声场开启";
    return;
  }
  const nextMuted = !audio.muted;
  audio.setMuted(nextMuted);
  button.classList.toggle("is-on", !nextMuted);
  $("#audio-label").textContent = nextMuted ? "已静音" : "声场开启";
}

function bindEvents() {
  $$(".scenario-tab").forEach((button) => {
    button.addEventListener("click", () => {
      createSimulation(button.dataset.scenario, strategyKey);
      updateScenarioTabs();
      renderComparison();
    });
  });
  $$("#strategy-switch button").forEach((button) => {
    button.addEventListener("click", () => {
      createSimulation(scenarioKey, button.dataset.strategy);
      updateStrategyPanel();
    });
  });
  $("#pause-button").addEventListener("click", () => setRunning(!running));
  $("#step-button").addEventListener("click", () => {
    if (running) setRunning(false);
    stepOnce();
  });
  $("#finish-button").addEventListener("click", fastForward);
  $("#replay-button").addEventListener("click", () => {
    const incident = sim.incidents.at(-1);
    startReplay(incident);
  });
  $("#exit-replay").addEventListener("click", exitReplay);
  $("#speed-select").addEventListener("change", (event) => {
    speed = Number(event.target.value);
  });
  $("#audio-toggle").addEventListener("click", toggleAudio);
  $("#nav-priority").addEventListener("click", () => {
    sim.applyCommand("nav-priority");
    setRunning(true);
  });
  $("#emergency-stop").addEventListener("click", () => {
    sim.applyCommand("emergency-stop");
    setRunning(false);
  });
  $("#auto-control").addEventListener("click", () => {
    sim.applyCommand("auto");
    setRunning(true);
  });
  $("#gate-slider").addEventListener("input", (event) => {
    $("#gate-slider-value").textContent = `${event.target.value}%`;
  });
  $("#apply-gate").addEventListener("click", () => {
    sim.applyCommand("gate", { opening: Number($("#gate-slider").value) / 100 });
    setRunning(true);
  });
  $("#run-compare").addEventListener("click", renderComparison);
  $("#close-incident").addEventListener("click", closeIncidentDrawer);
  $("#drawer-backdrop").addEventListener("click", closeIncidentDrawer);
  $("#recover-incident").addEventListener("click", () => {
    const incident = sim.recoverIncident();
    if (!incident) return;
    audio.alarmOnce(`${incident.id}-recovered`, "success");
    closeIncidentDrawer();
    running = true;
    accumulator = 0;
    lastFrame = performance.now();
    updateUI(true);
  });
  $("#replay-incident").addEventListener("click", () => {
    if (currentIncident) startReplay(currentIncident);
  });
  $("#result-close").addEventListener("click", hideResult);

  window.addEventListener("resize", () => renderer.resize());
  window.addEventListener("keydown", (event) => {
    if (event.target.matches("input, select, textarea")) return;
    if (event.code === "Space") {
      event.preventDefault();
      setRunning(!running);
    } else if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (running) setRunning(false);
      stepOnce();
    } else if (event.key === "Escape") {
      closeIncidentDrawer();
    }
  });
}

updateStrategyPanel();
updateScenarioTabs();
createSimulation("normal", "balanced");
bindEvents();
renderComparison();
uiForce = true;
updateUI(true);
requestAnimationFrame(frame);
