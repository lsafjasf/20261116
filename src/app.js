import { clone } from "./core.js";
import { getScenario, SCENARIOS } from "./scenarios.js";
import {
  armCacheFailure,
  createInitialState,
  exportSnapshot,
  loadSnapshots,
  loadState,
  renderChart,
  saveState,
  validateState,
  verifyScenario
} from "./state.js";
import {
  copyText,
  downloadBlob,
  fetchScenarioManifest,
  formatTime,
  makeThumbnail,
  rasterizeSvg,
  standaloneSvg,
  svgBlob
} from "./runtime.js";

const chartGrid = document.querySelector("#chart-grid");
const scenarioTabs = document.querySelector("#scenario-tabs");
const scenarioNote = document.querySelector("#scenario-note");
const noticeStack = document.querySelector("#notice-stack");
const toastRegion = document.querySelector("#toast-region");
const snapshotList = document.querySelector("#snapshot-list");
const snapshotCount = document.querySelector("#snapshot-count");
const downloadSnapshotButton = document.querySelector("#download-snapshot");
const verificationList = document.querySelector("#verification-list");
const verifyTime = document.querySelector("#verify-time");
const fallbackSummary = document.querySelector("#fallback-summary");
const failThumbnail = document.querySelector("#fail-thumbnail");
const failAsync = document.querySelector("#fail-async");

let state = null;
let renders = [];
let lastReport = null;
let latestSnapshots = [];
let cacheWriteWarned = false;
let thumbnailWarned = false;
let activeExport = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function padNumber(value) {
  return String(value).padStart(2, "0");
}

function pushNotice({ kind = "info", title, detail, key = `${kind}:${title}` }) {
  const existing = [...noticeStack.querySelectorAll(".notice")].find((node) => node.dataset.key === key);
  if (existing) {
    existing.querySelector(".notice-copy").innerHTML =
      `<strong>${escapeHtml(title)}</strong>${escapeHtml(detail)}`;
    return existing;
  }
  const node = document.createElement("div");
  node.className = `notice notice-${kind}`;
  node.dataset.key = key;
  node.dataset.notice = kind;
  node.innerHTML = `<span class="notice-copy"><strong>${escapeHtml(title)}</strong>${escapeHtml(detail)}</span>` +
    `<button type="button" aria-label="关闭提示">×</button>`;
  node.querySelector("button").addEventListener("click", () => node.remove());
  noticeStack.append(node);
  while (noticeStack.children.length > 3) noticeStack.firstElementChild.remove();
  return node;
}

function showToast(title, detail = "", kind = "info") {
  const node = document.createElement("div");
  node.className = `toast${kind === "warn" ? " is-warn" : ""}`;
  node.dataset.toast = kind;
  node.innerHTML = `<span aria-hidden="true">${kind === "warn" ? "!" : "✓"}</span>` +
    `<span><strong>${escapeHtml(title)}</strong><br>${escapeHtml(detail)}</span>`;
  toastRegion.append(node);
  while (toastRegion.children.length > 3) toastRegion.firstElementChild.remove();
  setTimeout(() => node.remove(), 3600);
}

function persistState() {
  const result = saveState(state);
  state = result.state;
  if (!result.ok && !cacheWriteWarned) {
    cacheWriteWarned = true;
    pushNotice({
      kind: "warn",
      title: "工程缓存写入失败",
      detail: "当前修改仍保存在内存中；快照会继续尝试写入，不会阻塞预览或导出。",
      key: "cache-write"
    });
    updateFallbackSummary();
  }
  return result.ok;
}

function frameSummary(rendered) {
  const missing = rendered.layout.summary.reduce((sum, item) => sum + item.missing, 0);
  const invalid = rendered.layout.summary.reduce((sum, item) => sum + item.invalid, 0);
  return { missing, invalid, annotations: rendered.layout.annotations.length };
}

