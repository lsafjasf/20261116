const STORAGE = {
  autosave: "frame.autosave.v1",
  exportSettings: "frame.export-settings.v1",
  session: "frame.session.v1",
  archived: "frame.autosave.archived.v1",
  failed: "frame.autosave.failed.v1"
};

const APP_SCHEMA = 1;
const SESSION_ID = globalThis.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clone = (value) => structuredClone(value);

function makeBaseProject() {
  return {
    schema: 1,
    id: "project-city-pulse",
    name: "城市脉搏 / 初剪",
    revision: 12,
    duration: 32,
    fps: 24,
    resolution: "1920x1080",
    colorSpace: "REC.709",
    tracks: [
      {
        id: "track-v1",
        type: "video",
        name: "主画面",
        enabled: true,
        locked: false,
        clips: [
          {
            id: "clip-skyline",
            name: "城市天际线",
            scene: "skyline",
            style: "video-clip",
            start: 2.4,
            duration: 8.2,
            scale: 112,
            opacity: 100,
            caption: "把城市的速度，留在这一帧。",
            keyframes: [
              { id: "kf-skyline-1", time: 0, property: "scale", value: 100, easing: "ease-out" },
              { id: "kf-skyline-2", time: 3.6, property: "scale", value: 112, easing: "ease-in-out" },
              { id: "kf-skyline-3", time: 8.2, property: "scale", value: 106, easing: "linear" }
            ]
          }
        ]
      },
      {
        id: "track-v2",
        type: "video",
        name: "城市叠加",
        enabled: true,
        locked: false,
        clips: [
          {
            id: "clip-night",
            name: "霓虹雨夜",
            scene: "night",
            style: "night-clip",
            start: 11.1,
            duration: 6.4,
            scale: 104,
            opacity: 88,
            caption: "雨停之前，城市仍在发光。",
            keyframes: [
              { id: "kf-night-1", time: 0, property: "opacity", value: 64, easing: "ease-in" },
              { id: "kf-night-2", time: 6.4, property: "opacity", value: 88, easing: "ease-out" }
            ]
          },
          {
            id: "clip-interview",
            name: "人物访谈",
            scene: "interview",
            style: "interview-clip",
            start: 18.2,
            duration: 11.2,
            scale: 100,
            opacity: 100,
            caption: "“这座城真正的节奏，来自住在里面的人。”",
            keyframes: [
              { id: "kf-int-1", time: 0, property: "scale", value: 100, easing: "linear" },
              { id: "kf-int-2", time: 11.2, property: "scale", value: 104, easing: "ease-in-out" }
            ]
          }
        ]
      },
      {
        id: "track-a1",
        type: "audio",
        name: "旁白 / VO",
        enabled: true,
        locked: false,
        sound: {
          volumeDb: -4.5,
          pan: 12,
          eq: { low: 1.2, mid: -0.8, high: 1.8 },
          compressor: true,
          noiseReduction: 42
        },
        clips: [
          {
            id: "clip-vo",
            name: "旁白_最终.wav",
            scene: "skyline",
            style: "audio-clip",
            start: 0,
            duration: 18.4,
            scale: 100,
            opacity: 100,
            caption: "旁白轨道 · 已降噪",
            keyframes: []
          }
        ]
      },
      {
        id: "track-a2",
        type: "audio",
        name: "氛围 / MUSIC",
        enabled: true,
        locked: false,
        sound: {
          volumeDb: -10,
          pan: -8,
          eq: { low: 0.6, mid: -1.4, high: 0.9 },
          compressor: false,
          noiseReduction: 0
        },
        clips: [
          {
            id: "clip-music",
            name: "城市底噪.wav",
            scene: "night",
            style: "music-clip",
            start: 2.2,
            duration: 27.4,
            scale: 100,
            opacity: 84,
            caption: "环境声 · 循环 1 次",
            keyframes: []
          }
        ]
      }
    ]
  };
}

function makeDefaultExportSettings() {
  return {
    filename: "city-pulse-v12",
    preset: "master",
    format: "mp4",
    resolution: "1080p",
    fps: "24",
    bitrate: 45,
    audioCodec: "aac",
    range: "all",
    normalize: true,
    updatedAt: null
  };
}

function makeDefaultUi() {
  return {
    selected: { kind: "clip", id: "clip-skyline" },
    playhead: 8.42,
    timelineScroll: { left: 0, top: 0 },
    zoom: 34,
    drafts: {}
  };
}

function createState(project = makeBaseProject()) {
  return {
    project,
    ui: makeDefaultUi(),
    exportSettings: makeDefaultExportSettings(),
    lastSavedAt: null,
    lastSavedReason: null,
    lastEnvelope: null,
    recoveryEnvelope: null,
    recoveryDecision: "pending",
    saveState: "saved",
    suppressCleanShutdown: false,
    activeInput: null
  };
}

const state = createState();
const history = { undo: [], redo: [] };

const els = {
  projectName: $("#project-name"),
  unsavedDot: $("#unsaved-dot"),
  saveIndicator: $("#save-indicator"),
  saveLabel: $("#save-label"),
  saveTime: $("#save-time"),
  undoButton: $("#undo-button"),
  redoButton: $("#redo-button"),
  interruptButton: $("#interrupt-button"),
  exportButton: $("#export-button"),
  mediaList: $(".media-list"),
  storageSize: $("#storage-size"),
  storageMeter: $("#storage-meter-fill"),
  preview: $("#preview"),
  previewScene: $("#preview-scene"),
  previewClipName: $("#preview-clip-name"),
  previewCaption: $("#preview-caption"),
  previewTimecode: $("#preview-timecode"),
  previewBadge: $("#preview-badge"),
  currentTimecode: $("#current-timecode"),
  durationOutput: $("#duration-output"),
  playheadRange: $("#playhead-range"),
  playButton: $("#play-button"),
  playIcon: $("#play-icon"),
  markerButton: $("#marker-button"),
  selectedKind: $("#selected-kind"),
  selectedIdLabel: $("#selected-id-label"),
  inspectorForm: $("#inspector-form"),
  clipName: $("#clip-name"),
  clipStart: $("#clip-start"),
  clipDuration: $("#clip-duration"),
  clipScale: $("#clip-scale"),
  clipOpacity: $("#clip-opacity"),
  audioPanel: $("#audio-panel"),
  audioVolume: $("#audio-volume"),
  audioPan: $("#audio-pan"),
  eqLow: $("#eq-low"),
  eqMid: $("#eq-mid"),
  eqHigh: $("#eq-high"),
  audioLevelChip: $("#audio-level-chip"),
  draftState: $("#draft-state"),
  applyButton: $("#apply-button"),
  formError: $("#form-error"),
  keyframeList: $("#keyframe-list"),
  keyframeCount: $("#keyframe-count"),
  addKeyframeButton: $("#add-keyframe-button"),
  syncBadge: $("#sync-badge"),
  syncInput: $("#sync-input"),
  syncMemory: $("#sync-memory"),
  syncStorage: $("#sync-storage"),
  syncRender: $("#sync-render"),
  syncChecks: $("#sync-checks"),
  syncJson: $("#sync-json"),
  recoveryFailureDemo: $("#recovery-failure-demo"),
  downloadSnapshot: $("#download-snapshot"),
  trackLabels: $("#track-labels"),
  timelineScroll: $("#timeline-scroll"),
  timelineContent: $("#timeline-content"),
  timelineRuler: $("#timeline-ruler"),
  trackLanes: $("#track-lanes"),
  timelinePlayhead: $("#timeline-playhead"),
  zoomLabel: $("#zoom-label"),
  zoomIn: $("#zoom-in"),
  zoomOut: $("#zoom-out"),
  autosaveNote: $("#autosave-note"),
  recoveryDialog: $("#recovery-dialog"),
  recoverySummary: $("#recovery-summary"),
  acceptRecovery: $("#accept-recovery"),
  declineRecovery: $("#decline-recovery"),
  exportDialog: $("#export-dialog"),
  exportForm: $("#export-form"),
  exportFilename: $("#export-filename"),
  exportPreset: $("#export-preset"),
  exportFormat: $("#export-format"),
  exportResolution: $("#export-resolution"),
  exportFps: $("#export-fps"),
  exportBitrate: $("#export-bitrate"),
  exportAudio: $("#export-audio"),
  exportRange: $("#export-range"),
  exportNormalize: $("#export-normalize"),
  exportSummary: $("#export-summary"),
  startExport: $("#start-export"),
  failureDialog: $("#failure-dialog"),
  failureRaw: $("#failure-raw"),
  failureReason: $("#failure-reason"),
  copyFailureRaw: $("#copy-failure-raw"),
  downloadFailureRaw: $("#download-failure-raw"),
  dismissFailure: $("#dismiss-failure"),
  toastRegion: $("#toast-region")
};

