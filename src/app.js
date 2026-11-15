import {
  APP_CONSTANTS,
  RestorationEngine,
  SOURCE_HASHES,
  STATE_LABELS,
  hashString,
  stableStringify
} from "./engine.js";
import {
  DAMAGE_TYPES,
  SAMPLES,
  TOOLS,
  formatTimecode,
  getSample,
  getTool
} from "./samples.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const engine = new RestorationEngine({ seed: 17042 });
let activeToolId = "denoise";
let toolValues = makeDefaults(engine.sample);
let lastMutationCount = -1;
let lastCanvasFrame = 0;
let lastHashPaint = 0;
let lastState = engine.currentState;
let lastRepairCount = 0;
let currentSearchResults = [];
let toastSerial = 0;
let clockActive = false;

function makeDefaults(sample) {
  return {
    denoise: 68,
    interpolate: 2,
    reduceNoise: 58,
    align: sample.driftMs
  };
}

function activeTool() {
  return getTool(activeToolId) || TOOLS[0];
}

function toast(title, detail = "", type = "info", ttl = 3600) {
  const stack = $("#toast-stack");
  while (stack.children.length >= 2) stack.firstElementChild?.remove();
  const node = document.createElement("div");
  const id = ++toastSerial;
  node.className = `toast ${type}`;
  node.dataset.toastId = String(id);
  node.innerHTML = `<div><strong></strong><p></p></div>`;
  $("strong", node).textContent = title;
  $("p", node).textContent = detail;
  stack.append(node);
  window.setTimeout(() => node.remove(), ttl);
}

function clockText(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const cents = Math.floor((safe % 1) * 100);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}:${String(secs).padStart(2, "0")}.${String(cents).padStart(2, "0")}`;
}

function frameTimecode(seconds) {
  const frame = Math.floor((Math.max(0, seconds) % 1) * 25);
  return `${formatTimecode(seconds, false)}:${String(frame).padStart(2, "0")}`;
}

function derivedHash() {
  return hashString(
    stableStringify({
      sample: engine.selectedId,
      repairs: engine.project.repairs,
      resources: engine.resources,
      diagnostics: engine.project.diagnostics
    })
  );
}

function downloadJSON(data, filename) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], {
    type: "application/json;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderCaseList() {
  const container = $("#case-list");
  container.innerHTML = SAMPLES.map((sample, index) => {
    const archived = engine.archives.some(
      (entry) => entry.summary.sampleId === sample.id
    );
    const selected = sample.id === engine.selectedId;
    return `
      <button class="case-card${selected ? " active" : ""}${
        archived ? " archived" : ""
      }" data-sample-id="${sample.id}" type="button">
        <span class="case-thumb"><canvas data-case-canvas="${sample.id}"></canvas></span>
        <span class="case-info">
          <span class="case-index">${String(index + 1).padStart(
            2,
            "0"
          )} · ${sample.code}</span>
          <strong>${sample.title}</strong>
          <span class="case-meta">
            <span>${formatTimecode(sample.duration).slice(3)}</span>
            <span class="damage-count">${sample.damage.length} 处异常</span>
          </span>
        </span>
      </button>
    `;
  }).join("");
  requestAnimationFrame(drawCaseThumbs);
}

function drawCaseThumbs() {
  $$("[data-case-canvas]").forEach((canvas) => {
    const sample = getSample(canvas.dataset.caseCanvas);
    const { ctx, width, height } = fitCanvas(canvas);
    drawScene(ctx, 0, 0, width, height, sample, 4, {
      grain: sample.damage.includes("grain"),
      missing: false,
      repaired: false,
      compact: true
    });
  });
}

function renderDamageGrid() {
  const project = engine.project;
  const locked =
    project.state !== "inspect" || engine.diagnosisComplete;
  $("#damage-grid").innerHTML = Object.values(DAMAGE_TYPES)
    .map((damage) => {
      const marked = project.diagnostics.includes(damage.id);
      const disabled = locked || marked;
      return `
        <button class="damage-chip${marked ? " marked" : ""}" type="button"
          data-damage-id="${damage.id}" ${disabled ? "disabled" : ""}>
          <span class="damage-icon">${
            damage.channel === "audio"
              ? "≈"
              : damage.id === "drift"
                ? "⇆"
                : damage.id === "drop"
                  ? "◫"
                  : "▧"
          }</span>
          <span>
            <span class="damage-label">${damage.label}</span>
            <span class="damage-channel">${damage.channel.toUpperCase()} · ${
              marked ? "MARKED" : "AUDIT"
            }</span>
          </span>
        </button>
      `;
    })
    .join("");
  $("#diagnosis-stat").textContent = `${project.diagnostics.length} / ${
    engine.sample.damage.length
  }`;
  const missing = engine.sample.damage.length - project.diagnostics.length;
  $("#clue-copy").textContent =
    missing === 0
      ? "损伤判读完成。检查修复序列并设置安全参数。"
      : `监看通道存在 ${missing} 处待标记异常；误判将触发保护锁。`;
}

function renderTools() {
  const project = engine.project;
  const doneCount = engine.requiredTools.filter(
    (id) => project.repairs[id]
  ).length;
  $("#sequence-label").textContent = `${doneCount} / ${engine.requiredTools.length}`;
  $("#sequence-dots").innerHTML = engine.requiredTools
    .map((id) => {
      const done = Boolean(project.repairs[id]);
      const active = id === activeToolId && !done;
      return `<span class="sequence-dot${done ? " done" : ""}${
        active ? " active" : ""
      }"></span>`;
    })
    .join("");
  $("#tool-stack").innerHTML = TOOLS.map((tool) => {
    const repair = project.repairs[tool.id];
    const active = activeToolId === tool.id;
    return `
      <button class="tool-card${active ? " active" : ""}${
        repair ? " done" : ""
      }" data-tool-id="${tool.id}" type="button">
        <span class="tool-icon">${tool.icon}</span>
        <span class="tool-copy">
          <span class="tool-title">${tool.label}</span>
          <span class="tool-meta">
            <span>${tool.domain.toUpperCase()}</span>
            <span>${tool.costCpu}G / ${tool.costMemory}M</span>
            ${
              repair
                ? `<span class="tool-score">Q ${repair.score}%</span>`
                : ""
            }
          </span>
        </span>
        <span class="tool-badge">${
          repair ? "DONE" : String(tool.order).padStart(2, "0")
        }</span>
      </button>
    `;
  }).join("");
}

function renderParameter() {
  const tool = activeTool();
  const value = toolValues[tool.id];
  const repair = engine.project.repairs[tool.id];
  $("#param-domain").textContent = `${tool.domain.toUpperCase()} TOOL`;
  $("#param-tool").textContent = tool.label;
  $("#param-desc").textContent = repair
    ? `本工序已锁定参数 ${repair.value}${tool.unit}，质量 ${repair.score}%。`
    : tool.desc;
  $("#param-value").textContent = value;
  $("#param-unit").textContent = tool.unit;
  $("#param-safe-range").textContent = `${tool.min}–${tool.max}${tool.unit}`;
  $("#param-hard-min").textContent = `${tool.hardMin}${tool.unit}`;
  $("#param-hard-max").textContent = `${tool.hardMax}${tool.unit}`;
  $("#param-number-unit").textContent = tool.unit;
  const slider = $("#param-slider");
  slider.min = String(tool.hardMin);
  slider.max = String(tool.hardMax);
  slider.step = tool.id === "align" ? "5" : "1";
  slider.value = String(value);
  slider.disabled = Boolean(repair);
  const number = $("#param-number");
  number.min = String(tool.hardMin);
  number.max = String(tool.hardMax);
  number.step = tool.id === "align" ? "5" : "1";
  number.value = String(value);
  number.disabled = Boolean(repair);
  $("#safe-preset").disabled = Boolean(repair);
}