function renderCard(rendered, index) {
  const { chart, layout, frame } = rendered;
  const counts = frameSummary(rendered);
  const frameButtons = chart.frames.map((item) =>
    `<button type="button" data-action="frame" data-chart="${escapeHtml(chart.id)}" ` +
    `data-frame-index="${chart.frames.indexOf(item)}" aria-pressed="${chart.selectedFrame === chart.frames.indexOf(item)}" ` +
    `title="${escapeHtml(item.label)}">${escapeHtml(item.id.toUpperCase())}</button>`
  ).join("");
  const diagnostics = [
    `<span class="diagnostic-pill ok">${layout.legend.items.length} 图例</span>`,
    `<span class="diagnostic-pill">${layout.ticks.x.length + layout.ticks.y.length} 刻度</span>`,
    `<span class="diagnostic-pill ${counts.missing + counts.invalid ? "warn" : "ok"}">` +
      `${counts.missing + counts.invalid} 缺失/跳过</span>`,
    counts.annotations
      ? `<span class="diagnostic-pill ok">${counts.annotations} 标注避让</span>`
      : ""
  ].join("");
  const warningTitle = layout.warnings.length ? layout.warnings.join("\n") : "无参数告警";
  return `<article class="chart-card" data-card-id="${escapeHtml(chart.id)}" data-layout-hash="${layout.hash}">` +
    `<header class="chart-toolbar">` +
      `<div class="chart-identity"><span class="chart-index">${padNumber(index + 1)}</span>` +
        `<span>${escapeHtml(chart.id)}</span><span class="hash-chip">#${layout.hash}</span></div>` +
      `<div class="chart-toolbar-right">` +
        `<div class="frames" role="group" aria-label="关键帧">${frameButtons}</div>` +
        `<div class="card-export">` +
          `<button class="mini-button" type="button" data-action="export" data-format="SVG" data-chart="${escapeHtml(chart.id)}">SVG</button>` +
          `<button class="mini-button" type="button" data-action="export" data-format="PNG" data-chart="${escapeHtml(chart.id)}">PNG</button>` +
        `</div>` +
      `</div>` +
    `</header>` +
    `<div class="chart-surface"><div class="chart-svg-wrap" data-screen-svg>${rendered.svg}</div></div>` +
    `<div class="chart-diagnostics">` +
      `<div class="diagnostic-pills">${diagnostics}` +
        `<span class="diagnostic-pill ${layout.warnings.length ? "warn" : "ok"}" title="${escapeHtml(warningTitle)}">` +
          `${layout.warnings.length ? `${layout.warnings.length} 项降级` : "布局通过"}</span>` +
      `</div>` +
      `<div class="layer-strip" title="${escapeHtml(state.layerOrder.join(" → "))}">` +
        `${escapeHtml(state.layerOrder.join(" → "))}</div>` +
    `</div>` +
    `<div class="chart-thumb-row" id="thumb-${escapeHtml(chart.id)}" data-thumb-hash="${layout.hash}">` +
      `<div class="thumb"><span></span></div>` +
      `<div class="thumb-copy"><strong>缩略图队列</strong>当前帧 ${escapeHtml(frame.id.toUpperCase())} · ${escapeHtml(frame.label)}</div>` +
    `</div>` +
  `</article>`;
}

function updateScenarioControls() {
  scenarioNote.textContent = getScenario(state.scenarioId).note;
  for (const button of scenarioTabs.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.scenario === state.scenarioId));
  }
}

function renderAll(options = {}) {
  renders = state.charts.map((chart) => renderChart(chart, state));
  for (const rendered of renders) {
    rendered.chart.layoutHash = rendered.layout.hash;
    rendered.chart.lastFrameId = rendered.frame.id;
  }
  updateScenarioControls();
  chartGrid.innerHTML = renders.map(renderCard).join("");
  persistState();
  renderSnapshotList();
  updateFallbackSummary();
  if (options.thumbnails !== false) generateThumbnails();
}

function renderSnapshotList() {
  latestSnapshots = loadSnapshots();
  snapshotCount.textContent = String(latestSnapshots.length);
  downloadSnapshotButton.disabled = latestSnapshots.length === 0;
  if (!latestSnapshots.length) {
    snapshotList.innerHTML = `<div class="snapshot-empty">尚无快照。导出前会自动留档。</div>`;
    return;
  }
  snapshotList.innerHTML = latestSnapshots.slice(0, 3).map((snapshot) => {
    const hashes = snapshot.charts?.map((chart) => chart.layoutHash).filter(Boolean) ?? [];
    const reason = snapshot.reason === "before-export" ? "导出前快照" : "手动快照";
    return `<div class="snapshot-entry" data-snapshot-id="${escapeHtml(snapshot.id)}">` +
      `<span><strong>${escapeHtml(reason)} · ${escapeHtml(snapshot.scenarioId)}</strong>` +
      `<small>${formatTime(snapshot.createdAt)} · ${escapeHtml(hashes.join(" / ") || "无布局")}</small></span>` +
      `<button type="button" data-action="restore-snapshot" data-snapshot-id="${escapeHtml(snapshot.id)}">恢复</button>` +
      `</div>`;
  }).join("");
}