function allTracks() {
  return state.project.tracks;
}

function allClips() {
  return state.project.tracks.flatMap((track) => track.clips.map((clip) => ({ clip, track })));
}

function findClipById(id) {
  return allClips().find(({ clip }) => clip.id === id) || null;
}

function findTrackByClipId(id) {
  return allTracks().find((track) => track.clips.some((clip) => clip.id === id)) || null;
}

function selectedEntry() {
  const selected = state.ui.selected;
  if (!selected) return null;
  return findClipById(selected.id);
}

function selectedClip() {
  return selectedEntry()?.clip || null;
}

function selectedTrack() {
  return selectedEntry()?.track || null;
}

function countKeyframes(project = state.project) {
  if (!Array.isArray(project?.tracks)) return 0;
  return project.tracks.reduce(
    (trackTotal, track) =>
      trackTotal +
      (Array.isArray(track?.clips)
        ? track.clips.reduce((clipTotal, clip) => clipTotal + (clip.keyframes?.length || 0), 0)
        : 0),
    0
  );
}

function formatTimecode(seconds, fps = state.project.fps || 24) {
  const safe = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(safe);
  const frames = Math.min(Math.round((safe - whole) * fps), fps - 1);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return [hours, minutes, secs, frames].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatClock(value = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(value);
}

function formatDateTime(value) {
  if (!value) return "未保存";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function parseJson(raw) {
  try {
    return { value: JSON.parse(raw), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function requireNumber(value, label, min = -Infinity, max = Infinity) {
  if (!isFiniteNumber(value) || value < min || value > max) {
    throw new Error(`${label} 无效（应为 ${min}–${max}）`);
  }
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("快照内容为空或格式不正确");
  const project = snapshot.project;
  if (!project || typeof project !== "object") throw new Error("快照缺少项目对象");
  if (!Array.isArray(project.tracks)) throw new Error("项目轨道数据损坏：tracks 不是数组");
  if (project.tracks.length === 0) throw new Error("项目没有可恢复的轨道");
  requireNumber(project.duration, "项目时长", 1, 7200);
  requireNumber(project.fps, "项目帧率", 1, 240);
  if (typeof project.name !== "string" || !project.name.trim()) throw new Error("项目名称缺失");

  const ids = new Set();
  for (const [trackIndex, track] of project.tracks.entries()) {
    if (!track || typeof track !== "object") throw new Error(`第 ${trackIndex + 1} 条轨道为空`);
    if (!track.id || ids.has(track.id)) throw new Error(`第 ${trackIndex + 1} 条轨道 ID 缺失或重复`);
    ids.add(track.id);
    if (!["video", "audio"].includes(track.type)) throw new Error(`轨道 ${track.name || track.id} 类型无效`);
    if (!Array.isArray(track.clips)) throw new Error(`轨道 ${track.name || track.id} 的片段列表损坏`);
    if (track.type === "audio") {
      if (!track.sound || typeof track.sound !== "object") throw new Error(`音轨 ${track.name} 缺少声音参数`);
      requireNumber(track.sound.volumeDb, `${track.name} 增益`, -60, 12);
      requireNumber(track.sound.pan, `${track.name} 声像`, -100, 100);
      if (!track.sound.eq) throw new Error(`音轨 ${track.name} 缺少均衡器参数`);
      requireNumber(track.sound.eq.low, `${track.name} 低频`, -12, 12);
      requireNumber(track.sound.eq.mid, `${track.name} 中频`, -12, 12);
      requireNumber(track.sound.eq.high, `${track.name} 高频`, -12, 12);
    }
    for (const clip of track.clips) {
      if (!clip || !clip.id || ids.has(clip.id)) throw new Error(`片段 ID 缺失或重复（${clip?.name || "未知"}）`);
      ids.add(clip.id);
      if (typeof clip.name !== "string" || !clip.name.trim()) throw new Error(`片段 ${clip.id} 缺少名称`);
      requireNumber(clip.start, `${clip.name} 入点`, 0, project.duration);
      requireNumber(clip.duration, `${clip.name} 时长`, 0.1, project.duration);
      requireNumber(clip.scale, `${clip.name} 缩放`, 1, 1000);
      requireNumber(clip.opacity, `${clip.name} 不透明度`, 0, 100);
      if (!Array.isArray(clip.keyframes)) throw new Error(`片段 ${clip.name} 的关键帧列表损坏`);
      for (const keyframe of clip.keyframes) {
        if (!keyframe?.id) throw new Error(`片段 ${clip.name} 存在无效关键帧`);
        requireNumber(keyframe.time, `${clip.name} 关键帧时间`, 0, clip.duration);
        requireNumber(keyframe.value, `${clip.name} 关键帧值`, -10000, 10000);
      }
    }
  }

  const ui = snapshot.ui;
  if (!ui || typeof ui !== "object") throw new Error("快照缺少界面状态");
  requireNumber(ui.playhead, "播放位置", 0, project.duration);
  if (!ui.selected || !findSnapshotClip(project, ui.selected.id)) throw new Error("快照中的选中对象不存在");
  if (!ui.timelineScroll || typeof ui.timelineScroll !== "object") throw new Error("时间线滚动位置缺失");
  requireNumber(ui.timelineScroll.left, "时间线横向位置", 0, 1000000);
  requireNumber(ui.timelineScroll.top, "时间线纵向位置", 0, 1000000);
  if (!ui.drafts || typeof ui.drafts !== "object" || Array.isArray(ui.drafts)) {
    throw new Error("未提交草稿数据损坏");
  }
  return true;
}

function findSnapshotClip(project, clipId) {
  for (const track of project.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function readPreviousSession() {
  const raw = safeStorageGet(STORAGE.session);
  if (!raw) return null;
  const parsed = parseJson(raw);
  return parsed.value && typeof parsed.value === "object" ? parsed.value : null;
}

function readEnvelope() {
  const raw = safeStorageGet(STORAGE.autosave);
  if (!raw) return null;
  const parsed = parseJson(raw);
  return {
    raw,
    envelope: parsed.value,
    parseError: parsed.error
  };
}

function readExportSettings() {
  const raw = safeStorageGet(STORAGE.exportSettings);
  if (!raw) return null;
  const parsed = parseJson(raw);
  if (!parsed.value || typeof parsed.value !== "object") return null;
  return { ...makeDefaultExportSettings(), ...parsed.value };
}

function writeSession(status, extra = {}) {
  const now = new Date().toISOString();
  const payload = {
    schema: APP_SCHEMA,
    id: SESSION_ID,
    status,
    startedAt: state.sessionStartedAt || now,
    lastSeen: now,
    ...extra
  };
  return safeStorageSet(STORAGE.session, JSON.stringify(payload));
}

function buildEnvelope(reason) {
  return {
    schema: APP_SCHEMA,
    app: "frame-local-editor",
    savedAt: new Date().toISOString(),
    reason,
    sessionId: SESSION_ID,
    snapshot: clone({
      project: state.project,
      ui: state.ui,
      exportSettings: state.exportSettings
    })
  };
}

let saveTimer = null;
let pendingSaveReason = "edit";

const SAVE_LABELS = {
  edit: "项目变更",
  selection: "选中对象",
  draft: "未提交草稿",
  playback: "播放位置",
  scroll: "时间线位置",
  commit: "属性应用",
  undo: "撤销",
  redo: "重做",
  "export-settings": "导出设置",
  "normal-refresh": "刷新前",
  "forced-interruption": "强制中断",
  "recovery-declined": "放弃恢复",
  "recovery-accepted": "恢复完成",
  keyframe: "关键帧"
};

function queueSave(reason = "edit", delay = 220) {
  pendingSaveReason = reason;
  state.saveState = "saving";
  renderSaveStatus("saving", "正在自动保存…");
  els.unsavedDot.hidden = false;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(reason), delay);
  updateSyncPanel();
}

function saveNow(reason = pendingSaveReason) {
  clearTimeout(saveTimer);
  saveTimer = null;
  const envelope = buildEnvelope(reason);
  const serialized = JSON.stringify(envelope);
  const result = safeStorageSet(STORAGE.autosave, serialized);
  const exportResult = safeStorageSet(STORAGE.exportSettings, JSON.stringify(state.exportSettings));

  if (!result.ok || !exportResult.ok) {
    state.saveState = "error";
    renderSaveStatus("error", "自动保存失败");
    els.unsavedDot.hidden = false;
    showToast("自动保存失败：浏览器存储不可用。当前内容仍保留在内存中。", "error");
    updateSyncPanel();
    return false;
  }

  writeSession("active");
  state.lastEnvelope = envelope;
  state.lastSavedAt = envelope.savedAt;
  state.lastSavedReason = reason;
  state.saveState = "saved";
  els.unsavedDot.hidden = true;
  renderSaveStatus("saved", `已自动保存 · ${SAVE_LABELS[reason] || reason}`);
  renderStorageMeta(serialized);
  updateSyncPanel();
  return true;
}

function renderSaveStatus(mode, label) {
  els.saveIndicator.dataset.state = mode;
  els.saveLabel.textContent = label;
  els.saveTime.textContent =
    mode === "saving" ? "…" : formatClock(state.lastSavedAt ? new Date(state.lastSavedAt) : new Date());
}

function renderStorageMeta(serialized = null) {
  const raw = serialized || safeStorageGet(STORAGE.autosave) || "";
  const bytes = new Blob([raw]).size;
  els.storageSize.textContent = formatBytes(bytes);
  els.storageMeter.style.width = `${Math.min(100, Math.max(5, (bytes / 6000) * 100))}%`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function draftKey() {
  const selected = state.ui.selected;
  return selected ? `${selected.kind}:${selected.id}` : "none";
}

function committedInspectorValues() {
  const clip = selectedClip();
  const track = selectedTrack();
  if (!clip) return null;
  return {
    name: clip.name,
    start: String(clip.start),
    duration: String(clip.duration),
    scale: String(clip.scale),
    opacity: String(clip.opacity),
    ...(track?.type === "audio"
      ? {
          volumeDb: String(track.sound.volumeDb),
          pan: String(track.sound.pan),
          eqLow: String(track.sound.eq.low),
          eqMid: String(track.sound.eq.mid),
          eqHigh: String(track.sound.eq.high)
        }
      : {})
  };
}

function readInspectorValues() {
  const track = selectedTrack();
  return {
    name: els.clipName.value,
    start: els.clipStart.value,
    duration: els.clipDuration.value,
    scale: els.clipScale.value,
    opacity: els.clipOpacity.value,
    ...(track?.type === "audio"
      ? {
          volumeDb: els.audioVolume.value,
          pan: els.audioPan.value,
          eqLow: els.eqLow.value,
          eqMid: els.eqMid.value,
          eqHigh: els.eqHigh.value
        }
      : {})
  };
}

function valuesDiffer(a, b) {
  if (!a || !b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (String(a[key] ?? "") !== String(b[key] ?? "")) return true;
  }
  return false;
}

function hasDraft() {
  return Boolean(state.ui.drafts[draftKey()]);
}

function captureDraftFromInputs() {
  if (!selectedClip()) return;
  const values = readInspectorValues();
  const committed = committedInspectorValues();
  if (valuesDiffer(values, committed)) {
    state.ui.drafts[draftKey()] = values;
  } else {
    delete state.ui.drafts[draftKey()];
  }
  renderDraftState();
  updateSyncPanel();
}

function renderDraftState() {
  const dirty = hasDraft();
  els.draftState.textContent = dirty ? "有未提交草稿 · 已随快照保存" : "与已提交状态一致";
  els.draftState.classList.toggle("is-dirty", dirty);
  const draft = state.ui.drafts[draftKey()] || {};
  const fieldPairs = [
    [els.clipName, "name"],
    [els.clipStart, "start"],
    [els.clipDuration, "duration"],
    [els.clipScale, "scale"],
    [els.clipOpacity, "opacity"],
    [els.audioVolume, "volumeDb"],
    [els.audioPan, "pan"],
    [els.eqLow, "eqLow"],
    [els.eqMid, "eqMid"],
    [els.eqHigh, "eqHigh"]
  ];
  for (const [input, field] of fieldPairs) {
    if (input) input.classList.toggle("has-draft", Object.hasOwn(draft, field));
  }
  updateSyncPanel();
}

function fillInspector() {
  const clip = selectedClip();
  const track = selectedTrack();
  if (!clip || !track) return;
  const draft = state.ui.drafts[draftKey()];
  const values = draft || committedInspectorValues();
  els.selectedKind.textContent = `片段 · ${track.name}`;
  els.selectedIdLabel.textContent = clip.id;
  els.clipName.value = values.name;
  els.clipStart.value = values.start;
  els.clipDuration.value = values.duration;
  els.clipScale.value = values.scale;
  els.clipOpacity.value = values.opacity;
  els.audioPanel.hidden = track.type !== "audio";
  els.addKeyframeButton.disabled = track.type === "audio";
  els.addKeyframeButton.title = track.type === "audio" ? "音轨参数直接保存，暂不使用关键帧" : "在当前播放位置添加关键帧";
  if (track.type === "audio") {
    els.audioVolume.value = values.volumeDb;
    els.audioPan.value = values.pan;
    els.eqLow.value = values.eqLow;
    els.eqMid.value = values.eqMid;
    els.eqHigh.value = values.eqHigh;
    els.audioLevelChip.textContent = `${Number(values.volumeDb).toFixed(1)} dB`;
  }
  els.formError.hidden = true;
  renderDraftState();
  renderKeyframes();
}

function renderKeyframes() {
  const clip = selectedClip();
  if (!clip) {
    els.keyframeList.innerHTML = "";
    els.keyframeCount.textContent = "0";
    return;
  }
  const keyframes = [...clip.keyframes].sort((a, b) => a.time - b.time);
  els.keyframeCount.textContent = String(keyframes.length);
  if (keyframes.length === 0) {
    els.keyframeList.innerHTML = '<p class="keyframe-empty">此片段尚无关键帧。</p>';
    return;
  }
  els.keyframeList.innerHTML = keyframes
    .map(
      (keyframe) => `
        <button class="keyframe-row" type="button" role="listitem" data-keyframe-time="${keyframe.time}" title="跳到 ${formatTimecode(keyframe.time)}">
          <i aria-hidden="true"></i>
          <code>${escapeHtml(keyframe.property)} · ${escapeHtml(keyframe.value)}</code>
          <small>${formatTimecode(keyframe.time)}</small>
        </button>`
    )
    .join("");
}

const PREVIEW_COPY = {
  skyline: ["把城市的速度，留在这一帧。", "CITY IN MOTION / 01"],
  night: ["雨停之前，城市仍在发光。", "NEON AFTERGLOW / 02"],
  interview: ["“这座城真正的节奏，来自住在里面的人。”", "VOICES / 03"]
};

function renderPreview() {
  const entry = selectedEntry();
  const clip = entry?.clip;
  if (!clip) return;
  const track = entry.track;
  const scene = clip.scene || "skyline";
  const [defaultCaption, kicker] = PREVIEW_COPY[scene] || PREVIEW_COPY.skyline;
  const isAudio = track.type === "audio";
  els.preview.dataset.scene = scene;
  els.preview.dataset.selectedId = clip.id;
  els.previewScene.style.transform = `scale(${Number(clip.scale) / 100})`;
  els.previewScene.style.opacity = String(Number(clip.opacity) / 100);
  els.previewClipName.textContent = clip.name;
  els.previewCaption.textContent = isAudio
    ? `${track.name} · ${track.sound.volumeDb.toFixed(1)} dB · 声像 ${track.sound.pan > 0 ? "+" : ""}${track.sound.pan}%`
    : clip.caption || defaultCaption;
  const kickerElement = $(".preview-kicker", els.preview);
  if (kickerElement) kickerElement.textContent = isAudio ? "AUDIO FOCUS / LIVE" : kicker;
  els.previewBadge.textContent = isAudio ? "音轨参数" : "片段预览";
  els.preview.setAttribute("aria-label", `${clip.name}${isAudio ? "音频参数" : "视频预览"}`);
}

function updateTimeDisplay() {
  const timecode = formatTimecode(state.ui.playhead);
  const duration = formatTimecode(state.project.duration);
  els.currentTimecode.textContent = timecode;
  els.previewTimecode.textContent = timecode;
  els.durationOutput.textContent = duration;
  els.playheadRange.max = String(state.project.duration);
  els.playheadRange.value = String(state.ui.playhead);
  const progress = Math.max(0, Math.min(100, (state.ui.playhead / state.project.duration) * 100));
  els.playheadRange.style.setProperty("--range-progress", `${progress}%`);
  els.timelinePlayhead.style.left = `${state.ui.playhead * state.ui.zoom}px`;
}

function renderTransport() {
  updateTimeDisplay();
  els.playButton.setAttribute("aria-pressed", state.isPlaying ? "true" : "false");
  els.playButton.setAttribute("aria-label", state.isPlaying ? "暂停" : "播放");
  els.playIcon.textContent = state.isPlaying ? "Ⅱ" : "▶";
}

function renderProjectHeader() {
  els.projectName.textContent = state.project.name;
  document.title = `${state.project.name} · FRAME`;
}

function renderSelectionState() {
  const selectedId = state.ui.selected?.id;
  $$(".media-item").forEach((item) => {
    item.classList.toggle("is-selected", item.dataset.clipId === selectedId);
  });
  $$(".clip", els.trackLanes).forEach((clip) => {
    clip.setAttribute("aria-pressed", clip.dataset.clipId === selectedId ? "true" : "false");
  });
  $$(".track-label", els.trackLabels).forEach((label) => {
    label.classList.toggle("is-selected", label.dataset.trackId === selectedTrack()?.id);
  });
}

function renderTimeline() {
  const zoom = state.ui.zoom;
  const contentWidth = Math.max(720, state.project.duration * zoom);
  els.timelineContent.style.width = `${contentWidth}px`;
  els.zoomLabel.textContent = `${zoom} px/s`;

  const tickStep = zoom >= 50 ? 1 : 2;
  const ticks = [];
  for (let second = 0; second <= state.project.duration; second += tickStep) {
    const major = second % (tickStep * 2) === 0 || second === 0;
    ticks.push(
      `<i class="ruler-tick${major ? " major" : ""}" style="left:${second * zoom}px">${
        major ? `<span>${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}</span>` : ""
      }</i>`
    );
  }
  els.timelineRuler.innerHTML = ticks.join("");

  els.trackLabels.innerHTML = `<div class="label-spacer" aria-hidden="true"></div>${state.project.tracks
    .map(
      (track) => `
        <button class="track-label ${track.type}" type="button" data-track-id="${escapeHtml(track.id)}" data-first-clip="${escapeHtml(
          track.clips[0]?.id || ""
        )}" aria-label="${escapeHtml(track.name)}，${track.type === "audio" ? "音频" : "视频"}轨道，选择首个片段">
          <span><i aria-hidden="true"></i>${escapeHtml(track.name)}</span>
          <small>${
            track.type === "audio"
              ? `${track.sound.volumeDb.toFixed(1)} dB · pan ${track.sound.pan > 0 ? "+" : ""}${track.sound.pan}%`
              : `${track.clips.length} 个片段 · ${track.enabled ? "启用" : "停用"}`
          }</small>
        </button>`
    )
    .join("")}`;

  els.trackLanes.innerHTML = state.project.tracks
    .map(
      (track) => `
        <div class="track-lane ${track.type}" data-track-id="${escapeHtml(track.id)}">
          ${track.clips
            .map((clip) => {
              const isSelected = state.ui.selected?.id === clip.id;
              const keyframes = (clip.keyframes || [])
                .map(
                  (keyframe) =>
                    `<i class="clip-keyframe" style="left:${Math.max(
                      0,
                      Math.min(clip.duration * zoom - 5, keyframe.time * zoom)
                    )}px"></i>`
                )
                .join("");
              return `
                <button class="clip ${escapeHtml(clip.style || "video-clip")}" type="button" data-clip-id="${escapeHtml(
                  clip.id
                )}" aria-pressed="${isSelected}" aria-label="选择片段 ${escapeHtml(clip.name)}，开始 ${formatTimecode(
                  clip.start
                )}，时长 ${formatTimecode(clip.duration)}" style="left:${clip.start * zoom}px;width:${Math.max(
                  20,
                  clip.duration * zoom
                )}px">
                  <span class="clip-label">${escapeHtml(clip.name)}</span>
                  <span class="clip-meta">${formatTimecode(clip.duration)} · ${escapeHtml(track.name)}</span>
                  ${track.type === "audio" ? '<span class="waveform" aria-hidden="true"></span>' : ""}
                  <span class="clip-keyframes" aria-hidden="true">${keyframes}</span>
                </button>`;
            })
            .join("")}
        </div>`
    )
    .join("");

  updateTimeDisplay();
  renderSelectionState();
  updateSyncPanel();
}

function syncCheck(label, ok) {
  return `<span class="check ${ok ? "ok" : "bad"}">${ok ? "✓" : "!"} ${escapeHtml(label)}</span>`;
}

function updateSyncPanel() {
  if (!els.syncJson) return;
  const clip = selectedClip();
  const track = selectedTrack();
  const draft = state.ui.drafts[draftKey()] || null;
  const committed = committedInspectorValues();
  const inputValues = clip ? readInspectorValues() : null;
  const inputMatchesDraft = !draft || !valuesDiffer(inputValues, draft);
  const saved = state.lastEnvelope?.snapshot;
  const memoryMatchesStorage = Boolean(
    saved &&
      saved.project.revision === state.project.revision &&
      saved.ui.selected?.id === state.ui.selected?.id &&
      Math.abs(saved.ui.playhead - state.ui.playhead) < 0.0001 &&
      saved.project.tracks.length === state.project.tracks.length
  );
  const rendered = $(".clip[aria-pressed='true']", els.trackLanes);
  const renderMatchesSelection = Boolean(
    clip && rendered?.dataset.clipId === clip.id && els.preview.dataset.selectedId === clip.id
  );
  const checks = [inputMatchesDraft, memoryMatchesStorage, renderMatchesSelection];
  const passed = checks.filter(Boolean).length;
  els.syncBadge.textContent = `${passed}/3`;
  els.syncBadge.classList.toggle("ok", passed === 3);
  els.syncBadge.classList.toggle("warn", passed < 3);
  els.syncInput.textContent = clip
    ? `${clip.id} · ${draft ? `${Object.keys(draft).length} 个草稿字段` : "已提交"}`
    : "无选中对象";
  els.syncMemory.textContent = clip
    ? `rev ${state.project.revision} · ${state.ui.playhead.toFixed(2)}s · ${state.ui.selected.id}`
    : "无选中对象";
  const rawEnvelope = safeStorageGet(STORAGE.autosave) || "";
  const byteLength = new Blob([rawEnvelope]).size;
  els.syncStorage.textContent = state.lastSavedAt
    ? `autosave.v1 · ${formatBytes(byteLength)} · ${hashText(rawEnvelope)}`
    : "尚未写入";
  els.syncRender.textContent = clip
    ? `#${clip.id} · ${Math.round(els.timelineScroll.scrollLeft)}px · ${state.project.tracks.length} 轨`
    : "等待渲染";
  els.syncChecks.innerHTML = [
    syncCheck("输入＝草稿", inputMatchesDraft),
    syncCheck("内存＝存储", memoryMatchesStorage),
    syncCheck("对象＝渲染", renderMatchesSelection)
  ].join("");
  const keyframes = countKeyframes();
  const audio = track?.type === "audio" ? track.sound : selectedTrackTypeFallback();
  const keyState = {
    input: {
      object: state.ui.selected,
      focused: state.activeInput || document.activeElement?.id || null,
      drafts: draft || {},
      values: inputValues,
      committed
    },
    memory: {
      revision: state.project.revision,
      selected: state.ui.selected,
      playhead: Number(state.ui.playhead.toFixed(3)),
      trackCount: state.project.tracks.length,
      keyframeCount: keyframes,
      sound: audio
    },
    storage: {
      key: STORAGE.autosave,
      bytes: byteLength,
      savedAt: state.lastSavedAt,
      reason: state.lastSavedReason,
      hash: rawEnvelope ? hashText(rawEnvelope) : null,
      pending: state.saveState === "saving"
    },
    render: {
      selectedId: rendered?.dataset.clipId || null,
      previewSelectedId: els.preview.dataset.selectedId || null,
      playheadLeftPx: Math.round(state.ui.playhead * state.ui.zoom),
      timelineScroll: {
        left: Math.round(els.timelineScroll.scrollLeft),
        top: Math.round(els.timelineScroll.scrollTop)
      },
      renderedTracks: $$(".track-lane", els.trackLanes).length,
      renderedClips: $$(".clip", els.trackLanes).length
    }
  };
  els.syncJson.textContent = JSON.stringify(keyState, null, 2);
}

