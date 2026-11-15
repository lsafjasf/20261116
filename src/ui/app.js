import { createGame } from "../core/game.js";
import { Metrics } from "../core/metrics.js";
import { SaveSystem, PRIMARY, BACKUP } from "../save/save_system.js";
import { BrowserStorage } from "../save/browser_storage.js";
import { stableStringify, checksumText } from "../core/checksum.js";

const TEMP = "save.tmp.json";
const canvas = document.querySelector("#board");
const ctx = canvas.getContext("2d");
const storage = new BrowserStorage("miniSave:");
const saveSystem = new SaveSystem(storage);
const metrics = new Metrics({ windowSize: 60 });
const logLines = [];

let game = createGame({ seed: 20261116, cacheCapacity: 256 });

function log(message, data) {
  const line =
    new Date().toLocaleTimeString() +
    "  " +
    message +
    (data ? "  " + JSON.stringify(data) : "");
  logLines.push(line);
  document.querySelector("#log").textContent = logLines.slice(-40).join("\n");
}

function cellSize() {
  return Math.min(
    canvas.width / game.map.width,
    canvas.height / game.map.height,
  );
}

function draw() {
  const { width, height, cells, gems } = game.map;
  const size = cellSize();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      ctx.fillStyle = cells[y * width + x] === 1 ? "#2c3a4f" : "#131a24";
      ctx.fillRect(x * size, y * size, size - 1, size - 1);
    }
  }
  for (const [gx, gy] of gems) {
    const taken = game.state.collected.some((g) => g[0] === gx && g[1] === gy);
    if (taken) {
      continue;
    }
    ctx.fillStyle = "#f0c04a";
    ctx.beginPath();
    ctx.arc(gx * size + size / 2, gy * size + size / 2, size * 0.28, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#55c2f0";
  ctx.fillRect(
    game.state.player.x * size + 1,
    game.state.player.y * size + 1,
    size - 2,
    size - 2,
  );
}

function refreshMetrics(frameMs) {
  const snapshot = metrics.recordFrame(frameMs, game.pathService);
  document.querySelector("#metric-frame").textContent =
    snapshot.frameMs.toFixed(3);
  document.querySelector("#metric-frame-avg").textContent =
    "avg " + snapshot.avgFrameMs.toFixed(3);
  document.querySelector("#metric-candidates").textContent =
    snapshot.candidates;
  document.querySelector("#metric-candidates-avg").textContent =
    "avg " + snapshot.avgCandidates.toFixed(1);
  document.querySelector("#metric-hitrate").textContent =
    snapshot.hitRate.toFixed(3);
  const cache = game.pathService.cache.stats;
  document.querySelector("#metric-cache-size").textContent =
    "size " + cache.size + "/" + cache.capacity + " (" + cache.hits + "/" + cache.misses + ")";
  document.querySelector("#metric-nodes").textContent = snapshot.nodesExpanded;
  document.querySelector("#metric-queries").textContent =
    "queries " + snapshot.queries;
}

function refreshState() {
  const snapshot = game.snapshot();
  document.querySelector("#state-score").textContent = snapshot.progress.score;
  document.querySelector("#state-moves").textContent = snapshot.progress.moves;
  document.querySelector("#state-gems").textContent =
    snapshot.progress.collected.length;
  document.querySelector("#state-replay").textContent =
    snapshot.replaySummary.count +
    " 条 / " +
    snapshot.replaySummary.totalSteps +
    " 步";
}

function renderBanner(status) {
  const banner = document.querySelector("#recovery-banner");
  banner.className = "banner " + status.state;
  document.querySelector("#recovery-text").textContent = status.message;
  const meta = [];
  if (status.version) meta.push("v" + status.version);
  if (status.checksum) meta.push("checksum=" + status.checksum);
  if (status.recoveredFrom) meta.push("from=" + status.recoveredFrom);
  if (status.migrationTrail && status.migrationTrail.length > 1) {
    meta.push("migration=" + status.migrationTrail.join("→"));
  }
  document.querySelector("#recovery-meta").textContent = meta.join(" · ");
}

function replaceGame(snapshot, cacheCapacity) {
  game = createGame({
    map: snapshot.map,
    settings: snapshot.settings,
    cacheCapacity,
  }).restore(snapshot);
  syncSettingInputs();
  draw();
  refreshState();
}

canvas.addEventListener("click", (event) => {
  const rect = canvas.getBoundingClientRect();
  const size = cellSize();
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * canvas.width / size);
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * canvas.height / size);
  const start = performance.now();
  const result = game.moveToward(x, y);
  const frameMs = performance.now() - start;
  if (!result.ok) {
    log("UNREACHABLE target", { target: [x, y] });
  }
  refreshMetrics(frameMs);
  refreshState();
  draw();
});

