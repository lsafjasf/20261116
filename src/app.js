import { Game, MODES, STATE, TICK_MS, hashState, replayRecord } from "./engine.js";
import { HarborAudio } from "./audio.js";
import { HarborRenderer } from "./harbor.js";

const element = (id) => document.getElementById(id);
const ui = {
  seedInput: element("seed-input"),
  soundButton: element("sound-button"),
  soundLabel: element("sound-label"),
  pauseButton: element("pause-button"),
  pauseLabel: element("pause-label"),
  restartButton: element("restart-button"),
  goalText: element("goal-text"),
  phaseLabel: element("phase-label"),
  creditValue: element("credit-value"),
  negotiationValue: element("negotiation-value"),
  creditMeter: element("credit-meter"),
  negotiationMeter: element("negotiation-meter"),
  loadedValue: element("loaded-value"),
  riskValue: element("risk-value"),
  dispatcherCard: element("dispatcher-card"),
  ownerCard: element("owner-card"),
  lastChangeText: element("last-change-text"),
  tickLabel: element("tick-label"),
  countdownChip: element("countdown-chip"),
  countdownValue: element("countdown-value"),
  tideChip: element("tide-chip"),
  cargoList: element("cargo-list"),
  modeList: element("mode-list"),
  inputOwner: element("input-owner"),
  responseTitle: element("response-title"),
  responseDetail: element("response-detail"),
  acceptButton: element("accept-button"),
  delayButton: element("delay-button"),
  eventLog: element("event-log"),
  hashLabel: element("hash-label"),
  footerSeed: element("footer-seed"),
  footerTick: element("footer-tick"),
  footerCheckpoint: element("footer-checkpoint"),
  restoreButton: element("restore-button"),
  replayButton: element("replay-button"),
  saveButton: element("save-button"),
  verifyButton: element("verify-button"),
  beginButton: element("begin-button"),
  startVeil: element("start-veil"),
  pauseVeil: element("pause-veil"),
  reportDialog: element("report-dialog"),
  dialogKicker: element("dialog-kicker"),
  dialogTitle: element("dialog-title"),
  dialogBody: element("dialog-body"),
  dialogPrimary: element("dialog-primary"),
  dialogSecondary: element("dialog-secondary"),
  dialogClose: element("dialog-close"),
  replayBar: element("replay-bar"),
  replayStatus: element("replay-status"),
  replayTick: element("replay-tick"),
  replayPause: element("replay-pause"),
  replaySpeed: element("replay-speed"),
  replayExit: element("replay-exit"),
  canvas: element("harbor-canvas"),
};

let game = new Game(ui.seedInput.value || "PORT-640");
let selectedCargo = lowestRankCargo(game);
let selectedMode = "standard";
let lastCountdownSecond = null;
let lastRenderedHash = "";
let lastTick = 0;
let tickAccumulator = 0;
let previousFrame = performance.now();
let dialogAction = "download";
let saveSnapshot = null;
let replay = createEmptyReplay();
let lastSeenStatus = STATE.READY;

const renderer = new HarborRenderer(ui.canvas);
const audio = new HarborAudio();

function createEmptyReplay() {
  return {
    active: false,
    paused: false,
    done: false,
    speed: 4,
    accumulator: 0,
    record: null,
    game: null,
    inputIndex: 0,
    enteredLivePause: false,
  };
}

function lowestRankCargo(targetGame) {
  return targetGame.state.cargos
    .filter((cargo) => !cargo.loaded)
    .sort((left, right) => left.rank - right.rank)[0]?.id ?? null;
}

function displayGame() {
  return replay.active && replay.game ? replay.game : game;
}

function isLiveInputAllowed(targetGame = game) {
  if (replay.active || targetGame.state.paused) return false;
  return [STATE.REQUESTING, STATE.RESPONDING].includes(targetGame.state.status);
}