function selectedTrackTypeFallback() {
  const audioTrack = state.project.tracks.find((track) => track.type === "audio");
  return audioTrack?.sound || null;
}

function renderUndoState() {
  els.undoButton.disabled = history.undo.length === 0;
  els.redoButton.disabled = history.redo.length === 0;
}

function renderAll({ preserveScroll = true } = {}) {
  renderProjectHeader();
  fillInspector();
  renderPreview();
  renderTransport();
  renderTimeline();
  renderStorageMeta();
  renderUndoState();
  renderSaveStatus(state.saveState, state.lastSavedAt ? `已自动保存 · ${SAVE_LABELS[state.lastSavedReason] || ""}` : "等待首次保存");
  if (!preserveScroll) restoreTimelineScroll();
  updateSyncPanel();
}

function restoreTimelineScroll() {
  const left = Number(state.ui.timelineScroll.left) || 0;
  const top = Number(state.ui.timelineScroll.top) || 0;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      els.timelineScroll.scrollLeft = left;
      els.timelineScroll.scrollTop = top;
      updateSyncPanel();
    });
  });
}

function pushHistory() {
  history.undo.push(clone(state.project));
  if (history.undo.length > 40) history.undo.shift();
  history.redo.length = 0;
  renderUndoState();
}

function selectClip(clipId, { focus = false, reason = "selection" } = {}) {
  const entry = findClipById(clipId);
  if (!entry) {
    showToast(`找不到片段 ${clipId}，选择未改变。`, "error");
    return;
  }
  state.ui.selected = { kind: "clip", id: clipId };
  fillInspector();
  renderPreview();
  renderSelectionState();
  renderKeyframes();
  updateSyncPanel();
  queueSave(reason, 120);
  if (focus) {
    requestAnimationFrame(() => {
      const clipButton = $(`.clip[data-clip-id="${CSS.escape(clipId)}"]`, els.trackLanes);
      clipButton?.focus({ preventScroll: true });
    });
  }
}