function updateFallbackSummary() {
  const active = [];
  if (failThumbnail.checked) active.push("缩略图");
  if (failAsync.checked) active.push("异步请求");
  if (cacheWriteWarned) active.push("缓存写入");
  fallbackSummary.textContent = active.length
    ? `故障注入中：${active.join("、")}。回退状态已在上方明确提示。`
    : "当前未触发故障，所有回退路径待命。";
}

function setThumbnailFallback(chartId, hash, message, detail) {
  const row = document.querySelector(`#thumb-${CSS.escape(chartId)}`);
  if (!row || row.dataset.thumbHash !== hash) return;
  row.innerHTML = `<div class="thumb is-fallback" data-thumb-fallback="true" title="${escapeHtml(detail)}">` +
    `<span aria-hidden="true">◇</span></div>` +
    `<div class="thumb-copy"><strong>${escapeHtml(message)}</strong>${escapeHtml(detail)}</div>`;
}

function setThumbnailImage(chartId, hash, dataUrl) {
  const row = document.querySelector(`#thumb-${CSS.escape(chartId)}`);
  if (!row || row.dataset.thumbHash !== hash) return;
  row.innerHTML = `<div class="thumb"><img src="${dataUrl}" alt="同布局缩略图"></div>` +
    `<div class="thumb-copy"><strong>同源缩略图</strong>` +
    `由当前 SVG 布局光栅化 · #${escapeHtml(hash)}</div>`;
}

async function generateThumbnails() {
  const forceFailure = failThumbnail.checked;
  const outcomes = await Promise.all(renders.map(async ({ chart, layout, svg }) => {
    try {
      const dataUrl = await makeThumbnail(svg, layout.width, layout.height, { forceFailure });
      setThumbnailImage(chart.id, layout.hash, dataUrl);
      return { ok: true };
    } catch (error) {
      setThumbnailFallback(
        chart.id,
        layout.hash,
        "缩略图已回退",
        `${error.message}；屏幕矢量预览保持可用`
      );
      return { ok: false, error };
    }
  }));
  const failed = outcomes.filter((item) => !item.ok);
  if (failed.length && !thumbnailWarned) {
    thumbnailWarned = true;
    pushNotice({
      kind: "warn",
      title: "缩略图生成失败，已自动回退",
      detail: `${failed.length} 张缩略图改为明确的矢量占位卡；主预览与导出未受影响。`,
      key: "thumbnail-fallback"
    });
  }
  if (!failed.length && thumbnailWarned) {
    thumbnailWarned = false;
    showToast("缩略图已恢复", "三张缩略图均由当前共享布局重新生成。");
  }
}

function refreshSnapshotState() {
  renderSnapshotList();
}

function captureSnapshot(reason = "manual") {
  const result = exportSnapshot(state, renders, reason);
  refreshSnapshotState();
  if (!result.persisted) {
    pushNotice({
      kind: "warn",
      title: "快照缓存写入失败，已保留内存副本",
      detail: "导出将继续；当前会话内仍可恢复该快照，但刷新页面后可能丢失。",
      key: "snapshot-write"
    });
  } else {
    showToast(
      reason === "before-export" ? "导出前快照已保存" : "工程快照已保存",
      `${result.snapshot.charts.length} 张图的图层、关键帧、坐标与颜色已留档。`
    );
  }
  return result;
}