function renderResources() {
  const { cpu, memory, integrity } = engine.resources;
  $("#cpu-value").textContent = String(cpu);
  $("#memory-value").textContent = String(memory);
  $("#integrity-value").textContent = `${integrity}%`;
  $("#cpu-bar").style.width = `${Math.max(0, Math.min(100, (cpu / 260) * 100))}%`;
  $("#memory-bar").style.width = `${Math.max(
    0,
    Math.min(100, (memory / 512) * 100)
  )}%`;
  $("#integrity-bar").style.width = `${integrity}%`;
  $("#cpu-bar").style.background =
    cpu < 70 ? "var(--amber)" : "var(--lime)";
  $("#memory-bar").style.background =
    memory < 120 ? "var(--amber)" : "var(--mint)";
}

function renderProcess() {
  const project = engine.project;
  const job = project.activeJob;
  const show = project.state === "repairing" || project.state === "paused";
  $("#process-card").classList.toggle("visible", show);
  $("#failure-card").classList.toggle("visible", project.state === "failed");
  if (show && job) {
    const tool = getTool(job.toolId);
    const percent = Math.round(job.progress * 100);
    $("#process-stage").textContent =
      project.state === "paused" ? "PAUSED / FROZEN" : "PROCESSING";
    $("#process-title").textContent =
      project.state === "paused"
        ? `${tool.label} · 已暂停`
        : `正在执行 ${tool.label}`;
    $("#process-percent").textContent = `${percent}%`;
    $("#process-bar").style.width = `${percent}%`;
    $("#process-detail").textContent =
      project.state === "paused"
        ? "计时、进度与随机序列已冻结"
        : `参数 ${job.value}${tool.unit} · 快照已写入`;
    $("#process-toggle").textContent =
      project.state === "paused" ? "恢复" : "暂停";
  }
  if (project.state === "failed" && project.error) {
    $("#failure-code").textContent = project.error.code;
    $("#failure-title").textContent = project.error.title;
    $("#failure-detail").textContent = project.error.detail;
  }
}

function renderPrimary() {
  const project = engine.project;
  const tool = activeTool();
  const button = $("#primary-btn");
  const hint = $("#primary-hint");
  const label = $("#primary-label");
  const icon = $("#primary-icon");
  button.classList.remove("warning", "paused");
  button.disabled = false;

  $("#primary-cost").textContent = `预算 ${tool.costCpu} GOPS · ${tool.costMemory} MB`;
  $("#primary-checksum").textContent = `DV: ${derivedHash().slice(0, 8)}`;

  if (project.state === "failed") {
    label.textContent = "恢复最近快照";
    icon.textContent = "↶";
    hint.textContent = "派生副本已保护，原始素材仍保持只读。";
    button.classList.add("warning");
    return;
  }
  if (project.state === "archived") {
    label.textContent = "打开修复索引";
    icon.textContent = "⌕";
    hint.textContent = "摘要已保存，可检索全部修复片段。";
    return;
  }
  if (project.state === "repairing") {
    label.textContent = "暂停当前工序";
    icon.textContent = "Ⅱ";
    hint.textContent = "暂停后计时、进度、回放与随机序列一起冻结。";
    button.classList.add("paused");
    return;
  }
  if (project.state === "paused") {
    label.textContent = "恢复处理";
    icon.textContent = "▶";
    hint.textContent = "从冻结快照继续当前工序。";
    button.classList.add("paused");
    return;
  }
  if (project.state === "ready") {
    label.textContent = "核对并归档";
    icon.textContent = "✓";
    hint.textContent = "保存摘要、导出索引，并生成可检索片段。";
    return;
  }
  if (!engine.diagnosisComplete) {
    label.textContent = "等待损伤判读";
    icon.textContent = "◎";
    hint.textContent = "在监看区标记全部实际损伤后开放修复。";
    button.disabled = true;
    return;
  }
  if (engine.project.repairs[tool.id]) {
    const next = engine.missingTools[0];
    if (next) {
      const nextTool = getTool(next);
      label.textContent = `选择 ${nextTool.label}`;
      icon.textContent = "›";
      hint.textContent = "当前工序已完成，请选择下一条修复链。";
      button.disabled = true;
    } else {
      label.textContent = "修复链已完成";
      icon.textContent = "✓";
      hint.textContent = "启动归档校验以保存摘要。";
      button.disabled = true;
    }
    return;
  }
  label.textContent = `执行 ${tool.label}`;
  icon.textContent = tool.icon;
  hint.textContent = `参数 ${toolValues[tool.id]}${tool.unit} · 每一步写入独立派生副本。`;
}

function renderWaveTags() {
  const project = engine.project;
  const sample = engine.sample;
  const tags = [];
  if (sample.damage.includes("hum")) {
    tags.push(
      project.repairs.denoise
        ? `<span class="wave-tag clean">DENOISED · ${project.repairs.denoise.value}% · Q ${project.repairs.denoise.score}</span>`
        : `<span class="wave-tag hum">HUM 50 Hz · −${Math.round(
            sample.humLevel * 36
          )} dB</span>`
    );
  }
  if (sample.damage.includes("drift")) {
    tags.push(
      project.repairs.align
        ? `<span class="wave-tag clean">SYNC LOCKED · ${sample.driftMs > 0 ? "+" : ""}${sample.driftMs} ms</span>`
        : `<span class="wave-tag drift">A/V OFFSET ${
            sample.driftMs > 0 ? "+" : ""
          }${sample.driftMs} ms</span>`
    );
  }
  if (!tags.length) {
    tags.push(`<span class="wave-tag clean">SIGNAL NOMINAL · 48 kHz</span>`);
  }
  $("#wave-tags").innerHTML = tags.join("");
}