function markValidationError(message) {
  els.formError.textContent = message;
  els.formError.hidden = false;
}

function applyInspectorChanges() {
  const clip = selectedClip();
  const track = selectedTrack();
  if (!clip || !track) return;
  const values = readInspectorValues();
  const name = values.name.trim();
  const start = Number(values.start);
  const duration = Number(values.duration);
  const scale = Number(values.scale);
  const opacity = Number(values.opacity);

  try {
    if (!name) throw new Error("片段名称不能为空。");
    if (!Number.isFinite(start) || start < 0 || start >= state.project.duration) {
      throw new Error("入点必须在项目时间线范围内。");
    }
    if (!Number.isFinite(duration) || duration < 0.5) throw new Error("片段时长至少为 0.5 秒。");
    if (start + duration > state.project.duration + 0.001) throw new Error("片段结束时间不能超出项目时长。");
    if (!Number.isFinite(scale) || scale < 25 || scale > 200) throw new Error("缩放范围应为 25%–200%。");
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) throw new Error("不透明度范围应为 0%–100%。");

    let sound = null;
    if (track.type === "audio") {
      sound = {
        volumeDb: Number(values.volumeDb),
        pan: Number(values.pan),
        low: Number(values.eqLow),
        mid: Number(values.eqMid),
        high: Number(values.eqHigh)
      };
      if (!Number.isFinite(sound.volumeDb) || sound.volumeDb < -60 || sound.volumeDb > 12) {
        throw new Error("增益范围应为 −60–12 dB。");
      }
      if (!Number.isFinite(sound.pan) || sound.pan < -100 || sound.pan > 100) {
        throw new Error("声像范围应为 −100%–100%。");
      }
      for (const [label, value] of [["低频", sound.low], ["中频", sound.mid], ["高频", sound.high]]) {
        if (!Number.isFinite(value) || value < -12 || value > 12) throw new Error(`${label} 范围应为 −12–12 dB。`);
      }
    }

    pushHistory();
    clip.name = name;
    clip.start = start;
    clip.duration = duration;
    clip.scale = scale;
    clip.opacity = opacity;
    clip.keyframes = clip.keyframes
      .map((keyframe) => ({ ...keyframe, time: Math.min(keyframe.time, duration) }))
      .sort((a, b) => a.time - b.time);
    if (sound) {
      track.sound.volumeDb = sound.volumeDb;
      track.sound.pan = sound.pan;
      track.sound.eq.low = sound.low;
      track.sound.eq.mid = sound.mid;
      track.sound.eq.high = sound.high;
    }
    state.project.revision += 1;
    delete state.ui.drafts[draftKey()];
    els.formError.hidden = true;
    fillInspector();
    renderPreview();
    renderTimeline();
    updateSyncPanel();
    queueSave("commit", 80);
    showToast(`已应用 ${clip.name} · ${track.type === "audio" ? "声音参数与画面属性" : "片段属性"}已提交。`);
  } catch (error) {
    markValidationError(error.message);
  }
}

