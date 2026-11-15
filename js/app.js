import {
  CHAPTERS,
  DEFAULT_FILTERS,
  DIRECTIONS,
  PERIODS,
  RECORD_SCOPES,
  buildExportManifest,
  buildNarrative,
  buildView,
  createProject,
  formatNumber,
  normalizeDataset,
  projectSettingsFromState,
  sanitizeFilters,
  validateProject
} from "./core.js";
import {
  buildChart,
  buildMap,
  buildMetrics,
  chapterById
} from "./views.js";
import {
  createChapterPng,
  downloadBlob,
  manifestFromPng
} from "./export.js";

const DATASET_FILES = {
  base: "data/city-traffic-v1.json",
  audit: "data/city-traffic-v2-audit.json"
};

const state = {
  datasets: {},
  datasetKey: "base",
  dataset: null,
  processed: null,
  view: null,
  filters: { ...DEFAULT_FILTERS },
  chapterId: CHAPTERS[0].id,
  noMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  stackAttempted: false,
  lastExport: null,
  lastProject: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let toastTimer = null;
let scrollFrame = null;
let chapterLockUntil = 0;

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function clearToast() {
  clearTimeout(toastTimer);
  $("#toast").classList.remove("is-visible");
}

function optionMarkup(options, selected) {
  return options.map((option) => (
    `<option value="${option.id}"${option.id === selected ? " selected" : ""}>${option.label}</option>`
  )).join("");
}

function populateControls() {
  const districts = [
    { id: "all", label: "全部片区" },
    ...state.dataset.districts.map((district) => ({ id: district.id, label: district.name }))
  ];
  $("#districtFilter").innerHTML = optionMarkup(districts, state.filters.districtId);
  $("#directionFilter").innerHTML = optionMarkup(DIRECTIONS, state.filters.direction);
  $("#periodFilter").innerHTML = optionMarkup(PERIODS, state.filters.period);
  $("#scopeFilter").innerHTML = optionMarkup(RECORD_SCOPES, state.filters.recordScope);
  $("#datasetSelect").value = state.datasetKey;
}

function syncControlValues() {
  $("#datasetSelect").value = state.datasetKey;
  $("#districtFilter").value = state.filters.districtId;
  $("#directionFilter").value = state.filters.direction;
  $("#periodFilter").value = state.filters.period;
  $("#scopeFilter").value = state.filters.recordScope;
}

function ensureCustomDatasetOption(dataset) {
  let option = $('#datasetSelect option[value="custom"]');
  if (!option) {
    option = document.createElement("option");
    option.value = "custom";
    $("#datasetSelect").append(option);
  }
  option.textContent = `工程快照 · ${dataset.version}`;
}

function renderChapterNavigation() {
  const nav = $("#chapterNav");
  nav.innerHTML = CHAPTERS.map((chapter) => (
    `<button class="rail-button${chapter.id === state.chapterId ? " is-active" : ""}" type="button" data-chapter-target="${chapter.id}" aria-current="${chapter.id === state.chapterId ? "step" : "false"}" aria-label="第 ${chapter.number} 章：${chapter.title}"><b>${chapter.number}</b><span>${chapter.short}</span></button>`
  )).join("");
  $$(".rail-button", nav).forEach((button) => {
    button.addEventListener("click", () => goToChapter(button.dataset.chapterTarget));
    button.addEventListener("keydown", handleChapterKeydown);
  });
}

function updateActiveChapterUi() {
  const chapter = chapterById(state.chapterId);
  $$("[data-chapter]").forEach((section) => {
    section.classList.toggle("is-active", section.dataset.chapter === state.chapterId);
  });
  $$(".rail-button").forEach((button) => {
    const active = button.dataset.chapterTarget === state.chapterId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "step" : "false");
  });
  $("#visualChapterNumber").textContent = `CHAPTER ${chapter.number}`;
  $("#visualChapterTitle").textContent = chapter.title;
}