function renderChrome() {
  const project = engine.project;
  const sample = engine.sample;
  const state = project.state;

  renderCaseList();
  renderResources();
  renderDamageGrid();
  renderTools();
  renderParameter();
  renderProcess();
  renderPrimary();
  renderWaveTags();
  renderSnapshotPanel();

  $("#current-goal").textContent = engine.currentGoal;
  $("#current-case").textContent = `${sample.code} / ${sample.title.split(" · ")[0]}`;
  $("#state-pill").textContent = STATE_LABELS[state] || state;
  $("#state-pill").dataset.state = state;
  $("#seed-label").textContent = `SEED ${engine.seed}`;
  $("#monitor-code").textContent = sample.code;
  $("#monitor-location").textContent = sample.location;
  $("#source-hash").textContent = `sha:${SOURCE_HASHES[sample.id].slice(0, 16)}`;
  $("#derived-hash").textContent = `dv:${derivedHash().slice(0, 16)}`;
  $("#source-description").textContent = sample.footage;
  $("#wave-state").textContent = engine.diagnosisComplete ? "AUDITED" : "UNAUDITED";
  $("#missing-label").textContent =
    sample.damage.includes("drop")
      ? project.repairs.interpolate
        ? `INTERPOLATED · ${sample.missingFrames.length} 帧已重建`
        : `DROP DETECTED · ${sample.missingFrames.length} 帧缺失`
      : sample.damage.includes("grain")
        ? project.repairs.reduceNoise
          ? "DENOISED · 时域颗粒已抑制"
          : "GRAIN DETECTED · 高感噪点"
        : "NO FRAME DEFECT";
  $("#change-code").textContent = project.lastChange.code;
  $("#last-change-text").textContent = `${project.lastChange.title}：${project.lastChange.detail}`;
  $("#dock-log").textContent = `${project.lastChange.title} · ${project.lastChange.detail}`;
  $("#state-pulse").classList.toggle("failed", state === "failed");
  $("#state-hash").textContent = engine.getStateHash().slice(0, 16).toUpperCase();
  $("#archive-count").textContent = String(
    engine.archives.reduce((sum, entry) => sum + entry.fragments.length, 0)
  );
  $("#queue-count").textContent = String(SAMPLES.length);
  $("#media-duration").textContent = frameTimecode(sample.duration);
  $("#playhead-slider").max = String(sample.duration);
  $("#frame-counter").textContent = `F ${String(
    Math.floor(project.mediaPlayhead * 25) + 1
  ).padStart(4, "0")}`;
  $("#playback-state").textContent = project.playing ? "PLAYING" : "PAUSED";
  $("#play-icon").textContent = project.playing ? "Ⅱ" : "▶";
  renderSummaryIfOpen();
  renderIndexIfOpen();
}

function renderSnapshotPanel() {
  const project = engine.project;
  const sample = engine.sample;
  const repairCount = Object.keys(project.repairs).length;
  $("#snapshot-count").textContent = `${engine.snapshots.length} 快照`;
  $("#vault-verify-hash").textContent = `sha:${SOURCE_HASHES[sample.id].slice(
    0,
    12
  )} · VERIFIED`;
  $("#workspace-repairs").textContent = `${repairCount} 工序 · ${project.diagnostics.length} 损伤`;
  const workspaceState = $("#workspace-state");
  workspaceState.textContent =
    project.state === "failed"
      ? "PROTECTED"
      : repairCount
        ? "DERIVED"
        : "CLEAN";
  workspaceState.className =
    project.state === "failed" ? "bad" : repairCount ? "warn" : "ok";
  $("#rng-state").textContent = `RNG ${engine.rngState}`;
  const recoveryState = $("#recovery-state");
  recoveryState.textContent =
    project.state === "failed"
      ? "RECOVERABLE"
      : engine.snapshots.length
        ? `${engine.snapshots.length} 可恢复`
        : "READY";
  recoveryState.className = project.state === "failed" ? "bad" : "ok";
  $("#recovery-detail").textContent =
    project.state === "failed"
      ? "点击恢复最近快照"
      : project.lastChange.title;
  $("#undo-btn").disabled =
    engine.snapshots.length === 0 &&
    project.state !== "failed";
  $("#undo-btn").textContent =
    project.state === "failed" ? "↶ 故障恢复" : "↶ 撤销 / 恢复快照";
}

function updateLive() {
  const sample = engine.sample;
  const project = engine.project;
  const playhead = project.mediaPlayhead;
  $("#session-clock").textContent = clockText(engine.sessionSeconds);
  $("#media-time").textContent = frameTimecode(playhead);
  $("#frame-counter").textContent = `F ${String(
    Math.floor(playhead * 25) + 1
  ).padStart(4, "0")}`;
  $("#preview-timecode").textContent = frameTimecode(playhead);
  $("#playback-state").textContent = project.playing ? "PLAYING" : "PAUSED";
  $("#play-icon").textContent = project.playing ? "Ⅱ" : "▶";
  const slider = $("#playhead-slider");
  if (document.activeElement !== slider) slider.value = String(playhead);
  const ratio = sample.duration ? playhead / sample.duration : 0;
  $("#strip-playhead").style.left = `${Math.min(1, ratio) * 100}%`;
  if (project.activeJob) {
    const percent = Math.round(project.activeJob.progress * 100);
    $("#process-percent").textContent = `${percent}%`;
    $("#process-bar").style.width = `${percent}%`;
  }
  const now = performance.now();
  if (now - lastHashPaint > 180) {
    lastHashPaint = now;
    $("#state-hash").textContent = engine.getStateHash().slice(0, 16).toUpperCase();
  }
  drawMonitor(now / 1000);
}

function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const targetWidth = Math.round(width * ratio);
  const targetHeight = Math.round(height * ratio);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function pseudo(seed, index) {
  const raw = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return raw - Math.floor(raw);
}