function render() {
  const target = displayGame();
  const state = target.state;
  const status = state.status;
  document.body.classList.toggle("status-won", status === STATE.WON);
  document.body.classList.toggle("status-lost", status === STATE.LOST);
  document.body.classList.toggle("replaying", replay.active);

  const paused = replay.active ? replay.paused : state.paused;
  const goalPrefix = paused ? "已暂停 · " : replay.active ? "回放 · " : "";
  ui.goalText.textContent = goalPrefix + target.currentGoal();
  ui.phaseLabel.textContent = replay.active ? (replay.done ? "回放完成" : "回放中") : target.phaseLabel();
  ui.creditValue.textContent = String(state.credit);
  ui.negotiationValue.textContent = String(state.negotiation);
  ui.loadedValue.textContent = `${state.loaded.length} / 4`;
  ui.riskValue.textContent = String(state.stats.delays + state.stats.timeouts + state.stats.wrongOrder);
  ui.creditMeter.style.width = `${Math.max(0, Math.min(100, (state.credit / 60) * 100))}%`;
  ui.creditMeter.style.background = state.credit <= 15 ? "var(--coral)" : "var(--mint)";
  ui.negotiationMeter.style.width = `${Math.max(0, Math.min(100, (state.negotiation / 14) * 100))}%`;

  const activeSeat = status === STATE.RESPONDING ? target.responderRole() : state.activeRole;
  renderRole(ui.dispatcherCard, "dispatcher", activeSeat, target);
  renderRole(ui.ownerCard, "owner", activeSeat, target);
  ui.lastChangeText.textContent = state.lastChange.text;
  ui.tickLabel.textContent = `T+${state.tick}`;
  ui.footerSeed.textContent = state.seed;
  ui.footerTick.textContent = String(state.tick);
  ui.hashLabel.textContent = `HASH ${target.hash()}`;
  ui.tideChip.textContent = `潮汐序列 ${state.randomForecast.slice(0, 3).join(" · ")}`;
  ui.inputOwner.textContent = replay.active
    ? "回放只读"
    : state.paused
      ? "已暂停"
      : `${target.roleName(state.activeRole)}操作`;

  renderCargos(target);
  renderModes(target);
  renderResponse(target);
  updateCountdown(target);
  renderLog(target);
  renderControls(target);
  ui.startVeil.classList.toggle("visible", !replay.active && status === STATE.READY);
  ui.pauseVeil.classList.toggle("visible", !replay.active && state.paused);
  ui.replayBar.hidden = !replay.active;
  lastRenderedHash = target.hash();
  lastTick = state.tick;
}

function renderRole(card, role, activeSeat, target) {
  const state = target.state;
  const active = role === activeSeat && ![STATE.WON, STATE.LOST].includes(state.status);
  card.classList.toggle("active", active);
  const label = card.querySelector(".role-state");
  if (state.status === STATE.RESPONDING && role === target.responderRole()) {
    label.textContent = "请回应";
  } else if (state.status === STATE.RESPONDING && role === state.activeRole) {
    label.textContent = "已发请求";
  } else if (state.status === STATE.REQUESTING && role === state.activeRole) {
    label.textContent = "提出请求";
  } else if (state.status === STATE.WON) {
    label.textContent = role === "dispatcher" ? "装船完成" : "货物交接";
  } else if (state.status === STATE.LOST) {
    label.textContent = "流程中断";
  } else {
    label.textContent = state.paused ? "冻结" : "待命";
  }
}

function renderCargos(target) {
  const state = target.state;
  if (!state.cargos.some((cargo) => cargo.id === selectedCargo && !cargo.loaded)) {
    selectedCargo = lowestRankCargo(target);
  }
  ui.cargoList.replaceChildren();
  for (const cargo of state.cargos) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cargo-card";
    button.classList.toggle("selected", cargo.id === selectedCargo);
    button.classList.toggle("loaded", cargo.loaded);
    button.disabled =
      cargo.loaded ||
      replay.active ||
      state.paused ||
      state.status !== STATE.REQUESTING;
    button.style.setProperty("--cargo-tone", cargo.tone);
    button.innerHTML = `
      <span class="cargo-icon">${cargo.code}</span>
      <span class="cargo-copy">
        <strong>${cargo.name}</strong>
        <span>${cargo.loaded ? `已装 ${cargo.loadedSlot} 号货位` : "等待优先权"}</span>
      </span>
      <span class="priority-tag">P${cargo.rank}</span>
    `;
    button.addEventListener("click", () => {
      selectedCargo = cargo.id;
      audio.play("select");
      render();
    });
    ui.cargoList.append(button);
  }
}