function renderNarratives() {
  $$("[data-chapter]").forEach((section) => {
    const chapterId = section.dataset.chapter;
    const narrative = buildNarrative(state.view, chapterId, state.filters);
    const values = {
      summary: narrative.summary,
      lede: narrative.lede,
      "paragraph-0": narrative.paragraphs[0] ?? "",
      "paragraph-1": narrative.paragraphs[1] ?? "",
      "metric-1-value": narrative.metrics[1]?.value ?? "—",
      "metric-1-unit": `${narrative.metrics[1]?.label ?? ""} · ${narrative.metrics[1]?.unit ?? ""}`
    };
    Object.entries(values).forEach(([key, value]) => {
      const node = $(`[data-narrative="${key}"]`, section);
      if (node) node.textContent = value;
    });
  });
}

function renderVisuals() {
  const chapter = chapterById(state.chapterId);
  const map = buildMap(state.dataset, state.view, chapter.id, state.filters);
  const chart = buildChart(state.view, chapter.id, state.stackAttempted);

  $("#cityMap").innerHTML = map.html;
  $("#cityMap").setAttribute("aria-label", map.ariaLabel);
  $("#mapModeLabel").textContent = map.modeLabel;
  $("#mapCaption").textContent = map.caption;

  $("#chartTitle").textContent = chart.title;
  $("#chartSubtitle").textContent = chart.subtitle;
  $("#storyChart").innerHTML = chart.html;
  $("#storyChart").setAttribute("aria-label", chart.ariaLabel);

  const stackButton = $("#stackButton");
  stackButton.hidden = chart.buttonHidden;
  stackButton.textContent = chart.buttonLabel;
  stackButton.setAttribute("aria-pressed", String(chart.buttonPressed));

  const warning = $("#chartWarning");
  warning.textContent = chart.warning;
  warning.hidden = !chart.warning;

  $("#visualMetrics").innerHTML = buildMetrics(state.view, chapter.id);
  $("#exportScope").textContent = `导出口径 · ${chapter.title} · ${state.view.filterSummary} · ${state.view.rowCount} 个对象。PNG 内嵌同一清单。`;
}

function renderHeaderAndStatus() {
  const { dataset, processed, view } = state;
  const sourceLabel = state.datasetKey === "custom" ? "工程快照 · " : "";
  $("#datasetVersion").textContent = `${sourceLabel}${dataset.version} · ${dataset.city}`;
  $("#currentFilter").textContent = view.filterSummary;
  $("#heroDate").textContent = dataset.releasedAt.slice(0, 10);

  let qualityNote = "";
  const anomalyRows = processed.rawCount - processed.cleanCount;
  if (anomalyRows > 0) {
    qualityNote = ` · 清洗排除 ${anomalyRows} 行（空值 ${processed.missingCount} / 重复 ${processed.duplicateCount} / 异常 ${processed.outlierCount}）`;
  }
  if (state.filters.recordScope === "audit" && processed.auditCount !== processed.cleanCount) {
    qualityNote += ` · 审计口径包含异常，对象 ${view.rowCount} 条`;
  }
  $("#filterStatus").textContent = `当前筛选：${view.filterSummary} · 视图对象 ${view.rowCount} 条 · 数据版本 ${dataset.version}${qualityNote}`;
}

