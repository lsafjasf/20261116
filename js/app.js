(function () {
  "use strict";

  const core = window.LandslideCore;
  const { SceneRenderer, AlertAudio } = window.LandslideRender;
  const {
    Simulation,
    ANCHORS,
    SENSOR_TYPES,
    ALERT_LEVELS,
    RESCUE_WINDOWS,
    DURATION,
    clamp,
    round,
    formatTime,
    buildDecisionRecord,
    recordToMarkdown,
    runReliabilitySuite,
  } = core;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const SIM_SECONDS_PER_REAL_SECOND = 0.5;
  const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7V5zm6 0h4v14h-4V5z"/></svg>';

  const canvas = $("#scene");
  const audio = new AlertAudio(true);
  let sim = new Simulation({ scenarioId: "normal" });
  let renderer = new SceneRenderer(canvas, {
    onAnchorClick: handleAnchorClick,
    onAnchorHover: () => {},
    onPlacementMiss: () => showToast("请点击坡面上的虚线标记点安装传感器。", "warn"),
  });
  renderer.setSimulation(sim);

  const state = {
    playing: false,
    speed: 1,
    accumulator: 0,
    lastFrame: performance.now(),
    lastUiUpdate: 0,
    activeSensorType: null,
    outcomeShown: false,
    replay: null,
    replayReturn: null,
    lastLogCount: -1,
    lastTimelineCount: -1,
    lastSensorSignature: "",
    testResults: null,
    currentRecord: null,
    soundEnabled: true,
  };

  function showToast(message, kind = "") {
    const region = $("#toastRegion");
    while (region.children.length >= 3) region.firstElementChild.remove();
    const toast = document.createElement("div");
    toast.className = `toast ${kind}`.trim();
    toast.textContent = message;
    region.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(6px)";
      setTimeout(() => toast.remove(), 220);
    }, 3200);
  }

  function setPlaying(playing) {
    if (sim.finished || sim.failed) {
      state.playing = false;
      updateTransport();
      return;
    }
    if (playing) audio.unlock();
    state.playing = playing;
    state.accumulator = 0;
    updateTransport();
  }

  function updateTransport() {
    $("#playBtn").innerHTML = state.playing ? PAUSE_ICON : PLAY_ICON;
    const clockState = $("#clockState");
    if (sim.failed) {
      clockState.textContent = "演练失败";
      clockState.className = "clock-state";
    } else if (sim.finished) {
      clockState.textContent = "记录完成";
      clockState.className = "clock-state live";
    } else if (state.replay) {
      clockState.textContent = state.playing ? "回放运行" : "回放暂停";
      clockState.className = `clock-state ${state.playing ? "live" : ""}`.trim();
    } else {
      clockState.textContent = state.playing ? "实时仿真" : (sim.t ? "已暂停" : "待启动");
      clockState.className = `clock-state ${state.playing ? "live" : ""}`.trim();
    }
  }

  function resetSimulation(scenarioId, options = {}) {
    stopReplay(false);
    sim = new Simulation({ scenarioId, seed: options.seed });
    renderer.setSimulation(sim);
    state.playing = false;
    state.accumulator = 0;
    state.outcomeShown = false;
    state.lastLogCount = -1;
    state.lastTimelineCount = -1;
    state.lastSensorSignature = "";
    state.currentRecord = null;
    state.activeSensorType = null;
    renderer.hoveredAnchor = null;
    renderer.setActiveSensor(null);
    $("#outcomeOverlay").hidden = true;
    $("#replayBtn").disabled = true;
    $("#replayFlag").hidden = true;
    $("#placementHint").hidden = true;
    $$(".sensor-tool").forEach((button) => button.classList.remove("is-active"));
    $$(".scenario-btn").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.scenario === scenarioId);
    });
    $("#testDialog").close();
    updateTransport();
    updateUi(true);
    updateSceneNotice(true);
    showToast(`已载入「${sim.scenario.label}」场景：${sim.scenario.objective}`, "warn");
  }

  function advanceSimulation(seconds) {
    if (sim.finished || sim.failed) return;
    const startTime = sim.t;
    for (let index = 0; index < seconds; index += 1) {
      if (sim.finished || sim.failed) break;
      if (state.replay) applyReplayActions();
      sim.advance();
      if (state.replay && sim.t >= state.replay.endTime) {
        state.playing = false;
        showToast(`回放止于 ${formatTime(sim.t)}，确定性时钟已冻结。`, "warn");
        updateTransport();
        break;
      }
    }
    if (sim.t > startTime) {
      audio.update(sim.alertLevel, true, performance.now());
    }
    updateUi(true);
    updateTransport();
    handleEndState();
  }

  function handleEndState() {
    if (state.outcomeShown) return;
    if (!sim.finished && !sim.failed) return;
    state.playing = false;
    state.outcomeShown = true;
    audio.failure();
    $("#replayBtn").disabled = Boolean(state.replay) || !sim.failed;
    updateTransport();
    showOutcome();
  }

  function showOutcome() {
    const success = sim.finished && sim.getSuccess();
    const overlay = $("#outcomeOverlay");
    const card = overlay.querySelector(".outcome-card");
    card.classList.toggle("failure", !success);
    $("#outcomeKicker").textContent = success ? "MISSION COMPLETE / 02:00:00" : "MISSION FAILED";
    $("#outcomeTitle").textContent = success ? "两小时预警演练成功" : "演练目标未完成";
    $("#outcomeText").textContent = success
      ? "无车辆受伤，救援通道全程可用，恢复观察与全部决策已写入可重复时钟记录。"
      : sim.failureReason || sim.getFailureSummary();
    const margin = round(sim.trueState.stability * 100, 1);
    $("#outcomeStats").innerHTML = `
      <div class="outcome-stat"><span>最终安全余量</span><strong>${margin}%</strong></div>
      <div class="outcome-stat"><span>人员受伤 / 救援延迟</span><strong>${sim.metrics.injuries} / ${sim.metrics.rescueDelays}</strong></div>
      <div class="outcome-stat"><span>决策与状态事件</span><strong>${sim.logs.length} 条</strong></div>
    `;
    $("#outcomeReplayBtn").hidden = success || Boolean(state.replay);
    overlay.hidden = false;
  }

  function hideOutcome() {
    $("#outcomeOverlay").hidden = true;
    state.outcomeShown = false;
  }

  function beginReplay() {
    if (state.replay) {
      showToast("失败回放正在进行。", "warn");
      return;
    }
    if (!sim.failed && !sim.userActions.length && !sim.faults.length) {
      showToast("没有可回放的决策与故障事件。", "warn");
      return;
    }
    const source = {
      scenarioId: sim.scenarioId,
      seed: sim.seed,
      actions: sim.userActions.map((action) => ({
        ...action,
        payload: { ...action.payload },
      })),
      endTime: Math.min(DURATION, (sim.failureTime || sim.t) + 2),
    };
    hideOutcome();
    state.replayReturn = source;
    sim = new Simulation({ scenarioId: source.scenarioId, seed: source.seed });
    renderer.setSimulation(sim);
    state.replay = {
      source,
      index: 0,
      endTime: source.endTime,
    };
    state.playing = true;
    state.speed = 4;
    syncSpeedButtons();
    state.accumulator = 0;
    state.lastLogCount = -1;
    state.lastTimelineCount = -1;
    state.lastSensorSignature = "";
    $("#replayFlag").hidden = false;
    $("#replayBtn").disabled = true;
    $("#outcomeOverlay").hidden = true;
    showToast(`失败回放启动：同一随机种子、同一操作时间轴，终点 ${formatTime(source.endTime)}。`, "warn");
    updateTransport();
    updateUi(true);
  }

  function applyReplayActions() {
    if (!state.replay) return;
    while (
      state.replay.index < state.replay.source.actions.length &&
      state.replay.source.actions[state.replay.index].t <= sim.t
    ) {
      const action = state.replay.source.actions[state.replay.index];
      const payload = action.payload || {};
      if (action.type === "deploy_sensor") sim.addSensor(payload.type, payload.anchorId);
      if (action.type === "issue_warning") sim.issueWarning();
      if (action.type === "set_road_mode") sim.setRoadMode(payload.mode);
      if (action.type === "reinforce") sim.reinforceSlope();
      if (action.type === "repair_fault") sim.repairFault();
      state.replay.index += 1;
    }
  }

  function stopReplay(showMessage = true) {
    if (!state.replay) return;
    state.replay = null;
    state.playing = false;
    $("#replayFlag").hidden = true;
    state.outcomeShown = false;
    if (showMessage) showToast("已退出回放，当前场景回到起点。");
    resetSimulation(sim.scenarioId);
  }

  function syncSpeedButtons() {
    $$(".speed-seg button").forEach((button) => {
      button.classList.toggle("is-active", Number(button.dataset.speed) === state.speed);
    });
  }

  function tickFrame(now) {
    const delta = Math.min(100, now - state.lastFrame);
    state.lastFrame = now;
    if (state.playing && !sim.finished && !sim.failed) {
      state.accumulator += delta / 1000 * SIM_SECONDS_PER_REAL_SECOND * state.speed;
      const wholeSeconds = Math.min(12, Math.floor(state.accumulator));
      if (wholeSeconds > 0) {
        state.accumulator -= wholeSeconds;
        advanceSimulation(wholeSeconds);
      }
    }
    renderer.render(delta);
    audio.update(sim.alertLevel, state.playing, now);
    if (now - state.lastUiUpdate > 150) {
      updateUi(false);
      state.lastUiUpdate = now;
    }
    requestAnimationFrame(tickFrame);
  }

  function updateUi(force) {
    const timeLabel = formatTime(sim.t);
    $("#simClock").textContent = sim.finished ? "02:00:00" : timeLabel;
    const visibleRain = sim.fusedReading("rain");
    const weather = weatherLabel(visibleRain == null ? sim.env.rain : visibleRain);
    $("#weatherBadge").textContent = visibleRain == null
      ? "雨量数据缺失"
      : `${weather} ${round(visibleRain, 1)} mm/h${sim.degraded ? " · 降级估值" : ""}`;
    const alertBadge = $("#alertBadge");
    alertBadge.textContent = ALERT_LEVELS[sim.alertLevel].label;
    alertBadge.className = `badge alert-level-${sim.alertLevel}`;
    $("#qualityBadge").textContent = `传感器 ${sim.sensors.length} / 6`;

    const displacement = sim.fusedReading("displacement");
    const rain = sim.fusedReading("rain");
    const pore = sim.fusedReading("pore");
    setMetric("disp", displacement, 60, displacement == null ? "未部署位移计" : "阈值 24 mm");
    setMetric("rain", rain, 40, rain == null ? "雨量通道不可用" : `累计 ${round(sim.env.cumulativeRain, 1)} mm`);
    setMetric("pore", pore, 20, pore == null ? "未部署孔压计" : "警戒值 13 kPa");

    const margin = sim.trueState.stability * 100;
    $("#marginValue").textContent = round(margin, 1);
    $("#marginBar").style.width = `${clamp(margin, 0, 100)}%`;
    $("#marginBar").style.background = margin > 60 ? "var(--mint)" : margin > 38 ? "var(--amber)" : "var(--red)";
    $("#marginValue").style.color = margin > 60 ? "" : margin > 38 ? "var(--amber)" : "var(--red)";
    const metricCard = $('[data-metric="margin"]');
    metricCard.classList.toggle("is-watch", margin <= 60 && margin > 38);
    metricCard.classList.toggle("is-danger", margin <= 38);
    $("#ttfValue").textContent = sim.timeToFailure >= 998
      ? "预计稳定时间 > 120 min"
      : `预计稳定时间 ${round(sim.timeToFailure, 0)} min`;

    $("#riskPill").textContent = ["低风险", "关注", "高风险", "临界"][sim.alertLevel];
    $("#riskPill").className = `risk-pill level-${sim.alertLevel}`;
    $("#riskScore").textContent = Math.round(sim.alertScore);
    $("#alertOrbit").className = `alert-orbit level-${sim.alertLevel}`;
    $("#alertTitle").textContent = ALERT_LEVELS[sim.alertLevel].title;
    $("#alertDescription").textContent = alertDescription(sim.alertLevel);
    $("#alertReason").textContent = alertReason();

    const warningButton = $("#warningBtn");
    warningButton.disabled = sim.warningIssued || sim.finished || sim.failed || Boolean(state.replay);
    warningButton.textContent = sim.warningIssued
      ? `预警已发布 ${formatTime(sim.warningTime, false)}`
      : `发布${["黄色", "黄色", "橙色", "红色"][sim.alertLevel]}预警`;
    $("#warningMeta").textContent = sim.warningIssued
      ? (sim.falseAlarm ? "记录已标记为低置信度误报；交通处置仍以现场复核为准。" : "预警已写入决策记录，交通管制仍可继续调整。")
      : "预警会写入决策记录；发布后仍可调整交通管制。";

    updateSensorList(force);
    updateRoadControls();
    updateEventLog(force);
    updateTimeline(force);
    updateSceneNotice(force);
    updateTransport();
  }

  function setMetric(prefix, value, max, note) {
    const decimals = prefix === "rain" ? 1 : 1;
    $(`#${prefix}Value`).textContent = value == null ? "--" : round(value, decimals);
    $(`#${prefix}Bar`).style.width = value == null ? "0%" : `${clamp(value / max * 100, 0, 100)}%`;
    $(`#${prefix}Trend`).textContent = note;
    const ratio = value == null ? 0 : value / max;
    $(`#${prefix}Bar`).style.background = ratio > 0.72 ? "var(--red)" : ratio > 0.48 ? "var(--amber)" : "var(--mint)";
  }

  function weatherLabel(rain) {
    if (rain < 0.8) return "无有效降雨";
    if (rain < 8) return "小雨";
    if (rain < 18) return "中雨";
    if (rain < 30) return "大雨";
    return "暴雨";
  }

  function alertDescription(level) {
    const descriptions = [
      "监测数据尚未越过关注阈值。继续布设冗余点位并观察变化速率。",
      "雨量入渗正在抬升孔压，位移开始加速；建议复核预警并准备交通管制。",
      "失稳时间窗口明显缩短，应发布预警、封闭社会车辆并保留救援车道。",
      "坡体接近失稳阈值，必须立即加固并确保救援通道不被全幅封路截断。",
    ];
    return descriptions[level];
  }

  function alertReason() {
    const factors = sim.factors || {};
    const value = (number, unit) => number == null ? "缺测" : `${round(number, 1)}${unit}`;
    return `雨 ${value(factors.rain, "mm/h")} · 位移 ${value(factors.displacement, "mm")} · 孔压 ${value(factors.pore, "kPa")}`;
  }

  function updateSensorList(force) {
    const signature = sim.sensors.map((sensor) =>
      `${sensor.id}:${sensor.status}:${sensor.reading}:${sensor.quality}`
    ).join("|");
    if (!force && signature === state.lastSensorSignature) return;
    state.lastSensorSignature = signature;
    const list = $("#sensorList");
    list.innerHTML = sim.sensors.map((sensor, index) => {
      const spec = SENSOR_TYPES[sensor.type];
      const anchor = ANCHORS.find((item) => item.id === sensor.anchorId);
      const reading = sensor.status === "offline"
        ? "OFFLINE"
        : sensor.status === "outlier"
          ? `${sensor.faultValue}`
          : sensor.reading == null ? "--" : round(sensor.reading, spec.decimals);
      const statusText = sensor.status === "offline"
        ? "通道掉线"
        : sensor.status === "outlier"
          ? "参数越限"
          : `适配度 ${Math.round(sensor.quality * 100)}%`;
      const rowClass = sensor.status === "offline" || sensor.status === "outlier"
        ? "is-fault"
        : sensor.quality < 0.55 ? "is-warn" : "";
      return `
        <div class="sensor-row ${rowClass}">
          <span class="sensor-index">${sensor.fixed ? "R0" : String(index + 1).padStart(2, "0")}</span>
          <span><b>${spec.label} · ${anchor.short}${sensor.fixed ? " · 既有" : ""}</b><small>${statusText}</small></span>
          <span class="sensor-reading"><strong>${reading}</strong><span>${sensor.status === "online" ? spec.unit : sensor.status}</span></span>
        </div>
      `;
    }).join("");
    $("#sensorCount").textContent = `${sim.sensors.length} / 6`;
    $("#qualityBadge").textContent = `传感器 ${sim.sensors.length} / 6`;
  }

  function updateRoadControls() {
    const labels = {
      OPEN: ["open", "社会车辆通行"],
      CONTROLLED: ["controlled", "应急管制 · 救援车道可用"],
      FULL_CLOSED: ["closed", "全幅封路 · 救援中断"],
    };
    const pill = $("#roadPill");
    if (sim.roadBlocked) {
      pill.className = "road-pill blocked";
      pill.textContent = "道路中断";
    } else {
      pill.className = `road-pill ${labels[sim.roadMode][0]}`;
      pill.textContent = labels[sim.roadMode][1];
    }
    const locked = sim.finished || sim.failed || Boolean(state.replay);
    $("#controlBtn").disabled = locked;
    $("#openBtn").disabled = locked;
    $("#closeBtn").disabled = locked;
    $("#reinforceBtn").disabled = locked || sim.reinforcement.count >= 2;
    $("#controlBtn").classList.toggle("is-active", sim.roadMode === "CONTROLLED");
    $("#openBtn").classList.toggle("is-active", sim.roadMode === "OPEN");

    const failedSensor = sim.sensors.find(
      (sensor) => sensor.status === "offline" || sensor.status === "outlier"
    );
    const repairBox = $("#repairBox");
    repairBox.hidden = !failedSensor || sim.observation.active || locked;
    if (failedSensor) {
      const parameter = failedSensor.status === "outlier";
      $("#repairTitle").textContent = parameter ? "参数通道已隔离" : "设备通道已隔离";
      $("#repairText").textContent = `${failedSensor.name} · ${parameter ? "超量程" : "无遥测"} · 待人工复位`;
      $("#repairBtn").textContent = parameter ? "复位参数通道" : "检修并恢复";
    }

    const observationBox = $("#observationBox");
    const showObservation = sim.observation.startedAt != null;
    observationBox.hidden = !showObservation;
    if (showObservation) {
      const remaining = Math.max(0, Math.ceil(sim.observation.remaining));
      const elapsed = 600 - remaining;
      $("#observationClock").textContent = sim.observation.complete
        ? (sim.observation.invalid ? "未通过" : "已通过")
        : `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
      $("#observationBar").style.width = `${clamp(elapsed / 6, 0, 100)}%`;
      observationBox.classList.toggle("is-complete", sim.observation.complete && !sim.observation.invalid);
      $("#observationText").textContent = sim.observation.complete
        ? (sim.observation.invalid
          ? `检测到 ${sim.observation.jumps} 次状态跳变或新故障，恢复未验证。`
          : "连续 10 分钟无重复故障、无状态跳变，未发现隐藏连锁错误。")
        : `固定观察期；监测设备复抖、警戒等级跳变与安全余量是否连续。`;
    }
  }

  function updateEventLog(force) {
    const signature = `${sim.logs.length}:${sim.logs.at(-1)?.id || ""}`;
    if (!force && signature === state.lastLogCount) return;
    state.lastLogCount = signature;
    const log = $("#eventLog");
    const visible = sim.logs.slice(-16);
    if (!visible.length) {
      log.innerHTML = '<div class="empty-log">尚无事件</div>';
      return;
    }
    const shouldStick = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    log.innerHTML = visible.map((event) => `
      <div class="log-row ${event.category}" title="${escapeAttribute(event.detail)}">
        <time>${event.time.slice(0, 5)}</time>
        <i class="log-marker"></i>
        <span>${escapeHtml(event.title)}</span>
      </div>
    `).join("");
    $("#eventCount").textContent = `${sim.logs.length} 条`;
    if (shouldStick) log.scrollTop = log.scrollHeight;
  }

  function updateTimeline(force) {
    const signature = `${sim.logs.length}:${sim.rescueLog.map((item) => item.status).join("")}`;
    if (!force && signature === state.lastTimelineCount) {
      updateTimelineCursor();
      return;
    }
    state.lastTimelineCount = signature;
    const container = $("#timelineEvents");
    container.innerHTML = sim.logs.map((event) => {
      const left = clamp(event.t / DURATION * 100, 0, 100);
      return `<i class="timeline-event ${event.category}" style="left:${left}%" title="${event.time} ${escapeAttribute(event.title)}"></i>`;
    }).join("");
    updateTimelineCursor();
    const latest = sim.logs.at(-1);
    $("#timelineStatus").textContent = latest
      ? `${latest.time} · ${latest.title}`
      : "操作与故障将固定写入仿真时钟";
    sim.rescueLog.forEach((rescue, index) => {
      const marker = $(`.rescue-time[data-rescue="${Math.round(RESCUE_WINDOWS[index] / 60)}"]`);
      if (!marker) return;
      marker.classList.toggle("is-warning", rescue.status === "delayed");
      marker.classList.toggle("is-passed", rescue.status === "passed");
    });
  }

  function updateTimelineCursor() {
    const percent = clamp(sim.t / DURATION * 100, 0, 100);
    $("#timelineProgress").style.width = `${percent}%`;
    $("#timelineCursor").style.left = `${percent}%`;
  }

  function updateSceneNotice(force) {
    const notice = $("#sceneNotice");
    const failedSensor = sim.sensors.find(
      (sensor) => sensor.status === "offline" || sensor.status === "outlier"
    );
    let title = "";
    let detail = "";
    if (sim.failed) {
      title = "边坡失稳";
      detail = sim.failureReason;
    } else if (failedSensor && !sim.observation.active) {
      title = failedSensor.status === "outlier" ? "参数通道越限" : "设备通道隔离";
      detail = `${failedSensor.name} 已自动隔离，等待人工检修与十分钟观察。`;
    } else if (sim.observation.active) {
      title = "恢复后稳定观察";
      detail = `剩余 ${formatTime(sim.observation.remaining, false)}；持续比对设备心跳与警戒等级。`;
    } else if (sim.observation.complete && sim.failed === false) {
      title = sim.observation.invalid ? "恢复观察未通过" : "恢复验证通过";
      detail = sim.observation.invalid
        ? "检测到异常复现或状态跳变，需要重新处置。"
        : "固定观察期内无隐藏连锁错误或状态跳变。";
    } else if (sim.t < 2 && !state.playing && !state.replay) {
      title = `场景目标 · ${sim.scenario.label}`;
      detail = sim.scenario.objective;
    }
    if (title) {
      $("#noticeTitle").textContent = title;
      $("#noticeText").textContent = detail;
      notice.hidden = false;
    } else {
      notice.hidden = true;
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replaceAll('"', "&quot;");
  }

  function handleAnchorClick(anchor) {
    if (!state.activeSensorType) return;
    if (state.replay || sim.finished || sim.failed) {
      showToast("回放与结束状态下不能调整传感器。", "warn");
      return;
    }
    const type = state.activeSensorType;
    const result = sim.addSensor(type, anchor.id);
    if (!result.ok) {
      showToast(result.reason, "warn");
      return;
    }
    const grade = Math.round(result.sensor.quality * 100);
    const qualityNote = grade >= 80 ? "点位适配良好" : grade >= 58 ? "点位可用，噪声中等" : "点位不适配，误报风险较高";
    showToast(`${anchor.name} 已安装${SENSOR_TYPES[type].label}：${qualityNote}（${grade}%）。`, grade < 58 ? "warn" : "");
    audio.pattern(1);
    updateUi(true);
  }

  function selectSensorType(type) {
    if (state.replay || sim.finished || sim.failed) {
      showToast("当前状态不能部署传感器。", "warn");
      return;
    }
    if (state.activeSensorType === type) {
      state.activeSensorType = null;
    } else {
      state.activeSensorType = type;
      audio.unlock();
    }
    renderer.setActiveSensor(state.activeSensorType);
    $$(".sensor-tool").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.sensor === state.activeSensorType);
    });
    const hint = $("#placementHint");
    hint.hidden = !state.activeSensorType;
    if (state.activeSensorType) {
      $("#placementType").textContent = SENSOR_TYPES[state.activeSensorType].label;
    }
  }

  function clearSensorSelection() {
    state.activeSensorType = null;
    renderer.setActiveSensor(null);
    $$(".sensor-tool").forEach((button) => button.classList.remove("is-active"));
    $("#placementHint").hidden = true;
  }

  function currentFaultSensor() {
    return sim.sensors.find(
      (sensor) => sensor.status === "offline" || sensor.status === "outlier"
    );
  }

  function performAction(type) {
    if (state.replay) {
      showToast("回放状态下操作已锁定。", "warn");
      return;
    }
    if (sim.finished || sim.failed) {
      showToast("仿真已结束，请重新演练。", "warn");
      return;
    }
    let result = { ok: false };
    if (type === "warning") result = sim.issueWarning();
    if (type === "control") result = sim.setRoadMode("CONTROLLED");
    if (type === "open") result = sim.setRoadMode("OPEN");
    if (type === "close") result = sim.setRoadMode("FULL_CLOSED");
    if (type === "reinforce") result = sim.reinforceSlope();
    if (type === "repair") result = sim.repairFault();

    if (!result.ok) {
      showToast(result.reason || "操作未生效", "warn");
      return;
    }
    if (type === "warning") {
      audio.pattern(Math.max(1, sim.alertLevel));
      showToast(sim.falseAlarm
        ? "预警已发布；当前证据置信度较低，记录已标记误报风险。"
        : "预警已发布并写入决策记录。", sim.falseAlarm ? "warn" : "");
    } else if (type === "close") {
      showToast("全幅封路已执行：救援通道中断，目标将无法判定为成功。", "danger");
    } else if (type === "repair") {
      showToast("通道已恢复；十分钟稳定观察开始。");
    } else if (type === "reinforce") {
      showToast("坡面加固已启动，失稳速率下降。");
    } else {
      showToast(type === "control" ? "应急管制已启动，救援车道保留。" : "道路通行状态已更新。");
    }
    updateUi(true);
  }

  function bindInteractions() {
    $$(".scenario-btn").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.dataset.scenario === sim.scenarioId && !sim.failed && !sim.finished) return;
        resetSimulation(button.dataset.scenario);
      });
    });
    $$(".sensor-tool").forEach((button) => {
      button.addEventListener("click", () => selectSensorType(button.dataset.sensor));
    });
    $$(".speed-seg button").forEach((button) => {
      button.addEventListener("click", () => {
        state.speed = Number(button.dataset.speed);
        syncSpeedButtons();
      });
    });
    $("#playBtn").addEventListener("click", () => {
      if (sim.finished || sim.failed) {
        showOutcome();
        return;
      }
      setPlaying(!state.playing);
      if (state.playing && sim.t < 2) updateSceneNotice(true);
    });
    $("#stepBtn").addEventListener("click", () => {
      if (sim.finished || sim.failed) return;
      setPlaying(false);
      advanceSimulation(60);
      showToast(`单步推进至 ${formatTime(sim.t)}。`);
    });
    $("#soundBtn").addEventListener("click", () => {
      state.soundEnabled = !state.soundEnabled;
      audio.setEnabled(state.soundEnabled);
      $("#soundBtn").classList.toggle("is-off", !state.soundEnabled);
      $("#soundBtn").setAttribute("aria-pressed", String(state.soundEnabled));
      if (state.soundEnabled) audio.update(sim.alertLevel, true, performance.now());
    });
    $("#warningBtn").addEventListener("click", () => performAction("warning"));
    $("#controlBtn").addEventListener("click", () => performAction("control"));
    $("#openBtn").addEventListener("click", () => performAction("open"));
    $("#closeBtn").addEventListener("click", () => performAction("close"));
    $("#reinforceBtn").addEventListener("click", () => performAction("reinforce"));
    $("#repairBtn").addEventListener("click", () => performAction("repair"));
    $("#replayBtn").addEventListener("click", beginReplay);
    $("#outcomeReplayBtn").addEventListener("click", beginReplay);
    $("#exitReplayBtn").addEventListener("click", () => stopReplay(true));
    $("#outcomeAgainBtn").addEventListener("click", () => resetSimulation(sim.scenarioId));
    $("#exportBtn").addEventListener("click", openExport);
    $("#outcomeExportBtn").addEventListener("click", openExport);
    $("#testBtn").addEventListener("click", openTestDialog);
    $("#runTestsBtn").addEventListener("click", runTests);
    $("#copyReportBtn").addEventListener("click", copyReport);
    $("#downloadMarkdownBtn").addEventListener("click", () => downloadReport("md"));
    $("#downloadJsonBtn").addEventListener("click", () => downloadReport("json"));
    $$("[data-close]").forEach((button) => {
      button.addEventListener("click", () => $("#" + button.dataset.close).close());
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.activeSensorType) clearSensorSelection();
      if (event.key === " " && document.activeElement.tagName !== "BUTTON" && !$("#exportDialog").open && !$("#testDialog").open) {
        event.preventDefault();
        $("#playBtn").click();
      }
    });
  }

  function openExport() {
    const record = buildDecisionRecord(sim);
    state.currentRecord = record;
    const markdown = recordToMarkdown(record);
    state.currentMarkdown = markdown;
    const finalResult = sim.finished
      ? (sim.getSuccess() ? "成功" : "未完成")
      : sim.failed ? "失败" : "进行中";
    $("#exportSummary").innerHTML = `
      <div class="summary-cell"><span>场景</span><strong>${record.scenario.label}</strong></div>
      <div class="summary-cell"><span>记录时刻</span><strong>${record.clock.elapsedLabel}</strong></div>
      <div class="summary-cell"><span>结果</span><strong class="${sim.finished && sim.getSuccess() ? "good" : sim.finished ? "bad" : ""}">${finalResult}</strong></div>
      <div class="summary-cell"><span>故障 / 事件</span><strong>${record.faults.length} / ${record.timeline.length}</strong></div>
    `;
    $("#exportPreview").textContent = markdown;
    $("#exportDialog").showModal();
  }

  async function copyReport() {
    if (!state.currentMarkdown) return;
    try {
      await navigator.clipboard.writeText(state.currentMarkdown);
      showToast("决策记录 Markdown 已复制到剪贴板。");
    } catch (error) {
      const textarea = document.createElement("textarea");
      textarea.value = state.currentMarkdown;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      showToast("决策记录已复制。");
    }
  }

  function downloadReport(format) {
    if (!state.currentRecord) return;
    const base = `landslide-decision-${sim.scenarioId}-${String(sim.t).padStart(5, "0")}`;
    if (format === "md") {
      downloadBlob(state.currentMarkdown, `${base}.md`, "text/markdown;charset=utf-8");
    } else {
      downloadBlob(
        JSON.stringify(state.currentRecord, null, 2),
        `${base}.json`,
        "application/json;charset=utf-8"
      );
    }
  }

  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`已导出 ${filename}`);
  }

  function openTestDialog() {
    $("#testDialog").showModal();
    if (state.testResults) renderTestResults(state.testResults);
  }

  function runTests() {
    const button = $("#runTestsBtn");
    button.disabled = true;
    button.textContent = "正在运行固定步长用例…";
    $("#testResults").innerHTML = '<div class="test-placeholder">仿真推进中：3 × 7,200 个固定秒步长…</div>';
    setTimeout(() => {
      try {
        state.testResults = runReliabilitySuite();
        renderTestResults(state.testResults);
      } catch (error) {
        $("#testResults").innerHTML = `<div class="test-case fail"><div class="test-head"><b>自检执行异常</b><span class="test-status">ERROR</span></div><p>${escapeHtml(error.message)}</p></div>`;
      } finally {
        button.disabled = false;
        button.textContent = "重新运行三组自检";
      }
    }, 50);
  }

  function renderTestResults(results) {
    $("#testResults").innerHTML = results.map((result) => {
      const facts = result.id === "normal"
        ? [
            ["故障注入", "无"],
            ["结果", result.success ? "成功" : "失败"],
            ["恢复观察", "不适用"],
          ]
        : [
            ["故障时刻", result.faultTime || "--"],
            ["当前余量", result.faultMargin == null ? "--" : `${result.faultMargin}%`],
            ["恢复观察", result.observation],
          ];
      const checks = result.checks.map((check) =>
        `<li class="${check.pass ? "" : "bad"}">${escapeHtml(check.label)}</li>`
      ).join("");
      return `
        <article class="test-case ${result.passed ? "pass" : "fail"}">
          <div class="test-head">
            <b>${escapeHtml(result.label)}</b>
            <span class="test-status">${result.passed ? "PASS" : "FAIL"}</span>
          </div>
          <div class="test-grid">
            ${facts.map(([label, value]) =>
              `<div class="test-fact"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`
            ).join("")}
          </div>
          <ul class="test-checks">${checks}</ul>
          ${result.faultResponse ? `<p class="microcopy" style="text-align:left;margin-top:7px">系统响应：${escapeHtml(result.faultResponse)}</p>` : ""}
          ${result.error ? `<p class="microcopy" style="text-align:left;color:var(--red)">执行错误：${escapeHtml(result.error)}</p>` : ""}
        </article>
      `;
    }).join("");
  }

  function boot() {
    bindInteractions();
    syncSpeedButtons();
    updateUi(true);
    updateSceneNotice(true);
    requestAnimationFrame(tickFrame);
  }

  boot();
})();