function renderModes(target) {
  const state = target.state;
  ui.modeList.replaceChildren();
  for (const mode of Object.values(MODES)) {
    const cost = mode.baseCost + state.refusalLevel;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mode-button";
    button.disabled =
      replay.active ||
      state.paused ||
      state.status !== STATE.REQUESTING ||
      !selectedCargo ||
      state.negotiation < cost;
    button.innerHTML = `
      <span>
        <strong>${mode.name}</strong>
        <small>${mode.detail}</small>
      </span>
      <span class="mode-cost">${cost} 点</span>
    `;
    button.addEventListener("click", () => sendRequest(mode.id));
    button.title = `发送「${mode.name}」请求`;
    ui.modeList.append(button);
  }
  ui.modeList.querySelectorAll(".mode-button")[0]?.setAttribute("data-mode", "escort");
}

function renderResponse(target) {
  const state = target.state;
  const canRespond =
    !replay.active && !state.paused && state.status === STATE.RESPONDING && Boolean(state.current);
  ui.acceptButton.disabled = !canRespond;
  ui.delayButton.disabled = !canRespond;
  if (state.status === STATE.RESPONDING && state.current) {
    const cargo = state.cargos.find((item) => item.id === state.current.cargoId);
    const mode = MODES[state.current.modeId];
    ui.responseTitle.textContent = `${cargo.name} · ${mode.name}`;
    ui.responseDetail.textContent = `${target.roleName(target.responderRole())}回应；接受支付 ${state.current.cost} 协商点，延迟损失 3 信用并把下次成本抬高 1 点。`;
  } else if (state.status === STATE.WON) {
    ui.responseTitle.textContent = "四票货物完成装船";
    ui.responseDetail.textContent = state.outcome?.text ?? "港口信用保持为正，协商成功。";
  } else if (state.status === STATE.LOST) {
    ui.responseTitle.textContent = "流程失败";
    ui.responseDetail.textContent = "恢复最近安全检查点，再决定是否继续或重开。";
  } else if (state.paused) {
    ui.responseTitle.textContent = "倒计时已冻结";
    ui.responseDetail.textContent = "恢复后继续当前协商，不消耗暂停期间的时间。";
  } else {
    ui.responseTitle.textContent = "等待提出请求";
    ui.responseDetail.textContent = "接受会扣协商点并装船；延迟会损耗信用，并抬高下一次成本。";
  }
}

function renderLog(target) {
  ui.eventLog.replaceChildren();
  for (const entry of target.state.history.slice(-6).reverse()) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = `T+${entry.tick}`;
    const text = document.createElement("span");
    text.textContent = entry.text;
    item.append(time, text);
    ui.eventLog.append(item);
  }
  const checkpoint = target.checkpointInfo();
  ui.footerCheckpoint.textContent = checkpoint
    ? `T+${checkpoint.tick} / ${checkpoint.loaded}票`
    : "--";
  ui.restoreButton.disabled = !checkpoint || replay.active;
}

function renderControls(target) {
  const paused = replay.active ? replay.paused : target.state.paused;
  ui.pauseLabel.textContent = paused ? "继续" : "暂停";
  ui.pauseButton.disabled =
    replay.active ? replay.done : [STATE.READY, STATE.WON, STATE.LOST].includes(target.state.status);
  ui.restartButton.disabled = false;
  ui.seedInput.disabled = replay.active;
  ui.soundButton.setAttribute("aria-pressed", String(audio.enabled));
  ui.soundLabel.textContent = audio.enabled ? "声音开" : "声音关";
}

function updateCountdown(target = displayGame()) {
  const state = target.state;
  const current = state.current;
  if (!current || state.status !== STATE.RESPONDING) {
    ui.countdownValue.textContent = "--";
    ui.countdownChip.classList.remove("urgent");
    return;
  }
  const remainingTicks = Math.max(0, current.expiresAt - state.tick);
  const seconds = remainingTicks / (1000 / TICK_MS);
  ui.countdownValue.textContent = `${seconds.toFixed(1)}s`;
  ui.countdownChip.classList.toggle("urgent", seconds <= 5);
}