function renderDebug() {
  const { processed, view } = state;
  const steps = [
    { label: "原始行", value: processed.rawCount },
    { label: "空值行", value: processed.missingCount, error: processed.missingCount > 0 },
    { label: "重复行", value: processed.duplicateCount, error: processed.duplicateCount > 0 },
    { label: "异常行", value: processed.outlierCount, error: processed.outlierCount > 0 },
    { label: "清洗后", value: processed.cleanCount, result: true },
    { label: "当前视图", value: view.rowCount, result: true }
  ];
  $("#pipeline").innerHTML = steps.map((step, index) => {
    const classes = `pipe-step${step.error ? " is-error" : ""}${step.result ? " is-result" : ""}`;
    return `${index ? '<span class="pipe-arrow">→</span>' : ""}<div class="${classes}"><span>${step.label}</span><strong>${formatNumber(step.value)}</strong></div>`;
  }).join("");

  const snapshot = {
    dataset: {
      key: state.datasetKey,
      id: state.dataset.id,
      version: state.dataset.version,
      releasedAt: state.dataset.releasedAt
    },
    filters: state.filters,
    filterSummary: view.filterSummary,
    chapterId: state.chapterId,
    noMotion: state.noMotion,
    stackAttempted: state.stackAttempted,
    pipeline: {
      raw: processed.rawCount,
      missing: processed.missingCount,
      duplicate: processed.duplicateCount,
      outlier: processed.outlierCount,
      clean: processed.cleanCount,
      audit: processed.auditCount,
      selected: view.rowCount
    },
    view: {
      totalFlow: Math.round(view.totalFlow),
      avgSpeed: view.avgSpeed,
      busRiders: Math.round(view.busRiders),
      transitShare: view.transitShare,
      corridors: view.corridors.length,
      districts: view.districts.length,
      dataHash: view.dataHash
    }
  };
  $("#debugState").textContent = JSON.stringify(snapshot, null, 2);
  $("#debugHash").textContent = `${view.dataHash} · ${view.rowCount} objects`;

  const anomalyLabels = { missing: "空值", duplicate: "重复", outlier: "异常" };
  const anomalies = processed.anomalies.slice(0, 20);
  $("#debugAnomalies").innerHTML = anomalies.length
    ? anomalies.map((anomaly) => (
      `<div class="anomaly-row"><b>${anomalyLabels[anomaly.type] ?? anomaly.type}</b><span>${anomaly.rowId}</span><span title="${anomaly.note}">${anomaly.field} · ${anomaly.note}</span></div>`
    )).join("")
    : '<div class="anomaly-empty">当前数据没有异常行。</div>';

  if (state.lastExport) {
    const currentKeyValues = {
      totalFlow: Math.round(view.totalFlow),
      avgSpeed: view.avgSpeed,
      busRiders: Math.round(view.busRiders),
      transitShare: view.transitShare,
      corridorCount: view.corridors.length,
      topCorridor: view.topCorridor?.name ?? null
    };
    const countMatches = state.lastExport.objectCount === view.rowCount;
    const keyValuesMatch = JSON.stringify(state.lastExport.keyValues) === JSON.stringify(currentKeyValues);
    const hashMatches = state.lastExport.dataHash === view.dataHash;
    const matches = countMatches && keyValuesMatch && hashMatches;
    $("#debugExportHeading").textContent = `最近一次导出口径 · ${matches ? "一致" : "口径已变化"}`;
    $("#debugExportHeading").dataset.state = matches ? "match" : "changed";
    $("#debugExport").textContent = JSON.stringify({
      chapter: state.lastExport.chapterTitle,
      datasetVersion: state.lastExport.datasetVersion,
      filterSummary: state.lastExport.filterSummary,
      exportScope: state.lastExport.exportScope,
      objectCount: state.lastExport.objectCount,
      keyValues: state.lastExport.keyValues,
      dataHash: state.lastExport.dataHash,
      beforeAfter: {
        objectCountMatches: countMatches,
        keyValuesMatch,
        dataHashMatches: hashMatches,
        result: matches ? "一致" : "当前口径已变化"
      }
    }, null, 2);
  } else {
    $("#debugExportHeading").textContent = "最近一次导出口径";
    delete $("#debugExportHeading").dataset.state;
    $("#debugExport").textContent = "尚未导出";
  }
}

function renderAll() {
  renderHeaderAndStatus();
  renderNarratives();
  updateActiveChapterUi();
  renderVisuals();
  renderDebug();
  syncControlValues();
}

function recomputeView() {
  state.view = buildView(state.dataset, state.processed, state.filters);
  renderAll();
  updateScrollProgress();
}

function applyFilters(partial) {
  state.filters = sanitizeFilters({ ...state.filters, ...partial });
  recomputeView();
}