function addKeyframeAtPlayhead() {
  const clip = selectedClip();
  const track = selectedTrack();
  if (!clip || !track) return;
  if (track.type === "audio") {
    showToast("声音参数会直接保存；此音轨暂不使用关键帧。", "error");
    return;
  }
  const relativeTime = Math.max(0, Math.min(clip.duration, state.ui.playhead - clip.start));
  pushHistory();
  const existing = clip.keyframes.find((keyframe) => Math.abs(keyframe.time - relativeTime) < 0.04);
  if (existing) {
    existing.value = clip.scale;
  } else {
    clip.keyframes.push({
      id: `kf-${clip.id}-${Date.now().toString(36)}`,
      time: Number(relativeTime.toFixed(2)),
      property: "scale",
      value: clip.scale,
      easing: "ease-in-out"
    });
    clip.keyframes.sort((a, b) => a.time - b.time);
  }
  state.project.revision += 1;
  renderKeyframes();
  renderTimeline();
  updateSyncPanel();
  queueSave("keyframe", 80);
  showToast(`已在 ${formatTimecode(relativeTime)} 添加缩放关键帧。`);
}

function setPlayhead(value, { save = true, reason = "playback" } = {}) {
  const next = Math.max(0, Math.min(state.project.duration, Number(value) || 0));
  state.ui.playhead = Math.round(next * 10000) / 10000;
  renderTransport();
  updateSyncPanel();
  if (save) queueSave(reason, 300);
}