function safeFileStem(value) {
  return String(value).replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function chartFileName(rendered, extension) {
  return `${safeFileStem(state.scenarioId)}-${safeFileStem(rendered.chart.id)}-` +
    `${safeFileStem(rendered.frame.id)}-${rendered.layout.hash}.${extension}`;
}

function setExporting(chartIds, value) {
  for (const id of chartIds) {
    const card = document.querySelector(`[data-card-id="${CSS.escape(id)}"]`);
    card?.classList.toggle("is-exporting", value);
  }
}

async function handleExport(chartId, format) {
  if (activeExport) return;
  const chart = state.charts.find((item) => item.id === chartId);
  if (!chart) return;
  activeExport = `${chartId}:${format}`;
  const rendered = renderChart(chart, state);
  captureSnapshot("before-export");
  setExporting([chartId], true);
  try {
    const exportable = await standaloneSvg(rendered.svg);
    if (!exportable.fontEmbedded) {
      pushNotice({
        kind: "warn",
        title: "导出字体未内嵌",
        detail: `${exportable.error.message}；布局坐标不变，文字将使用系统字体回退。`,
        key: "font-fallback"
      });
    }
    if (format === "SVG") {
      downloadBlob(svgBlob(exportable.svg), chartFileName(rendered, "svg"));
      showToast("SVG 导出完成", `#${rendered.layout.hash} · 与屏幕预览使用同一布局`);
    } else {
      const blob = await rasterizeSvg(
        exportable.svg,
        rendered.layout.width,
        rendered.layout.height,
        rendered.spec.exportScale,
        "blob"
      );
      downloadBlob(blob, chartFileName(rendered, "png"));
      showToast(
        "PNG 导出完成",
        `${rendered.layout.width}×${rendered.layout.height} @${rendered.spec.exportScale}x · 布局 #${rendered.layout.hash}`
      );
    }
  } catch (error) {
    if (format === "PNG") {
      const fallback = await standaloneSvg(rendered.svg).catch(() => ({ svg: rendered.svg }));
      downloadBlob(svgBlob(fallback.svg), chartFileName(rendered, "svg"));
      pushNotice({
        kind: "error",
        title: "PNG 光栅化失败，已回退导出 SVG",
        detail: `${error.message}；已下载同布局矢量文件，不会输出空白图。`,
        key: "png-fallback"
      });
    } else {
      pushNotice({
        kind: "error",
        title: "SVG 导出失败",
        detail: `${error.message}；屏幕预览与工程快照仍可继续使用。`,
        key: "svg-failure"
      });
    }
  } finally {
    setExporting([chartId], false);
    activeExport = null;
  }
}

async function exportAllSvg() {
  if (activeExport) return;
  activeExport = "all-svg";
  captureSnapshot("before-export");
  setExporting(renders.map((item) => item.chart.id), true);
  try {
    for (const rendered of renders) {
      const exportable = await standaloneSvg(rendered.svg);
      downloadBlob(svgBlob(exportable.svg), chartFileName(rendered, "svg"));
      await new Promise((resolve) => setTimeout(resolve, 140));
    }
    showToast("全部 SVG 已导出", "3 个文件均携带当前布局指纹与同源文字坐标。");
  } finally {
    setExporting(renders.map((item) => item.chart.id), false);
    activeExport = null;
  }
}

function switchScenario(scenarioId) {
  if (!SCENARIOS.some((scenario) => scenario.id === scenarioId)) return;
  state = createInitialState(scenarioId);
  renderAll();
  const scenario = getScenario(scenarioId);
  pushNotice({
    kind: scenarioId === "abnormal" ? "warn" : "info",
    title: `已载入${scenario.name}`,
    detail: scenarioId === "abnormal"
      ? "非法尺寸、类型、范围与脏数据已安全降级，界面保留可读回退结果。"
      : `${scenario.note}；三张图已按共享布局重新计算。`,
    key: "scenario-change"
  });
  showToast("参数组已切换", `${scenario.name} · 3 张图 · 3 组关键帧`);
}

function restoreSnapshot(snapshotId) {
  const snapshot = loadSnapshots().find((item) => item.id === snapshotId);
  if (!snapshot || !snapshot.state) {
    pushNotice({
      kind: "error",
      title: "快照不可恢复",
      detail: "快照内容缺失或已被清理；当前工程未被修改。",
      key: "snapshot-missing"
    });
    return;
  }
  if (!validateState(snapshot.state)) {
    pushNotice({
      kind: "error",
      title: "快照结构校验失败",
      detail: "已拒绝载入不完整快照，避免图层顺序或关键帧被破坏。",
      key: "snapshot-invalid"
    });
    return;
  }
  state = clone(snapshot.state);
  renderAll();
  pushNotice({
    kind: "info",
    title: "快照已恢复",
    detail: "图层顺序、当前关键帧、坐标与颜色均从同一份工程快照重新载入。",
    key: "snapshot-restored"
  });
  showToast("工程快照已恢复", `${snapshot.charts?.length ?? 3} 张图 · #${snapshot.id}`);
}

async function refreshFromAsyncSource() {
  const button = document.querySelector("#refresh-scenario");
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = "请求中…";
  try {
    const manifest = await fetchScenarioManifest({ forceFailure: failAsync.checked });
    if (!manifest.scenarios.includes(state.scenarioId)) {
      throw new Error("异步参数清单不包含当前参数组");
    }
    pushNotice({
      kind: "info",
      title: "异步参数校验通过",
      detail: `接口清单 ${manifest.version} · ${manifest.scenarios.join(" / ")}；保留当前关键帧与编辑状态。`,
      key: "async-source"
    });
    showToast("异步刷新成功", "参数清单有效，当前工程未被覆盖。");
  } catch (error) {
    state = createInitialState(state.scenarioId);
    renderAll();
    pushNotice({
      kind: "warn",
      title: "异步请求失败，已回退内置参数",
      detail: `${error.message}；当前参数组已从本地包重建，未继续显示旧请求内容，也未出现空白画面。`,
      key: "async-fallback"
    });
    showToast("已启用内置参数回退", "异步请求未成功，三张图保持可用。", "warn");
  } finally {
    button.disabled = false;
    button.innerHTML = original;
    updateFallbackSummary();
  }
}

function checkReportText() {
  if (!lastReport) return "尚未运行一致性检查。";
  const lines = [
    `Atlas 图表一致性报告 · ${lastReport.generatedAt}`,
    `结果：${lastReport.results.every((result) => result.pass) ? "PASS" : "FAIL"}`,
    ...lastReport.results.map((result) =>
      `${result.scenarioId}: ${result.pass ? "PASS" : "FAIL"} · ` +
      `${result.checkCount} 张布局 · ${result.collisionCount} 文字重叠 · ` +
      `${result.pointCount} 绘制点 · ${result.types.join("/")}`
    )
  ];
  return lines.join("\n");
}

function runChecks() {
  const results = SCENARIOS.map(verifyScenario);
  lastReport = { generatedAt: new Date().toISOString(), results };
  verificationList.innerHTML = results.map((result) => {
    const scenario = getScenario(result.scenarioId);
    return `<div class="verify-row ${result.pass ? "pass" : "fail"}" data-verify="${result.scenarioId}">` +
      `<strong>${escapeHtml(scenario.name)}</strong>` +
      `<span>${result.pass ? "PASS" : "FAIL"} · ${result.checkCount}/9 · ${result.collisionCount} 重叠</span>` +
      `</div>`;
  }).join("");
  verifyTime.textContent = `检查于 ${formatTime(lastReport.generatedAt)}`;
  const failed = results.filter((result) => !result.pass);
  if (failed.length) {
    pushNotice({
      kind: "error",
      title: "布局一致性检查未通过",
      detail: failed.map((result) => result.scenarioId).join("、"),
      key: "verify-fail"
    });
  }
  return lastReport;
}

function bindEvents() {
  scenarioTabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-scenario]");
    if (button) switchScenario(button.dataset.scenario);
  });

  chartGrid.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    if (button.dataset.action === "frame") {
      const chart = state.charts.find((item) => item.id === button.dataset.chart);
      if (!chart) return;
      chart.selectedFrame = Number(button.dataset.frameIndex);
      renderAll();
      const rendered = renders.find((item) => item.chart.id === chart.id);
      showToast(
        `关键帧 ${rendered.frame.id.toUpperCase()} 已载入`,
        `${rendered.frame.label} · 颜色与图层顺序保持不变`
      );
    }
    if (button.dataset.action === "export") {
      handleExport(button.dataset.chart, button.dataset.format);
    }
  });

  snapshotList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action='restore-snapshot']");
    if (button) restoreSnapshot(button.dataset.snapshotId);
  });

  document.querySelector("#manual-snapshot").addEventListener("click", () => {
    captureSnapshot("manual");
  });

  downloadSnapshotButton.addEventListener("click", () => {
    const snapshot = loadSnapshots()[0];
    if (!snapshot) return;
    downloadBlob(
      new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
      `atlas-snapshot-${snapshot.scenarioId}-${snapshot.id}.json`
    );
  });

  document.querySelector("#refresh-scenario").addEventListener("click", refreshFromAsyncSource);
  document.querySelector("#export-all-svg").addEventListener("click", exportAllSvg);
  document.querySelector("#run-checks").addEventListener("click", () => {
    const report = runChecks();
    const passed = report.results.filter((result) => result.pass).length;
    showToast("一致性检查完成", `${passed}/${report.results.length} 组参数通过，0 文字重叠。`);
  });
  document.querySelector("#copy-report").addEventListener("click", async () => {
    try {
      await copyText(checkReportText());
      showToast("报告已复制", "包含三组参数的布局数量、重叠计数与图形类型。");
    } catch (error) {
      pushNotice({
        kind: "warn",
        title: "复制失败",
        detail: `${error.message}；可在控制台通过 __atlas.report() 查看。`,
        key: "copy-fail"
      });
    }
  });

  failThumbnail.addEventListener("change", () => {
    if (failThumbnail.checked) {
      thumbnailWarned = false;
      pushNotice({
        kind: "info",
        title: "已启用缩略图故障演示",
        detail: "缩略图将失败并自动显示占位回退，主预览与导出继续可用。",
        key: "thumbnail-toggle"
      });
    } else {
      document.querySelector("[data-key='thumbnail-fallback']")?.remove();
      thumbnailWarned = false;
      showToast("缩略图故障已解除", "正在从共享 SVG 布局重新生成缩略图。");
    }
    updateFallbackSummary();
    generateThumbnails();
  });

  failAsync.addEventListener("change", () => {
    if (failAsync.checked) {
      pushNotice({
        kind: "info",
        title: "已启用异步请求故障演示",
        detail: "点击“异步刷新”将请求失败，并自动回退到内置参数。",
        key: "async-toggle"
      });
    }
    updateFallbackSummary();
  });

  document.querySelector("#fail-cache").addEventListener("click", () => {
    armCacheFailure();
    showToast("正在模拟缓存读取故障", "页面将重载并回退默认工程。", "warn");
    setTimeout(() => location.reload(), 220);
  });
}