function sendRequest(modeId) {
  if (!selectedCargo || !isLiveInputAllowed()) return;
  selectedMode = modeId;
  const result = game.propose(selectedCargo, modeId);
  if (!result.ok) {
    showDialog({
      kicker: "REQUEST BLOCKED",
      title: "请求未发出",
      body: reasonText(result.reason),
      primary: "知道了",
      action: "close",
    });
    return;
  }
  audio.play("request");
  lastCountdownSecond = null;
  afterLiveInput();
}

function answerRequest(decision) {
  if (!isLiveInputAllowed()) return;
  const result = game.respond(decision);
  if (!result.ok) {
    if (result.reason === "REQUEST_TIMED_OUT") {
      audio.play("timeout");
      render();
      return;
    }
    showDialog({
      kicker: "RESPONSE BLOCKED",
      title: "回应未生效",
      body: reasonText(result.reason),
      primary: "知道了",
      action: "close",
    });
    return;
  }
  audio.play(decision === "accept" ? "accept" : "delay");
  lastCountdownSecond = null;
  afterLiveInput();
}

function afterLiveInput() {
  persistRecord();
  updateTerminalFeedback();
  render();
}

function updateTerminalFeedback() {
  if (game.state.status === lastSeenStatus) return;
  if (game.state.status === STATE.WON) audio.play("win");
  if (game.state.status === STATE.LOST) audio.play("lose");
  lastSeenStatus = game.state.status;
}

function reasonText(reason) {
  return (
    {
      PAUSED: "协商暂停时不能提交输入。",
      NOT_REQUESTING: "当前状态机不在“提出请求”阶段。",
      NO_ACTIVE_REQUEST: "没有可回应的优先权请求。",
      CARGO_ALREADY_LOADED: "该货物已经装船。",
      INSUFFICIENT_NEGOTIATION: "协商点不足，请先降低请求等级或恢复检查点。",
      UNKNOWN_CARGO: "货物参数无效。",
      UNKNOWN_MODE: "优先权参数无效。",
      BAD_DECISION: "未知的回应类型。",
    }[reason] ?? `操作被状态机拒绝：${reason}`
  );
}

function togglePause() {
  if (replay.active) {
    replay.paused = !replay.paused;
    audio.reset();
    updateReplayBar();
    render();
    return;
  }
  if (!game.togglePause()) return;
  lastCountdownSecond = null;
  audio.reset();
  persistRecord();
  render();
}

function beginGame() {
  audio.ensure();
  audio.play("select");
  game.start();
  selectedCargo = lowestRankCargo(game);
  lastSeenStatus = game.state.status;
  renderer.reset();
  render();
}

function restartGame() {
  if (replay.active) exitReplay();
  const seed = ui.seedInput.value.trim() || "PORT-640";
  ui.seedInput.value = seed;
  game = new Game(seed);
  game.start();
  selectedCargo = lowestRankCargo(game);
  selectedMode = "standard";
  lastCountdownSecond = null;
  lastSeenStatus = game.state.status;
  lastRenderedHash = "";
  lastTick = 0;
  tickAccumulator = 0;
  audio.reset();
  renderer.reset();
  persistRecord();
  render();
}

function restoreCheckpoint() {
  if (replay.active) return;
  const result = game.restoreCheckpoint();
  if (!result.ok) return;
  audio.reset();
  audio.play("select");
  selectedCargo = lowestRankCargo(game);
  lastCountdownSecond = null;
  lastSeenStatus = game.state.status;
  tickAccumulator = 0;
  renderer.reset();
  persistRecord();
  render();
}

function toggleSound() {
  const enabled = audio.toggle();
  if (enabled) audio.play("select");
  render();
}

function persistRecord() {
  try {
    localStorage.setItem("berth-04-live-record", JSON.stringify(game.toRecord()));
  } catch {
    // Storage can be unavailable in private or embedded contexts.
  }
}

function showDialog({ kicker, title, body, primary, action }) {
  ui.dialogKicker.textContent = kicker;
  ui.dialogTitle.textContent = title;
  ui.dialogBody.textContent = body;
  ui.dialogPrimary.textContent = primary;
  dialogAction = action;
  if (typeof ui.reportDialog.showModal === "function") ui.reportDialog.showModal();
  else ui.reportDialog.setAttribute("open", "");
}