let playTimer = null;
let playbackStartedAt = 0;
let playbackStartPosition = 0;
let lastPlaybackSaveAt = 0;

function stopPlayback() {
  if (!state.isPlaying) return;
  state.isPlaying = false;
  clearInterval(playTimer);
  playTimer = null;
  renderTransport();
  queueSave("playback", 80);
}

function togglePlayback() {
  if (state.isPlaying) {
    stopPlayback();
    return;
  }
  if (state.ui.playhead >= state.project.duration) state.ui.playhead = 0;
  state.isPlaying = true;
  playbackStartedAt = performance.now();
  playbackStartPosition = state.ui.playhead;
  lastPlaybackSaveAt = playbackStartedAt;
  renderTransport();
  playTimer = setInterval(() => {
    const now = performance.now();
    const elapsed = (now - playbackStartedAt) / 1000;
    const next = playbackStartPosition + elapsed;
    if (next >= state.project.duration) {
      setPlayhead(state.project.duration, { save: false });
      stopPlayback();
      return;
    }
    setPlayhead(next, { save: false });
    if (now - lastPlaybackSaveAt >= 500) {
      lastPlaybackSaveAt = now;
      queueSave("playback", 180);
    }
  }, 80);
  queueSave("playback", 200);
}

function undoProject() {
  if (!history.undo.length) return;
  const selection = clone(state.ui.selected);
  const scroll = clone(state.ui.timelineScroll);
  history.redo.push(clone(state.project));
  state.project = history.undo.pop();
  state.ui.selected = findClipById(selection?.id)
    ? selection
    : { kind: "clip", id: state.project.tracks[0]?.clips[0]?.id };
  state.ui.timelineScroll = scroll;
  fillInspector();
  renderPreview();
  renderTimeline();
  renderUndoState();
  restoreTimelineScroll();
  queueSave("undo", 80);
  showToast("已撤销。未提交草稿、选中对象与滚动位置均已保留。");
}

function redoProject() {
  if (!history.redo.length) return;
  const selection = clone(state.ui.selected);
  const scroll = clone(state.ui.timelineScroll);
  history.undo.push(clone(state.project));
  state.project = history.redo.pop();
  state.ui.selected = findClipById(selection?.id)
    ? selection
    : { kind: "clip", id: state.project.tracks[0]?.clips[0]?.id };
  state.ui.timelineScroll = scroll;
  fillInspector();
  renderPreview();
  renderTimeline();
  renderUndoState();
  restoreTimelineScroll();
  queueSave("redo", 80);
  showToast("已重做。选中对象与时间线位置保持不变。");
}

let toastCounter = 0;

function showToast(message, kind = "success", duration = 4200) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.kind = kind;
  toast.dataset.toastId = String(++toastCounter);
  toast.textContent = message;
  els.toastRegion.append(toast);
  while (els.toastRegion.children.length > 3) els.toastRegion.firstElementChild.remove();
  setTimeout(() => toast.remove(), duration);
}

function populateExportForm() {
  const settings = state.exportSettings;
  els.exportFilename.value = settings.filename;
  els.exportPreset.value = settings.preset;
  els.exportFormat.value = settings.format;
  els.exportResolution.value = settings.resolution;
  els.exportFps.value = settings.fps;
  els.exportBitrate.value = String(settings.bitrate);
  els.exportAudio.value = settings.audioCodec;
  els.exportRange.value = settings.range;
  els.exportNormalize.checked = Boolean(settings.normalize);
  renderExportSummary();
}

function readExportForm() {
  return {
    filename: els.exportFilename.value.trim(),
    preset: els.exportPreset.value,
    format: els.exportFormat.value,
    resolution: els.exportResolution.value,
    fps: els.exportFps.value,
    bitrate: Number(els.exportBitrate.value),
    audioCodec: els.exportAudio.value,
    range: els.exportRange.value,
    normalize: els.exportNormalize.checked
  };
}

function persistExportSettings() {
  const settings = readExportForm();
  state.exportSettings = {
    ...state.exportSettings,
    ...settings,
    updatedAt: new Date().toISOString()
  };
  safeStorageSet(STORAGE.exportSettings, JSON.stringify(state.exportSettings));
  renderExportSummary();
  queueSave("export-settings", 160);
}

function renderExportSummary() {
  const settings = readExportForm();
  const presetLabels = { master: "母版", web: "网络", social: "社交" };
  const rangeLabels = { all: "整个序列", inout: "入点至出点", selected: "选中片段" };
  els.exportSummary.textContent = `${presetLabels[settings.preset] || settings.preset} · ${settings.format.toUpperCase()} · ${
    settings.resolution
  } · ${settings.fps} fps · ${settings.bitrate || 0} Mbps · ${rangeLabels[settings.range] || settings.range} · ${
    settings.normalize ? "响度标准化" : "原始响度"
  }`;
}

let exportOpener = null;

function openExportDialog() {
  exportOpener = document.activeElement instanceof HTMLElement ? document.activeElement : els.exportButton;
  populateExportForm();
  if (!els.exportDialog.open) els.exportDialog.showModal();
  requestAnimationFrame(() => els.exportFilename.focus());
}

function closeExportDialog() {
  if (els.exportDialog.open) els.exportDialog.close("cancel");
}

function startExport() {
  const values = readExportForm();
  if (!values.filename) {
    showToast("导出文件名不能为空。", "error");
    els.exportFilename.focus();
    return;
  }
  if (!Number.isFinite(values.bitrate) || values.bitrate < 1 || values.bitrate > 200) {
    showToast("目标码率应为 1–200 Mbps。", "error");
    els.exportBitrate.focus();
    return;
  }
  persistExportSettings();
  els.startExport.disabled = true;
  els.startExport.textContent = "正在准备…";
  setTimeout(() => {
    els.startExport.disabled = false;
    els.startExport.textContent = "开始导出";
    closeExportDialog();
    showToast(`导出任务已建立：${values.filename}.${values.format}，最近设置已保存。`);
  }, 650);
}