function drawScene(ctx, x, y, width, height, sample, frameNo, options = {}) {
  const palette = sample.palette;
  const grain = Boolean(options.grain);
  const missing = Boolean(options.missing);
  const repaired = Boolean(options.repaired);
  const compact = Boolean(options.compact);
  const drift = Number(options.drift || 0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();

  const bg = ctx.createLinearGradient(x, y, x, y + height);
  if (sample.id === "rain-shed") {
    bg.addColorStop(0, "#17221c");
    bg.addColorStop(0.55, "#0e1714");
    bg.addColorStop(1, "#070b08");
  } else if (sample.id === "pier") {
    bg.addColorStop(0, "#151b25");
    bg.addColorStop(0.48, "#18242b");
    bg.addColorStop(1, "#070b0d");
  } else {
    bg.addColorStop(0, "#121822");
    bg.addColorStop(0.55, "#11151a");
    bg.addColorStop(1, "#07090c");
  }
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, width, height);

  const unit = Math.min(width, height);
  const horizon = y + height * (sample.id === "pier" ? 0.53 : 0.61);
  ctx.save();
  ctx.translate(drift * width * 0.018, 0);

  if (sample.id === "rain-shed") {
    ctx.fillStyle = "rgba(23, 35, 27, 0.95)";
    ctx.fillRect(x, y, width, height * 0.19);
    ctx.fillStyle = "rgba(8, 12, 9, 0.82)";
    for (let index = 0; index < 7; index += 1) {
      const bx = x + width * (index / 7);
      const bw = width * (0.09 + pseudo(sample.frameSeed, index) * 0.04);
      const bh = height * (0.12 + pseudo(sample.frameSeed, index + 20) * 0.18);
      ctx.fillRect(bx, y + height * 0.17 - bh, bw, bh);
    }
    ctx.fillStyle = "rgba(42, 62, 47, 0.72)";
    ctx.beginPath();
    ctx.moveTo(x, y + height * 0.17);
    ctx.lineTo(x + width, y + height * 0.12);
    ctx.lineTo(x + width, y + height * 0.22);
    ctx.lineTo(x, y + height * 0.26);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(200, 255, 90, 0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + height * 0.26);
    ctx.lineTo(x + width, y + height * 0.22);
    ctx.stroke();
    ctx.fillStyle = "rgba(44, 54, 42, 0.8)";
    ctx.fillRect(x, horizon, width, height - (horizon - y));
    ctx.fillStyle = `rgba(200, 255, 90, ${grain ? 0.13 : 0.22})`;
    ctx.fillRect(x + width * 0.76, y + height * 0.46, width * 0.12, height * 0.22);
    ctx.fillStyle = "rgba(240, 220, 160, 0.16)";
    ctx.fillRect(
      x + width * 0.785,
      y + height * 0.5,
      width * 0.07,
      height * 0.1
    );
    ctx.strokeStyle = "rgba(160, 206, 180, 0.16)";
    for (let index = 0; index < (compact ? 9 : 28); index += 1) {
      const rx = x + pseudo(sample.frameSeed + frameNo, index) * width;
      const ry =
        y +
        ((pseudo(sample.frameSeed + frameNo * 3, index + 9) * height * 0.7 +
          frameNo * 2) %
          (height * 0.65));
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(rx - height * 0.018, ry + height * 0.07);
      ctx.stroke();
    }
  } else if (sample.id === "pier") {
    ctx.fillStyle = "rgba(20, 32, 39, 0.9)";
    ctx.fillRect(x, y, width, height * 0.42);
    const water = ctx.createLinearGradient(x, horizon, x, y + height);
    water.addColorStop(0, "#17282c");
    water.addColorStop(1, "#070d0f");
    ctx.fillStyle = water;
    ctx.fillRect(x, horizon, width, y + height - horizon);
    ctx.strokeStyle = "rgba(123, 185, 255, 0.20)";
    ctx.lineWidth = 1;
    for (let index = 0; index < 9; index += 1) {
      const wy = horizon + (index / 9) * (height - (horizon - y)) * 0.8;
      ctx.beginPath();
      ctx.moveTo(x + pseudo(sample.frameSeed, index) * width * 0.4, wy);
      ctx.lineTo(
        x + width * (0.45 + pseudo(sample.frameSeed, index + 5) * 0.5),
        wy
      );
      ctx.stroke();
    }
    const offset = compact ? 0.06 : 0.12;
    for (let index = 0; index < 3; index += 1) {
      ctx.fillStyle = ["#3d4c42", "#4a4032", "#333c46"][index];
      ctx.fillRect(
        x + width * (0.08 + index * 0.22 + offset),
        y + height * (0.48 - index * 0.045),
        width * 0.19,
        height * 0.19
      );
      ctx.strokeStyle = "rgba(255, 177, 104, 0.18)";
      ctx.strokeRect(
        x + width * (0.08 + index * 0.22 + offset),
        y + height * (0.48 - index * 0.045),
        width * 0.19,
        height * 0.19
      );
    }
    ctx.strokeStyle = "rgba(255, 177, 104, 0.5)";
    ctx.lineWidth = Math.max(1, width * 0.004);
    ctx.beginPath();
    ctx.moveTo(x + width * 0.7, y + height * 0.08);
    ctx.lineTo(x + width * 0.7, y + height * 0.5);
    ctx.lineTo(x + width * 0.93, y + height * 0.39);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 177, 104, 0.24)";
    ctx.beginPath();
    ctx.moveTo(x + width * 0.7, y + height * 0.12);
    ctx.lineTo(x + width * 0.52, y + height * 0.14);
    ctx.stroke();
    if (!compact && frameNo % 7 < 3) {
      const flash = ctx.createRadialGradient(
        x + width * 0.75,
        y + height * 0.36,
        0,
        x + width * 0.75,
        y + height * 0.36,
        width * 0.24
      );
      flash.addColorStop(0, "rgba(220, 240, 255, 0.55)");
      flash.addColorStop(0.15, "rgba(123, 185, 255, 0.24)");
      flash.addColorStop(1, "rgba(123, 185, 255, 0)");
      ctx.fillStyle = flash;
      ctx.fillRect(x, y, width, height);
    }
  } else {
    ctx.fillStyle = "#10141a";
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = "rgba(123, 185, 255, 0.11)";
    ctx.lineWidth = 1;
    const vanishingX = x + width * 0.58;
    const vanishingY = y + height * 0.48;
    for (let index = 0; index < 7; index += 1) {
      ctx.beginPath();
      ctx.moveTo(x, y + height * (index / 6));
      ctx.lineTo(vanishingX, vanishingY);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(23, 29, 36, 0.96)";
    ctx.beginPath();
    ctx.moveTo(x, y + height * 0.68);
    ctx.lineTo(vanishingX, vanishingY);
    ctx.lineTo(x + width, y + height * 0.72);
    ctx.lineTo(x + width, y + height);
    ctx.lineTo(x, y + height);
    ctx.closePath();
    ctx.fill();
    for (let index = 0; index < 4; index += 1) {
      const cx = x + width * (0.08 + index * 0.21);
      const ch = height * (0.3 - index * 0.035);
      ctx.fillStyle = "rgba(40, 48, 58, 0.8)";
      ctx.fillRect(cx, y + height * 0.26, width * 0.035, ch);
      ctx.fillStyle = "rgba(210, 168, 255, 0.15)";
      ctx.fillRect(cx, y + height * 0.26, width * 0.035, 2);
    }
    ctx.fillStyle = "rgba(123, 185, 255, 0.12)";
    ctx.fillRect(
      x + width * 0.63,
      y + height * 0.26,
      width * 0.16,
      height * 0.32
    );
    ctx.fillStyle = "rgba(200, 255, 90, 0.35)";
    ctx.fillRect(
      x + width * 0.7,
      y + height * 0.34,
      width * 0.015,
      height * 0.17
    );
    ctx.fillStyle = "rgba(220, 230, 240, 0.22)";
    ctx.fillRect(x + width * 0.3, y + height * 0.08, width * 0.2, height * 0.035);
  }

  if (!compact) {
    const personX =
      x + width * (0.47 + Math.sin(frameNo * 0.19 + sample.frameSeed) * 0.015);
    const personY = horizon + (y + height - horizon) * 0.17;
    ctx.fillStyle = "rgba(4, 7, 5, 0.8)";
    ctx.beginPath();
    ctx.arc(personX, personY, unit * 0.052, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(
      personX - unit * 0.047,
      personY + unit * 0.045,
      unit * 0.095,
      unit * 0.2
    );
    ctx.fillRect(
      personX - unit * 0.038,
      personY + unit * 0.23,
      unit * 0.025,
      unit * 0.13
    );
    ctx.fillRect(
      personX + unit * 0.014,
      personY + unit * 0.23,
      unit * 0.025,
      unit * 0.13
    );
  }
  ctx.restore();

  if (grain) {
    const count = Math.min(compact ? 42 : 780, Math.round(width * height * 0.01));
    for (let index = 0; index < count; index += 1) {
      const nx = x + pseudo(sample.frameSeed + frameNo, index * 2) * width;
      const ny =
        y + pseudo(sample.frameSeed + frameNo + 2, index * 2 + 1) * height;
      const bright = pseudo(sample.frameSeed + 19, index);
      ctx.fillStyle =
        bright > 0.75
          ? `rgba(255, 235, 190, ${0.18 + bright * 0.34})`
          : `rgba(220, 235, 240, ${bright * 0.15})`;
      ctx.fillRect(nx, ny, bright > 0.9 ? 2 : 1, 1);
    }
  }

  if (drift !== 0) {
    ctx.fillStyle = "rgba(255, 107, 94, 0.08)";
    ctx.fillRect(x, y, width, height * 0.024);
  }
  if (missing) {
    ctx.fillStyle = "rgba(10, 7, 7, 0.76)";
    ctx.fillRect(x, y, width, height);
    for (let index = 0; index < 18; index += 1) {
      const gx = x + pseudo(sample.frameSeed, index) * width;
      const gy = y + pseudo(sample.frameSeed + 4, index) * height;
      ctx.fillStyle =
        index % 3 === 0
          ? "rgba(255, 107, 94, 0.19)"
          : "rgba(200, 255, 90, 0.07)";
      ctx.fillRect(
        gx,
        gy,
        width * (0.04 + pseudo(sample.frameSeed + 7, index) * 0.22),
        Math.max(1, height * 0.015)
      );
    }
    if (!compact) {
      ctx.fillStyle = "rgba(255, 107, 94, 0.85)";
      ctx.font = `600 ${Math.max(8, unit * 0.052)}px ${getComputedStyle(
        document.body
      ).fontFamily}`;
      ctx.textAlign = "center";
      ctx.fillText("FRAME LOST", x + width / 2, y + height / 2);
      ctx.font = `400 ${Math.max(6, unit * 0.03)}px monospace`;
      ctx.fillStyle = "rgba(255, 220, 210, 0.58)";
      ctx.fillText(
        `DROPOUT / ${String(frameNo).padStart(3, "0")}`,
        x + width / 2,
        y + height / 2 + unit * 0.075
      );
    }
  } else if (repaired) {
    ctx.strokeStyle = "rgba(101, 216, 199, 0.44)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 2, y + 2, width - 4, height - 4);
  }

  if (!compact) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.16)";
    for (let lineY = y; lineY < y + height; lineY += 3) {
      ctx.fillRect(x, lineY, width, 1);
    }
  }
  ctx.restore();
}

