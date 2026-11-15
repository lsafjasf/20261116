import { AudioEngine } from "./audio-engine.js";
import {
  CHAIN_DEFINITION,
  DEFAULT_PARAMS,
  DROPOUT,
  POPS,
  SAFE_CEILING_DB,
  cloneParams,
  formatDb,
  nodeOrderLabel,
  repairParams,
  validateChainOrder
} from "./audio-core.js";

const $ = (id) => document.getElementById(id);
const SNAPSHOT_KEY = "signal-lab-snapshot-v1";
const state = {
  params: cloneParams(DEFAULT_PARAMS),
  rendered: null,
  snapshot: null,
  isPlaying: false,
  renderInFlight: false,
  renderQueued: false,
  renderPromise: null,
  renderTimer: null,
  rafId: null,
  listenerCount: 0,
  lastAudit: null,
  toastTimer: null,
  booted: false
};

const dom = {
  statusPill: $("statusPill"),
  statusText: $("statusText"),
  activeNodeTop: $("activeNodeTop"),
  peakTop: $("peakTop"),
  playBtn: $("playBtn"),
  playLabel: $("playLabel"),
  stopBtn: $("stopBtn"),
  exportBtn: $("exportBtn"),
  chainList: $("chainList"),
  chainBadge: $("chainBadge"),
  masterGain: $("masterGain"),
  masterGainValue: $("masterGainValue"),
  inputPeak: $("inputPeak"),
  inputPeakNote: $("inputPeakNote"),
  outputPeak: $("outputPeak"),
  outputPeakNote: $("outputPeakNote"),
  correlation: $("correlation"),
  panValue: $("panValue"),
  clipGuard: $("clipGuard"),
  beforeSpectrumPeak: $("beforeSpectrumPeak"),
  afterSpectrumPeak: $("afterSpectrumPeak"),
  activeNodes: $("activeNodes"),
  contextState: $("contextState"),
  schedulerState: $("schedulerState"),
  listenerCount: $("listenerCount"),
  graphGeneration: $("graphGeneration"),
  diagnosis: $("diagnosis"),
  runtimePulse: $("runtimePulse"),
  safetyCard: $("safetyCard"),
  safetyMessage: $("safetyMessage"),
  safetyFill: $("safetyFill"),
  safetyState: $("safetyState"),
  saveSnapshotBtn: $("saveSnapshotBtn"),
  restoreSnapshotBtn: $("restoreSnapshotBtn"),
  snapshotComparison: $("snapshotComparison"),
  fixRecordBtn: $("fixRecordBtn"),
  auditLog: $("auditLog"),
  selfTestBtn: $("selfTestBtn"),
  playTime: $("playTime"),
  playhead: $("playhead"),
  markerRow: $("markerRow"),
  timelineCanvas: $("timelineCanvas"),
  spectrumBefore: $("spectrumBefore"),
  spectrumAfter: $("spectrumAfter"),
  wavIdentity: $("wavIdentity"),
  toast: $("toast")
};

let engine;

function listen(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  state.listenerCount += 1;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60).toString().padStart(2, "0");
  const remainder = (safe % 60).toFixed(3).padStart(6, "0");
  return `${minutes}:${remainder}`;
}

function formatInteger(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.round(Number(value) || 0));
}

function formatFrequency(frequency) {
  if (!Number.isFinite(frequency)) return "--";
  return frequency >= 1000 ? `${(frequency / 1000).toFixed(2)} kHz` : `${Math.round(frequency)} Hz`;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function rangeFill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const percent = ((value - min) / (max - min)) * 100;
  input.style.setProperty("--fill", `${clamp(percent, 0, 100)}%`);
}

function showToast(message, tone = "ok") {
  dom.toast.textContent = message;
  dom.toast.dataset.tone = tone;
  dom.toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => dom.toast.classList.remove("is-visible"), 3600);
}

function setStatus(mode, label) {
  dom.statusPill.dataset.state = mode;
  dom.statusText.textContent = label;
  dom.runtimePulse.dataset.state = mode;
}

function logAudit(kind, text) {
  const item = document.createElement("li");
  item.dataset.kind = kind;
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const message = document.createElement("span");
  message.textContent = text;
  item.append(time, message);
  dom.auditLog.prepend(item);
  while (dom.auditLog.children.length > 24) dom.auditLog.lastElementChild.remove();
}

