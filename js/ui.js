import {
  addLog,
  clone,
  draftHash,
  formatClock,
  formatDuration,
  makeWave,
  persist,
  redo,
  resourceCount,
  reuseCount,
  selectedClip,
  shortHash,
  stableStringify,
  STORAGE_KEY,
  undo
} from "./core.js";
import {
  describeModule,
  getAudioUrl,
  MODULE_META,
  resetModuleOperation,
  runModule,
  snapshotText
} from "./operations.js";

const DRAFT_FIELDS = {
  image: {
    brightness: { id: "image-brightness", type: "number" },
    blur: { id: "image-blur", type: "number" },
    warmth: { id: "image-warmth", type: "number" },
    note: { id: "image-note", type: "string" }
  },
  audio: {
    frequency: { id: "audio-frequency", type: "number" },
    duration: { id: "audio-duration", type: "number" },
    texture: { id: "audio-texture", type: "string" }
  },
  export: {
    name: { id: "export-name", type: "string" },
    format: { id: "export-format", type: "string" },
    quality: { id: "export-quality", type: "string" }
  }
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function byId(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const element = byId(id);
  if (element) element.textContent = text;
}

function getDraftFromDom(moduleId) {
  const result = {};
  for (const [key, config] of Object.entries(DRAFT_FIELDS[moduleId])) {
    const input = byId(config.id);
    if (!input) continue;
    result[key] = config.type === "number" ? Number(input.value) : input.value;
  }
  return result;
}

function inputValue(input) {
  if (input.type === "range") return Number(input.value);
  return input.value;
}

function makeWaveMarkup(values, color = "#8bb8ff") {
  const bars = values.map((value, index) => {
    const height = Math.max(2, Math.round(value * 80));
    const x = index * 4 + 1;
    return `<rect x="${x}" y="${40 - height / 2}" width="2" height="${height}" rx="1" fill="${color}" opacity="${0.4 + (index % 4) * 0.12}"/>`;
  }).join("");
  return `<svg viewBox="0 0 220 80" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`;
}

function moduleStatusLabel(module) {
  if (module.status === "running") return `处理中 · ${module.stage}`;
  if (module.status === "error") return `需恢复 · ${module.stage}`;
  if (module.stage === "完成") return "就绪";
  return "待处理";
}

function statusClass(module) {
  if (module.status === "running") return "state-running";
  if (module.status === "error") return "state-error";
  return "state-ready";
}

function formatDraft(draft) {
  return Object.entries(draft).map(([key, value]) => `${key}=${value}`).join(" · ");
}

function createBoundaryMarkup(moduleId, module) {
  const error = module.error;
  if (!error) return "";
  const snapshot = error.snapshot || module.snapshot;
  const meta = MODULE_META[moduleId];
  const headline = `${meta.name}失败 · ${error.stage}`;
  const snapshotLine = snapshotText(snapshot);
  const resource = snapshot?.resourceId
    ? `${snapshot.resourceId} · 1 份 · 已复用 ${snapshot.resourceReuses || 0} 次`
    : "尚未创建资源";
  return `
    <article class="boundary-fallback" id="boundary-${moduleId}" tabindex="-1" role="alert" aria-labelledby="boundary-${moduleId}-heading">
      <h4 id="boundary-${moduleId}-heading">${escapeHtml(headline)}</h4>
      <dl class="boundary-meta">
        <dt>模块</dt><dd>${escapeHtml(meta.name)}</dd>
        <dt>阶段</dt><dd>${escapeHtml(error.stage)} · 第 ${error.attempt} 次尝试</dd>
        <dt>资源</dt><dd>${escapeHtml(resource)}</dd>
      </dl>
      <p class="boundary-advice"><strong>可操作建议：</strong>${escapeHtml(error.advice)}</p>
      <p class="boundary-snapshot" title="${escapeHtml(snapshotLine)}">安全快照：${escapeHtml(snapshotLine)}</p>
      <div class="boundary-actions">
        <button class="button button-accent" type="button" data-retry-module="${moduleId}">重试并复用资源</button>
        <button class="text-button" type="button" data-copy-snapshot="${moduleId}">复制快照</button>
        <button class="text-button" type="button" data-open-module-log="${moduleId}">查看日志</button>
      </div>
    </article>
  `;
}

function moduleResourceLabel(state, moduleId) {
  const module = state.modules[moduleId];
  if (!module.resourceId) return "资源待分配";
  const resource = state.resources[module.resourceId];
  if (!resource) return module.resourceId;
  return `${resource.id} · ${resource.count} 份 · 复用 ${resource.reuses || 0}`;
}

function syncPayloadFromDom(state) {
  const selectedNode = document.querySelector(".scene-item.is-selected");
  return {
    drafts: {
      image: getDraftFromDom("image"),
      audio: getDraftFromDom("audio"),
      export: getDraftFromDom("export")
    },
    selectedId: selectedNode?.dataset.clipId || null,
    selectedName: selectedNode?.querySelector(".scene-name")?.textContent || null,
    title: byId("project-title")?.value || "",
    clipCount: document.querySelectorAll(".timeline-clip").length
  };
}

function syncPayloadFromState(state) {
  const clip = selectedClip(state);
  return {
    drafts: clone(state.drafts),
    selectedId: state.selectedId,
    selectedName: clip?.name || null,
    title: state.title,
    clipCount: state.clips.length
  };
}

function syncPayloadFromStorage(rawState) {
  if (!rawState) return null;
  const clip = rawState.clips?.find((item) => item.id === rawState.selectedId);
  return {
    drafts: rawState.drafts,
    selectedId: rawState.selectedId,
    selectedName: clip?.name || null,
    title: rawState.title,
    clipCount: rawState.clips?.length || 0
  };
}

export function createUI(state) {
  let toastTimer = null;
  let stepDelay = 150;
  const dialogTriggers = new Map();
  let scrollSaveQueued = false;

  const elements = {
    timeline: byId("timeline-scroller"),
    inspector: byId("inspector-body"),
    exportDialog: byId("export-dialog"),
    logDialog: byId("log-dialog"),
    logList: byId("log-list")
  };

  function toast(message) {
    const node = byId("toast");
    if (!node) return;
    clearTimeout(toastTimer);
    node.textContent = message;
    node.hidden = false;
    toastTimer = setTimeout(() => {
      node.hidden = true;
    }, 4200);
  }

  function showGlobalError(message, error) {
    const banner = byId("global-banner");
    if (banner) banner.hidden = false;
    setText("global-banner-text", message);
    addLog(state, {
      level: "error",
      module: "界面保护",
      stage: "渲染",
      message: `${message}${error ? `：${String(error.message || error)}` : ""}`
    });
    persist(state, "安全模式已记录错误");
    renderLogs();
    renderSaveStatus();
  }

  function safeRender(name, renderFunction) {
    try {
      renderFunction();
    } catch (error) {
      console.error(`[safeRender:${name}]`, error);
      showGlobalError(`${name}视图未完成绘制，其他区域保持可读。`, error);
    }
  }

  function bindDraftInputs() {
    document.querySelectorAll("[data-draft]").forEach((input) => {
      input.addEventListener("input", () => {
        const [moduleId, key] = input.dataset.draft.split(".");
        if (!state.drafts[moduleId]) return;
        state.drafts[moduleId][key] = inputValue(input);
        document.querySelectorAll(`[data-draft="${moduleId}.${key}"]`).forEach((peer) => {
          if (peer !== input && peer.value !== input.value) peer.value = input.value;
        });
        updateDraftOutputs(moduleId);
        persist(state, "草稿已自动保存");
        safeRender("preview", renderPreview);
        safeRender("timeline", renderTimeline);
        safeRender("modules", () => renderModuleStates());
        safeRender("mirror", renderMirror);
        renderSaveStatus();
      });
      input.addEventListener("change", () => {
        const [moduleId] = input.dataset.draft.split(".");
        updateDraftOutputs(moduleId);
        renderMirror();
      });
    });
  }

  function updateDraftOutputs(moduleId) {
    if (moduleId === "image") {
      setText("image-brightness-value", state.drafts.image.brightness);
      setText("image-blur-value", `${Number(state.drafts.image.blur).toFixed(1)} px`);
      setText("image-warmth-value", `${state.drafts.image.warmth >= 0 ? "+" : ""}${state.drafts.image.warmth}`);
    }
    if (moduleId === "audio") {
      setText("audio-frequency-value", `${state.drafts.audio.frequency} Hz`);
      setText("audio-duration-value", `${Number(state.drafts.audio.duration).toFixed(1)} s`);
    }
  }

  function syncDraftControls() {
    for (const [moduleId, fields] of Object.entries(DRAFT_FIELDS)) {
      for (const [key, config] of Object.entries(fields)) {
        const value = state.drafts[moduleId][key];
        document.querySelectorAll(`[data-draft="${moduleId}.${key}"]`).forEach((input) => {
          if (input !== document.activeElement) input.value = value;
        });
        const canonical = byId(config.id);
        if (canonical && canonical !== document.activeElement) canonical.value = value;
      }
    }
    const title = byId("project-title");
    if (title && title !== document.activeElement) title.value = state.title;
    updateDraftOutputs("image");
    updateDraftOutputs("audio");
  }

  function renderScenes() {
    const list = byId("scene-list");
    if (!list) return;
    list.innerHTML = state.clips.map((clip) => `
      <button class="scene-item ${clip.id === state.selectedId ? "is-selected" : ""}" type="button" data-clip-id="${escapeHtml(clip.id)}" data-kind="${escapeHtml(clip.kind)}" aria-pressed="${clip.id === state.selectedId}">
        <span class="scene-thumb" aria-hidden="true">${clip.kind === "image" ? "▧" : "≋"}</span>
        <span>
          <span class="scene-name">${escapeHtml(clip.name)}</span>
          <span class="scene-meta">${clip.kind === "image" ? "图像图层" : "音频图层"} · ${clip.resourceId ? "已绑定资源" : "未生成资源"}</span>
        </span>
        <span class="scene-duration">${formatDuration(clip.duration)}</span>
      </button>
    `).join("");
    setText("clip-count", `${state.clips.length} 项`);
  }

  function renderResources() {
    const list = byId("resource-list");
    if (!list) return;
    const resources = Object.values(state.resources).sort((left, right) => right.createdAt - left.createdAt);
    setText("resource-count", `${resources.length} 个`);
    setText("reuse-summary", resources.length
      ? `共 ${reuseCount(state)} 次幂等复用 · 每个键只保留 1 份`
      : "重试会复用同一资源键。");
    if (resources.length === 0) {
      list.innerHTML = '<p class="microcopy">触发一次处理后，唯一资源会显示在这里。</p>';
      return;
    }
    list.innerHTML = resources.map((resource) => `
      <div class="resource-item" title="${escapeHtml(resource.idempotencyKey)}">
        <strong>${escapeHtml(resource.id)}</strong>
        <span class="resource-reuse">复用 ${resource.reuses || 0}</span>
        <span>${escapeHtml(resource.kind)} · ${resource.count} 份</span>
        <span>${escapeHtml(shortHash(resource.idempotencyKey))}</span>
      </div>
    `).join("");
  }

  function renderTimeline(options = {}) {
    const track = byId("timeline-track");
    if (!track) return;
    const scroller = elements.timeline;
    const previousScroll = typeof options.scroll === "number"
      ? options.scroll
      : Math.max(scroller.scrollLeft, state.view.timelineScroll);
    const totalDuration = 24;
    const zoom = state.view.zoom || 1;
    const rows = [
      { kind: "image", label: "V1" },
      { kind: "audio", label: "A1" }
    ];
    track.style.width = `${980 * zoom}px`;
    track.innerHTML = rows.map((row) => {
      const clips = state.clips.filter((clip) => clip.kind === row.kind);
      return `
        <div class="timeline-row" data-track="${row.kind}">
          <span class="track-label" aria-hidden="true">${row.label}</span>
          ${clips.map((clip) => {
            const left = (clip.start / totalDuration) * 100;
            const width = (clip.duration / totalDuration) * 100;
            return `
              <button class="timeline-clip ${clip.id === state.selectedId ? "is-selected" : ""}" type="button" data-clip-id="${escapeHtml(clip.id)}" data-kind="${clip.kind}" style="left:${left}%;width:${width}%" aria-pressed="${clip.id === state.selectedId}" aria-label="${escapeHtml(clip.name)}，${formatDuration(clip.duration)}">
                <span aria-hidden="true">${clip.kind === "image" ? "▧" : "≋"}</span>${escapeHtml(clip.name)}
              </button>
            `;
          }).join("")}
        </div>
      `;
    }).join("");
    const ruler = document.querySelector(".timeline-ruler");
    if (ruler) ruler.style.width = `${980 * zoom}px`;
    requestAnimationFrame(() => {
      scroller.scrollLeft = Math.min(previousScroll, Math.max(0, scroller.scrollWidth - scroller.clientWidth));
      state.view.timelineScroll = scroller.scrollLeft;
      updateScrollLabels();
    });
  }

  function updateScrollLabels() {
    setText("scroll-position-label", `${Math.round(state.view.timelineScroll || 0)} px`);
    setText("zoom-value", `${Math.round((state.view.zoom || 1) * 100)}%`);
  }

  function renderPreview() {
    const clip = selectedClip(state);
    const draft = state.drafts.image;
    const brightness = Number(draft.brightness) / 100;
    const blur = Number(draft.blur);
    const warmth = Number(draft.warmth);
    const image = byId("preview-image");
    const stage = byId("preview-stage");
    const selection = byId("preview-selection");
    const waveform = byId("preview-waveform");
    if (!clip || !image || !stage || !selection || !waveform) return;
    const filter = `brightness(${brightness.toFixed(2)}) blur(${blur.toFixed(1)}px) sepia(${Math.max(0, warmth / 100).toFixed(2)}) hue-rotate(${warmth > 0 ? -5 : 5}deg)`;
    image.style.filter = filter;
    const sky = document.querySelector(".preview-sky");
    if (sky) sky.style.filter = `brightness(${brightness.toFixed(2)}) saturate(${1 + warmth / 100})`;
    selection.dataset.selectedKind = clip.kind;
    setText("selection-label", `${clip.kind === "image" ? "图像" : "音频"} · ${clip.name}`);
    const waveValues = clip.kind === "image"
      ? makeWave(Number(state.drafts.audio.frequency))
      : makeWave(Number(state.drafts.audio.frequency));
    waveform.innerHTML = makeWaveMarkup(waveValues, clip.kind === "audio" ? "#9dc6ff" : "#f3b477");
    waveform.style.opacity = clip.kind === "audio" ? "0.88" : "0.32";
    setText("preview-filter-label", `亮度 ${draft.brightness} · 模糊 ${Number(draft.blur).toFixed(1)}px`);
    stage.dataset.selectedId = clip.id;
    stage.dataset.selectedKind = clip.kind;
    stage.setAttribute("aria-label", `${clip.name}，图像亮度 ${draft.brightness}，模糊 ${blur} 像素，草稿预览`);
    setText("selected-summary", `已选：${clip.name}`);
    setText("preview-source-badge", "草稿预览");
    const audioBars = byId("audio-waveform-preview");
    if (audioBars) {
      audioBars.innerHTML = makeWave(Number(state.drafts.audio.frequency), 42)
        .map((value) => `<i style="height:${Math.max(8, Math.round(value * 90))}%"></i>`)
        .join("");
    }
  }

  function renderModuleStates() {
    for (const moduleId of Object.keys(MODULE_META)) {
      const module = state.modules[moduleId];
      const card = byId(`module-${moduleId}`);
      if (!card) continue;
      card.classList.toggle("has-error", module.status === "error");
      card.classList.toggle("is-running", module.status === "running");
      card.setAttribute("aria-busy", String(module.status === "running"));
      const stateNode = byId(`module-${moduleId}-state`);
      if (stateNode) {
        stateNode.textContent = moduleStatusLabel(module);
        stateNode.className = `module-state ${statusClass(module)}`;
      }
      const progress = byId(`module-${moduleId}-progress`);
      if (progress) progress.hidden = module.status !== "running";
      const fields = byId(`module-${moduleId}-fields`);
      if (fields) {
        fields.classList.toggle("is-locked", module.status === "running");
        fields.inert = module.status === "running";
      }
      const runButton = byId(`run-${moduleId}`);
      if (runButton) {
        runButton.disabled = module.status === "running";
        runButton.textContent = module.status === "running"
          ? `${module.stage}…`
          : moduleId === "image"
            ? "应用图像处理"
            : moduleId === "audio"
              ? "生成音频"
              : "开始导出";
      }
      const boundary = byId(`module-${moduleId}-boundary`);
      if (boundary) boundary.innerHTML = module.status === "error" ? createBoundaryMarkup(moduleId, module) : "";
    }
    const failed = Object.values(state.modules).filter((module) => module.status === "error").length;
    setText("module-health", failed ? `${3 - failed} / 3 可用 · ${failed} 个待恢复` : "3 / 3 可用");
    byId("module-health")?.classList.toggle("has-error", failed > 0);
    const health = byId("preview-health");
    if (health) {
      health.textContent = failed ? `${failed} 个模块待恢复，其他编辑内容已保留` : "三个模块就绪";
      health.classList.toggle("has-error", failed > 0);
    }
    updateCommitIndicators();
  }

  function updateCommitIndicators() {
    const imageClip = state.clips.find((clip) => clip.kind === "image");
    const audioClip = state.clips.find((clip) => clip.kind === "audio");
    const imageDirty = stableStringify(state.drafts.image) !== stableStringify(imageClip?.style);
    const audioDirty = stableStringify(state.drafts.audio) !== stableStringify(audioClip?.style);
    const imageChip = byId("image-commit-state");
    const audioChip = byId("audio-commit-state");
    const exportChip = byId("export-commit-state");
    if (imageChip) {
      imageChip.textContent = imageDirty ? "未提交草稿" : "已提交";
      imageChip.classList.toggle("is-dirty", imageDirty);
    }
    if (audioChip) {
      audioChip.textContent = audioDirty ? "未提交草稿" : "已提交";
      audioChip.classList.toggle("is-dirty", audioDirty);
    }
    if (exportChip) {
      exportChip.textContent = "草稿已保存";
      exportChip.classList.add("is-dirty");
    }
    setText("image-resource-label", moduleResourceLabel(state, "image"));
    setText("audio-resource-label", moduleResourceLabel(state, "audio"));
    setText("export-resource-label", moduleResourceLabel(state, "export"));
    const playButton = byId("play-audio");
    if (playButton) playButton.disabled = !state.modules.audio.resourceId;
  }

  function renderLogs() {
    const entries = [...state.logs].reverse();
    setText("log-count", String(state.logs.length));
    if (!elements.logList) return;
    elements.logList.innerHTML = entries.map((entry) => `
      <div class="log-entry ${entry.level === "error" ? "is-error" : entry.level === "success" ? "is-success" : ""}">
        <span class="log-time">${formatClock(entry.at)}</span>
        <span class="log-module">${escapeHtml(entry.module)} · ${escapeHtml(entry.stage)}</span>
        <span class="log-message">${escapeHtml(entry.message)}${entry.resourceId ? ` <span class="mono">[${escapeHtml(entry.resourceId)}]</span>` : ""}</span>
      </div>
    `).join("") || '<p class="microcopy">暂无日志。</p>';
  }

  function readStorageState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function renderMirror() {
    const inputPayload = syncPayloadFromState(state);
    const stored = readStorageState();
    const storagePayload = syncPayloadFromStorage(stored);
    const renderPayload = syncPayloadFromDom(state);
    const inputHash = shortHash(inputPayload);
    const storageHash = storagePayload ? shortHash(storagePayload) : "--------";
    const renderHash = shortHash(renderPayload);
    setText("input-hash", inputHash);
    setText("storage-hash", storageHash);
    setText("render-hash", renderHash);
    const inputNode = byId("mirror-input");
    const storageNode = byId("mirror-storage");
    const renderNode = byId("mirror-render");
    if (inputNode) {
      inputNode.textContent = `drafts ${formatDraft(inputPayload.drafts.image)}
${formatDraft(inputPayload.drafts.audio)} · ${formatDraft(inputPayload.drafts.export)}
selected ${inputPayload.selectedId} / title "${inputPayload.title}"`;
    }
    if (storageNode) {
      storageNode.textContent = `rev ${state.meta.revision} · ${state.meta.lastSavedLabel}
key ${STORAGE_KEY}
full ${state.meta.storageHash}
scroll ${Math.round(state.view.timelineScroll)}px`;
    }
    if (renderNode) {
      const clip = selectedClip(state);
      const domSelected = document.querySelector(".scene-item.is-selected")?.dataset.clipId || "none";
      const domClips = document.querySelectorAll(".timeline-clip").length;
      renderNode.textContent = `selected node ${domSelected} / ${clip?.name || "none"}
timeline nodes ${domClips} · filter ${byId("preview-image")?.style.filter || "none"}
inspector ${Math.round(elements.inspector.scrollTop)}px / timeline ${Math.round(elements.timeline.scrollLeft)}px`;
    }
    const consistent = inputHash === storageHash && inputHash === renderHash;
    const badge = byId("sync-badge");
    if (badge) {
      badge.textContent = consistent ? "三方一致 ✓" : "检测到差异";
      badge.classList.toggle("is-ok", consistent);
      badge.classList.toggle("is-warn", !consistent);
    }
    const explanation = byId("sync-explanation");
    if (explanation) {
      explanation.textContent = consistent
        ? `输入、localStorage 与 DOM 快照一致 · ${inputHash} · 草稿写入 ${stored?.meta?.lastSavedLabel || "未知"}`
        : "输入、存储或渲染至少一方不同步；请检查草稿、选中对象或存储状态。";
      explanation.classList.toggle("is-warn", !consistent);
    }
  }

  function renderSaveStatus() {
    const status = byId("save-status");
    if (status) status.classList.remove("is-saving");
    setText("save-status-text", `${state.meta.lastAction} · ${state.meta.lastSavedLabel}`);
  }

  function renderUndoRedo() {
    const undoButton = byId("undo-btn");
    const redoButton = byId("redo-btn");
    if (undoButton) undoButton.disabled = state.history.past.length === 0;
    if (redoButton) redoButton.disabled = state.history.future.length === 0;
  }

  function renderFaultLab() {
    const active = ["image", "audio", "export"].filter((id) => state.faults[id]);
    const errors = Object.entries(state.modules).filter(([, module]) => module.status === "error");
    const note = byId("fault-note");
    if (!note) return;
    note.classList.toggle("is-active", active.length > 0 || errors.length > 0);
    if (errors.length) {
      note.textContent = errors.map(([id, module]) => `${describeModule(id)}：${module.stage} 失败，等待恢复`).join("；");
    } else if (active.length) {
      note.textContent = `${active.map(describeModule).join("、")}已注入，持久模式${state.faults.persistent ? "开启" : "关闭"}`;
    } else {
      note.textContent = "尚未注入故障；正常操作不会报错。";
    }
    const persistent = byId("persistent-fault");
    if (persistent && persistent !== document.activeElement) persistent.checked = state.faults.persistent;
  }

  function renderDialogSummary() {
    const format = String(state.drafts.export.format || "").toUpperCase();
    setText("dialog-summary", `${state.clips.length} 个时间线对象 · ${format} · ${state.drafts.export.quality}质量`);
  }

  function renderAll() {
    safeRender("场景", renderScenes);
    safeRender("资源", renderResources);
    safeRender("时间线", renderTimeline);
    safeRender("预览", renderPreview);
    safeRender("模块", renderModuleStates);
    safeRender("日志", renderLogs);
    safeRender("故障实验室", renderFaultLab);
    safeRender("保存状态", renderSaveStatus);
    safeRender("撤销状态", renderUndoRedo);
    safeRender("对话框", renderDialogSummary);
    safeRender("镜像", renderMirror);
    updateScrollLabels();
  }

  function restoreViewState() {
    requestAnimationFrame(() => {
      elements.timeline.scrollLeft = Math.max(0, Number(state.view.timelineScroll) || 0);
      elements.inspector.scrollTop = Math.max(0, Number(state.view.inspectorScroll) || 0);
      if (elements.logList) elements.logList.scrollTop = Math.max(0, Number(state.view.logScroll) || 0);
      updateScrollLabels();
      safeRender("恢复后镜像", renderMirror);
    });
  }

  function persistAndRefresh(label) {
    persist(state, label);
    renderSaveStatus();
    safeRender("资源", renderResources);
    safeRender("日志", renderLogs);
    safeRender("镜像", renderMirror);
  }

  function selectClip(clipId, focusSelector) {
    if (!state.clips.some((clip) => clip.id === clipId)) return;
    state.selectedId = clipId;
    persist(state, "已切换选中对象");
    safeRender("场景", renderScenes);
    safeRender("时间线", renderTimeline);
    safeRender("预览", renderPreview);
    safeRender("模块状态", renderModuleStates);
    safeRender("镜像", renderMirror);
    safeRender("保存状态", renderSaveStatus);
    if (focusSelector) {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        const focusStillUnclaimed = !active || active === document.body || active === document.documentElement;
        if (focusStillUnclaimed) document.querySelector(focusSelector)?.focus();
      });
    }
  }

  async function runModuleAction(moduleId, options = {}) {
    const module = state.modules[moduleId];
    if (module.status === "running") return;
    const hadError = module.status === "error";
    const sameDraft = hadError
      && module.error
      && stableStringify(state.drafts[moduleId]) === stableStringify(module.error.snapshot?.draft);
    if (options.injectFault) {
      state.faults[moduleId] = true;
      state.faults.persistent = byId("persistent-fault")?.checked || false;
      persist(state, `已注入${describeModule(moduleId)}故障`);
      renderFaultLab();
    }
    const result = await runModule(state, moduleId, {
      isRetry: options.isRetry ?? (hadError && sameDraft),
      download: options.download,
      stepDelay,
      onUpdate: ({ stage }) => {
        safeRender("模块状态", renderModuleStates);
        safeRender("日志", renderLogs);
        safeRender("故障实验室", renderFaultLab);
        if (stage) safeRender("保存状态", renderSaveStatus);
      },
      persistState: () => persistAndRefresh(`${describeModule(moduleId)}处理中`)
    });
    safeRender("全部界面", renderAll);
    if (!result.ok) {
      toast(`${describeModule(moduleId)}在“${result.error.stage}”失败；草稿与资源快照已保留。`);
      requestAnimationFrame(() => byId(`boundary-${moduleId}`)?.focus());
    } else {
      if (hadError) requestAnimationFrame(() => byId(`run-${moduleId}`)?.focus());
      toast(`${describeModule(moduleId)}已恢复；资源复用完成，未新增副本。`);
    }
    return result;
  }

  function handleUndo() {
    if (!undo(state)) return;
    persist(state, "已撤销工程修改");
    safeRender("全部界面", renderAll);
    restoreViewState();
    toast("已撤销上一步工程修改；草稿、选中对象和滚动位置保持不变。");
  }

  function handleRedo() {
    if (!redo(state)) return;
    persist(state, "已重做工程修改");
    safeRender("全部界面", renderAll);
    restoreViewState();
    toast("已重做工程修改。");
  }

  function openDialog(dialog, trigger) {
    if (!dialog || dialog.open) return;
    syncDraftControls();
    dialogTriggers.set(dialog, trigger);
    dialog.showModal();
  }

  function closeDialog(dialog) {
    if (dialog?.open) dialog.close();
  }

  async function copyText(text, successMessage) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    toast(successMessage);
  }

  function bindModuleActions() {
    byId("run-image")?.addEventListener("click", () => runModuleAction("image"));
    byId("run-audio")?.addEventListener("click", () => runModuleAction("audio"));
    byId("run-export")?.addEventListener("click", () => runModuleAction("export"));

    byId("fault-image")?.addEventListener("click", () => runModuleAction("image", { injectFault: true }));
    byId("fault-audio")?.addEventListener("click", () => runModuleAction("audio", { injectFault: true }));
    byId("fault-export")?.addEventListener("click", () => runModuleAction("export", { injectFault: true, download: false }));

    for (const moduleId of Object.keys(MODULE_META)) {
      const reset = byId(`reset-${moduleId}`);
      if (reset) {
        reset.addEventListener("click", () => {
          const clip = moduleId === "image"
            ? state.clips.find((item) => item.kind === "image")
            : moduleId === "audio"
              ? state.clips.find((item) => item.kind === "audio")
              : null;
          if (clip?.style) state.drafts[moduleId] = clone(clip.style);
          resetModuleOperation(state, moduleId);
          persist(state, "已恢复已提交参数");
          syncDraftControls();
          renderAll();
          toast("已恢复到最近一次提交的参数。");
        });
      }
    }

    document.addEventListener("click", (event) => {
      const scene = event.target.closest(".scene-item");
      if (scene) {
        selectClip(scene.dataset.clipId, `.scene-item[data-clip-id="${scene.dataset.clipId}"]`);
        return;
      }
      const timelineClip = event.target.closest(".timeline-clip");
      if (timelineClip) {
        selectClip(timelineClip.dataset.clipId, `.timeline-clip[data-clip-id="${timelineClip.dataset.clipId}"]`);
        return;
      }
      const retry = event.target.closest("[data-retry-module]");
      if (retry) {
        runModuleAction(retry.dataset.retryModule, { isRetry: true });
        return;
      }
      const copySnapshot = event.target.closest("[data-copy-snapshot]");
      if (copySnapshot) {
        const module = state.modules[copySnapshot.dataset.copySnapshot];
        const text = snapshotText(module.error?.snapshot || module.snapshot);
        copyText(text, "安全快照已复制，可粘贴到工单或日志中。");
        return;
      }
      const openModuleLog = event.target.closest("[data-open-module-log]");
      if (openModuleLog) {
        openDialog(elements.logDialog, openModuleLog);
      }
    });
  }

  function scheduleScrollSave() {
    if (scrollSaveQueued) return;
    scrollSaveQueued = true;
    requestAnimationFrame(() => {
      scrollSaveQueued = false;
      persist(state, "已保存视图位置");
      renderSaveStatus();
      safeRender("镜像", renderMirror);
    });
  }

  function bindViewControls() {
    byId("undo-btn")?.addEventListener("click", handleUndo);
    byId("redo-btn")?.addEventListener("click", handleRedo);
    byId("project-title")?.addEventListener("input", (event) => {
      state.title = event.target.value;
      persist(state, "工程名称已保存");
      renderSaveStatus();
      safeRender("镜像", renderMirror);
    });

    elements.timeline?.addEventListener("scroll", () => {
      state.view.timelineScroll = elements.timeline.scrollLeft;
      updateScrollLabels();
      scheduleScrollSave();
    }, { passive: true });

    elements.inspector?.addEventListener("scroll", () => {
      state.view.inspectorScroll = elements.inspector.scrollTop;
      scheduleScrollSave();
    }, { passive: true });

    elements.logList?.addEventListener("scroll", () => {
      state.view.logScroll = elements.logList.scrollTop;
      scheduleScrollSave();
    }, { passive: true });

    byId("zoom-out")?.addEventListener("click", () => {
      state.view.zoom = Math.max(0.75, Number((state.view.zoom - 0.25).toFixed(2)));
      persist(state, "时间线缩放已保存");
      safeRender("时间线", () => renderTimeline());
      safeRender("镜像", renderMirror);
    });

    byId("zoom-in")?.addEventListener("click", () => {
      state.view.zoom = Math.min(1.75, Number((state.view.zoom + 0.25).toFixed(2)));
      persist(state, "时间线缩放已保存");
      safeRender("时间线", () => renderTimeline());
      safeRender("镜像", renderMirror);
    });

    byId("persistent-fault")?.addEventListener("change", (event) => {
      state.faults.persistent = event.target.checked;
      if (!event.target.checked) {
        state.faults.image = false;
        state.faults.audio = false;
        state.faults.export = false;
      }
      persist(state, "故障演练模式已更新");
      renderFaultLab();
      toast(event.target.checked ? "持久失败已开启：重试仍会保留可读快照。" : "持久失败已关闭：下次重试会尝试恢复。");
    });

    byId("preview-play")?.addEventListener("click", () => {
      const url = getAudioUrl(state);
      if (!url) {
        toast("请先成功生成音频，或重新运行音频合成。");
        return;
      }
      const audio = new Audio(url);
      audio.play().then(() => {
        const button = byId("preview-play");
        if (button) button.textContent = "■";
        audio.addEventListener("ended", () => {
          if (button) button.textContent = "▶";
        });
      }).catch(() => toast("浏览器阻止了自动播放，请再次点击播放。"));
    });

    byId("play-audio")?.addEventListener("click", () => byId("preview-play")?.click());
  }

  function bindDialogs() {
    const exportTrigger = byId("open-export");
    const editExportTrigger = byId("edit-export");
    byId("open-export")?.addEventListener("click", () => openDialog(elements.exportDialog, exportTrigger));
    editExportTrigger?.addEventListener("click", () => openDialog(elements.exportDialog, editExportTrigger));
    byId("close-export")?.addEventListener("click", () => closeDialog(elements.exportDialog));
    byId("cancel-export")?.addEventListener("click", () => closeDialog(elements.exportDialog));
    byId("confirm-export")?.addEventListener("click", () => {
      closeDialog(elements.exportDialog);
      runModuleAction("export");
    });
    byId("export-form")?.addEventListener("submit", (event) => event.preventDefault());

    const logTrigger = byId("open-logs");
    byId("open-logs")?.addEventListener("click", () => openDialog(elements.logDialog, logTrigger));
    byId("close-logs")?.addEventListener("click", () => closeDialog(elements.logDialog));
    byId("close-logs-footer")?.addEventListener("click", () => closeDialog(elements.logDialog));
    byId("copy-log")?.addEventListener("click", () => {
      const text = state.logs.map((entry) => `${formatClock(entry.at)} [${entry.module}/${entry.stage}] ${entry.message}`).join("\n");
      copyText(text, "运行日志已复制。");
    });

    for (const dialog of [elements.exportDialog, elements.logDialog]) {
      dialog?.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        const focusable = [...dialog.querySelectorAll(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"
        )].filter((element) => element.getClientRects().length > 0);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (!dialog.contains(active)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      });
      dialog?.addEventListener("close", () => {
        const trigger = dialogTriggers.get(dialog);
        requestAnimationFrame(() => {
          if (trigger && document.contains(trigger)) trigger.focus();
        });
      });
    }
  }

  function bindKeyboard() {
    document.addEventListener("keydown", (event) => {
      const editable = event.target.closest?.("input, textarea, select, [contenteditable='true']");
      const dialogOpen = elements.exportDialog.open || elements.logDialog.open;
      if (dialogOpen) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "z") {
        if (editable) return;
        event.preventDefault();
        if (event.shiftKey) handleRedo();
        else handleUndo();
      }
      if (modifier && event.key.toLowerCase() === "y" && !editable) {
        event.preventDefault();
        handleRedo();
      }
    });
  }

  function bindGlobalControls() {
    byId("global-dismiss")?.addEventListener("click", () => {
      const banner = byId("global-banner");
      if (banner) banner.hidden = true;
    });
    window.addEventListener("beforeunload", () => {
      persist(state, "离开前已保存");
    });
    window.addEventListener("pagehide", () => {
      persist(state, "页面隐藏前已保存");
    });
  }

  function mount() {
    syncDraftControls();
    bindDraftInputs();
    bindModuleActions();
    bindViewControls();
    bindDialogs();
    bindKeyboard();
    bindGlobalControls();
    renderAll();
    restoreViewState();
  }

  function setStepDelay(milliseconds) {
    stepDelay = Math.max(1, Number(milliseconds) || 1);
  }

  return {
    mount,
    renderAll,
    renderMirror,
    showGlobalError,
    toast,
    setStepDelay,
    runModuleAction,
    selectClip,
    getStepDelay: () => stepDelay
  };
}