function drawMonitor(now) {
  const sample = engine.sample;
  const project = engine.project;
  const frameCell = Math.min(
    13,
    Math.floor((project.mediaPlayhead / sample.duration) * 14)
  );
  const missingActive =
    sample.missingFrames.includes(frameCell) && !project.repairs.interpolate;
  const grainActive =
    sample.damage.includes("grain") && !project.repairs.reduceNoise;
  const driftActive =
    sample.damage.includes("drift") && !project.repairs.align;

  drawWaveform(now);

  const preview = $("#frame-canvas");
  {
    const { ctx, width, height } = fitCanvas(preview);
    drawScene(
      ctx,
      0,
      0,
      width,
      height,
      sample,
      Math.floor(project.mediaPlayhead * 25),
      {
        grain: grainActive,
        missing: missingActive,
        repaired: Boolean(project.repairs.interpolate) && sample.missingFrames.includes(frameCell),
        drift: driftActive ? 1 : 0
      }
    );
  }

  const strip = $("#filmstrip-canvas");
  {
    const { ctx, width, height } = fitCanvas(strip);
    const columns = 14;
    const gap = Math.max(2, width * 0.0035);
    const outer = Math.max(3, width * 0.008);
    const cellWidth = (width - outer * 2 - gap * (columns - 1)) / columns;
    const cellHeight = height - outer * 2;
    for (let index = 0; index < columns; index += 1) {
      const cellX = outer + index * (cellWidth + gap);
      const isMissing = sample.missingFrames.includes(index);
      const gain = sample.grainFrames.includes(index) && grainActive;
      drawScene(ctx, cellX, outer, cellWidth, cellHeight, sample, index + 1, {
        grain: gain,
        missing: isMissing && !project.repairs.interpolate,
        repaired: isMissing && Boolean(project.repairs.interpolate),
        compact: true,
        drift: driftActive ? 0.4 : 0
      });
      if (isMissing && !project.repairs.interpolate) {
        ctx.fillStyle = "rgba(255, 107, 94, 0.16)";
        ctx.fillRect(cellX, outer + cellHeight * 0.44, cellWidth, 2);
        ctx.fillStyle = "rgba(255, 107, 94, 0.8)";
        ctx.font = `500 ${Math.max(5, cellWidth * 0.16)}px monospace`;
        ctx.textAlign = "center";
        ctx.fillText("DROP", cellX + cellWidth / 2, outer + cellHeight / 2 - 4);
      }
      if (index === frameCell) {
        ctx.strokeStyle = "rgba(200, 255, 90, 0.9)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(cellX - 1, outer - 1, cellWidth + 2, cellHeight + 2);
      } else {
        ctx.strokeStyle = "rgba(218, 234, 198, 0.11)";
        ctx.lineWidth = 1;
        ctx.strokeRect(cellX, outer, cellWidth, cellHeight);
      }
      if (isMissing && project.repairs.interpolate) {
        ctx.fillStyle = "rgba(101, 216, 199, 0.9)";
        ctx.font = `500 ${Math.max(5, cellWidth * 0.13)}px monospace`;
        ctx.textAlign = "center";
        ctx.fillText("AI", cellX + cellWidth / 2, outer + cellHeight - 3);
      }
    }
  }

  const status = $("#preview-status");
  if (missingActive) {
    status.textContent = "FRAME LOST / DROPOUT";
    status.style.color = "var(--danger)";
  } else if (project.repairs.interpolate) {
    status.textContent = "RECONSTRUCTED · VERIFIED";
    status.style.color = "var(--mint)";
  } else if (grainActive) {
    status.textContent = "HIGH-ISO GRAIN";
    status.style.color = "var(--amber)";
  } else if (driftActive) {
    status.textContent = "A/V DRIFT";
    status.style.color = "var(--danger)";
  } else {
    status.textContent = "DERIVATIVE OK";
    status.style.color = "var(--lime)";
  }
}