function applyDataset(datasetKey) {
  const dataset = state.datasets[datasetKey];
  if (!dataset) return;
  state.datasetKey = datasetKey;
  state.dataset = dataset;
  state.processed = normalizeDataset(dataset);
  if (state.filters.districtId !== "all" && !dataset.districts.some((district) => district.id === state.filters.districtId)) {
    state.filters = { ...state.filters, districtId: "all" };
  }
  state.stackAttempted = false;
  populateControls();
  recomputeView();
  showToast(`已切换到 ${dataset.version}`);
}

function updateScrollProgress() {
  const documentHeight = document.documentElement.scrollHeight - window.innerHeight;
  const progress = documentHeight > 0 ? Math.min(1, Math.max(0, window.scrollY / documentHeight)) : 0;
  $("#scrollProgress").style.height = `${Math.round(progress * 100)}%`;
}

function chapterAtViewport() {
  const marker = window.innerHeight * 0.42;
  let current = CHAPTERS[0].id;
  for (const chapter of CHAPTERS) {
    const section = $(`#chapter-${chapter.id}`);
    const rect = section.getBoundingClientRect();
    if (rect.top <= marker) current = chapter.id;
  }
  return current;
}

function handleScroll() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    updateScrollProgress();
    if (performance.now() < chapterLockUntil) return;
    const nextChapter = chapterAtViewport();
    if (nextChapter !== state.chapterId) {
      state.chapterId = nextChapter;
      chapterLockUntil = 0;
      clearToast();
      updateActiveChapterUi();
      renderVisuals();
      renderDebug();
    }
  });
}

function goToChapter(chapterId, options = {}) {
  if (!CHAPTERS.some((chapter) => chapter.id === chapterId)) return;
  state.chapterId = chapterId;
  chapterLockUntil = performance.now() + (options.scroll === false ? 1800 : 1100);
  clearToast();
  updateActiveChapterUi();
  renderVisuals();
  renderDebug();
  const section = $(`#chapter-${chapterId}`);
  if (options.scroll !== false && section) {
    section.scrollIntoView({
      behavior: state.noMotion ? "auto" : "smooth",
      block: "start"
    });
  }
}

function handleChapterKeydown(event) {
  const buttons = $$(".rail-button");
  const index = buttons.indexOf(event.currentTarget);
  const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
  if (!keys.includes(event.key)) return;
  event.preventDefault();
  let nextIndex = index;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (index + 1) % buttons.length;
  if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (index - 1 + buttons.length) % buttons.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = buttons.length - 1;
  const button = buttons[nextIndex];
  button.focus();
  goToChapter(button.dataset.chapterTarget);
}

function exportSnapshot() {
  return {
    datasetVersion: state.dataset.version,
    datasetId: state.dataset.id,
    chapterId: state.chapterId,
    chapterTitle: chapterById(state.chapterId).title,
    filterSummary: state.view.filterSummary,
    filters: { ...state.filters },
    objectCount: state.view.rowCount,
    keyValues: {
      totalFlow: Math.round(state.view.totalFlow),
      avgSpeed: state.view.avgSpeed,
      busRiders: Math.round(state.view.busRiders),
      transitShare: state.view.transitShare,
      corridorCount: state.view.corridors.length,
      topCorridor: state.view.topCorridor?.name ?? null
    },
    dataHash: state.view.dataHash,
    pipeline: {
      raw: state.processed.rawCount,
      missing: state.processed.missingCount,
      duplicate: state.processed.duplicateCount,
      outlier: state.processed.outlierCount,
      clean: state.processed.cleanCount,
      audit: state.processed.auditCount,
      selected: state.view.rowCount
    },
    noMotion: state.noMotion,
    stackAttempted: state.stackAttempted
  };
}