function closeDialog() {
  if (typeof ui.reportDialog.close === "function") ui.reportDialog.close();
  else ui.reportDialog.removeAttribute("open");
}

function saveCurrentRecord() {
  saveSnapshot = game.toRecord();
  showDialog({
    kicker: "DETERMINISTIC RECORD",
    title: "seed 与输入记录",
    body: JSON.stringify(saveSnapshot, null, 2),
    primary: "下载 JSON",
    action: "download",
  });
}

function verifyCurrentRecord() {
  const record = game.toRecord();
  const result = replayRecord(record);
  const passed = result.matches;
  showDialog({
    kicker: passed ? "HASH VERIFIED" : "HASH MISMATCH",
    title: passed ? "最终状态哈希一致" : "复算未通过",
    body: [
      `seed       ${record.seed}`,
      `inputs     ${record.inputs.length}`,
      `final tick ${record.finalTick}`,
      `saved      ${record.finalHash}`,
      `replayed   ${result.finalHash}`,
      `status     ${result.game.state.status}`,
      "",
      passed ? "同 seed 与输入记录复算成功，最终状态完全一致。" : "请保存现场 JSON 以排查。",
    ].join("\n"),
    primary: "关闭",
    action: "close",
  });
}

function downloadRecord(record) {
  const payload = JSON.stringify(record, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `berth-04-${record.seed.replace(/[^a-zA-Z0-9_-]/g, "_")}-${record.finalHash}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function startReplay() {
  if (replay.active) return;
  const record = game.toRecord();
  replay = {
    active: true,
    paused: false,
    done: false,
    speed: 4,
    accumulator: 0,
    record,
    game: new Game(record.seed, { tickMs: record.tickMs }),
    inputIndex: 0,
    enteredLivePause: false,
  };
  replay.game.start();
  tickAccumulator = 0;
  lastCountdownSecond = null;
  audio.reset();
  renderer.reset();
  updateReplayBar();
  render();
}

function exitReplay() {
  if (!replay.active) return;
  replay = createEmptyReplay();
  tickAccumulator = 0;
  previousFrame = performance.now();
  audio.reset();
  renderer.reset();
  updateReplayBar();
  render();
}

function advanceReplay(deltaMs) {
  if (!replay.active || replay.paused || replay.done) return;
  replay.accumulator += (deltaMs / TICK_MS) * replay.speed;
  let budget = Math.floor(replay.accumulator);
  replay.accumulator -= budget;
  const target = replay.game;
  const record = replay.record;
  let guard = 0;

  while (budget > 0 && guard < 50000) {
    guard += 1;
    const nextInput = record.inputs[replay.inputIndex];
    if (nextInput && nextInput.atTick <= target.state.tick) {
      applyReplayInput(nextInput);
      replay.inputIndex += 1;
      continue;
    }
    if (!nextInput && target.state.tick >= record.finalTick) {
      finishReplay();
      break;
    }
    if (target.state.tick >= record.finalTick) {
      finishReplay();
      break;
    }
    const requested = nextInput ? Math.min(budget, nextInput.atTick - target.state.tick) : budget;
    const step = Math.max(1, Math.min(requested, record.finalTick - target.state.tick));
    const advanced = target.tick(step);
    if (!advanced) {
      finishReplay();
      break;
    }
    budget -= step;
  }
  if (target.hash() !== lastRenderedHash) {
    render();
  } else {
    updateCountdown(target);
  }
  updateReplayBar();
}

function applyReplayInput(input) {
  if (input.action === "propose") {
    replay.game.propose(input.cargoId, input.modeId);
  } else if (input.action === "respond") {
    replay.game.respond(input.decision);
  } else if (input.action === "restore") {
    replay.game.restoreCheckpoint();
  } else if (input.action === "pause") {
    replay.game.setPaused(input.paused);
  }
}

function finishReplay() {
  if (replay.done) return;
  replay.done = true;
  replay.paused = false;
  const finalHash = replay.game.hash();
  const match = finalHash === replay.record.finalHash;
  replay.record.verified = match;
  updateReplayBar();
  render();
}

function updateReplayBar() {
  if (!replay.active) {
    ui.replayBar.hidden = true;
    return;
  }
  ui.replayBar.hidden = false;
  ui.replayTick.textContent = `T+${replay.game.state.tick}`;
  ui.replayPause.textContent = replay.paused ? "继续" : "暂停";
  ui.replaySpeed.textContent = `${replay.speed}×`;
  if (replay.done) {
    const finalHash = replay.game.hash();
    ui.replayStatus.textContent =
      finalHash === replay.record.finalHash ? `完成 · ${finalHash} 一致` : `完成 · ${finalHash} 不一致`;
  } else {
    ui.replayStatus.textContent = replay.paused ? "已暂停" : "按输入记录复演";
  }
}

function cycleReplaySpeed() {
  const speeds = [1, 4, 16];
  const index = speeds.indexOf(replay.speed);
  replay.speed = speeds[(index + 1) % speeds.length];
  updateReplayBar();
}

function liveAudioTick(previousState) {
  if (game.state.stats.timeouts > previousState.timeouts) audio.play("timeout");
  if (!game.state.current || game.state.status !== STATE.RESPONDING || game.state.paused) {
    lastCountdownSecond = null;
    return;
  }
  const seconds = Math.ceil((game.state.current.expiresAt - game.state.tick) / (1000 / TICK_MS));
  if (seconds <= 5 && seconds > 0 && seconds !== lastCountdownSecond) {
    lastCountdownSecond = seconds;
    audio.countdown(seconds);
  }
}

function frame(now) {
  const delta = Math.min(250, Math.max(0, now - previousFrame));
  previousFrame = now;

  if (replay.active) {
    advanceReplay(delta);
  } else if (!game.state.paused && [STATE.REQUESTING, STATE.RESPONDING].includes(game.state.status)) {
    tickAccumulator += delta;
    const steps = Math.floor(tickAccumulator / TICK_MS);
    if (steps > 0) {
      tickAccumulator -= steps * TICK_MS;
      const before = {
        status: game.state.status,
        timeouts: game.state.stats.timeouts,
      };
      game.tick(steps);
      liveAudioTick(before);
      updateTerminalFeedback();
      if (game.hash() !== lastRenderedHash) render();
    }
  }

  updateCountdown(displayGame());
  renderer.draw(displayGame(), { phase: displayGame().phaseLabel() });
  requestAnimationFrame(frame);
}

ui.beginButton.addEventListener("click", beginGame);
ui.pauseButton.addEventListener("click", togglePause);
ui.restartButton.addEventListener("click", restartGame);
ui.soundButton.addEventListener("click", toggleSound);
ui.acceptButton.addEventListener("click", () => answerRequest("accept"));
ui.delayButton.addEventListener("click", () => answerRequest("delay"));
ui.restoreButton.addEventListener("click", restoreCheckpoint);
ui.replayButton.addEventListener("click", startReplay);
ui.saveButton.addEventListener("click", saveCurrentRecord);
ui.verifyButton.addEventListener("click", verifyCurrentRecord);
ui.replayPause.addEventListener("click", togglePause);
ui.replaySpeed.addEventListener("click", cycleReplaySpeed);
ui.replayExit.addEventListener("click", exitReplay);
ui.dialogClose.addEventListener("click", closeDialog);
ui.dialogSecondary.addEventListener("click", closeDialog);
ui.dialogPrimary.addEventListener("click", () => {
  if (dialogAction === "download") downloadRecord(saveSnapshot ?? game.toRecord());
  closeDialog();
});
ui.seedInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") restartGame();
});
window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key.toLowerCase() === "p") togglePause();
  if (event.key === "Escape" && ui.reportDialog.open) closeDialog();
});

globalThis.__berth = {
  get game() {
    return game;
  },
  get replayGame() {
    return replay.game;
  },
  get replayState() {
    return replay;
  },
  start: beginGame,
  restart: restartGame,
  propose: (cargoId, modeId) => {
    selectedCargo = cargoId;
    sendRequest(modeId);
  },
  respond: answerRequest,
  pause: togglePause,
  restore: restoreCheckpoint,
  record: () => game.toRecord(),
  replayRecord,
  hashState,
  renderer,
  audio,
};

render();
requestAnimationFrame(frame);