function drawWaveform(now) {
  const sample = engine.sample;
  const project = engine.project;
  const { ctx, width, height } = fitCanvas($("#waveform-canvas"));
  const phase = now * (project.playing ? 1.4 : 0.18);
  const denoised = Boolean(project.repairs.denoise);
  const humActive = sample.damage.includes("hum") && !denoised;
  const top = height * 0.22;
  const bottom = height * 0.78;
  const mid = (top + bottom) / 2;
  const amp = (bottom - top) * 0.42;

  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(218, 234, 198, 0.11)";
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(width, mid);
  ctx.stroke();

  for (let channel = 0; channel < 2; channel += 1) {
    const channelMid = channel === 0 ? top + (bottom - top) * 0.28 : top + (bottom - top) * 0.72;
    const points = Math.max(110, Math.floor(width / 3));
    const trace = new Path2D();
    const mirror = new Path2D();
    for (let index = 0; index <= points; index += 1) {
      const t = index / points;
      const moving =
        Math.sin(t * 93 + phase * 1.4 + channel * 0.7) * 0.14 +
        Math.sin(t * 211 - phase * 0.8) * 0.068 +
        Math.sin(t * 39 + phase * 0.45) * 0.22;
      const dip = Math.exp(-Math.pow((t - 0.48) / 0.055, 2));
      const burst = Math.exp(-Math.pow((t - 0.73) / 0.03, 2));
      const hum = humActive ? Math.sin(t * 470 + phase * 2.2) * sample.humLevel * 0.45 : 0;
      const hiss =
        (pseudo(sample.frameSeed + channel, index + Math.floor(phase * 2)) - 0.5) *
        (humActive ? 0.08 : 0.025);
      const envelope =
        0.34 + Math.max(0, Math.sin(t * 11 + 0.8)) * 0.45 + dip * 0.8 + burst * 0.55;
      const value = (moving + hum + hiss) * envelope;
      const px = (t * width);
      const py = channelMid + value * amp * (channel === 0 ? 0.62 : 0.5);
      const pyMirror = channelMid - value * amp * (channel === 0 ? 0.62 : 0.5);
      if (index === 0) {
        trace.moveTo(px, py);
        mirror.moveTo(px, pyMirror);
      } else {
        trace.lineTo(px, py);
        mirror.lineTo(px, pyMirror);
      }
    }
    ctx.save();
    ctx.strokeStyle = denoised
      ? channel === 0
        ? "rgba(200, 255, 90, 0.86)"
        : "rgba(101, 216, 199, 0.72)"
      : channel === 0
        ? "rgba(255, 177, 104, 0.72)"
        : "rgba(255, 177, 104, 0.42)";
    ctx.shadowBlur = denoised ? 8 : 4;
    ctx.shadowColor = denoised
      ? "rgba(200, 255, 90, 0.3)"
      : "rgba(255, 177, 104, 0.3)";
    ctx.lineWidth = 1;
    ctx.stroke(trace);
    ctx.globalAlpha = 0.28;
    ctx.stroke(mirror);
    ctx.restore();
  }

  if (humActive) {
    ctx.save();
    ctx.strokeStyle = "rgba(255, 107, 94, 0.38)";
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(0, top - 4);
    ctx.lineTo(width, top - 4);
    ctx.stroke();
    ctx.restore();
  }

  if (sample.damage.includes("drop") && !project.repairs.interpolate) {
    const x = width * 0.36;
    ctx.fillStyle = "rgba(255, 107, 94, 0.1)";
    ctx.fillRect(x, 0, width * 0.05, height);
    ctx.strokeStyle = "rgba(255, 107, 94, 0.3)";
    ctx.strokeRect(x, 0, width * 0.05, height);
  }

  if (sample.damage.includes("drift") && !project.repairs.align) {
    ctx.save();
    ctx.strokeStyle = "rgba(255, 107, 94, 0.28)";
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(width * 0.18, 0);
    ctx.lineTo(width * 0.18, height);
    ctx.stroke();
    ctx.restore();
  }

  const playX = (project.mediaPlayhead / sample.duration) * width;
  ctx.strokeStyle = "rgba(237, 241, 223, 0.56)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(playX, 0);
  ctx.lineTo(playX, height);
  ctx.stroke();
  ctx.fillStyle = "var(--lime)";
  ctx.fillStyle = "#c8ff5a";
  ctx.fillRect(playX - 2, 0, 4, 2);
}

function selectTool(toolId) {
  const tool = getTool(toolId);
  if (!tool) return;
  activeToolId = toolId;
  renderTools();
  renderParameter();
  renderPrimary();
}

function handlePrimaryAction() {
  const state = engine.currentState;
  clockActive = true;
  if (state === "failed") {
    const result = engine.recover();
    if (result.ok && engine.missingTools[0]) {
      activeToolId = engine.missingTools[0];
    }
    toast(
      result.ok ? "快照恢复完成" : "无法恢复",
      result.ok ? `已回滚：${result.label}` : "没有可用快照",
      result.ok ? "info" : "error"
    );
    renderChrome();
    return;
  }
  if (state === "archived") {
    openIndexDialog("");
    return;
  }
  if (state === "repairing") {
    engine.pauseSession();
    toast("处理已暂停", "计时、音画、进度与随机序列同时冻结", "info");
    renderChrome();
    return;
  }
  if (state === "paused") {
    engine.resumeSession();
    toast("处理已恢复", "从同一冻结快照继续", "info");
    renderChrome();
    return;
  }
  if (state === "ready") {
    const result = engine.archive();
    if (!result.ok) {
      toast("归档校验失败", result.error?.detail || "请检查修复参数", "error");
      renderChrome();
      return;
    }
    lastMutationCount = engine.mutationCount;
    toast(
      "摘要已保存",
      `${result.summary.archiveId} · ${result.summary.fragments.length} 个片段已入索引`,
      "info",
      5200
    );
    renderChrome();
    openSummaryDialog();
    return;
  }
  const tool = activeTool();
  if (engine.project.repairs[tool.id]) {
    const next = engine.missingTools[0];
    if (next) selectTool(next);
    return;
  }
  const result = engine.startRepair(tool.id, toolValues[tool.id]);
  if (!result.ok) {
    toast(
      result.error?.title || "工序无法启动",
      result.error?.detail || result.code,
      "error"
    );
    renderChrome();
    return;
  }
  renderChrome();
}

function togglePlayback() {
  const project = engine.project;
  clockActive = true;
  if (project.playing) {
    engine.pauseMedia();
  } else {
    const result = engine.playMedia();
    if (!result.ok) {
      toast("回放不可用", "故障或归档状态下已锁定监看", "error");
    }
  }
  renderChrome();
  updateLive();
}

function recoverSnapshot() {
  const project = engine.project;
  clockActive = true;
  if (project.state === "failed") {
    const result = engine.recover();
    if (result.ok && engine.missingTools[0]) {
      activeToolId = engine.missingTools[0];
    }
    toast(
      result.ok ? "故障已恢复" : "恢复失败",
      result.ok ? `已回滚：${result.label}` : "没有可用快照",
      result.ok ? "info" : "error"
    );
  } else {
    const result = engine.undo();
    if (result.ok && engine.missingTools[0]) {
      activeToolId = engine.missingTools[0];
    }
    toast(
      result.ok ? "已撤销一步" : "没有可撤销快照",
      result.ok ? `恢复点：${result.label}` : "当前已是初始派生状态",
      result.ok ? "info" : "error"
    );
  }
  renderChrome();
}

function openSummaryDialog() {
  if (!engine.archives.length) return;
  const entry = engine.archives[0];
  const summary = entry.summary;
  const fragments = entry.fragments;
  $("#summary-subtitle").textContent = `${summary.code} · 修复片段已写入只读索引`;
  $("#summary-archive-id").textContent = summary.archiveId;
  $("#summary-list").innerHTML = [
    ["样本", `${summary.title} / ${summary.code}`],
    ["事件", summary.incident],
    ["时长", formatTimecode(summary.duration)],
    ["修复工序", `${Object.keys(summary.repairs).length} 道工序`],
    ["音轨质量", `<strong>${summary.metrics.audio}%</strong>`],
    ["画面质量", `<strong>${summary.metrics.video}%</strong>`],
    ["音画同步", `<strong>${summary.metrics.sync}%</strong>`],
    ["来源哈希", `sha:${summary.sourceHash.slice(0, 16)}`],
    ["归档时间", summary.archivedAt.replace("T", " ").replace(".000Z", "Z")]
  ]
    .map(([key, value]) => `<div><dt>${key}</dt><dd>${value}</dd></div>`)
    .join("");
  $("#chain-copy").innerHTML = `<b>CHAIN OF CUSTODY</b>${summary.chainOfCustody.join(
    "<br>"
  )}`;
  $("#fragment-count").textContent = String(fragments.length);
  $("#summary-fragments").innerHTML = `
    <div class="fragment-preview">
      ${fragments
        .map(
          (fragment) => `
          <div class="fragment-preview-row">
            <span class="fragment-kind-dot"></span>
            <span>
              <strong>${fragment.label}</strong>
              <small>${fragment.fragmentId} · ${fragment.timecode}</small>
            </span>
            <code>${fragment.repairHash.slice(0, 8)}</code>
          </div>
        `
        )
        .join("")}
    </div>
  `;
  $("#summary-state-hash").textContent = engine.finalStateHash || engine.getStateHash();
  const proof = $("#replay-proof");
  proof.classList.remove("match");
  if (engine.replayResult?.match) {
    proof.classList.add("match");
    $("p", proof).textContent = `MATCH · ${engine.replayResult.actual.slice(
      0,
      16
    )} · ${engine.replayResult.ticks} ticks · 同 seed 输入一致`;
  } else {
    $("p", proof).textContent = "同 seed 与输入记录尚未复跑";
  }
  const searchInput = $("#summary-search-input");
  searchInput.value = engine.sample.tags[0] || engine.sample.code;
  performSummarySearch();
  const dialog = $("#summary-dialog");
  if (!dialog.open) dialog.showModal();
}