async function exportCurrentChapter({ download = true } = {}) {
  const button = $("#exportButton");
  const originalLabel = button.innerHTML;
  button.disabled = true;
  button.textContent = "生成 PNG…";
  try {
    const chapter = chapterById(state.chapterId);
    const narrative = buildNarrative(state.view, state.chapterId, state.filters);
    const manifest = buildExportManifest(state.dataset, state.processed, state.view, state.chapterId);
    const result = await createChapterPng({
      dataset: state.dataset,
      view: state.view,
      chapterId: state.chapterId,
      narrative,
      filters: state.filters,
      manifest,
      noMotion: state.noMotion
    });
    state.lastExport = result.manifest;
    renderDebug();
    if (download) downloadBlob(result.blob, result.filename);
    showToast(`已导出「${chapter.title}」PNG：${formatNumber(result.manifest.objectCount)} 个对象，哈希 ${result.manifest.dataHash}`);
    return result;
  } catch (error) {
    console.error(error);
    showToast(`导出失败：${error.message}`);
    throw error;
  } finally {
    button.disabled = false;
    button.innerHTML = originalLabel;
  }
}

function setNoMotion(value) {
  state.noMotion = Boolean(value);
  document.documentElement.classList.toggle("no-motion", state.noMotion);
  const toggle = $("#motionToggle");
  toggle.setAttribute("aria-pressed", String(state.noMotion));
  toggle.querySelector(".button-label").textContent = state.noMotion ? "无动画" : "动画开";
  if (state.view) renderDebug();
}

function toggleNoMotion() {
  setNoMotion(!state.noMotion);
  showToast(state.noMotion ? "已启用无动画模式：滚动与过渡改为即时。" : "已恢复标准动画模式。");
}

function toggleStackAttempt() {
  state.stackAttempted = !state.stackAttempted;
  renderVisuals();
  renderDebug();
  showToast(state.stackAttempted
    ? "速度不可堆叠，已保留独立走廊视图。"
    : "已恢复分组速度视图。");
}

function saveProject({ download = true } = {}) {
  const project = createProject(
    state.dataset,
    projectSettingsFromState(state),
    `临江市 · ${chapterById(state.chapterId).title}报道工程`
  );
  state.lastProject = project;
  if (download) {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const blob = new Blob([`${JSON.stringify(project, null, 2)}\n`], { type: "application/json" });
    downloadBlob(blob, `城市脉冲_工程_${stamp}.json`);
    showToast("工程已保存，包含数据快照、筛选、章节和无动画设置。");
  }
  return project;
}

function loadProjectObject(project, { announce = true } = {}) {
  const valid = validateProject(project);
  state.datasets.custom = valid.dataset;
  state.datasetKey = "custom";
  state.dataset = valid.dataset;
  state.processed = normalizeDataset(valid.dataset);
  state.filters = sanitizeFilters(valid.settings);
  state.chapterId = CHAPTERS.some((chapter) => chapter.id === valid.settings.chapterId)
    ? valid.settings.chapterId
    : CHAPTERS[0].id;
  state.stackAttempted = Boolean(valid.settings.stackAttempted);
  state.lastExport = null;
  ensureCustomDatasetOption(valid.dataset);
  populateControls();
  setNoMotion(Boolean(valid.settings.noMotion));
  recomputeView();
  renderChapterNavigation();
  goToChapter(state.chapterId);
  if (announce) showToast(`已载入工程「${valid.name || "未命名"}」，所有视图已按工程状态恢复。`);
  return exportSnapshot();
}

function handleProjectFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  file.text()
    .then((text) => loadProjectObject(JSON.parse(text)))
    .catch((error) => {
      console.error(error);
      showToast(`工程载入失败：${error.message}`);
    })
    .finally(() => {
      event.target.value = "";
    });
}