function statMarkup(label, value) {
  return `<div class="recovery-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function recoverySummary(envelope) {
  const snapshot = envelope?.snapshot || {};
  const project = snapshot.project || {};
  const tracks = Array.isArray(project.tracks) ? project.tracks : [];
  const audioTrack = tracks.find((track) => track?.type === "audio");
  const playhead = Number(snapshot.ui?.playhead) || 0;
  return [
    statMarkup("保存时间", formatDateTime(envelope?.savedAt)),
    statMarkup("项目", project.name || "未知项目"),
    statMarkup("轨道 / 片段", `${tracks.length} / ${tracks.reduce((sum, track) => sum + (track.clips?.length || 0), 0)}`),
    statMarkup("关键帧", String(countKeyframes(project))),
    statMarkup("播放位置", formatTimecode(playhead, project.fps || 24)),
    statMarkup(
      "声音参数",
      audioTrack?.sound
        ? `${Number(audioTrack.sound.volumeDb).toFixed(1)} dB · pan ${audioTrack.sound.pan}`
        : "无音轨参数"
    )
  ].join("");
}

function showRecoveryPrompt(stored) {
  state.recoveryEnvelope = stored.envelope;
  state.recoveryRaw = stored.raw;
  state.recoveryDecision = "pending";
  els.recoverySummary.innerHTML = recoverySummary(stored.envelope);
  if (!els.recoveryDialog.open) els.recoveryDialog.showModal();
  requestAnimationFrame(() => els.acceptRecovery.focus());
}

function hydrateFromEnvelope(envelope, { source = "recovery" } = {}) {
  validateSnapshot(envelope?.snapshot);
  const snapshot = clone(envelope.snapshot);
  const selected = findSnapshotClip(snapshot.project, snapshot.ui.selected.id);
  if (!selected) throw new Error("选中的对象已被移除");

  state.project = snapshot.project;
  state.ui.selected = { kind: "clip", id: snapshot.ui.selected.id };
  state.ui.playhead = snapshot.ui.playhead;
  state.ui.timelineScroll = {
    left: Math.max(0, Number(snapshot.ui.timelineScroll?.left) || 0),
    top: Math.max(0, Number(snapshot.ui.timelineScroll?.top) || 0)
  };
  state.ui.zoom = [18, 24, 34, 44, 54, 64].includes(snapshot.ui.zoom) ? snapshot.ui.zoom : 34;
  state.ui.drafts =
    snapshot.ui.drafts && typeof snapshot.ui.drafts === "object" ? clone(snapshot.ui.drafts) : {};
  state.exportSettings = {
    ...makeDefaultExportSettings(),
    ...(snapshot.exportSettings || {}),
    ...(readExportSettings() || {})
  };
  state.lastEnvelope = envelope;
  state.lastSavedAt = envelope.savedAt || new Date().toISOString();
  state.lastSavedReason = "normal-refresh";
  state.saveState = "restored";
  state.recoveryDecision = source === "recovery" ? "accepted" : "refresh";
  renderAll({ preserveScroll: false });
  renderSaveStatus("restored", source === "recovery" ? "已从异常会话恢复" : "已从刷新恢复");
  writeSession("active");
  return snapshot;
}

function acceptRecovery() {
  if (!state.recoveryEnvelope) {
    els.recoveryDialog.close("empty");
    return;
  }
  try {
    const snapshot = hydrateFromEnvelope(state.recoveryEnvelope, { source: "recovery" });
    els.recoveryDialog.close("accepted");
    saveNow("recovery-accepted");
    const draftCount = Object.keys(snapshot.ui.drafts || {}).length;
    showToast(
      `恢复完成：${snapshot.project.tracks.length} 条轨道、${countKeyframes(snapshot.project)} 个关键帧、播放位置 ${formatTimecode(
        snapshot.ui.playhead,
        snapshot.project.fps
      )}${draftCount ? `，含 ${draftCount} 组未提交草稿` : ""}。`,
      "restore",
      6200
    );
  } catch (error) {
    if (els.recoveryDialog.open) els.recoveryDialog.close("failed");
    showFailureDialog(state.recoveryRaw || JSON.stringify(state.recoveryEnvelope, null, 2), error);
  }
}

function declineRecovery() {
  if (state.recoveryRaw) {
    state.recoveryDecision = "declined";
    safeStorageSet(
      STORAGE.archived,
      JSON.stringify({
        archivedAt: new Date().toISOString(),
        reason: "user-declined",
        original: state.recoveryRaw
      })
    );
  }
  if (els.recoveryDialog.open) els.recoveryDialog.close("declined");
  state.recoveryEnvelope = null;
  writeSession("active");
  saveNow("recovery-declined");
  showToast("已暂不恢复。当前项目保持原状，旧快照已归档但未应用。", "warning", 5600);
}

let failureRawText = "";

function prettySnapshot(raw) {
  const parsed = parseJson(raw);
  if (!parsed.error && parsed.value) {
    try {
      return JSON.stringify(parsed.value, null, 2);
    } catch {
      return raw;
    }
  }
  return raw;
}

function showFailureDialog(raw, error) {
  failureRawText = raw;
  safeStorageSet(
    STORAGE.failed,
    JSON.stringify({
      capturedAt: new Date().toISOString(),
      reason: error?.message || "unknown",
      original: raw
    })
  );
  els.failureRaw.textContent = prettySnapshot(raw);
  els.failureReason.textContent = `诊断：${error?.message || "未知恢复错误"}。原始快照未删除。`;
  if (!els.failureDialog.open) els.failureDialog.showModal();
  requestAnimationFrame(() => els.failureRaw.focus());
}

function dismissFailure() {
  if (els.failureDialog.open) els.failureDialog.close("dismissed");
  state.recoveryDecision = "failed";
  writeSession("active");
  saveNow("recovery-declined");
  showToast("当前项目继续使用；无法恢复的原始快照已保存在失败归档中。", "warning", 5600);
}

function simulateRecoveryFailure() {
  const envelope = buildEnvelope("recovery-failure-demo");
  envelope.snapshot.project.tracks = "corrupted-demo-value";
  const raw = JSON.stringify(envelope, null, 2);
  state.recoveryRaw = raw;
  state.recoveryEnvelope = envelope;
  showFailureDialog(raw, new Error("项目轨道数据损坏：tracks 不是数组（演示）"));
}

async function copyFailureSnapshot() {
  try {
    await navigator.clipboard.writeText(prettySnapshot(failureRawText));
    showToast("原始快照已复制到剪贴板。");
  } catch {
    showToast("无法访问剪贴板，请手动选择快照文本复制。", "error");
    els.failureRaw.focus();
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(els.failureRaw);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCurrentSnapshot() {
  const envelope = state.lastEnvelope || buildEnvelope("manual-download");
  downloadText(`frame-snapshot-${Date.now()}.json`, JSON.stringify(envelope, null, 2));
  showToast("当前快照已下载。");
}

function downloadFailureSnapshot() {
  downloadText(`frame-failed-snapshot-${Date.now()}.json`, prettySnapshot(failureRawText));
  showToast("失败快照已下载，原始内容未被改写。");
}

function updateTimelineScrollState() {
  state.ui.timelineScroll = {
    left: Math.round(els.timelineScroll.scrollLeft),
    top: Math.round(els.timelineScroll.scrollTop)
  };
  updateSyncPanel();
  queueSave("scroll", 180);
}

function changeZoom(delta) {
  const steps = [18, 24, 34, 44, 54, 64];
  const current = steps.indexOf(state.ui.zoom);
  const index = Math.max(0, Math.min(steps.length - 1, (current < 0 ? 2 : current) + delta));
  state.ui.zoom = steps[index];
  renderTimeline();
  updateTimelineScrollState();
  showToast(`时间线缩放：${state.ui.zoom} px/s`);
}

function filterMediaTabs(event) {
  const tab = event.target.closest(".tab");
  if (!tab) return;
  $$(".tab").forEach((candidate) => {
    const active = candidate === tab;
    candidate.classList.toggle("is-active", active);
    candidate.setAttribute("aria-selected", String(active));
  });
  const label = tab.textContent.trim().split(/\s/)[0];
  $$(".media-item").forEach((item) => {
    const track = findTrackByClipId(item.dataset.clipId);
    const visible = label === "全部" || (label === "视频" && track?.type === "video") || (label === "音频" && track?.type === "audio");
    item.hidden = !visible;
  });
}

function handleKeyboard(event) {
  const target = event.target;
  const isTyping =
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    target?.isContentEditable;
  const modifier = event.ctrlKey || event.metaKey;

  if (modifier && event.key.toLowerCase() === "e") {
    event.preventDefault();
    openExportDialog();
    return;
  }

  if (modifier && event.shiftKey && event.key.toLowerCase() === "x") {
    event.preventDefault();
    simulateForcedInterruption();
    return;
  }

  if (modifier && event.key === "Enter") {
    event.preventDefault();
    applyInspectorChanges();
    return;
  }

  if (modifier && event.key.toLowerCase() === "z") {
    if (isTyping && !event.shiftKey) return;
    event.preventDefault();
    if (event.shiftKey) redoProject();
    else undoProject();
    return;
  }

  if (modifier && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redoProject();
    return;
  }

  if (event.key === "Escape") {
    if (els.exportDialog.open) {
      event.preventDefault();
      closeExportDialog();
    }
    return;
  }

  if (isTyping || els.exportDialog.open || els.recoveryDialog.open || els.failureDialog.open) return;

  if (event.key.toLowerCase() === "t") {
    event.preventDefault();
    els.timelineScroll.focus();
    showToast("已聚焦时间线。使用 Ctrl + ←/→ 横向滚动，Shift + ←/→ 跳转 1 秒。", "success", 3200);
    return;
  }

  const timelineFocused =
    document.activeElement === els.timelineScroll || els.timelineScroll.contains(document.activeElement);
  if (timelineFocused && modifier && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    els.timelineScroll.scrollBy({ left: event.key === "ArrowRight" ? 120 : -120, behavior: "smooth" });
    return;
  }

  if (event.code === "Space") {
    event.preventDefault();
    togglePlayback();
    return;
  }

  if (event.key.toLowerCase() === "m") {
    event.preventDefault();
    addKeyframeAtPlayhead();
    return;
  }

  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    if (!timelineFocused) return;
    event.preventDefault();
    if (event.key === "Home") setPlayhead(0);
    else if (event.key === "End") setPlayhead(state.project.duration);
    else {
      const amount = event.shiftKey ? 1 : 1 / state.project.fps;
      setPlayhead(state.ui.playhead + (event.key === "ArrowRight" ? amount : -amount));
    }
  }
}

function bindEvents() {
  els.undoButton.addEventListener("click", undoProject);
  els.redoButton.addEventListener("click", redoProject);
  els.exportButton.addEventListener("click", openExportDialog);
  els.interruptButton.addEventListener("click", simulateForcedInterruption);
  els.playButton.addEventListener("click", togglePlayback);
  els.markerButton.addEventListener("click", addKeyframeAtPlayhead);
  els.addKeyframeButton.addEventListener("click", addKeyframeAtPlayhead);
  els.keyframeList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-keyframe-time]");
    const clip = selectedClip();
    if (!row || !clip) return;
    setPlayhead(clip.start + Number(row.dataset.keyframeTime));
    showToast(`播放头已跳到关键帧 ${formatTimecode(Number(row.dataset.keyframeTime))}。`);
  });

  els.inspectorForm.addEventListener("submit", (event) => {
    event.preventDefault();
    applyInspectorChanges();
  });
  const inspectorInputs = [
    els.clipName,
    els.clipStart,
    els.clipDuration,
    els.clipScale,
    els.clipOpacity,
    els.audioVolume,
    els.audioPan,
    els.eqLow,
    els.eqMid,
    els.eqHigh
  ];
  inspectorInputs.forEach((input) => {
    input.addEventListener("input", () => {
      captureDraftFromInputs();
      queueSave("draft", 180);
    });
  });

  els.mediaList.addEventListener("click", (event) => {
    const item = event.target.closest("[data-clip-id]");
    if (item) selectClip(item.dataset.clipId);
  });
  $(".library-tabs").addEventListener("click", filterMediaTabs);

  els.trackLabels.addEventListener("click", (event) => {
    const label = event.target.closest("[data-first-clip]");
    if (label?.dataset.firstClip) selectClip(label.dataset.firstClip, { focus: true });
  });
  els.trackLanes.addEventListener("click", (event) => {
    const clipButton = event.target.closest("[data-clip-id]");
    if (clipButton) {
      selectClip(clipButton.dataset.clipId);
      return;
    }
    const lane = event.target.closest(".track-lane");
    if (!lane) return;
    const rect = lane.getBoundingClientRect();
    setPlayhead((event.clientX - rect.left) / state.ui.zoom);
  });

  els.playheadRange.addEventListener("input", () => setPlayhead(Number(els.playheadRange.value)));
  els.timelineScroll.addEventListener("scroll", updateTimelineScrollState, { passive: true });
  els.timelineScroll.addEventListener("keydown", (event) => {
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setPlayhead(event.key === "Home" ? 0 : state.project.duration);
    }
  });

  els.zoomIn.addEventListener("click", () => changeZoom(1));
  els.zoomOut.addEventListener("click", () => changeZoom(-1));
  els.downloadSnapshot.addEventListener("click", downloadCurrentSnapshot);
  els.recoveryFailureDemo.addEventListener("click", simulateRecoveryFailure);

  els.acceptRecovery.addEventListener("click", acceptRecovery);
  els.declineRecovery.addEventListener("click", declineRecovery);
  els.recoveryDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    declineRecovery();
  });

  els.exportForm.addEventListener("input", persistExportSettings);
  els.exportForm.addEventListener("change", persistExportSettings);
  els.exportForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      closeExportDialog();
      return;
    }
    startExport();
  });
  els.startExport.addEventListener("click", startExport);
  els.exportDialog.addEventListener("close", () => {
    if (exportOpener?.isConnected) exportOpener.focus({ preventScroll: true });
    else els.exportButton.focus();
  });

  els.copyFailureRaw.addEventListener("click", copyFailureSnapshot);
  els.downloadFailureRaw.addEventListener("click", downloadFailureSnapshot);
  els.dismissFailure.addEventListener("click", dismissFailure);
  els.failureDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismissFailure();
  });

  els.fullscreenButton = $("#fullscreen-button");
  els.fullscreenButton?.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await els.preview.requestFullscreen();
    } catch {
      showToast("当前浏览器未允许全屏预览。", "error");
    }
  });

  document.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
      state.activeInput = event.target.id || event.target.name || event.target.tagName.toLowerCase();
      updateSyncPanel();
    }
  });
  document.addEventListener("focusout", () => {
    state.activeInput = null;
    updateSyncPanel();
  });
  document.addEventListener("keydown", handleKeyboard);

  window.addEventListener("pagehide", handleCleanShutdown);
  window.addEventListener("beforeunload", handleCleanShutdown);
}

let cleanShutdownWritten = false;

function handleCleanShutdown() {
  if (state.suppressCleanShutdown || cleanShutdownWritten) return;
  cleanShutdownWritten = true;
  if (state.recoveryDecision === "pending" || els.failureDialog.open) return;
  state.ui.timelineScroll = {
    left: Math.round(els.timelineScroll.scrollLeft),
    top: Math.round(els.timelineScroll.scrollTop)
  };
  saveNow("normal-refresh");
  writeSession("clean", { cleanedAt: new Date().toISOString() });
}

function simulateForcedInterruption() {
  saveNow("forced-interruption");
  state.suppressCleanShutdown = true;
  writeSession("active", {
    abnormal: true,
    abnormalReason: "simulated-forced-interruption",
    snapshotHint: formatDateTime(state.lastSavedAt)
  });
  showToast("正在模拟无退出事件的强制中断…", "warning", 800);
  setTimeout(() => location.reload(), 180);
}

function initializeSessionAndRestore() {
  state.sessionStartedAt = new Date().toISOString();
  const standaloneExport = readExportSettings();
  if (standaloneExport) state.exportSettings = standaloneExport;

  const previousSession = readPreviousSession();
  const stored = readEnvelope();
  const previousWasAbnormal =
    previousSession &&
    previousSession.id !== SESSION_ID &&
    previousSession.status === "active";

  if (previousWasAbnormal && stored) {
    if (stored.parseError || !stored.envelope) {
      showFailureDialog(stored.raw, stored.parseError || new Error("快照内容为空"));
    } else {
      showRecoveryPrompt(stored);
    }
    writeSession("active");
    return;
  }

  if (stored) {
    if (stored.parseError || !stored.envelope) {
      showFailureDialog(stored.raw, stored.parseError || new Error("快照内容为空"));
      writeSession("active");
      return;
    }
    try {
      const snapshot = hydrateFromEnvelope(stored.envelope, { source: "refresh" });
      writeSession("active");
      showToast(
        `刷新恢复完成：${snapshot.project.tracks.length} 条轨道、${countKeyframes(
          snapshot.project
        )} 个关键帧、播放位置 ${formatTimecode(snapshot.ui.playhead, snapshot.project.fps)}。`,
        "restore",
        5800
      );
      return;
    } catch (error) {
      showFailureDialog(stored.raw, error);
      writeSession("active");
      return;
    }
  }

  state.recoveryDecision = "normal";
  renderAll({ preserveScroll: false });
  writeSession("active");
  saveNow("edit");
}

function boot() {
  state.isPlaying = false;
  bindEvents();
  renderAll({ preserveScroll: false });
  renderSaveStatus("saved", "已自动保存");
  initializeSessionAndRestore();
}

boot();