function buildChain() {
  const fragment = document.createDocumentFragment();
  for (const definition of CHAIN_DEFINITION) {
    const node = state.params.nodes[definition.id];
    const value = node[definition.control];
    const card = document.createElement("article");
    card.className = "node-card";
    card.dataset.node = definition.id;
    card.innerHTML = `
      <span class="node-index">0${definition.order}</span>
      <div class="node-main">
        <div class="node-name">
          <span>${definition.name}</span>
          <span class="node-type">${definition.type}</span>
        </div>
        <div class="node-readout"><output data-readout>${definition.describe(node)}</output></div>
        <input class="node-range" data-control="${definition.control}" type="range"
          min="${definition.min}" max="${definition.max}" step="${definition.step}"
          value="${value}" aria-label="${definition.name} ${definition.control}">
      </div>
      <label class="bypass" title="旁路 ${definition.name}">
        <input class="bypass-toggle" type="checkbox" aria-label="旁路 ${definition.name}">
        <span class="bypass-ui"></span>
      </label>
    `;
    fragment.append(card);
  }
  dom.chainList.replaceChildren(fragment);
  syncChainControls();
}

function syncChainControls() {
  for (const definition of CHAIN_DEFINITION) {
    const card = dom.chainList.querySelector(`[data-node="${definition.id}"]`);
    const node = state.params.nodes[definition.id];
    const control = card.querySelector("[data-control]");
    const bypass = card.querySelector(".bypass-toggle");
    control.value = node[definition.control];
    bypass.checked = node.bypass;
    card.classList.toggle("is-bypassed", node.bypass);
    card.querySelector("[data-readout]").textContent = definition.describe(node);
    rangeFill(control);
  }
  dom.masterGain.value = state.params.masterGainDb;
  dom.masterGainValue.textContent = formatDb(state.params.masterGainDb);
  rangeFill(dom.masterGain);
  const active = CHAIN_DEFINITION.filter(({ id }) => !state.params.nodes[id].bypass).length;
  dom.chainBadge.textContent = `${active}/5 + 安全`;
}

function buildMarkers() {
  dom.markerRow.replaceChildren();
  const addMarker = (time, label, className) => {
    const marker = document.createElement("span");
    marker.className = `marker ${className}`;
    marker.style.left = `${(time / 10) * 100}%`;
    marker.textContent = label;
    dom.markerRow.append(marker);
  };
  addMarker(POPS[0].time, "P1 爆音", "marker-pop");
  addMarker((DROPOUT.start + DROPOUT.end) / 2, "DROPOUT", "marker-drop");
  addMarker(POPS[1].time, "P2 爆音", "marker-pop");
}