function bindEvents() {
  $("#datasetSelect").addEventListener("change", (event) => applyDataset(event.target.value));
  $("#districtFilter").addEventListener("change", (event) => applyFilters({ districtId: event.target.value }));
  $("#directionFilter").addEventListener("change", (event) => applyFilters({ direction: event.target.value }));
  $("#periodFilter").addEventListener("change", (event) => applyFilters({ period: event.target.value }));
  $("#scopeFilter").addEventListener("change", (event) => applyFilters({ recordScope: event.target.value }));
  $("#resetButton").addEventListener("click", () => {
    state.filters = { ...DEFAULT_FILTERS };
    state.stackAttempted = false;
    recomputeView();
    showToast("筛选已重置，全部视图使用同一默认口径。");
  });
  $("#motionToggle").addEventListener("click", toggleNoMotion);
  $("#stackButton").addEventListener("click", toggleStackAttempt);
  $("#exportButton").addEventListener("click", () => exportCurrentChapter());
  $("#saveProjectButton").addEventListener("click", () => saveProject());
  $("#projectFile").addEventListener("change", handleProjectFile);
  $("#debugToggle").addEventListener("click", () => {
    setDebugOpen(!$("#debugPanel").classList.contains("is-open"));
  });

  window.addEventListener("scroll", handleScroll, { passive: true });
  window.addEventListener("resize", updateScrollProgress);
  document.addEventListener("keydown", (event) => {
    const isField = event.target.matches?.("input, select, textarea, [contenteditable]");
    if (isField) return;
    if (event.altKey && ["1", "2", "3"].includes(event.key)) {
      event.preventDefault();
      goToChapter(CHAPTERS[Number(event.key) - 1].id);
    }
    if (event.altKey && event.key.toLowerCase() === "m") {
      event.preventDefault();
      toggleNoMotion();
    }
  });
}

function setDebugOpen(open) {
  $("#debugPanel").classList.toggle("is-open", open);
  $("#debugToggle").setAttribute("aria-expanded", String(open));
  $("#debugToggle").textContent = open ? "收起" : "展开";
}

function installReportApi() {
  window.reportApi = {
    ready: true,
    getSnapshot: () => exportSnapshot(),
    getDebugText: () => $("#debugState").textContent,
    getAnomalies: () => state.processed.anomalies.map((anomaly) => ({ ...anomaly })),
    getNarrative: (chapterId = state.chapterId) => buildNarrative(state.view, chapterId, state.filters),
    setFilters: (partial) => {
      applyFilters(partial);
      return exportSnapshot();
    },
    setDataset: (datasetKey) => {
      applyDataset(datasetKey);
      return exportSnapshot();
    },
    goToChapter: (chapterId, options = {}) => {
      goToChapter(chapterId, options);
      return exportSnapshot();
    },
    setNoMotion: (value) => {
      setNoMotion(value);
      return exportSnapshot();
    },
    attemptStack: () => {
      if (!state.stackAttempted) toggleStackAttempt();
      return exportSnapshot();
    },
    exportCurrentChapter: (options = {}) => exportCurrentChapter(options),
    readManifest: manifestFromPng,
    saveProject: (options = {}) => saveProject(options),
    loadProject: (project, options = {}) => loadProjectObject(project, options),
    getLastExport: () => state.lastExport,
    getLastProject: () => state.lastProject
  };
  document.dispatchEvent(new CustomEvent("citypulse:ready"));
}

async function init() {
  try {
    const entries = await Promise.all(Object.entries(DATASET_FILES).map(async ([key, url]) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url} 返回 ${response.status}`);
      return [key, await response.json()];
    }));
    state.datasets = Object.fromEntries(entries);
    state.datasetKey = "base";
    state.dataset = state.datasets.base;
    state.processed = normalizeDataset(state.dataset);
    $("#filterStatus").setAttribute("aria-live", "polite");
    populateControls();
    setNoMotion(state.noMotion);
    renderChapterNavigation();
    bindEvents();
    recomputeView();
    if (window.innerHeight < 860) setDebugOpen(false);
    installReportApi();
  } catch (error) {
    console.error(error);
    $("#filterStatus").textContent = `数据载入失败：${error.message}。请通过本地服务器打开页面。`;
    $("#filterStatus").setAttribute("role", "alert");
    showToast("数据载入失败，请运行 npm start 后访问页面。");
  }
}

init();