function performSummarySearch() {
  const query = $("#summary-search-input").value.trim();
  const results = engine.search(query);
  currentSearchResults = results;
  const total = engine.archives.reduce(
    (sum, entry) => sum + entry.fragments.length,
    0
  );
  $("#index-check").textContent =
    total === 0
      ? "尚未归档"
      : `${results.length} / ${total} 片段匹配「${query || "全部"}」`;
  $("#summary-search-results").innerHTML = results.length
    ? results
        .map(
          (fragment) =>
            `<span class="search-result-chip"><b>${fragment.fragmentId}</b> · ${
              fragment.label
            } · ${fragment.timecode}</span>`
        )
        .join("")
    : `<span class="search-empty">索引中没有匹配片段</span>`;
}

function renderIndexResults(results) {
  const container = $("#index-results");
  currentSearchResults = results;
  $("#index-fragment-total").textContent = String(
    engine.archives.reduce((sum, entry) => sum + entry.fragments.length, 0)
  );
  if (!engine.archives.length) {
    container.innerHTML = `<div class="search-empty">尚未归档任何修复片段。完成一条修复链后点击「核对并归档」。</div>`;
    return;
  }
  if (!results.length) {
    container.innerHTML = `<div class="search-empty">没有匹配结果。尝试“雨棚”“同步”“补帧”或片段号。</div>`;
    return;
  }
  const kindLabel = { audio: "AUD", video: "VID", sync: "SYN" };
  container.innerHTML = results
    .map(
      (fragment) => `
      <article class="index-result">
        <span class="result-kind">${kindLabel[fragment.kind] || fragment.kind}</span>
        <div>
          <h4>${fragment.title} · ${fragment.label}</h4>
          <p>${fragment.fragmentId} · ${fragment.timecode} · ${fragment.tools.join(
            " / "
          )}</p>
          <div class="result-tags">${fragment.tags
            .slice(0, 5)
            .map((tag) => `<span>${tag}</span>`)
            .join("")}</div>
        </div>
        <div>
          <small>REPAIR HASH</small>
          <code>${fragment.repairHash.slice(0, 16)}</code>
        </div>
        <div>
          <small>SOURCE</small>
          <code>sha:${fragment.sourceHash.slice(0, 12)}</code>
        </div>
      </article>
    `
    )
    .join("");
}

function performIndexSearch(query) {
  renderIndexResults(engine.search(query));
}

function renderIndexIfOpen() {
  if (!$("#index-dialog").open) return;
  const query = $("#index-search-input").value;
  performIndexSearch(query);
}

function renderSummaryIfOpen() {
  if (!$("#summary-dialog").open) return;
  const hash = $("#summary-state-hash");
  if (hash && !engine.replayResult?.match) {
    hash.textContent = engine.finalStateHash || engine.getStateHash();
  }
}

function openIndexDialog(initialQuery = "") {
  const dialog = $("#index-dialog");
  const search = $("#index-search-input");
  search.value = initialQuery;
  $("#index-chips").innerHTML = [
    ["全部", ""],
    ["音频", "音轨"],
    ["影像", "影像"],
    ["同步", "同步"],
    ["去噪", "去噪"],
    ["补帧", "补帧"],
    ["降噪", "降噪"],
    ["对齐", "对齐"]
  ]
    .map(
      ([label, query], index) =>
        `<button class="index-chip${index === 0 ? " active" : ""}" type="button" data-index-query="${query}">${label}</button>`
    )
    .join("");
  performIndexSearch(initialQuery);
  if (!dialog.open) dialog.showModal();
}

function runDeterministicReplay() {
  const record = engine.getRunRecord();
  const replay = RestorationEngine.replay(record);
  const actual = replay.getStateHash();
  const expected = record.stateHash;
  const match = actual === expected && replay.finalStateHash === expected;
  engine.replayResult = {
    match,
    expected,
    actual,
    ticks: record.finalTick,
    seed: record.seed
  };
  const proof = $("#replay-proof");
  proof.classList.toggle("match", match);
  $("p", proof).textContent = match
    ? `MATCH · ${actual.slice(0, 16)} · ${record.finalTick} ticks · seed ${record.seed}`
    : `MISMATCH · expected ${expected.slice(0, 12)} / actual ${actual.slice(0, 12)}`;
  toast(
    match ? "确定性复跑通过" : "确定性复跑失败",
    match
      ? `最终状态哈希一致：${actual.slice(0, 16)}`
      : "状态哈希不一致，请保留运行记录排查",
    match ? "info" : "error",
    5000
  );
}

function exportIndex() {
  if (!engine.archives.length) {
    toast("索引为空", "先完成一条修复链并归档，再导出 JSON", "error");
    return;
  }
  const bundle = engine.exportBundle();
  downloadJSON(bundle, `signal-index-${engine.seed}.json`);
  toast(
    "索引已导出",
    `${bundle.fragmentCount} 个修复片段 · ${bundle.integrity.finalStateHash.slice(0, 16)}`,
    "info"
  );
}

function downloadSummary() {
  if (!engine.archives.length) {
    toast("没有摘要", "请先归档修复片段", "error");
    return;
  }
  downloadJSON(
    engine.archives[0].summary,
    `restoration-summary-${engine.sample.code}-${engine.seed}.json`
  );
  toast("摘要已下载", "原始素材与派生片段哈希均包含在摘要中", "info");
}

function downloadRunRecord() {
  if (!engine.archives.length) {
    toast("没有可保存记录", "请先完成归档", "error");
    return;
  }
  downloadJSON(
    engine.getRunRecord(),
    `restoration-run-${engine.sample.code}-${engine.seed}.json`
  );
  toast("运行记录已保存", "包含 seed、固定步长与完整输入命令序列", "info");
}

function updateParameterValue(rawValue) {
  const tool = activeTool();
  if (engine.project.repairs[tool.id]) return;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return;
  toolValues[tool.id] = value;
  renderParameter();
  renderPrimary();
}

