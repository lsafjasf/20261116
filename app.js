(() => {
  "use strict";

  const STORAGE_KEY = "echo-relay.state.v1";
  const BACKUP_KEY = "echo-relay.snapshot.v1";
  const SCHEMA_VERSION = 1;
  const ROWS = 5;
  const COLS = 5;
  const MAX_LOG_ITEMS = 40;
  const KEY_POSITION = { x: 2, y: 1 };
  const EXIT_POSITION = { x: 4, y: 4 };

  const DIRECTIONS = {
    up: { dx: 0, dy: -1, label: "北", arrow: "↑", key: "ArrowUp" },
    right: { dx: 1, dy: 0, label: "东", arrow: "→", key: "ArrowRight" },
    down: { dx: 0, dy: 1, label: "南", arrow: "↓", key: "ArrowDown" },
    left: { dx: -1, dy: 0, label: "西", arrow: "←", key: "ArrowLeft" },
  };

  const KEY_TO_DIRECTION = {
    ArrowUp: "up",
    ArrowRight: "right",
    ArrowDown: "down",
    ArrowLeft: "left",
    w: "up",
    d: "right",
    s: "down",
    a: "left",
    W: "up",
    D: "right",
    S: "down",
    A: "left",
  };

  const KIND_LABELS = {
    start: "起点",
    safe: "安全格",
    key: "信号钥匙",
    hazard: "脉冲危险区",
    exit: "出口",
  };

  const els = {};
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let ctx = null;
  let canvasSize = 640;
  let dialogReturnFocus = null;
  let saveTimer = 0;
  let scrollSaveTimer = 0;
  let animationFrame = 0;
  let lastPaintedAt = 0;
  let lastAnnouncement = { text: "", at: 0 };
  let persistencePaused = false;

  function coord(position) {
    return `${String.fromCharCode(65 + position.x)}${position.y + 1}`;
  }

  function parseCoord(text) {
    const match = /^([A-E])([1-5])$/.exec(text);
    if (!match) return null;
    return { x: match[1].charCodeAt(0) - 65, y: Number(match[2]) - 1 };
  }

  function samePosition(a, b) {
    return Boolean(a && b && a.x === b.x && a.y === b.y);
  }

  function inBounds(position) {
    return position.x >= 0 && position.x < COLS && position.y >= 0 && position.y < ROWS;
  }

  function clonePosition(position) {
    return { x: position.x, y: position.y };
  }

  function cellAt(position) {
    if (!inBounds(position)) return null;
    if (samePosition(position, { x: 0, y: 0 })) return { kind: "start", title: "起点" };
    if (samePosition(position, KEY_POSITION)) return { kind: "key", title: "信号钥匙" };
    if (samePosition(position, EXIT_POSITION)) return { kind: "exit", title: "出口" };
    if (
      samePosition(position, { x: 1, y: 2 }) ||
      samePosition(position, { x: 3, y: 2 }) ||
      samePosition(position, { x: 2, y: 3 })
    ) {
      return { kind: "hazard", title: "脉冲危险区" };
    }
    return { kind: "safe", title: "安全格" };
  }

  function defaultState() {
    return {
      version: SCHEMA_VERSION,
      game: {
        player: { x: 0, y: 0 },
        selected: { x: 0, y: 0 },
        hasKey: false,
        status: "playing",
        turn: 0,
        lastResult: {
          tone: "info",
          message: "你在 A1。先向东方前往 C2，取得信号钥匙。",
        },
        undoStack: [],
      },
      draft: { text: "", submitted: false },
      logs: [],
      ui: {
        scrollY: 0,
        logScroll: 0,
        input: "等待输入",
        focusId: "",
      },
      meta: {
        savedAt: null,
        renderRev: 0,
        restoreStatus: "new",
        storageError: "",
      },
    };
  }

  function isPosition(value) {
    return (
      value &&
      Number.isInteger(value.x) &&
      Number.isInteger(value.y) &&
      value.x >= 0 &&
      value.x < COLS &&
      value.y >= 0 &&
      value.y < ROWS
    );
  }

  function isValidState(value) {
    if (!value || typeof value !== "object") return false;
    if (value.version !== SCHEMA_VERSION) return false;
    if (!value.game || typeof value.game !== "object") return false;
    if (!isPosition(value.game.player) || !isPosition(value.game.selected)) return false;
    if (typeof value.game.hasKey !== "boolean") return false;
    if (!["playing", "won"].includes(value.game.status)) return false;
    if (!Number.isInteger(value.game.turn) || value.game.turn < 0) return false;
    if (!value.game.lastResult || typeof value.game.lastResult.message !== "string") return false;
    if (!Array.isArray(value.game.undoStack)) return false;
    if (!value.draft || typeof value.draft.text !== "string") return false;
    if (!Array.isArray(value.logs)) return false;
    if (!value.ui || typeof value.ui !== "object") return false;
    if (!value.meta || typeof value.meta !== "object") return false;
    return true;
  }

  function normalizeState(value) {
    const next = defaultState();
    next.version = SCHEMA_VERSION;
    next.game.player = clonePosition(value.game.player);
    next.game.selected = clonePosition(value.game.selected);
    next.game.hasKey = value.game.hasKey;
    next.game.status = value.game.status;
    next.game.turn = value.game.turn;
    next.game.lastResult = {
      tone: ["info", "success", "warning", "error"].includes(value.game.lastResult.tone)
        ? value.game.lastResult.tone
        : "info",
      message: value.game.lastResult.message.slice(0, 500),
    };
    next.game.undoStack = value.game.undoStack
      .filter((entry) => entry && isPosition(entry.player) && typeof entry.hasKey === "boolean")
      .slice(-30)
      .map((entry) => ({
        player: clonePosition(entry.player),
        hasKey: entry.hasKey,
        status: entry.status === "won" ? "won" : "playing",
        turn: Number.isInteger(entry.turn) ? entry.turn : 0,
        lastResult: {
          tone: entry.lastResult?.tone || "info",
          message: String(entry.lastResult?.message || "").slice(0, 500),
        },
      }));
    next.draft.text = value.draft.text.slice(0, 240);
    next.draft.submitted = Boolean(value.draft.submitted);
    next.logs = value.logs
      .filter((entry) => entry && typeof entry.message === "string")
      .slice(-MAX_LOG_ITEMS)
      .map((entry) => ({
        id: String(entry.id || ""),
        time: String(entry.time || ""),
        kind: String(entry.kind || "info"),
        input: String(entry.input || ""),
        message: entry.message.slice(0, 500),
      }));
    next.ui.scrollY = Number.isFinite(value.ui.scrollY) ? Math.max(0, value.ui.scrollY) : 0;
    next.ui.logScroll = Number.isFinite(value.ui.logScroll)
      ? Math.max(0, value.ui.logScroll)
      : 0;
    next.ui.input = typeof value.ui.input === "string" ? value.ui.input.slice(0, 80) : "等待输入";
    next.ui.focusId = typeof value.ui.focusId === "string" ? value.ui.focusId.slice(0, 80) : "";
    next.meta.savedAt = typeof value.meta.savedAt === "string" ? value.meta.savedAt : null;
    next.meta.renderRev = Number.isInteger(value.meta.renderRev) ? value.meta.renderRev : 0;
    next.meta.restoreStatus = "restored";
    next.meta.storageError = "";
    return next;
  }

  function readSnapshot(key) {
    const raw = localStorage.getItem(key);
    if (!raw) return { found: false, value: null, error: "" };
    try {
      const parsed = JSON.parse(raw);
      if (!isValidState(parsed)) {
        return { found: true, value: null, error: "结构校验未通过" };
      }
      return { found: true, value: normalizeState(parsed), error: "" };
    } catch {
      return { found: true, value: null, error: "JSON 无法解析" };
    }
  }

  function loadState() {
    try {
      const primary = readSnapshot(STORAGE_KEY);
      if (primary.value) {
        primary.value.meta.restoreStatus = "restored";
        return primary.value;
      }

      const backup = readSnapshot(BACKUP_KEY);
      if (backup.value) {
        backup.value.meta.restoreStatus = "recovered";
        backup.value.meta.storageError =
          `主存档恢复失败（${primary.error || "存档不存在"}），已载入上一份可读快照。`;
        return backup.value;
      }

      if (!primary.found && !backup.found) {
        return defaultState();
      }

      const fallback = defaultState();
      fallback.meta.restoreStatus = "failed";
      fallback.meta.storageError =
        `存档恢复失败（${primary.error || backup.error || "没有可读数据"}）。已保留当前可读快照。`;
      return fallback;
    } catch {
      const fallback = defaultState();
      fallback.meta.restoreStatus = "failed";
      fallback.meta.storageError = "浏览器拒绝读取本地存储。已保留当前可读快照。";
      return fallback;
    }
  }

  let state = loadState();

  function objective() {
    if (!state.game.hasKey) {
      return {
        kind: "key",
        label: "C2 的信号钥匙",
        position: KEY_POSITION,
      };
    }
    return {
      kind: "exit",
      label: "E5 出口",
      position: EXIT_POSITION,
    };
  }

  function objectiveDirection() {
    const target = objective().position;
    const dx = target.x - state.game.player.x;
    const dy = target.y - state.game.player.y;
    if (dx === 0 && dy === 0) {
      return { label: "已抵达", detail: "当前目标就在脚下", target };
    }

    const vertical = dy < 0 ? "北" : dy > 0 ? "南" : "";
    const horizontal = dx < 0 ? "西" : dx > 0 ? "东" : "";
    const label = `${horizontal}${vertical}方`;
    const parts = [];
    if (horizontal) parts.push(`向${horizontal} ${Math.abs(dx)} 格`);
    if (vertical) parts.push(`向${vertical} ${Math.abs(dy)} 格`);
    return { label, detail: parts.join("、"), target };
  }

  function adjacentHazards() {
    const hazards = [];
    for (const [key, direction] of Object.entries(DIRECTIONS)) {
      const position = {
        x: state.game.player.x + direction.dx,
        y: state.game.player.y + direction.dy,
      };
      if (inBounds(position) && cellAt(position).kind === "hazard") {
        hazards.push({ key, position, direction });
      }
    }
    return hazards;
  }

  function dangerDescription() {
    const hazards = adjacentHazards();
    if (!hazards.length) {
      return {
        short: "无",
        long: "当前危险：无。附近没有可进入的脉冲危险格。",
        hasDanger: false,
      };
    }
    const details = hazards
      .map(({ position, direction }) => `${direction.label}侧 ${coord(position)}`)
      .join("、");
    return {
      short: `${hazards.length} 格 · ${details}`,
      long: `当前危险：${details} 有脉冲危险区，共 ${hazards.length} 格；进入会使移动失败。`,
      hasDanger: true,
    };
  }

  function selectedCell() {
    return cellAt(state.game.selected);
  }

  function selectedDescription() {
    const cell = selectedCell();
    const atPlayer = samePosition(state.game.selected, state.game.player);
    const parts = [];
    if (cell.kind === "start") parts.push("起点。");
    if (cell.kind === "safe") parts.push("安全格。");
    if (cell.kind === "key") {
      parts.push(state.game.hasKey ? "信号钥匙已被取走。" : "取得它后，出口将解锁。");
    }
    if (cell.kind === "hazard") parts.push("不可进入；进入会触发移动失败。");
    if (cell.kind === "exit") {
      parts.push(state.game.hasKey ? "出口已解锁。" : "出口锁定，需要先取得信号钥匙。");
    }
    if (atPlayer) parts.push("你的当前位置。");
    return parts.join(" ");
  }

  function targetSummary() {
    const target = objective();
    const direction = objectiveDirection();
    return `${coord(target.position)} · ${direction.label}`;
  }

  function currentStatusText() {
    if (state.game.status === "won") {
      return "任务完成：钥匙已取得，玩家已抵达 E5 出口。";
    }
    if (state.game.hasKey) {
      return "任务状态：钥匙已取得，出口已解锁；尚未抵达 E5 出口。";
    }
    return "任务状态：进行中，尚未取得信号钥匙，尚未抵达出口。";
  }

  function statusLabel() {
    return state.game.status === "won" ? "任务已完成" : "任务进行中";
  }

  function timeLabel(iso = new Date().toISOString()) {
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(iso));
    } catch {
      return "--:--:--";
    }
  }

  function makeLog(kind, input, message) {
    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      time: new Date().toISOString(),
      kind,
      input,
      message,
    };
  }

  function addLog(kind, input, message) {
    state.logs.push(makeLog(kind, input, message));
    state.logs = state.logs.slice(-MAX_LOG_ITEMS);
  }

  function captureScroll() {
    state.ui.scrollY = Math.max(0, window.scrollY || document.documentElement.scrollTop || 0);
    state.ui.logScroll = els.logScroll ? Math.max(0, els.logScroll.scrollTop) : state.ui.logScroll;
  }

  function restoreScroll() {
    window.scrollTo({ top: state.ui.scrollY, left: 0, behavior: "instant" });
    if (els.logScroll) {
      els.logScroll.scrollTop = state.ui.logScroll;
    }
  }

  function updateStorageBadge(status) {
    state.meta.storageStatus = status;
  }

  function saveState(reason = "state") {
    if (persistencePaused) return false;
    captureScroll();
    try {
      state.meta.savedAt = new Date().toISOString();
      const snapshot = JSON.stringify(state);
      localStorage.setItem(BACKUP_KEY, snapshot);
      localStorage.setItem(STORAGE_KEY, snapshot);
      state.meta.storageError = "";
      state.meta.storageStatus = "saved";
      state.meta.lastSaveReason = reason;
      renderStorageState();
      return true;
    } catch {
      state.meta.storageStatus = "failed";
      state.meta.storageError =
        "本地保存失败；页面内可读快照仍保留，刷新前请核对关键状态。";
      renderStorageState();
      renderRestoreBanner();
      announce(
        `保存失败。当前可读快照：玩家 ${coord(state.game.player)}，选中 ${coord(
          state.game.selected,
        )}，草稿 ${state.draft.text.trim() ? `${state.draft.text.length} 字` : "为空"}。`,
        "assertive",
      );
      return false;
    }
  }

  function scheduleSave(reason, delay = 220) {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => saveState(reason), delay);
  }

  function setResult(tone, message) {
    state.game.lastResult = { tone, message };
  }

  function commitState(options = {}) {
    state.meta.renderRev += 1;
    if (window.__echoRelay) window.__echoRelay.metrics.uiCommits += 1;
    renderAll();
    saveState(options.reason || "action");
    if (options.message) {
      announce(options.message, options.priority || "polite");
    }
  }

  function move(directionKey, source) {
    const direction = DIRECTIONS[directionKey];
    if (!direction) return;

    state.ui.input = source || `方向 · ${direction.label}`;

    if (state.game.status === "won") {
      setResult("success", "任务已完成；可撤销上一步或重新开始一局。");
      commitState({
        message: "任务已完成，棋盘位置不再改变。",
      });
      return;
    }

    const from = clonePosition(state.game.player);
    const target = {
      x: from.x + direction.dx,
      y: from.y + direction.dy,
    };

    if (!inBounds(target)) {
      state.game.selected = clonePosition(from);
      setResult(
        "error",
        `移动失败：${direction.label}侧越界，玩家仍在 ${coord(from)}。请换一个方向。`,
      );
      addLog("error", state.ui.input, state.game.lastResult.message);
      commitState({
        message: `移动失败：${direction.label}侧越界，玩家仍在 ${coord(from)}。`,
        priority: "assertive",
      });
      return;
    }

    const destination = cellAt(target);
    if (destination.kind === "hazard") {
      state.game.selected = clonePosition(target);
      setResult(
        "error",
        `移动失败：${coord(target)} 是脉冲危险区，玩家仍在 ${coord(from)}；未进入该格。`,
      );
      addLog("error", state.ui.input, state.game.lastResult.message);
      commitState({
        message: `移动失败：${coord(target)} 是脉冲危险区，玩家仍在 ${coord(from)}。`,
        priority: "assertive",
      });
      return;
    }

    if (destination.kind === "exit" && !state.game.hasKey) {
      state.game.selected = clonePosition(target);
      setResult(
        "error",
        `移动失败：E5 出口锁定，需要先取得 C2 的信号钥匙；玩家仍在 ${coord(from)}。`,
      );
      addLog("error", state.ui.input, state.game.lastResult.message);
      commitState({
        message: `移动失败：E5 出口锁定，需要先取得 C2 的信号钥匙；玩家仍在 ${coord(from)}。`,
        priority: "assertive",
      });
      return;
    }

    state.game.undoStack.push({
      player: clonePosition(from),
      hasKey: state.game.hasKey,
      status: state.game.status,
      turn: state.game.turn,
      lastResult: { ...state.game.lastResult },
    });
    state.game.undoStack = state.game.undoStack.slice(-30);

    state.game.player = clonePosition(target);
    state.game.selected = clonePosition(target);
    state.game.turn += 1;

    if (destination.kind === "key" && !state.game.hasKey) {
      state.game.hasKey = true;
      setResult(
        "success",
        `已取得 C2 信号钥匙；目标改为 E5 出口。你现在在 ${coord(target)}，下一步目标方向为${objectiveDirection().label}。`,
      );
    } else if (destination.kind === "exit" && state.game.hasKey) {
      state.game.status = "won";
      setResult(
        "success",
        `任务完成：你在第 ${state.game.turn} 步抵达 E5 出口，信号已送达。`,
      );
    } else {
      const danger = dangerDescription();
      setResult(
        "info",
        `移动成功：${coord(from)} → ${coord(target)}。目标方向${objectiveDirection().label}；${danger.long}`,
      );
    }

    addLog(
      state.game.status === "won" ? "success" : destination.kind === "key" ? "key" : "move",
      state.ui.input,
      state.game.lastResult.message,
    );
    commitState({
      message: state.game.lastResult.message,
    });
  }

  function handleCanvasClick(event) {
    if (!ctx || event.button !== 0) return;
    const position = canvasPositionFromEvent(event);
    if (!position) return;
    selectAndMaybeMove(position, `鼠标 · 点击 ${coord(position)}`);
  }

  function selectAndMaybeMove(position, inputLabel) {
    state.ui.input = inputLabel;
    const player = state.game.player;
    const distance = Math.abs(position.x - player.x) + Math.abs(position.y - player.y);
    const cell = cellAt(position);

    if (distance === 1) {
      const directionKey = Object.keys(DIRECTIONS).find((key) => {
        const direction = DIRECTIONS[key];
        return (
          player.x + direction.dx === position.x &&
          player.y + direction.dy === position.y
        );
      });
      move(directionKey, inputLabel);
      return;
    }

    state.game.selected = clonePosition(position);
    const suffix =
      distance === 0
        ? "这是玩家当前所在格。"
        : `该格距离玩家 ${distance} 格，本次只选中、不移动。`;
    const result =
      cell.kind === "hazard"
        ? `已选中 ${coord(position)} 脉冲危险区。${suffix} 点击相邻格才会尝试移动。`
        : `已选中 ${coord(position)}（${KIND_LABELS[cell.kind]}）。${suffix}`;
    setResult("info", result);
    addLog("select", inputLabel, result);
    commitState({
      message: `${result} ${objectiveDirection().label}。${dangerDescription().long}`,
    });
  }

  function undo() {
    if (!state.game.undoStack.length) {
      state.ui.input = "按钮 · 撤销";
      setResult("error", "撤销失败：没有可撤销的移动。");
      addLog("error", state.ui.input, state.game.lastResult.message);
      commitState({
        message: "撤销失败：没有可撤销的移动。",
        priority: "assertive",
      });
      return;
    }

    state.ui.input = "按钮 · 撤销";
    const selectedBefore = clonePosition(state.game.selected);
    const snapshot = state.game.undoStack.pop();
    state.game.player = clonePosition(snapshot.player);
    state.game.hasKey = snapshot.hasKey;
    state.game.status = snapshot.status;
    state.game.turn = snapshot.turn;
    setResult(
      "warning",
      `已撤销上一步：玩家回到 ${coord(state.game.player)}。未提交备注、选中格 ${coord(
        selectedBefore,
      )} 与滚动位置均保留。`,
    );
    addLog("undo", state.ui.input, state.game.lastResult.message);
    state.meta.renderRev += 1;
    renderAll();
    restoreScroll();
    saveState("undo");
    announce(
      `已撤销。玩家在 ${coord(state.game.player)}。未提交备注、选中格 ${coord(
        selectedBefore,
      )} 和滚动位置均保留。`,
    );
  }

  function submitDraft() {
    const text = els.draftNote.value;
    state.ui.input = "按钮 · 提交备注";
    if (!text.trim()) {
      state.draft.submitted = false;
      setResult("error", "提交失败：交接备注为空，请先输入内容。");
      addLog("error", state.ui.input, state.game.lastResult.message);
      commitState({
        message: "提交失败：交接备注为空。",
        priority: "assertive",
      });
      els.draftNote.focus();
      return;
    }

    state.draft.text = text.slice(0, 240);
    state.draft.submitted = true;
    setResult(
      "success",
      `交接备注已提交（${state.draft.text.length} 字）。游戏进度、选中格与滚动位置保持不变。`,
    );
    addLog("draft", state.ui.input, `已提交 ${state.draft.text.length} 字交接备注。`);
    commitState({
      message: "交接备注已提交，游戏进度与页面位置保持不变。",
    });
  }

  function resetGame() {
    const previousDraft = state.draft;
    state.game = defaultState().game;
    state.draft = previousDraft;
    state.ui.input = "按钮 · 重新开始";
    setResult("warning", "新一局已开始：玩家回到 A1，目标回到 C2 信号钥匙。");
    addLog("system", state.ui.input, "新一局开始；未提交备注与滚动位置保留。");
    state.meta.renderRev += 1;
    renderAll();
    restoreScroll();
    saveState("reset");
    announce(`新一局开始。玩家在 A1，目标方向${objectiveDirection().label}。未提交备注保留。`);
  }

  function storageLabel() {
    if (state.meta.storageStatus === "failed") return "保存失败 · 页面快照";
    if (state.meta.savedAt) return `已保存 · ${timeLabel(state.meta.savedAt)}`;
    if (state.meta.restoreStatus === "recovered") return "快照恢复 · 待保存";
    if (state.meta.restoreStatus === "restored") return "已恢复 · 待保存";
    return "等待保存";
  }

  function storageChipLabel() {
    if (state.meta.storageStatus === "failed") return "保存失败";
    if (state.meta.storageStatus === "saved") return "已保存";
    if (state.meta.restoreStatus === "recovered") return "快照恢复";
    if (state.meta.restoreStatus === "failed") return "恢复失败";
    return "等待保存";
  }

  function renderStorageState() {
    if (!els.storageChip) return;
    const status = state.meta.storageStatus || state.meta.restoreStatus;
    els.storageChip.textContent = storageChipLabel();
    els.storageChip.dataset.status =
      status === "saved" ? "saved" : status === "failed" ? "failed" : "pending";
    renderSync();
    renderRestoreBanner();
  }

  function renderReadouts() {
    const danger = dangerDescription();
    const direction = objectiveDirection();
    els.readoutPosition.textContent = coord(state.game.player);
    els.readoutObjective.textContent = targetSummary();
    els.readoutDanger.textContent = danger.short;
    els.readoutDanger.parentElement.classList.toggle("has-danger", danger.hasDanger);

    els.statusBadge.textContent = statusLabel();
    els.statusBadge.dataset.state = state.game.status;
    els.turnChip.textContent = `第 ${state.game.turn} 步`;
    els.keyTask.classList.toggle("is-done", state.game.hasKey);
    els.exitTask.classList.toggle("is-done", state.game.status === "won");
    els.keyTask.querySelector(".check-box").textContent = state.game.hasKey ? "✓" : "□";
    els.exitTask.querySelector(".check-box").textContent =
      state.game.status === "won" ? "✓" : "□";

    els.selectedName.textContent = `${coord(state.game.selected)} · ${
      KIND_LABELS[selectedCell().kind]
    }`;
    els.selectedDetail.textContent = selectedDescription();

    for (const button of document.querySelectorAll("[data-move]")) {
      const key = button.dataset.move;
      const item = DIRECTIONS[key];
      const target = {
        x: state.game.player.x + item.dx,
        y: state.game.player.y + item.dy,
      };
      let label = `向${item.label}移动`;
      if (!inBounds(target)) {
        label += "，当前会越界";
      } else {
        const kind = cellAt(target).kind;
        label += `到 ${coord(target)}`;
        if (kind === "hazard") label += "，脉冲危险区";
        if (kind === "exit" && !state.game.hasKey) label += "，出口锁定";
      }
      button.setAttribute("aria-label", label);
    }

    const result = state.game.lastResult;
    els.resultPanel.dataset.tone = result.tone;
    els.resultText.textContent = result.message;
    els.resultIcon.textContent =
      result.tone === "success"
        ? "✓"
        : result.tone === "error"
          ? "!"
          : result.tone === "warning"
            ? "↶"
            : "◎";
  }

  function renderDraft() {
    if (els.draftNote.value !== state.draft.text) {
      const start = els.draftNote.selectionStart;
      const end = els.draftNote.selectionEnd;
      els.draftNote.value = state.draft.text;
      if (document.activeElement === els.draftNote) {
        els.draftNote.setSelectionRange(start, end);
      }
    }
    els.draftCount.textContent = `${state.draft.text.length} / 240`;
    els.draftChip.textContent = state.draft.submitted ? "已提交" : "草稿自动保存";
    els.submitNote.textContent = state.draft.submitted ? "再次提交当前备注" : "提交交接备注";
  }

  function renderLogs() {
    const previousScroll = els.logScroll.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const item of state.logs) {
      const row = document.createElement("li");
      row.dataset.kind = item.kind;
      const time = document.createElement("time");
      time.dateTime = item.time;
      time.textContent = timeLabel(item.time);
      const text = document.createElement("span");
      text.textContent = item.message;
      row.append(time, text);
      fragment.append(row);
    }
    els.logList.replaceChildren(fragment);
    els.logScroll.scrollTop = previousScroll;
  }

  function semanticSummary() {
    const position = coord(state.game.player);
    const objectiveInfo = objective();
    const direction = objectiveDirection();
    const danger = dangerDescription();
    return (
      `玩家在 ${position}。目标：${objectiveInfo.label}，目标方向${direction.label}，` +
      `${direction.detail}。${danger.long} 最近操作结果：${state.game.lastResult.message}`
    );
  }

  function renderSemantics() {
    if (window.__echoRelay) window.__echoRelay.metrics.semanticRenders += 1;
    const position = coord(state.game.player);
    const objectiveInfo = objective();
    const direction = objectiveDirection();
    const danger = dangerDescription();
    const selected = coord(state.game.selected);

    els.semanticSummary.textContent = semanticSummary();
    els.semanticPosition.textContent =
      `玩家当前位置：${position}，第 ${state.game.player.y + 1} 行第 ${
        state.game.player.x + 1
      } 列。`;
    els.semanticObjective.textContent =
      `当前目标：${objectiveInfo.label}。目标方向：${direction.label}，${direction.detail}。`;
    els.semanticDanger.textContent = danger.long;
    els.semanticResult.textContent = `最近操作结果：${state.game.lastResult.message}`;
    els.semanticStatus.textContent = currentStatusText();

    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        const positionName = coord({ x, y });
        const cell = cellAt({ x, y });
        const flags = [];
        if (samePosition({ x, y }, state.game.player)) flags.push("玩家在此");
        if (samePosition({ x, y }, state.game.selected)) flags.push("已选中");
        if (cell.kind === "key" && state.game.hasKey) flags.push("钥匙已取走");
        if (cell.kind === "exit" && state.game.status === "won") flags.push("任务完成");
        const cellNode = els.semanticCells.get(positionName);
        if (cellNode) {
          cellNode.textContent = `${positionName}，${KIND_LABELS[cell.kind]}${
            flags.length ? `，${flags.join("，")}` : ""
          }`;
        }
      }
    }

    els.canvas.setAttribute(
      "aria-label",
      `回声航道棋盘。玩家在 ${position}，目标方向${direction.label}。${danger.long} 按方向键移动。`,
    );
    els.canvas.title = `玩家 ${position} · 目标 ${direction.label} · ${
      danger.hasDanger ? "附近有危险" : "附近安全"
    }`;
  }

  function renderSync() {
    const direction = objectiveDirection();
    const danger = dangerDescription();
    els.syncInput.textContent = state.ui.input;
    els.syncPlayer.textContent = coord(state.game.player);
    els.syncTarget.textContent = `${coord(objective().position)} / ${direction.label}`;
    els.syncSelected.textContent = `${coord(state.game.selected)} / ${
      KIND_LABELS[selectedCell().kind]
    }`;
    els.syncDraft.textContent = state.draft.text
      ? `${state.draft.submitted ? "已提交" : "未提交"} · ${state.draft.text.length} 字`
      : "空";
    els.syncStorage.textContent = storageLabel();
    els.syncRender.textContent = `rev ${state.meta.renderRev}`;

    const pin = {
      input: state.ui.input,
      position: coord(state.game.player),
      objective: `${coord(objective().position)} / ${direction.label} / ${direction.detail}`,
      danger: danger.short,
      selected: coord(state.game.selected),
      draft: state.draft.text
        ? `${state.draft.submitted ? "已提交" : "未提交"} / ${state.draft.text.length} 字`
        : "空",
      storage: storageLabel(),
      render: `rev ${state.meta.renderRev}`,
      result: state.game.lastResult.message,
    };
    els.statePin.textContent = JSON.stringify(pin, null, 2);
  }

  function renderRestoreBanner() {
    const message =
      state.meta.storageError ||
      (state.meta.restoreStatus === "recovered"
        ? "主存档恢复失败，已载入上一份可读快照。"
        : state.meta.restoreStatus === "failed"
          ? "存档恢复失败，已保留当前可读快照。"
          : "");
    if (!message) {
      els.restoreBanner.hidden = true;
      els.restoreBanner.textContent = "";
      return;
    }
    const snapshot =
      `可读快照：玩家 ${coord(state.game.player)}；目标 ${coord(
        objective().position,
      )}；选中 ${coord(state.game.selected)}；草稿 ${
        state.draft.text ? `${state.draft.text.length} 字` : "为空"
      }。`;
    els.restoreBanner.hidden = false;
    els.restoreBanner.textContent = `${message} ${snapshot}`;
  }

  function renderDialog() {
    if (!els.cellDialog.open) return;
    const position = coord(state.game.selected);
    const cell = selectedCell();
    els.dialogTitle.textContent = `${position} · ${KIND_LABELS[cell.kind]}`;
    els.dialogDescription.textContent = selectedDescription();
    els.dialogCoordinate.textContent = `${position} / 第 ${state.game.selected.y + 1} 行第 ${
      state.game.selected.x + 1
    } 列`;
    els.dialogKind.textContent = KIND_LABELS[cell.kind];
    els.dialogDanger.textContent =
      cell.kind === "hazard" ? "脉冲危险，不可进入" : dangerDescription().hasDanger ? "附近有危险" : "无";
  }

  function renderAll() {
    renderReadouts();
    renderDraft();
    renderLogs();
    renderSemantics();
    renderSync();
    renderStorageState();
    renderDialog();
  }

  function announce(text, priority = "polite") {
    const region = priority === "assertive" ? els.liveAssertive : els.livePolite;
    const now = performance.now();
    if (lastAnnouncement.text === text && now - lastAnnouncement.at < 1200) return;
    lastAnnouncement = { text, at: now };
    window.clearTimeout(region._announceTimer);
    region.textContent = "";
    region._announceTimer = window.setTimeout(() => {
      region.textContent = text;
      if (window.__echoRelay) window.__echoRelay.announcementCount += 1;
    }, 30);
  }

  function buildSemanticTable() {
    const fragment = document.createDocumentFragment();
    els.semanticCells = new Map();
    for (let y = 0; y < ROWS; y += 1) {
      const row = document.createElement("tr");
      const header = document.createElement("th");
      header.scope = "row";
      header.textContent = `第 ${y + 1} 行`;
      row.append(header);
      for (let x = 0; x < COLS; x += 1) {
        const cell = document.createElement("td");
        const positionName = coord({ x, y });
        cell.dataset.coordinate = positionName;
        cell.textContent = positionName;
        els.semanticCells.set(positionName, cell);
        row.append(cell);
      }
      fragment.append(row);
    }
    els.semanticBoardBody.replaceChildren(fragment);
  }

  function resizeCanvas() {
    if (!ctx) return;
    const rect = els.canvas.getBoundingClientRect();
    const size = Math.max(1, rect.width || 640);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(size * dpr);
    if (els.canvas.width !== pixelWidth || els.canvas.height !== pixelWidth) {
      els.canvas.width = pixelWidth;
      els.canvas.height = pixelWidth;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (window.__echoRelay) window.__echoRelay.metrics.canvasResizes += 1;
    }
    canvasSize = size;
  }

  function boardMetrics() {
    const padding = Math.max(12, canvasSize * 0.032);
    const gap = Math.max(6, canvasSize * 0.014);
    const cell = (canvasSize - padding * 2 - gap * (COLS - 1)) / COLS;
    return { padding, gap, cell };
  }

  function cellCenter(position, metrics = boardMetrics()) {
    return {
      x: metrics.padding + position.x * (metrics.cell + metrics.gap) + metrics.cell / 2,
      y: metrics.padding + position.y * (metrics.cell + metrics.gap) + metrics.cell / 2,
    };
  }

  function cellTopLeft(position, metrics = boardMetrics()) {
    return {
      x: metrics.padding + position.x * (metrics.cell + metrics.gap),
      y: metrics.padding + position.y * (metrics.cell + metrics.gap),
    };
  }

  function canvasPositionFromEvent(event) {
    const rect = els.canvas.getBoundingClientRect();
    const metrics = boardMetrics();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const col = Math.floor((x - metrics.padding) / (metrics.cell + metrics.gap));
    const row = Math.floor((y - metrics.padding) / (metrics.cell + metrics.gap));
    const position = { x: col, y: row };
    if (!inBounds(position)) return null;
    const left = cellTopLeft(position, metrics);
    if (
      x < left.x ||
      x > left.x + metrics.cell ||
      y < left.y ||
      y > left.y + metrics.cell
    ) {
      return null;
    }
    return position;
  }

  function roundedRectPath(context, x, y, width, height, radius) {
    const safeRadius = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + safeRadius, y);
    context.arcTo(x + width, y, x + width, y + height, safeRadius);
    context.arcTo(x + width, y + height, x, y + height, safeRadius);
    context.arcTo(x, y + height, x, y, safeRadius);
    context.arcTo(x, y, x + width, y, safeRadius);
    context.closePath();
  }

  function drawCellBase(context, position, metrics, time) {
    const cell = cellAt(position);
    const { x, y } = cellTopLeft(position, metrics);
    const size = metrics.cell;
    const radius = Math.max(8, size * 0.1);
    const isPlayer = samePosition(position, state.game.player);
    const isSelected = samePosition(position, state.game.selected);
    const isAdjacentHazard = adjacentHazards().some((item) =>
      samePosition(item.position, position),
    );

    roundedRectPath(context, x, y, size, size, radius);
    const gradient = context.createLinearGradient(x, y, x + size, y + size);
    if (cell.kind === "hazard") {
      gradient.addColorStop(0, "#32191c");
      gradient.addColorStop(1, "#1f1114");
    } else if (cell.kind === "key") {
      gradient.addColorStop(0, state.game.hasKey ? "#18251e" : "#2d2715");
      gradient.addColorStop(1, "#0f1c18");
    } else if (cell.kind === "exit") {
      gradient.addColorStop(
        0,
        state.game.hasKey ? "#143328" : "#1b2522",
      );
      gradient.addColorStop(1, "#0c1916");
    } else if (cell.kind === "start") {
      gradient.addColorStop(0, "#122d2d");
      gradient.addColorStop(1, "#0c1c1c");
    } else {
      gradient.addColorStop(0, "#10231f");
      gradient.addColorStop(1, "#0a1714");
    }
    context.fillStyle = gradient;
    context.fill();

    context.strokeStyle =
      cell.kind === "hazard"
        ? "rgba(255,122,120,0.32)"
        : "rgba(163,221,199,0.16)";
    context.lineWidth = 1;
    context.stroke();

    if (cell.kind === "hazard") {
      context.save();
      roundedRectPath(context, x, y, size, size, radius);
      context.clip();
      context.strokeStyle = "rgba(255,122,120,0.16)";
      context.lineWidth = 3;
      for (let offset = -size; offset < size * 2; offset += 14) {
        context.beginPath();
        context.moveTo(x + offset, y + size);
        context.lineTo(x + offset + size, y);
        context.stroke();
      }
      context.restore();
    }

    if (isAdjacentHazard) {
      const pulse = prefersReducedMotion.matches ? 0.5 : (Math.sin(time / 320) + 1) / 2;
      context.save();
      roundedRectPath(context, x - 3, y - 3, size + 6, size + 6, radius + 3);
      context.strokeStyle = `rgba(255,122,120,${0.35 + pulse * 0.45})`;
      context.lineWidth = 2;
      context.stroke();
      context.restore();
    }

    if (isSelected) {
      roundedRectPath(context, x + 3, y + 3, size - 6, size - 6, radius - 2);
      context.strokeStyle = "#73d8ff";
      context.lineWidth = 2;
      context.stroke();
      context.fillStyle = "#73d8ff";
      context.beginPath();
      context.arc(x + 12, y + 12, 2.5, 0, Math.PI * 2);
      context.fill();
    }

    context.fillStyle = "rgba(204,245,228,0.5)";
    context.font = `600 ${Math.max(7, size * 0.085)}px ${getComputedStyle(document.documentElement).getPropertyValue("--mono")}`;
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillText(coord(position), x + size * 0.1, y + size * 0.09);

    if (isPlayer) {
      context.fillStyle = "rgba(116,242,193,0.05)";
      context.beginPath();
      context.arc(
        x + size / 2,
        y + size / 2,
        size * 0.4,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
  }

  function drawTargetLine(context, metrics) {
    const target = objective().position;
    if (samePosition(target, state.game.player)) return;
    const from = cellCenter(state.game.player, metrics);
    const to = cellCenter(target, metrics);
    context.save();
    context.strokeStyle = "rgba(255,200,107,0.4)";
    context.lineWidth = 2;
    context.setLineDash([5, 8]);
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = "rgba(255,200,107,0.85)";
    context.beginPath();
    context.arc(to.x, to.y, 4, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  function drawCellGlyph(context, position, metrics, time) {
    const cell = cellAt(position);
    const center = cellCenter(position, metrics);
    const size = metrics.cell;

    context.save();
    context.textAlign = "center";
    context.textBaseline = "middle";
    if (cell.kind === "key" && !state.game.hasKey) {
      const pulse = prefersReducedMotion.matches ? 0.5 : (Math.sin(time / 360) + 1) / 2;
      context.strokeStyle = "#ffc86b";
      context.lineWidth = 3;
      context.shadowColor = "#ffc86b";
      context.shadowBlur = 12 + pulse * 8;
      context.beginPath();
      context.arc(center.x - size * 0.06, center.y, size * 0.14, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.moveTo(center.x + size * 0.07, center.y);
      context.lineTo(center.x + size * 0.28, center.y);
      context.lineTo(center.x + size * 0.28, center.y + size * 0.1);
      context.stroke();
      context.shadowBlur = 0;
    } else if (cell.kind === "key" && state.game.hasKey) {
      context.fillStyle = "rgba(116,242,193,0.75)";
      context.font = `700 ${size * 0.24}px ${getComputedStyle(document.documentElement).getPropertyValue("--mono")}`;
      context.fillText("✓", center.x, center.y + 1);
    } else if (cell.kind === "exit") {
      const unlocked = state.game.hasKey;
      context.strokeStyle = unlocked ? "#74f2c1" : "rgba(160,190,178,0.55)";
      context.lineWidth = 3;
      context.shadowColor = unlocked ? "#74f2c1" : "transparent";
      context.shadowBlur = unlocked ? 16 : 0;
      context.strokeRect(
        center.x - size * 0.17,
        center.y - size * 0.23,
        size * 0.34,
        size * 0.46,
      );
      context.shadowBlur = 0;
      if (unlocked) {
        context.fillStyle = "#74f2c1";
        context.beginPath();
        context.moveTo(center.x - size * 0.08, center.y);
        context.lineTo(center.x + size * 0.08, center.y);
        context.lineTo(center.x, center.y - size * 0.14);
        context.closePath();
        context.fill();
      } else {
        context.fillStyle = "rgba(160,190,178,0.7)";
        context.font = `700 ${size * 0.16}px ${getComputedStyle(document.documentElement).getPropertyValue("--mono")}`;
        context.fillText("LOCK", center.x, center.y + size * 0.27);
      }
    } else if (cell.kind === "hazard") {
      context.fillStyle = "rgba(255,122,120,0.88)";
      context.beginPath();
      context.moveTo(center.x, center.y - size * 0.2);
      context.lineTo(center.x + size * 0.2, center.y + size * 0.16);
      context.lineTo(center.x - size * 0.2, center.y + size * 0.16);
      context.closePath();
      context.fill();
      context.fillStyle = "#2b1114";
      context.font = `800 ${size * 0.2}px ${getComputedStyle(document.documentElement).getPropertyValue("--mono")}`;
      context.fillText("!", center.x, center.y + size * 0.06);
    } else if (cell.kind === "start") {
      context.strokeStyle = "rgba(115,216,255,0.38)";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(center.x, center.y, size * 0.25, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.arc(center.x, center.y, size * 0.16, 0, Math.PI * 2);
      context.stroke();
    }
    context.restore();
  }

  function drawPlayer(context, time) {
    const metrics = boardMetrics();
    const center = cellCenter(state.game.player, metrics);
    const size = metrics.cell;
    const pulse = prefersReducedMotion.matches ? 0.5 : (Math.sin(time / 280) + 1) / 2;
    context.save();
    context.shadowColor = "#74f2c1";
    context.shadowBlur = 18 + pulse * 12;
    context.fillStyle = "#74f2c1";
    context.beginPath();
    context.arc(center.x, center.y, size * 0.17, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
    context.strokeStyle = `rgba(116,242,193,${0.25 + pulse * 0.4})`;
    context.lineWidth = 2;
    context.beginPath();
    context.arc(center.x, center.y, size * (0.26 + pulse * 0.05), 0, Math.PI * 2);
    context.stroke();
    context.fillStyle = "#07100f";
    context.beginPath();
    context.arc(center.x, center.y, size * 0.055, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  function drawBoard(time) {
    if (!ctx) return;
    resizeCanvas();
    const metrics = boardMetrics();
    ctx.clearRect(0, 0, canvasSize, canvasSize);
    ctx.fillStyle = "#071311";
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    const washed = ctx.createRadialGradient(
      canvasSize * 0.5,
      canvasSize * 0.45,
      0,
      canvasSize * 0.5,
      canvasSize * 0.45,
      canvasSize * 0.75,
    );
    washed.addColorStop(0, "rgba(28,83,67,0.16)");
    washed.addColorStop(1, "rgba(3,10,9,0)");
    ctx.fillStyle = washed;
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        drawCellBase(ctx, { x, y }, metrics, time);
      }
    }
    drawTargetLine(ctx, metrics);
    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        drawCellGlyph(ctx, { x, y }, metrics, time);
      }
    }
    drawPlayer(ctx, time);

    ctx.strokeStyle =
      state.game.status === "won" ? "rgba(116,242,193,0.7)" : "rgba(173,226,205,0.2)";
    ctx.lineWidth = 2;
    roundedRectPath(
      ctx,
      metrics.padding * 0.45,
      metrics.padding * 0.45,
      canvasSize - metrics.padding * 0.9,
      canvasSize - metrics.padding * 0.9,
      18,
    );
    ctx.stroke();
  }

  function animationLoop(time) {
    if (window.__echoRelay) window.__echoRelay.metrics.frames += 1;
    if (time - lastPaintedAt >= 33) {
      lastPaintedAt = time;
      drawBoard(time);
    }
    animationFrame = window.requestAnimationFrame(animationLoop);
  }

  function cacheElements() {
    const ids = [
      "readout-position",
      "readout-objective",
      "readout-danger",
      "status-badge",
      "turn-chip",
      "key-task",
      "exit-task",
      "selected-name",
      "selected-detail",
      "result-panel",
      "result-text",
      "result-icon",
      "draft-note",
      "draft-count",
      "draft-chip",
      "submit-note",
      "log-scroll",
      "log-list",
      "semantic-summary",
      "semantic-position",
      "semantic-objective",
      "semantic-danger",
      "semantic-result",
      "semantic-status",
      "semantic-board-body",
      "game-canvas",
      "storage-chip",
      "sync-input",
      "sync-player",
      "sync-target",
      "sync-selected",
      "sync-draft",
      "sync-storage",
      "sync-render",
      "state-pin",
      "restore-banner",
      "live-polite",
      "live-assertive",
      "open-cell",
      "undo",
      "reset-game",
      "cell-dialog",
      "close-cell",
      "dialog-done",
      "cell-dialog-title",
      "cell-dialog-description",
      "dialog-coordinate",
      "dialog-kind",
      "dialog-danger",
    ];
    for (const id of ids) {
      const key = id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      els[key] = document.getElementById(id);
    }
    els.canvas = els.gameCanvas;
    els.dialogTitle = els.cellDialogTitle;
    els.dialogDescription = els.cellDialogDescription;
  }

  function openCellDialog() {
    dialogReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : els.canvas;
    if (typeof els.cellDialog.showModal === "function") {
      els.cellDialog.showModal();
    } else {
      els.cellDialog.setAttribute("open", "");
    }
    renderDialog();
    els.closeCell.focus({ preventScroll: true });
    announce(
      `已打开 ${coord(state.game.selected)} 格点详情。${selectedDescription()}`,
    );
  }

  function closeCellDialog() {
    if (els.cellDialog.open && typeof els.cellDialog.close === "function") {
      els.cellDialog.close();
    } else {
      els.cellDialog.removeAttribute("open");
      if (dialogReturnFocus) dialogReturnFocus.focus({ preventScroll: true });
    }
  }

  function scheduleScrollPersistence() {
    window.clearTimeout(scrollSaveTimer);
    scrollSaveTimer = window.setTimeout(() => {
      captureScroll();
      saveState("scroll");
    }, 280);
  }

  function attachEvents() {
    els.canvas.addEventListener("click", handleCanvasClick);
    els.canvas.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const directionKey = KEY_TO_DIRECTION[event.key];
      if (directionKey) {
        event.preventDefault();
        const arrow = DIRECTIONS[directionKey].arrow;
        move(
          directionKey,
          `键盘 · ${event.key.length === 1 ? event.key.toUpperCase() : event.key} ${arrow}`,
        );
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openCellDialog();
      }
    });

    for (const button of document.querySelectorAll("[data-move]")) {
      button.addEventListener("click", () => {
        const directionKey = button.dataset.move;
        move(directionKey, `按钮 · 向${DIRECTIONS[directionKey].label}`);
      });
    }

    els.openCell.addEventListener("click", openCellDialog);
    els.undo.addEventListener("click", undo);
    els.submitNote.addEventListener("click", submitDraft);
    els.resetGame.addEventListener("click", resetGame);

    els.draftNote.addEventListener("input", () => {
      state.draft.text = els.draftNote.value.slice(0, 240);
      state.draft.submitted = false;
      state.ui.input = "输入 · 交接备注";
      renderDraft();
      renderSync();
      scheduleSave("draft", 180);
    });

    els.closeCell.addEventListener("click", closeCellDialog);
    els.dialogDone.addEventListener("click", closeCellDialog);
    els.cellDialog.addEventListener("close", () => {
      renderSync();
      scheduleSave("dialog-close", 0);
      if (dialogReturnFocus && document.contains(dialogReturnFocus)) {
        dialogReturnFocus.focus({ preventScroll: true });
      } else {
        els.openCell.focus({ preventScroll: true });
      }
      announce(`格点详情已关闭。未提交备注、选中格与滚动位置保持不变。`);
    });

    window.addEventListener("scroll", scheduleScrollPersistence, { passive: true });
    els.logScroll.addEventListener("scroll", scheduleScrollPersistence, { passive: true });

    document.addEventListener("focusin", (event) => {
      if (event.target instanceof HTMLElement && event.target.id) {
        state.ui.focusId = event.target.id;
        scheduleSave("focus", 320);
      }
    });

    window.addEventListener("pagehide", () => {
      if (els.draftNote) state.draft.text = els.draftNote.value.slice(0, 240);
      captureScroll();
      saveState("pagehide");
    });

    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(() => {
        resizeCanvas();
      });
      observer.observe(els.canvas);
    } else {
      window.addEventListener("resize", resizeCanvas);
    }
  }

  function restorePositionAndFocus() {
    requestAnimationFrame(() => {
      restoreScroll();
      requestAnimationFrame(() => {
        restoreScroll();
        if (state.ui.focusId) {
          const target = document.getElementById(state.ui.focusId);
          if (
            target &&
            !target.disabled &&
            target.offsetParent !== null &&
            state.ui.focusId !== "cell-dialog"
          ) {
            target.focus({ preventScroll: true });
            restoreScroll();
          }
        }
      });
    });
  }

  function initialize() {
    cacheElements();
    buildSemanticTable();
    ctx = els.canvas.getContext("2d");
    window.__echoRelay = {
      getState: () => JSON.parse(JSON.stringify(state)),
      getSemanticText: () => document.getElementById("game-semantics").innerText,
      getSnapshot: () => els.statePin.textContent,
      getStorageKeys: () => ({ main: STORAGE_KEY, backup: BACKUP_KEY }),
      saveNow: (reason = "manual") => saveState(reason),
      setPersistencePaused: (paused) => {
        persistencePaused = Boolean(paused);
      },
      announcementCount: 0,
      metrics: {
        frames: 0,
        semanticRenders: 0,
        uiCommits: 0,
        canvasResizes: 0,
      },
    };

    attachEvents();
    renderAll();
    restorePositionAndFocus();
    resizeCanvas();
    animationFrame = window.requestAnimationFrame(animationLoop);

    if (state.meta.restoreStatus === "new") {
      saveState("init");
    } else {
      renderStorageState();
    }

    if (state.meta.restoreStatus === "recovered" || state.meta.restoreStatus === "failed") {
      window.setTimeout(() => {
        announce(
          `存档恢复未完全成功。${els.restoreBanner.textContent}`,
          "assertive",
        );
      }, 120);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