function prepareCanvas(canvas) {
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.min(2.5, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const targetWidth = Math.round(width * ratio);
  const targetHeight = Math.round(height * ratio);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

function drawTimeline() {
  const result = state.rendered;
  if (!result) return;
  const { context, width, height } = prepareCanvas(dom.timelineCanvas);
  const padding = { left: 5, right: 5, top: 10, bottom: 6 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const middle = padding.top + plotHeight / 2;

  context.save();
  context.strokeStyle = "rgba(224, 238, 216, 0.06)";
  context.lineWidth = 1;
  for (let second = 0; second <= 10; second += 1) {
    const x = padding.left + (second / 10) * plotWidth;
    context.beginPath();
    context.moveTo(x, padding.top);
    context.lineTo(x, padding.top + plotHeight);
    context.stroke();
  }
  for (const fraction of [0.25, 0.5, 0.75]) {
    const y = padding.top + fraction * plotHeight;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(padding.left + plotWidth, y);
    context.stroke();
  }

  const dropStart = padding.left + (DROPOUT.start / 10) * plotWidth;
  const dropEnd = padding.left + (DROPOUT.end / 10) * plotWidth;
  context.fillStyle = "rgba(255, 107, 94, 0.08)";
  context.fillRect(dropStart, padding.top, dropEnd - dropStart, plotHeight);
  context.fillStyle = "rgba(255, 107, 94, 0.45)";
  context.font = "7px ui-monospace, monospace";
  context.fillText("DROP", dropStart + 3, padding.top + 9);

  const drawEnvelope = (envelope, color, scale, alpha) => {
    context.globalAlpha = alpha;
    context.strokeStyle = color;
    context.lineWidth = 1;
    context.beginPath();
    for (let index = 0; index < envelope.minimum.length; index += 1) {
      const x = padding.left + (index / (envelope.minimum.length - 1)) * plotWidth;
      const low = middle - envelope.minimum[index] * plotHeight * scale;
      const high = middle - envelope.maximum[index] * plotHeight * scale;
      context.moveTo(x, low);
      context.lineTo(x, Math.min(low - 0.6, high));
    }
    context.stroke();
  };

  drawEnvelope(result.waveform.input, "#ffb45c", 1.42, 0.38);
  drawEnvelope(result.waveform.output, "#c7f36b", 1.42, 0.82);
  context.globalAlpha = 1;

  for (const pop of POPS) {
    const x = padding.left + (pop.time / 10) * plotWidth;
    context.strokeStyle = "rgba(255, 180, 92, 0.48)";
    context.setLineDash([2, 3]);
    context.beginPath();
    context.moveTo(x, padding.top);
    context.lineTo(x, padding.top + plotHeight);
    context.stroke();
  }
  context.restore();
}

function drawSpectrum(canvas, spectrum, color) {
  if (!spectrum) return;
  const { context, width, height } = prepareCanvas(canvas);
  const padding = { left: 4, right: 4, top: 8, bottom: 9 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const topDb = Math.ceil(spectrum.maxDb / 10) * 10;
  const bottomDb = topDb - 70;
  const xForFrequency = (frequency) => {
    const minimum = Math.log10(20);
    const maximum = Math.log10(20000);
    return padding.left + (Math.log10(frequency) - minimum) / (maximum - minimum) * plotWidth;
  };
  const yForDb = (db) => padding.top + (topDb - clamp(db, bottomDb, topDb)) / (topDb - bottomDb) * plotHeight;

  context.save();
  context.strokeStyle = "rgba(224, 238, 216, 0.055)";
  context.lineWidth = 1;
  for (const frequency of [20, 100, 1000, 10000, 20000]) {
    const x = xForFrequency(frequency);
    context.beginPath();
    context.moveTo(x, padding.top);
    context.lineTo(x, padding.top + plotHeight);
    context.stroke();
  }
  for (const ratio of [0, 0.33, 0.66, 1]) {
    const y = padding.top + ratio * plotHeight;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(padding.left + plotWidth, y);
    context.stroke();
  }

  const gradient = context.createLinearGradient(0, padding.top, 0, padding.top + plotHeight);
  gradient.addColorStop(0, `${color}44`);
  gradient.addColorStop(1, `${color}00`);
  context.beginPath();
  context.moveTo(xForFrequency(20), padding.top + plotHeight);
  for (let bin = 1; bin < spectrum.frequencies.length; bin += 1) {
    const frequency = spectrum.frequencies[bin];
    if (frequency < 20 || frequency > 20000) continue;
    context.lineTo(xForFrequency(frequency), yForDb(spectrum.magnitudesDb[bin]));
  }
  context.lineTo(xForFrequency(20000), padding.top + plotHeight);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  let started = false;
  for (let bin = 1; bin < spectrum.frequencies.length; bin += 1) {
    const frequency = spectrum.frequencies[bin];
    if (frequency < 20 || frequency > 20000) continue;
    const x = xForFrequency(frequency);
    const y = yForDb(spectrum.magnitudesDb[bin]);
    if (!started) {
      context.moveTo(x, y);
      started = true;
    } else {
      context.lineTo(x, y);
    }
  }
  context.strokeStyle = color;
  context.lineWidth = 1.15;
  context.stroke();

  const peakX = xForFrequency(clamp(spectrum.peakHz, 20, 20000));
  const peakY = yForDb(spectrum.maxDb);
  context.fillStyle = color;
  context.beginPath();
  context.arc(peakX, peakY, 2, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawAll() {
  drawTimeline();
  if (state.rendered) {
    drawSpectrum(dom.spectrumBefore, state.rendered.spectra.before, "#ffb45c");
    drawSpectrum(dom.spectrumAfter, state.rendered.spectra.after, "#c7f36b");
  }
}

function applyRendered(result) {
  if (!result) return;
  state.rendered = result;
  state.params = repairParams(cloneParams(result.params));
  syncChainControls();

  const input = result.metrics.input;
  const output = result.metrics.output;
  const safety = result.safety;
  dom.inputPeak.textContent = formatDb(input.peakDb);
  dom.inputPeakNote.textContent = `源端削波 ${formatInteger(result.metadata.sourceClippedSamples)} 样本`;
  dom.outputPeak.textContent = formatDb(output.peakDb);
  dom.outputPeakNote.textContent = `天花板 ${SAFE_CEILING_DB.toFixed(2)} dBFS`;
  dom.correlation.textContent = `${output.correlation >= 0 ? "+" : ""}${output.correlation.toFixed(3)}`;
  dom.panValue.textContent = `声像 ${output.pan >= 0 ? "右" : "左"} ${output.pan >= 0 ? "+" : ""}${output.pan.toFixed(3)}`;
  dom.clipGuard.textContent = formatInteger(safety.overCeilingSamples);
  dom.beforeSpectrumPeak.textContent = `PEAK ${formatFrequency(result.spectra.before.peakHz)}`;
  dom.afterSpectrumPeak.textContent = `PEAK ${formatFrequency(result.spectra.after.peakHz)}`;
  dom.peakTop.textContent = formatDb(output.peakDb);
  dom.wavIdentity.textContent =
    `WAV 16-bit stereo · ${formatInteger(result.sampleCount)} samples · ${result.duration.toFixed(3)} s · #${result.checksum}`;

  const validOutput = safety.outputClippedSamples === 0 && output.peak < 1;
  dom.safetyCard.dataset.state = validOutput ? (safety.engaged ? "blocked" : "active") : "error";
  dom.safetyState.textContent = validOutput ? (safety.engaged ? "LIMITED / SAFE" : "LOCKED") : "BLOCKED";
  dom.safetyFill.style.width = `${clamp(output.peak * 100, 0, 100)}%`;
  if (!validOutput) {
    dom.safetyMessage.textContent = "输出校验失败：检测到削波样本，播放与导出已阻止。";
  } else if (safety.engaged) {
    dom.safetyMessage.textContent =
      `联锁拦截 ${formatInteger(safety.overCeilingSamples)} 个超天花板样本，整体缩放 ${formatDb(20 * Math.log10(safety.scale))}；最终削波 0。`;
  } else {
    dom.safetyMessage.textContent =
      `输出峰值 ${formatDb(safety.outputPeakDb)}，低于不可旁路天花板；最终削波 0。`;
  }

  dom.exportBtn.disabled = !validOutput || state.renderInFlight;
  dom.playBtn.disabled = !validOutput || state.renderInFlight;
  drawAll();
  updateDiagnosis();
}

function updateDiagnosis() {
  const runtime = engine?.getState();
  dom.diagnosis.dataset.tone = "ok";
  if (!state.rendered) {
    dom.diagnosis.innerHTML = "<span class=\"diagnosis-icon\">◎</span><p><strong>调度 / 正在准备</strong><small>等待首轮离线渲染，资源计数尚未就绪。</small></p>";
    return;
  }
  if (state.renderInFlight) {
    dom.diagnosis.dataset.tone = "warn";
    dom.diagnosis.innerHTML = "<span class=\"diagnosis-icon\">◎</span><p><strong>调度 / 离线计算</strong><small>参数变更正在重新渲染；旧播放会话已释放。</small></p>";
    return;
  }
  if (state.isPlaying) {
    dom.diagnosis.innerHTML = `<span class="diagnosis-icon">◉</span><p><strong>播放链路 / 在线</strong><small>${runtime.activeNodes} 个活动节点，监听器 ${state.listenerCount} 个；调度正常。</small></p>`;
    return;
  }
  dom.diagnosis.innerHTML = `<span class="diagnosis-icon">✓</span><p><strong>资源管理 / 已回收</strong><small>活动节点 0，Context ${runtime.contextState}；监听器 ${state.listenerCount} 个保持稳定。</small></p>`;
}

function refreshStatus() {
  if (state.renderInFlight) {
    setStatus("rendering", "离线渲染");
    return;
  }
  if (engine?.getState().status === "error") {
    setStatus("error", "处理异常");
    return;
  }
  if (state.isPlaying) {
    setStatus("running", "播放中");
    return;
  }
  if (state.rendered) {
    setStatus("ready", "已就绪");
    return;
  }
  setStatus("idle", "待机");
}

function updateTelemetry(runtime) {
  dom.activeNodes.textContent = String(runtime.activeNodes);
  dom.activeNodeTop.textContent = String(runtime.activeNodes);
  dom.contextState.textContent = runtime.contextState;
  dom.schedulerState.textContent = state.isPlaying
    ? `PLAY ${formatTime(runtime.playbackTime)}`
    : state.renderInFlight ? "OFFLINE RENDER" : "空闲 / 已回收";
  dom.listenerCount.textContent = String(state.listenerCount);
  dom.graphGeneration.textContent = `G${runtime.generation}`;
  dom.stopBtn.disabled = !state.isPlaying;
  if (state.isPlaying) {
    dom.playBtn.dataset.playing = "true";
    dom.playLabel.textContent = "暂停";
  } else {
    dom.playBtn.dataset.playing = "false";
    dom.playLabel.textContent = "试听";
  }
  refreshStatus();
  updateDiagnosis();
}

async function renderCurrent() {
  state.renderQueued = true;
  if (state.renderInFlight && state.renderPromise) {
    return state.renderPromise;
  }
  if (state.isPlaying) await stopPlayback();

  state.renderInFlight = true;
  dom.playBtn.disabled = true;
  dom.exportBtn.disabled = true;
  state.renderPromise = (async () => {
    try {
      while (state.renderQueued) {
        state.renderQueued = false;
        const config = repairParams(cloneParams(state.params));
        setStatus("rendering", "离线渲染");
        updateDiagnosis();
        const result = await engine.render(config);
        if (result) {
          applyRendered(result);
          dom.chainBadge.textContent =
            `${CHAIN_DEFINITION.filter(({ id }) => !result.params.nodes[id].bypass).length}/5 + 安全`;
        }
      }
    } catch (error) {
      setStatus("error", "处理异常");
      dom.diagnosis.dataset.tone = "error";
      dom.diagnosis.innerHTML = `<span class="diagnosis-icon">×</span><p><strong>播放链路 / 异常</strong><small>${error instanceof Error ? error.message : String(error)}</small></p>`;
      showToast(`渲染失败：${error instanceof Error ? error.message : String(error)}`, "error");
      throw error;
    } finally {
      state.renderInFlight = false;
      state.renderPromise = null;
      if (state.rendered) {
        dom.playBtn.disabled = false;
        dom.exportBtn.disabled = state.rendered.safety.outputClippedSamples !== 0;
      }
      updateTelemetry(engine.getState());
    }
  })();
  return state.renderPromise;
}

function scheduleRender() {
  if (state.isPlaying) stopPlayback();
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => {
    renderCurrent().catch(() => {});
  }, 180);
}

function startPlayhead() {
  cancelAnimationFrame(state.rafId);
  const tick = () => {
    if (!state.isPlaying) return;
    const time = engine.getPlaybackTime();
    const ratio = clamp(time / 10, 0, 1);
    dom.playTime.textContent = formatTime(time);
    dom.playhead.style.left = `${ratio * 100}%`;
    state.rafId = requestAnimationFrame(tick);
  };
  state.rafId = requestAnimationFrame(tick);
}

function finishPlaybackUi({ natural = false } = {}) {
  cancelAnimationFrame(state.rafId);
  state.rafId = null;
  state.isPlaying = false;
  dom.playBtn.dataset.playing = "false";
  dom.playLabel.textContent = "试听";
  dom.stopBtn.disabled = true;
  dom.playTime.textContent = formatTime(natural ? 10 : 0);
  dom.playhead.style.left = natural ? "100%" : "0%";
  refreshStatus();
  updateDiagnosis();
}

async function stopPlayback({ reset = true } = {}) {
  cancelAnimationFrame(state.rafId);
  state.rafId = null;
  try {
    await engine.stop("manual");
  } finally {
    state.isPlaying = false;
    finishPlaybackUi({ natural: false });
    if (reset) {
      dom.playTime.textContent = formatTime(0);
      dom.playhead.style.left = "0%";
    }
  }
}

async function togglePlayback() {
  if (state.isPlaying) {
    await stopPlayback();
    return;
  }
  if (state.renderInFlight && state.renderPromise) {
    try {
      await state.renderPromise;
    } catch {
      return;
    }
  }
  if (!state.rendered || state.rendered.safety.outputClippedSamples !== 0) {
    showToast("安全联锁未通过，播放已阻止。", "error");
    return;
  }
  try {
    await engine.play();
    state.isPlaying = true;
    dom.stopBtn.disabled = false;
    dom.playBtn.dataset.playing = "true";
    dom.playLabel.textContent = "暂停";
    startPlayhead();
    refreshStatus();
    updateDiagnosis();
  } catch (error) {
    showToast(`播放失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function exportWav() {
  if (state.renderInFlight && state.renderPromise) await state.renderPromise;
  const result = state.rendered;
  if (!result || result.safety.outputClippedSamples !== 0) {
    showToast("输出含削波，WAV 导出被联锁阻止。", "error");
    return;
  }
  const blob = new Blob([result.wavBytes], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `signal-lab_${result.checksum}_${result.duration.toFixed(3)}s.wav`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  window.__lastExport = {
    checksum: result.checksum,
    duration: result.duration,
    samples: result.sampleCount,
    byteLength: result.wavBytes.byteLength,
    samePcmAsAudition: true
  };
  logAudit("pass", `WAV 导出一致：${result.duration.toFixed(3)} s · ${formatInteger(result.sampleCount)} samples · #${result.checksum}`);
  showToast(`WAV 已导出，与试听共用同一 int16 PCM（#${result.checksum}）。`);
}

function loadSnapshotFromStorage() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return;
    const snapshot = JSON.parse(raw);
    if (!snapshot?.params || !snapshot?.metrics) return;
    state.snapshot = snapshot;
    dom.restoreSnapshotBtn.disabled = false;
    dom.snapshotComparison.innerHTML =
      `<p class="empty-copy">已载入 ${new Date(snapshot.savedAt).toLocaleString("zh-CN")} 的快照，可恢复并比较。</p>`;
  } catch {
    // Private browsing can deny localStorage; snapshots still work in memory.
  }
}

function saveSnapshot() {
  if (!state.rendered) {
    showToast("尚无可用渲染结果，无法保存快照。", "error");
    return;
  }
  const metrics = engine.snapshotValues();
  state.snapshot = {
    schema: 1,
    savedAt: new Date().toISOString(),
    params: cloneParams(state.params),
    metrics
  };
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(state.snapshot));
  } catch {
    showToast("浏览器拒绝持久化，快照已保存在当前会话。", "error");
  }
  dom.restoreSnapshotBtn.disabled = false;
  dom.snapshotComparison.innerHTML =
    `<p class="empty-copy">快照已保存：${metrics.beatPoints.map((time) => time.toFixed(3)).join(" / ")} s · 声像 ${metrics.pan.toFixed(3)} · ${formatDb(metrics.gainDb)} · ${metrics.exportDuration.toFixed(3)} s</p>`;
  logAudit("pass", `参数快照已保存 #${metrics.checksum}，等待恢复比较。`);
  showToast("当前参数与测量值已保存。");
}

function numberMatches(a, b, tolerance = 1e-6) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function beatPointsMatch(a, b, tolerance = 1e-3) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((value, index) => numberMatches(value, b[index], tolerance));
}

function renderSnapshotComparison(expected, actual) {
  const rows = [
    {
      label: "节拍点",
      value: `${actual.beatPoints.map((time) => time.toFixed(3)).join(" / ")} s`,
      pass: beatPointsMatch(expected.beatPoints, actual.beatPoints)
    },
    {
      label: "声像",
      value: `${actual.pan >= 0 ? "+" : ""}${actual.pan.toFixed(6)}`,
      pass: numberMatches(expected.pan, actual.pan)
    },
    {
      label: "增益",
      value: formatDb(actual.gainDb),
      pass: numberMatches(expected.gainDb, actual.gainDb)
    },
    {
      label: "WAV 时长",
      value: `${actual.exportDuration.toFixed(6)} s`,
      pass: numberMatches(expected.exportDuration, actual.exportDuration)
    }
  ];
  dom.snapshotComparison.innerHTML = rows.map((row) => `
    <div class="compare-row ${row.pass ? "" : "is-mismatch"}">
      <span>${row.label}</span><strong>${row.value}</strong><i>${row.pass ? "✓" : "×"}</i>
    </div>
  `).join("");
  return {
    rows,
    passed: rows.every((row) => row.pass),
    checksumMatches: expected.checksum === actual.checksum
  };
}

async function restoreSnapshot() {
  if (!state.snapshot) {
    showToast("没有可恢复的快照。", "error");
    return;
  }
  dom.restoreSnapshotBtn.disabled = true;
  try {
    state.params = repairParams(cloneParams(state.snapshot.params));
    syncChainControls();
    if (state.isPlaying) await stopPlayback();
    await renderCurrent();
    const actual = engine.snapshotValues();
    const comparison = renderSnapshotComparison(state.snapshot.metrics, actual);
    state.lastSnapshotComparison = comparison;
    if (comparison.passed) {
      logAudit("pass",
        `快照恢复一致：节拍点 ✓ · 声像 ✓ · 增益 ✓ · WAV ${actual.exportDuration.toFixed(3)} s ✓`);
      showToast("快照恢复完成，四项测量一致。");
    } else {
      logAudit("warn", "快照恢复存在偏差，请检查失败项。");
      showToast("快照恢复后测量不一致。", "error");
    }
  } catch (error) {
    logAudit("error", `快照恢复失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    dom.restoreSnapshotBtn.disabled = !state.snapshot;
  }
}

async function fixAndRecord() {
  dom.fixRecordBtn.disabled = true;
  dom.fixRecordBtn.textContent = "审计中…";
  try {
    if (state.isPlaying) await stopPlayback();
    const original = cloneParams(state.params);
    const repaired = repairParams(original);
    const changed = JSON.stringify(original) !== JSON.stringify(repaired);
    state.params = repaired;
    syncChainControls();
    await renderCurrent();

    const topology = validateChainOrder(repaired);
    if (!topology.ok) throw new Error("节点拓扑顺序校验失败");
    logAudit("pass", `修复完成：${changed ? "非法参数已钳位" : "重建音频图并清理孤儿连接"}；安全级固定末端。`);
    logAudit("info", `节点顺序 ${nodeOrderLabel()}`);

    setStatus("rendering", "重开验证");
    const reopened = new AudioEngine();
    try {
      const result = await reopened.initialize(cloneParams(repaired));
      const first = state.rendered;
      const checksumMatches = result.checksum === first.checksum;
      const durationMatches = numberMatches(result.duration, first.duration);
      const panMatches = numberMatches(result.metrics.output.pan, first.metrics.output.pan);
      const gainMatches = numberMatches(result.params.masterGainDb, first.params.masterGainDb);
      const beatsMatch = beatPointsMatch(result.metadata.beatPoints, first.metadata.beatPoints);
      const passed = checksumMatches && durationMatches && panMatches && gainMatches && beatsMatch;
      state.lastAudit = {
        order: topology.order,
        safetyLast: topology.safetyLast,
        passed,
        checksum: result.checksum,
        checksumMatches,
        duration: result.duration,
        pan: result.metrics.output.pan,
        gainDb: result.params.masterGainDb,
        beatPoints: result.metadata.beatPoints
      };
      logAudit(passed ? "pass" : "warn",
        `同参数重开${passed ? "一致" : "偏差"}：#${result.checksum} · ${result.duration.toFixed(3)} s · 声像 ${result.metrics.output.pan.toFixed(4)}`);
      showToast(passed ? "修复记录完成，重开结果与当前渲染一致。" : "重开结果存在偏差，已写入审计。", passed ? "ok" : "error");
    } finally {
      await reopened.dispose();
    }
  } catch (error) {
    logAudit("error", `修复审计失败：${error instanceof Error ? error.message : String(error)}`);
    showToast("修复审计失败。", "error");
  } finally {
    dom.fixRecordBtn.disabled = false;
    dom.fixRecordBtn.textContent = "修复并记录";
    refreshStatus();
    updateTelemetry(engine.getState());
  }
}

async function runLifecycleSelfTest() {
  dom.selfTestBtn.disabled = true;
  dom.selfTestBtn.textContent = "自检运行中…";
  try {
    if (state.isPlaying) await stopPlayback();
    if (state.renderInFlight && state.renderPromise) await state.renderPromise;
    logAudit("info", "生命周期自检开始：输入中断 → 节点销毁 → 重复启动。");
    const results = await engine.runLifecycleAudit({
      listenerCountBefore: state.listenerCount,
      getListenerCount: () => state.listenerCount
    });
    state.lastLifecycle = results;
    for (const result of results) {
      logAudit(result.passed ? "pass" : "error", `${result.name}：${result.detail}`);
    }
    const passed = results.filter((result) => result.passed).length;
    dom.selfTestBtn.textContent = passed === results.length
      ? `自检通过 ${passed}/${results.length}`
      : `自检异常 ${passed}/${results.length}`;
    if (passed === results.length) showToast("输入中断、节点销毁、重复启动均通过。");
    else showToast("生命周期自检发现资源残留。", "error");
  } catch (error) {
    logAudit("error", `生命周期自检失败：${error instanceof Error ? error.message : String(error)}`);
    showToast("生命周期自检失败。", "error");
  } finally {
    state.isPlaying = false;
    finishPlaybackUi();
    dom.selfTestBtn.disabled = false;
  }
}

function bindEvents() {
  listen(dom.playBtn, "click", () => togglePlayback());
  listen(dom.stopBtn, "click", () => stopPlayback());
  listen(dom.exportBtn, "click", () => exportWav());
  listen(dom.saveSnapshotBtn, "click", saveSnapshot);
  listen(dom.restoreSnapshotBtn, "click", () => restoreSnapshot());
  listen(dom.fixRecordBtn, "click", () => fixAndRecord());
  listen(dom.selfTestBtn, "click", () => runLifecycleSelfTest());

  listen(dom.chainList, "input", (event) => {
    const input = event.target.closest("[data-control]");
    if (!input) return;
    const card = input.closest("[data-node]");
    const definition = CHAIN_DEFINITION.find(({ id }) => id === card.dataset.node);
    if (!definition) return;
    const node = state.params.nodes[definition.id];
    node[definition.control] = Number(input.value);
    card.querySelector("[data-readout]").textContent = definition.describe(node);
    rangeFill(input);
    scheduleRender();
  });

  listen(dom.chainList, "change", (event) => {
    const bypass = event.target.closest(".bypass-toggle");
    if (!bypass) return;
    const card = bypass.closest("[data-node]");
    state.params.nodes[card.dataset.node].bypass = bypass.checked;
    card.classList.toggle("is-bypassed", bypass.checked);
    syncChainControls();
    scheduleRender();
  });

  listen(dom.masterGain, "input", () => {
    state.params.masterGainDb = Number(dom.masterGain.value);
    dom.masterGainValue.textContent = formatDb(state.params.masterGainDb);
    rangeFill(dom.masterGain);
    scheduleRender();
  });

  listen(window, "resize", () => {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(drawAll, 90);
  });

  listen(document, "visibilitychange", () => {
    if (document.hidden && state.isPlaying) {
      stopPlayback();
      logAudit("info", "页面转入后台：播放会话已主动停止并释放。");
    }
  });

  listen(document, "keydown", (event) => {
    if (event.code !== "Space" || event.repeat) return;
    if (event.target.closest("input, button, textarea, select")) return;
    event.preventDefault();
    togglePlayback();
  });

  listen(window, "beforeunload", () => {
    engine?.dispose();
  });
}

function exposeDebugApi() {
  window.__signalLab = {
    getState: () => {
      const runtime = engine.getState();
      return {
        ...runtime,
        isPlaying: state.isPlaying,
        renderInFlight: state.renderInFlight,
        listenerCount: state.listenerCount,
        params: cloneParams(state.params),
        checksum: state.rendered?.checksum || null,
        duration: state.rendered?.duration || 0,
        sampleCount: state.rendered?.sampleCount || 0,
        outputPeak: state.rendered?.safety.outputPeak || 0,
        outputClippedSamples: state.rendered?.safety.outputClippedSamples ?? null,
        overCeilingSamples: state.rendered?.safety.overCeilingSamples ?? null,
        safetyEngaged: state.rendered?.safety.engaged ?? false,
        correlation: state.rendered?.metrics.output.correlation ?? null,
        pan: state.rendered?.metrics.output.pan ?? null,
        beatPoints: state.rendered?.metadata.beatPoints || [],
        nodeOrder: validateChainOrder(state.params).order,
        lastAudit: state.lastAudit,
        lastSnapshotComparison: state.lastSnapshotComparison || null,
        lastLifecycle: state.lastLifecycle || null
      };
    },
    play: togglePlayback,
    stop: () => stopPlayback(),
    exportWav,
    saveSnapshot,
    restoreSnapshot,
    fixAndRecord,
    runLifecycleSelfTest,
    render: () => renderCurrent()
  };
}

async function boot() {
  if (state.booted) return;
  state.booted = true;
  buildChain();
  buildMarkers();
  bindEvents();
  loadSnapshotFromStorage();
  dom.listenerCount.textContent = String(state.listenerCount);

  engine = new AudioEngine({
    onEnded: () => {
      if (!state.isPlaying) return;
      finishPlaybackUi({ natural: true });
      logAudit("info", "播放完成：BufferSource 已结束，Context 已关闭。");
    },
    onTelemetry: updateTelemetry
  });
  exposeDebugApi();
  updateTelemetry(engine.getState());

  try {
    await renderCurrent();
    const result = state.rendered;
    logAudit("pass",
      `首轮渲染完成：${result.duration.toFixed(3)} s · #${result.checksum} · 最终削波 ${result.safety.outputClippedSamples}`);
    logAudit("info", `节点顺序 ${nodeOrderLabel()}`);
    logAudit("info", `联锁${result.safety.engaged ? `拦截 ${formatInteger(result.safety.overCeilingSamples)} 样本` : "未触发"}；WAV 与试听同源。`);
  } catch {
    // renderCurrent already surfaced the error in the status panel.
  }
}

boot();