function selectSample(sampleId) {
  if (
    engine.project.state === "repairing" ||
    engine.project.state === "paused"
  ) {
    toast("样本已锁定", "当前工序处理中，请先完成或暂停后撤销", "error");
    return;
  }
  if (sampleId === engine.selectedId) return;
  const result = engine.selectSample(sampleId);
  if (!result.ok) {
    toast("切换失败", result.code, "error");
    return;
  }
  activeToolId = "denoise";
  toolValues = makeDefaults(engine.sample);
  lastRepairCount = 0;
  renderChrome();
  toast(
    "样本已切换",
    `${engine.sample.code} · ${engine.sample.title}`,
    "info"
  );
}

function confirmReset() {
  engine.reset();
  clockActive = false;
  activeToolId = "denoise";
  toolValues = makeDefaults(engine.sample);
  lastRepairCount = 0;
  lastMutationCount = engine.mutationCount;
  $("#reset-dialog").close();
  $("#summary-dialog").open && $("#summary-dialog").close();
  $("#index-dialog").open && $("#index-dialog").close();
  $("#toast-stack").innerHTML = "";
  renderChrome();
  updateLive();
  toast(
    "整场会话已复位",
    `计时 00:00:00.00 · 播放头 00:00:00 · 资源 260/512/100 · RNG #${engine.seed}`,
    "info",
    5600
  );
}

function bindEvents() {
  $("#case-list").addEventListener("click", (event) => {
    const card = event.target.closest("[data-sample-id]");
    if (card) selectSample(card.dataset.sampleId);
  });

  $("#damage-grid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-damage-id]");
    if (!button || button.disabled) return;
    clockActive = true;
    const damageId = button.dataset.damageId;
    const result = engine.diagnose(damageId);
    if (!result.ok) {
      toast(
        result.error?.title || "判读失败",
        result.error?.detail || result.code,
        "error"
      );
    } else if (engine.diagnosisComplete) {
      toast(
        "损伤判读完成",
        `已锁定 ${engine.project.diagnostics.length} 类损伤，修复序列已开放`,
        "info",
        2800
      );
    }
    renderChrome();
  });

  $("#tool-stack").addEventListener("click", (event) => {
    const card = event.target.closest("[data-tool-id]");
    if (card) selectTool(card.dataset.toolId);
  });

  $("#param-slider").addEventListener("input", (event) => {
    updateParameterValue(event.target.value);
  });

  $("#param-number").addEventListener("input", (event) => {
    updateParameterValue(event.target.value);
  });

  $("#safe-preset").addEventListener("click", () => {
    const tool = activeTool();
    const safeValue = tool.id === "align" ? engine.sample.driftMs : tool.ideal;
    updateParameterValue(safeValue);
    toast(
      "安全参数已载入",
      `${tool.parameter} ${safeValue}${tool.unit}`,
      "info"
    );
  });

  $("#primary-btn").addEventListener("click", handlePrimaryAction);
  $("#process-toggle").addEventListener("click", handlePrimaryAction);
  $("#recover-btn").addEventListener("click", handlePrimaryAction);
  $("#undo-btn").addEventListener("click", recoverSnapshot);
  $("#play-btn").addEventListener("click", togglePlayback);

  $("#playhead-slider").addEventListener("change", (event) => {
    clockActive = true;
    engine.seekMedia(Number(event.target.value));
    renderChrome();
  });
  $("#playhead-slider").addEventListener("input", (event) => {
    const ratio =
      Number(event.target.value) / Math.max(1, engine.sample.duration);
    $("#strip-playhead").style.left = `${Math.min(1, ratio) * 100}%`;
  });

  $("#reset-btn").addEventListener("click", () => {
    $("#reset-dialog").showModal();
  });
  $("#confirm-reset-btn").addEventListener("click", confirmReset);
  $("#scroll-to-console").addEventListener("click", () => {
    $(".control-rail").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("#summary-search-btn").addEventListener("click", performSummarySearch);
  $("#summary-search-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") performSummarySearch();
  });
  $("#replay-btn").addEventListener("click", runDeterministicReplay);
  $("#download-record-btn").addEventListener("click", downloadRunRecord);
  $("#download-summary-btn").addEventListener("click", downloadSummary);
  $("#download-index-btn").addEventListener("click", exportIndex);
  $("#download-index-btn-2").addEventListener("click", exportIndex);

  $("#index-btn").addEventListener("click", () => openIndexDialog(""));
  $("#export-index-btn").addEventListener("click", exportIndex);
  $("#quick-search-btn").addEventListener("click", () => {
    openIndexDialog($("#quick-search-input").value.trim());
  });
  $("#quick-search-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      openIndexDialog($("#quick-search-input").value.trim());
    }
  });
  $("#index-search-btn").addEventListener("click", () => {
    performIndexSearch($("#index-search-input").value);
  });
  $("#index-search-input").addEventListener("input", (event) => {
    performIndexSearch(event.target.value);
  });
  $("#index-chips").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-index-query]");
    if (!chip) return;
    $$(".index-chip", $("#index-chips")).forEach((node) =>
      node.classList.toggle("active", node === chip)
    );
    $("#index-search-input").value = chip.dataset.indexQuery;
    performIndexSearch(chip.dataset.indexQuery);
  });

  $$("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
      const dialog = document.getElementById(button.dataset.closeDialog);
      if (dialog?.open) dialog.close();
    });
  });

  $$("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  document.addEventListener("keydown", (event) => {
    const tag = document.activeElement?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA";
    if (typing || $("dialog[open]")) return;
    if (event.key === "Enter") {
      event.preventDefault();
      handlePrimaryAction();
    }
    if (event.code === "Space") {
      event.preventDefault();
      togglePlayback();
    }
  });

  window.addEventListener("resize", () => {
    drawCaseThumbs();
    updateLive();
  });
}

let rafLast = performance.now();
let rafAccumulator = 0;

function animationLoop(now) {
  const elapsed = Math.min(0.1, Math.max(0, (now - rafLast) / 1000));
  rafLast = now;
  rafAccumulator += elapsed;
  let steps = 0;
  if (!clockActive) {
    rafAccumulator = 0;
  } else {
    while (rafAccumulator >= APP_CONSTANTS.fixedStep && steps < 4) {
      engine.tick(APP_CONSTANTS.fixedStep);
      rafAccumulator -= APP_CONSTANTS.fixedStep;
      steps += 1;
    }
  }

  const repairCount = Object.keys(engine.project.repairs).length;
  if (repairCount > lastRepairCount) {
    const next = engine.missingTools[0];
    if (next) activeToolId = next;
    toast(
      "工序已写入派生副本",
      next
        ? `下一条：${getTool(next).label}`
        : "全部工序完成，等待归档校验",
      "info",
      2700
    );
  }
  lastRepairCount = repairCount;

  if (engine.mutationCount !== lastMutationCount) {
    lastMutationCount = engine.mutationCount;
    renderChrome();
  }
  if (engine.currentState !== lastState) {
    lastState = engine.currentState;
  }
  updateLive();
  requestAnimationFrame(animationLoop);
}

function init() {
  bindEvents();
  renderChrome();
  updateLive();
  lastMutationCount = engine.mutationCount;
  rafLast = performance.now();
  requestAnimationFrame(animationLoop);
  window.setTimeout(() => {
    toast(
      "修复台已就绪",
      "先标记波形与画面中的损伤，再按顺序执行修复。",
      "info",
      4200
    );
  }, 500);
}

init();