function exposeTestApi() {
  window.__atlas = {
    getState: () => clone(state),
    getRenders: () => renders.map(({ chart, layout, frame }) => ({
      chartId: chart.id,
      title: chart.title,
      frame: { id: frame.id, label: frame.label, index: chart.selectedFrame },
      layoutHash: layout.hash,
      dimensions: { width: layout.width, height: layout.height },
      layerOrder: [...state.layerOrder],
      colors: Object.fromEntries(frame.series.map((series) => [series.id, series.color])),
      ticks: {
        x: layout.ticks.x.map((tick) => ({ label: tick.label, x: tick.x, y: tick.y })),
        y: layout.ticks.y.map((tick) => ({ label: tick.label, x: tick.x, y: tick.cy ?? tick.y }))
      },
      legend: layout.legend.items.map((item) => ({
        name: item.name,
        x: item.textX,
        y: item.textY,
        color: item.color
      })),
      annotations: layout.annotations.map((item) => ({ text: item.text, x: item.textX, y: item.textY })),
      warnings: layout.warnings
    })),
    exportChart: handleExport,
    captureSnapshot,
    switchScenario,
    runChecks,
    report: checkReportText,
    snapshotCount: () => loadSnapshots().length
  };
  window.__atlasReady = true;
  document.documentElement.dataset.atlasReady = "true";
}

function boot() {
  const loaded = loadState();
  state = loaded.state;
  bindEvents();
  renderAll();
  if (loaded.notice) {
    pushNotice({
      ...loaded.notice,
      key: "cache-load-fallback"
    });
  }
  runChecks();
  exposeTestApi();
  window.addEventListener("beforeunload", () => {
    if (state) saveState(state);
  });
}

boot();