function syncSettingInputs() {
  const volume = document.querySelector("#setting-volume");
  volume.value = game.state.settings.volume;
  document.querySelector("#setting-volume-value").textContent =
    Number(volume.value).toFixed(2);
  document.querySelector("#setting-difficulty").value =
    game.state.settings.difficulty;
  document.querySelector("#setting-particles").checked =
    game.state.settings.particles;
}

document.querySelector("#setting-volume").addEventListener("input", (event) => {
  const volume = Number(event.target.value);
  document.querySelector("#setting-volume-value").textContent =
    volume.toFixed(2);
  game.updateSettings({ volume });
  refreshState();
});

document.querySelector("#setting-difficulty").addEventListener("change", (event) => {
  game.updateSettings({ difficulty: event.target.value });
  refreshState();
});

document.querySelector("#setting-particles").addEventListener("change", (event) => {
  game.updateSettings({ particles: event.target.checked });
  refreshState();
});

document.querySelector("#cache-toggle").addEventListener("change", (event) => {
  const capacity = event.target.checked ? 256 : 0;
  replaceGame(game.snapshot(), capacity);
  log("cache capacity switched", { capacity });
});

document.querySelector("#btn-save").addEventListener("click", () => {
  try {
    const status = saveSystem.save(game.snapshot());
    renderBanner(status);
    log("snapshot saved", { checksum: status.checksum, bytes: status.bytes });
  } catch (error) {
    renderBanner(saveSystem.lastStatus);
    log("save failed", { code: error.code, message: error.message });
  }
});

document.querySelector("#btn-load").addEventListener("click", () => {
  const result = saveSystem.load();
  renderBanner(result.status);
  if (result.ok) {
    const capacity = game.pathService.cache.capacity;
    replaceGame(result.payload, capacity);
    log("snapshot loaded", {
      state: result.status.state,
      trail: result.migrationTrail,
    });
  } else {
    log("no usable snapshot", result.attempts);
  }
});

document.querySelector("#btn-corrupt").addEventListener("click", () => {
  const raw = storage.read(PRIMARY);
  if (raw === null) {
    log("cannot corrupt: no primary snapshot yet");
    return;
  }
  storage.write(PRIMARY, raw.slice(0, Math.floor(raw.length / 2)) + "##BROKEN##");
  log("primary snapshot corrupted on purpose");
  const result = saveSystem.load();
  renderBanner(result.status);
  if (result.ok) {
    replaceGame(result.payload, game.pathService.cache.capacity);
  }
  log("recovery attempts", result.attempts);
});

document.querySelector("#btn-interrupt").addEventListener("click", () => {
  storage.options.failWrites = 1;
  try {
    saveSystem.save(game.snapshot());
  } catch (error) {
    renderBanner(saveSystem.lastStatus);
    log("interrupted write contained", {
      code: error.code,
      tempCleared: storage.read(TEMP) === null,
    });
  }
});

document.querySelector("#btn-legacy").addEventListener("click", () => {
  const current = game.snapshot();
  const legacyPayload = {
    map: current.map,
    progress: {
      player: current.progress.player,
      score: current.progress.score,
      moves: current.progress.moves,
      tick: current.progress.tick,
      gems: current.progress.collected.length,
    },
    settings: { volume: 80, particles: true },
  };
  const envelope = {
    format: "offline-mini-save",
    version: 1,
    checksum: checksumText(stableStringify(legacyPayload)),
    createdAt: Date.now(),
    payload: legacyPayload,
  };
  storage.write(PRIMARY, JSON.stringify(envelope));
  storage.remove(BACKUP);
  log("legacy v1 envelope injected");
  const result = saveSystem.load();
  renderBanner(result.status);
  if (result.ok) {
    replaceGame(result.payload, game.pathService.cache.capacity);
    log("migration result", { trail: result.migrationTrail });
  }
});

document.querySelector("#btn-quota").addEventListener("click", () => {
  storage.options.quotaBytes = Math.max(
    128,
    Math.floor(storage.usedBytes() * 0.4),
  );
  try {
    saveSystem.save(game.snapshot());
  } catch (error) {
    renderBanner(saveSystem.lastStatus);
    log("quota enforced", {
      code: error.code,
      quotaBytes: storage.options.quotaBytes,
    });
  } finally {
    storage.options.quotaBytes = null;
  }
});

document.querySelector("#btn-clear").addEventListener("click", () => {
  storage.remove(PRIMARY);
  storage.remove(BACKUP);
  storage.remove(TEMP);
  renderBanner(saveSystem.setStatus("empty", "Local snapshots cleared"));
  log("snapshots cleared");
});

syncSettingInputs();
draw();
refreshState();
refreshMetrics(0);
renderBanner(saveSystem.lastStatus);
log("ui ready", { cacheCapacity: game.pathService.cache.capacity });
