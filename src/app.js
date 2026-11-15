import { createSceneEngine, applyChange, runComparison, SCENE_SIZE } from "./scenarios.js";
import { drawCommands, drawArtboardShadow } from "./canvas-renderer.js";

const $ = (selector) => document.querySelector(selector);
const dom = {
  canvas: $("#editorCanvas"),
  canvasWrap: $("#canvasWrap"),
  layerTree: $("#layerTree"),
  layerCount: $("#layerCount"),
  selectedName: $("#selectedName"),
  selectedType: $("#selectedType"),
  selectedId: $("#selectedId"),
  propX: $("#propX"),
  propY: $("#propY"),
  propW: $("#propW"),
  propH: $("#propH"),
  propFont: $("#propFont"),
  fontValue: $("#fontValue"),
  toggleVisible: $("#toggleVisible"),
  visibilityLabel: $("#visibilityLabel"),
  deleteNode: $("#deleteNode"),
  layoutKey: $("#layoutKey"),
  paintKey: $("#paintKey"),
  dependencyPills: $("#dependencyPills"),
  selectionTrail: $("#selectionTrail"),
  zoomLabel: $("#zoomLabel"),
  statusUpdate: $("#statusUpdate"),
  changeToast: $("#changeToast"),
  metricFrame: $("#metricFrame"),
  metricHitRate: $("#metricHitRate"),
  metricHits: $("#metricHits"),
  metricCandidates: $("#metricCandidates"),
  metricCandidateDetail: $("#metricCandidateDetail"),
  metricRecompute: $("#metricRecompute"),
  metricRecomputeDetail: $("#metricRecomputeDetail"),
  metricNodes: $("#metricNodes"),
  metricCaches: $("#metricCaches"),
  metricDangling: $("#metricDangling"),
  cacheDrawer: $("#cacheDrawer"),
  cacheDrawerBody: $("#cacheDrawerBody"),
  benchmarkDialog: $("#benchmarkDialog"),
  benchmarkBody: $("#benchmarkBody"),
  benchmarkVerdict: $("#benchmarkVerdict"),
};

const measureCanvas = document.createElement("canvas");
const measureContext = measureCanvas.getContext("2d");
const measureText = (text, style) => {
  measureContext.font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
  return measureContext.measureText(String(text)).width;
};

let engine = null;
let commands = [];
let currentBenchmark = null;
let toastTimer = 0;
let flashTimer = 0;
let flashIds = [];
let flashUntil = 0;
let hasFit = false;

const view = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
};

const state = {
  selectedId: "hero",
  expanded: new Set(["root", "hero", "heroTitle", "insight", "insightBars", "notes", "palette"]),
  panning: false,
  panStart: null,
  moved: false,
};

const TYPE_LABELS = {
  group: "GROUP",
  frame: "FRAME",
  text: "TEXT",
  rect: "RECT",
  ellipse: "ELLIPSE",
  line: "LINE",
};

const ICONS = {
  group: "G",
  frame: "F",
  text: "T",
  rect: "R",
  ellipse: "○",
  line: "/",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shortKey(key) {
  return key ? key.slice(0, 8) : "—";
}

function percent(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

function eyeIcon(visible) {
  if (!visible) {
    return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 2l12 12M6.5 6.7A2 2 0 008.1 10M4.2 4.5C2.9 5.4 2 6.6 2 8c1.2 2 3.4 3.4 6 3.4 1 0 1.9-.2 2.7-.6M7.2 4.7c.3-.1.5-.1.8-.1 2.6 0 4.8 1.4 6 3.4-.4.7-1 1.4-1.7 1.9" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';
  }
  return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 8c1.2-2 3.4-3.4 6-3.4S12.8 6 14 8c-1.2 2-3.4 3.4-6 3.4S3.2 10 2 8z" stroke="currentColor" stroke-width="1.1"/><circle cx="8" cy="8" r="1.8" stroke="currentColor" stroke-width="1.1"/></svg>';
}

function ancestorsOf(id) {
  const result = [];
  let node = engine.getNode(id);
  while (node && node.parentId) {
    result.push(node.parentId);
    node = engine.getNode(node.parentId);
  }
  return result;
}

function expandAncestors(id) {
  for (const ancestor of ancestorsOf(id)) state.expanded.add(ancestor);
}

function newEngine(options = {}) {
  engine = createSceneEngine({ measureText, ...options });
  state.selectedId = "hero";
  state.expanded = new Set(["root", "hero", "heroTitle", "insight", "insightBars", "notes", "palette"]);
  commands = [];
  engine.resetTelemetry();
}

function isEffectivelyVisible(node) {
  let cursor = node;
  while (cursor) {
    if (!cursor.visible) return false;
    cursor = engine.getParent(cursor);
  }
  return true;
}

function renderTree() {
  if (!engine) return;
  const rows = [];
  const walk = (id, depth) => {
    const node = engine.getNode(id);
    if (!node) return;
    const expanded = state.expanded.has(id);
    const selected = id === state.selectedId;
    const visible = isEffectivelyVisible(node);
    const hasChildren = node.children.length > 0;
    rows.push(`
      <div class="layer-row${selected ? " is-selected" : ""}${visible ? "" : " is-hidden"}"
           data-layer-id="${escapeHtml(id)}" style="--depth:${depth}" role="treeitem"
           aria-selected="${selected}" aria-expanded="${hasChildren ? expanded : "false"}">
        <span class="layer-caret${expanded ? " is-open" : ""}" data-caret="${escapeHtml(id)}">${hasChildren ? "›" : ""}</span>
        <span class="layer-icon">${ICONS[node.type] ?? "G"}</span>
        <span class="layer-name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span>
        <button class="layer-eye" type="button" data-eye="${escapeHtml(id)}" aria-label="${node.visible ? "隐藏" : "显示"} ${escapeHtml(node.name)}">
          ${eyeIcon(node.visible)}
        </button>
      </div>
    `);
    if (hasChildren && expanded) {
      for (const childId of node.children) walk(childId, depth + 1);
    }
  };
  walk(engine.rootId, 0);
  dom.layerTree.innerHTML = rows.join("");
  dom.layerCount.textContent = engine.getMetrics().nodeCount;

  dom.layerTree.querySelectorAll(".layer-row").forEach((row) => {
    row.addEventListener("click", () => selectNode(row.dataset.layerId));
  });
  dom.layerTree.querySelectorAll(".layer-caret").forEach((caret) => {
    caret.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = caret.dataset.caret;
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      renderTree();
    });
  });
  dom.layerTree.querySelectorAll(".layer-eye").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = button.dataset.eye;
      const node = engine.getNode(id);
      if (!node) return;
      const willShow = !node.visible;
      engine.setVisible(id, willShow);
      state.selectedId = id;
      expandAncestors(id);
      renderScene({
        toast: `图层「${node.name}」${willShow ? "已显示" : "已隐藏"} · 仅绘制缓存失效`,
      });
    });
  });
}

function selectNode(id, { expand = true } = {}) {
  if (!engine?.getNode(id)) return;
  state.selectedId = id;
  if (expand) expandAncestors(id);
  renderTree();
  updateInspector();
  drawStage();
}

function updateInspector() {
  const node = engine?.getNode(state.selectedId);
  if (!node) return;
  const layout = node.cache.layout;
  const style = engine.resolveStyle(node);
  dom.selectedName.textContent = node.name;
  dom.selectedType.textContent = TYPE_LABELS[node.type] ?? node.type.toUpperCase();
  dom.selectedId.textContent = node.id;
  dom.propX.value = Math.round(layout?.x ?? 0);
  dom.propY.value = Math.round(layout?.y ?? 0);
  dom.propW.value = Math.round(layout?.width ?? 0);
  dom.propH.value = Math.round(layout?.height ?? 0);
  dom.propFont.value = Math.round(style.fontSize);
  dom.fontValue.textContent = `${Math.round(style.fontSize)} px`;
  dom.visibilityLabel.textContent = node.visible ? "隐藏图层" : "显示图层";
  dom.toggleVisible.classList.toggle("is-muted", !node.visible);
  dom.deleteNode.disabled = node.id === engine.rootId;
  const rangeValue = ((Number(dom.propFont.value) - 32) / (96 - 32)) * 100;
  dom.propFont.style.background =
    `linear-gradient(to right, var(--accent) 0 ${rangeValue}%, #dedbd2 ${rangeValue}% 100%)`;
  dom.layoutKey.textContent = shortKey(layout?.key);
  dom.layoutKey.title = layout?.key ?? "";
  dom.paintKey.textContent = shortKey(node.cache.paint?.key);
  dom.paintKey.title = node.cache.paint?.key ?? "";
  const dependencies = engine.getDependencies(node.id);
  const pills = [
    ...dependencies.layout.map((id) => `layout ← ${id}`),
    ...dependencies.paint.slice(1, 4).map((id) => `paint ← ${id}`),
    ...dependencies.font.map((id) => `font ← ${id}`),
  ];
  dom.dependencyPills.innerHTML = pills.length
    ? pills.map((label) => `<span class="dependency-pill">${escapeHtml(label)}</span>`).join("")
    : '<span class="dependency-pill">根节点</span>';
  const dependentCount = dependencies.layout.length + dependencies.paint.length + dependencies.font.length;
  dom.selectionTrail.textContent = `${node.name} · ${dependentCount} 个直接依赖`;
}

function updateMetrics() {
  if (!engine) return;
  const metrics = engine.getMetrics();
  const last = engine.lastUpdate;
  const frameMs = metrics.lastFrameMs;
  dom.metricFrame.innerHTML = `${frameMs < 0.1 ? "<0.1" : frameMs.toFixed(2)}<small>ms</small>`;
  dom.metricHitRate.innerHTML = `${Math.round(metrics.hitRate * 100)}<small>%</small>`;
  dom.metricHits.textContent =
    `${metrics.layoutHits + metrics.paintHits} hit / ${metrics.layoutMisses + metrics.paintMisses} miss`;
  dom.metricCandidates.textContent = String(metrics.candidateCount);
  dom.metricCandidateDetail.textContent =
    metrics.candidateCount
      ? `L${metrics.layoutCandidates} · P${metrics.paintCandidates} / ${metrics.nodeCount}`
      : "等待一次变更";
  dom.metricRecompute.textContent = String(metrics.layoutRecomputes + metrics.paintRecomputes);
  dom.metricRecomputeDetail.textContent =
    `本次 L${last.layoutRecomputes} · P${last.paintRecomputes}`;
  dom.metricNodes.textContent = String(metrics.nodeCount);
  dom.metricCaches.textContent = `${metrics.cacheEntries} 条缓存`;
  dom.metricDangling.textContent = String(metrics.danglingCount);
  dom.statusUpdate.textContent = engine.lastInvalidation.reason
    ? `最近：${engine.lastInvalidation.reason} · ${metrics.candidateCount} 候选`
    : "缓存图有效 · 等待变更";
  const selected = engine.getNode(state.selectedId);
  if (selected) {
    dom.layoutKey.textContent = shortKey(selected.cache.layout?.key);
    dom.layoutKey.title = selected.cache.layout?.key ?? "";
    dom.paintKey.textContent = shortKey(selected.cache.paint?.key);
    dom.paintKey.title = selected.cache.paint?.key ?? "";
  }
}

function screenToWorld(clientX, clientY) {
  const rect = dom.canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - view.offsetX) / view.scale,
    y: (clientY - rect.top - view.offsetY) / view.scale,
  };
}

function fitView() {
  const width = dom.canvasWrap.clientWidth;
  const height = dom.canvasWrap.clientHeight;
  if (!width || !height) return;
  const marginX = Math.min(100, width * 0.12);
  const marginY = Math.min(84, height * 0.12);
  view.scale = Math.max(
    0.2,
    Math.min(
      1.25,
      (width - marginX * 2) / SCENE_SIZE.width,
      (height - marginY * 2) / SCENE_SIZE.height,
    ),
  );
  view.offsetX = (width - SCENE_SIZE.width * view.scale) / 2;
  view.offsetY = (height - SCENE_SIZE.height * view.scale) / 2;
  hasFit = true;
  dom.zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
  drawStage();
}

function resizeCanvas() {
  const width = dom.canvasWrap.clientWidth;
  const height = dom.canvasWrap.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  if (dom.canvas.width !== pixelWidth || dom.canvas.height !== pixelHeight) {
    dom.canvas.width = pixelWidth;
    dom.canvas.height = pixelHeight;
  }
  if (!hasFit) fitView();
  else drawStage();
}

function drawSelectionOverlay(ctx) {
  const now = performance.now();
  if (now < flashUntil && flashIds.length) {
    ctx.save();
    ctx.strokeStyle = "rgba(220, 99, 74, 0.65)";
    ctx.fillStyle = "rgba(220, 99, 74, 0.045)";
    ctx.lineWidth = 1 / view.scale;
    ctx.setLineDash([4 / view.scale, 3 / view.scale]);
    for (const id of flashIds.slice(0, 24)) {
      const node = engine.getNode(id);
      const layout = node?.cache.layout;
      if (!layout) continue;
      ctx.fillRect(layout.worldX, layout.worldY, layout.width, layout.height);
      ctx.strokeRect(layout.worldX, layout.worldY, layout.width, layout.height);
    }
    ctx.restore();
  }

  const node = engine.getNode(state.selectedId);
  const layout = node?.cache.layout;
  if (!node || !layout) return;
  ctx.save();
  ctx.strokeStyle = node.visible ? "#2C5D48" : "#B36F52";
  ctx.lineWidth = 1.35 / view.scale;
  ctx.setLineDash([]);
  ctx.strokeRect(layout.worldX, layout.worldY, layout.width, layout.height);
  const handle = 5 / view.scale;
  const points = [
    [layout.worldX, layout.worldY],
    [layout.worldX + layout.width, layout.worldY],
    [layout.worldX, layout.worldY + layout.height],
    [layout.worldX + layout.width, layout.worldY + layout.height],
  ];
  ctx.fillStyle = "#FBFAF6";
  for (const [x, y] of points) {
    ctx.fillRect(x - handle / 2, y - handle / 2, handle, handle);
    ctx.strokeRect(x - handle / 2, y - handle / 2, handle, handle);
  }
  const label = `${node.name}  ${Math.round(layout.width)} × ${Math.round(layout.height)}`;
  ctx.font = `600 ${9 / view.scale}px "Noto Sans SC", "SFMono-Regular", monospace`;
  const textWidth = ctx.measureText(label).width;
  const labelHeight = 17 / view.scale;
  const labelY = layout.worldY - labelHeight - 5 / view.scale;
  ctx.fillStyle = "#2C5D48";
  ctx.fillRect(layout.worldX, labelY, textWidth + 10 / view.scale, labelHeight);
  ctx.fillStyle = "#F8FBF8";
  ctx.textBaseline = "middle";
  ctx.fillText(label, layout.worldX + 5 / view.scale, labelY + labelHeight / 2);
  ctx.restore();
}

function drawStage() {
  if (!engine) return;
  const width = dom.canvasWrap.clientWidth;
  const height = dom.canvasWrap.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (!width || !height) return;
  const ctx = dom.canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.scale, view.scale);
  drawArtboardShadow(ctx, SCENE_SIZE.width, SCENE_SIZE.height);
  drawCommands(ctx, commands);
  drawSelectionOverlay(ctx);
  ctx.restore();
}

function startFlash() {
  flashIds = [...engine.lastInvalidation.ids];
  if (!flashIds.length) return;
  flashUntil = performance.now() + 850;
  cancelAnimationFrame(flashTimer);
  const animate = () => {
    drawStage();
    if (performance.now() < flashUntil) flashTimer = requestAnimationFrame(animate);
    else {
      flashIds = [];
      drawStage();
    }
  };
  flashTimer = requestAnimationFrame(animate);
}

function showToast(message) {
  dom.changeToast.innerHTML = message;
  dom.changeToast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => dom.changeToast.classList.remove("is-visible"), 3600);
}

function renderScene({ toast = "", flash = true } = {}) {
  if (!engine) return;
  if (!engine.getNode(state.selectedId)) state.selectedId = engine.rootId;
  const start = performance.now();
  commands = engine.render();
  drawStage();
  const elapsed = performance.now() - start;
  engine.recordFrameTime(elapsed);
  renderTree();
  updateInspector();
  updateMetrics();
  if (flash) startFlash();
  const metrics = engine.getMetrics();
  if (toast) {
    showToast(
      `${toast}<br><strong>${metrics.candidateCount} 个候选</strong> · 布局 ${metrics.layoutCandidates} / 绘制 ${metrics.paintCandidates} · 本次重算 ${engine.lastUpdate.layoutRecomputes + engine.lastUpdate.paintRecomputes}`,
    );
  }
}

function openCacheDrawer() {
  if (!engine) return;
  const metrics = engine.getMetrics();
  const rows = [];
  for (const node of engine.nodes.values()) {
    const dependencies = engine.getDependencies(node.id);
    const depCount =
      dependencies.layout.length + dependencies.paint.length + dependencies.font.length;
    rows.push(`
      <tr class="${node.id === state.selectedId ? "is-selected" : ""}">
        <td class="drawer-name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</td>
        <td>${escapeHtml(node.id)}</td>
        <td><code>${shortKey(node.cache.layout?.key)}</code></td>
        <td><code>${shortKey(node.cache.paint?.key)}</code></td>
        <td>${depCount}</td>
        <td>${node.cache.layoutDirty ? "dirty" : "clean"} / ${node.cache.paintDirty ? "dirty" : "clean"}</td>
      </tr>
    `);
  }
  const selected = engine.getNode(state.selectedId);
  const dependencies = selected ? engine.getDependencies(selected.id) : { layout: [], paint: [], font: [] };
  const parentKey = selected?.parentId
    ? engine.getNode(selected.parentId)?.cache.layout?.key ?? "—"
    : "root";
  const childKeys = selected
    ? selected.children.map((id) => {
      const child = engine.getNode(id);
      return `${id} → ${shortKey(child?.cache.paint?.key)}`;
    })
    : [];
  dom.cacheDrawerBody.innerHTML = `
    <div class="cache-overview">
      <div><span>节点</span><strong>${metrics.nodeCount}</strong></div>
      <div><span>缓存条目</span><strong>${metrics.cacheEntries}</strong></div>
      <div><span>命中率</span><strong>${percent(metrics.hitRate)}</strong></div>
      <div><span>悬空引用</span><strong>${metrics.danglingCount}</strong></div>
    </div>
    <table class="drawer-table">
      <thead>
        <tr><th>图层</th><th>ID</th><th>LAYOUT</th><th>PAINT</th><th>依赖</th><th>状态</th></tr>
      </thead>
      <tbody>${rows.join("")}</tbody>
    </table>
    <div class="drawer-caption">选中节点的依赖图</div>
    <div class="dependency-map"><span class="accent">${escapeHtml(selected?.name ?? "—")}</span> <span class="accent">${escapeHtml(selected?.id ?? "")}</span>
layout.key  ← parent(${escapeHtml(selected?.parentId ?? "root")}):${shortKey(parentKey)}
paint.key   ← children: ${childKeys.length ? escapeHtml(childKeys.join(", ")) : "none"}
font.source ← ${dependencies.font.length ? escapeHtml(dependencies.font.join(", ")) : escapeHtml(selected?.id ?? "—")}
layout.deps = ${dependencies.layout.length} · paint.deps = ${dependencies.paint.length} · font.deps = ${dependencies.font.length}
<span class="warn">deleted.refs = ${metrics.danglingCount}</span></div>
  `;
  dom.cacheDrawer.classList.add("is-open");
  dom.cacheDrawer.setAttribute("aria-hidden", "false");
}

function closeCacheDrawer() {
  dom.cacheDrawer.classList.remove("is-open");
  dom.cacheDrawer.setAttribute("aria-hidden", "true");
}

function benchmarkModeCard(run, title, subtitle, className = "") {
  return `
    <article class="benchmark-mode ${className}">
      <span class="benchmark-mode-tag">${escapeHtml(run.mode.toUpperCase())}</span>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(subtitle)}</p>
      ${className.includes("is-best")
        ? `<span class="mode-saving">−${Math.round(currentBenchmark.summary.recomputeSaved * 100)}% 重算</span>`
        : ""}
    </article>
  `;
}

function renderBenchmark(result) {
  currentBenchmark = result;
  window.__cacheBenchmark = result;
  const { before, after, boundary, boundaryOracle, checks, summary } = result;
  const cellHash = (value, valid) =>
    `<span class="${valid ? "is-pass" : "is-warn"}">${escapeHtml(value ?? "—")} ${valid ? "✓" : "!"}</span>`;
  dom.benchmarkBody.innerHTML = `
    <div class="benchmark-summary">
      ${benchmarkModeCard(before, "优化前 · 全量失效", "视觉正确，但每次变更重算整棵树；作为性能基线。")}
      ${benchmarkModeCard(after, "优化后 · 增量失效", "布局键引用父键，绘制键引用子键，只失效依赖路径。", "is-best")}
      ${benchmarkModeCard(boundary, "边界参数 · 增量失效", "极限尺寸、88 px 继承字号与隐藏后删除；同时对照全量重建。", "is-boundary")}
    </div>
    <div class="comparison-table-wrap">
      <table class="comparison-table">
        <thead>
          <tr>
            <th>观测项</th>
            <th>优化前</th>
            <th>优化后</th>
            <th>边界参数</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>最终画面签名</th>
            <td class="hash-cell">${cellHash(before.visualHash, checks.visualEqual)}</td>
            <td class="hash-cell">${cellHash(after.visualHash, true)}</td>
            <td class="hash-cell">${cellHash(boundary.visualHash, checks.boundaryVisualEqual)} <small>oracle ${escapeHtml(boundaryOracle.visualHash)}</small></td>
          </tr>
          <tr>
            <th>公开数据签名</th>
            <td class="hash-cell">${cellHash(before.documentHash, checks.documentEqual)}</td>
            <td class="hash-cell">${cellHash(after.documentHash, true)}</td>
            <td class="hash-cell">${cellHash(boundary.documentHash, checks.boundaryDocumentEqual)}</td>
          </tr>
          <tr>
            <th>交互探针签名</th>
            <td class="hash-cell">${cellHash(before.interactionHash, checks.interactionEqual)}</td>
            <td class="hash-cell">${cellHash(after.interactionHash, true)}</td>
            <td class="hash-cell">${cellHash(boundary.interactionHash, checks.boundaryInteractionEqual)}</td>
          </tr>
          <tr>
            <th>异常日志</th>
            <td class="${before.exceptions.length ? "is-warn" : "is-pass"}">${before.exceptions.length} 条</td>
            <td class="${after.exceptions.length ? "is-warn" : "is-pass"}">${after.exceptions.length} 条</td>
            <td class="${boundary.exceptions.length ? "is-warn" : "is-pass"}">${boundary.exceptions.length} 条</td>
          </tr>
          <tr>
            <th>布局 + 绘制重算</th>
            <td>${before.totalRecomputes} <small>L${before.layoutRecomputes} / P${before.paintRecomputes}</small></td>
            <td class="is-pass"><strong>${after.totalRecomputes}</strong> <small>L${after.layoutRecomputes} / P${after.paintRecomputes}</small></td>
            <td>${boundary.totalRecomputes} <small>L${boundary.layoutRecomputes} / P${boundary.paintRecomputes}</small></td>
          </tr>
          <tr>
            <th>累计失效候选</th>
            <td>${before.candidateTotal}</td>
            <td class="is-pass"><strong>${after.candidateTotal}</strong></td>
            <td>${boundary.candidateTotal}</td>
          </tr>
          <tr>
            <th>缓存命中率</th>
            <td>${percent(before.hitRate)}</td>
            <td class="is-pass"><strong>${percent(after.hitRate)}</strong></td>
            <td>${percent(boundary.hitRate)}</td>
          </tr>
          <tr>
            <th>平均帧时间</th>
            <td>${before.avgFrameMs.toFixed(2)} ms</td>
            <td>${after.avgFrameMs.toFixed(2)} ms</td>
            <td>${boundary.avgFrameMs.toFixed(2)} ms</td>
          </tr>
          <tr>
            <th>节点 / 缓存条目</th>
            <td>${before.nodeCount} / ${before.cacheEntries}</td>
            <td>${after.nodeCount} / ${after.cacheEntries}</td>
            <td>${boundary.nodeCount} / ${boundary.cacheEntries}</td>
          </tr>
          <tr>
            <th>悬空引用</th>
            <td class="is-pass">${before.danglingCount}</td>
            <td class="is-pass">${after.danglingCount}</td>
            <td class="is-pass">${boundary.danglingCount}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="benchmark-notes">
      <div class="benchmark-note"><strong>语义等价：</strong>${
        checks.visualEqual && checks.documentEqual && checks.interactionEqual
          ? "最终绘制、公开文档与交互命中结果完全一致。差异只来自缓存失效范围，没有改动既有视觉、交互或数据结构。"
          : "检测到语义差异，请检查失效依赖。"
      }</div>
      <div class="benchmark-note"><strong>边界对照：</strong>${
        result.summary.boundaryEquivalent
          ? `极限参数下增量结果与全量重建一致（${boundaryOracle.visualHash}），异常日志与悬空引用均为 0。`
          : "边界参数与全量重建不一致。"
      }</div>
    </div>
  `;
  dom.benchmarkVerdict.textContent = summary.pass
    ? `验证通过 · 重算减少 ${Math.round(summary.recomputeSaved * 100)}% · 语义零差异`
    : "验证失败 · 请查看异常与签名差异";
  dom.benchmarkVerdict.classList.toggle("is-error", !summary.pass);
}

function runBenchmark() {
  dom.benchmarkBody.innerHTML = `
    <div class="benchmark-loading"><span class="loading-ring"></span>正在运行 3 组固定场景…</div>
  `;
  dom.benchmarkVerdict.textContent = "运行中 · 全量 / 增量 / 边界";
  dom.benchmarkVerdict.classList.remove("is-error");
  requestAnimationFrame(() => {
    window.setTimeout(() => {
      const result = runComparison({ measureText });
      renderBenchmark(result);
    }, 40);
  });
}

function resetEditor({ toast = "已恢复初始画布" } = {}) {
  newEngine();
  state.selectedId = "hero";
  expandAncestors("hero");
  renderScene({ toast });
}

function warmEngineTelemetry() {
  engine.render();
  engine.resetTelemetry();
}

function runScenario(kind) {
  newEngine();
  warmEngineTelemetry();
  const targets = {
    resize: "hero",
    font: "heroTitle",
    visibility: "heroArtwork",
  };
  const messages = {
    resize: "父尺寸已更新：绘制的父键与子树布局键同步重算",
    font: "继承字号已更新：仅字体消费者与其祖先绘制键失效",
    visibility: "装饰层已隐藏：布局缓存保留，仅绘制子树失效",
  };
  if (!targets[kind]) return;
  state.selectedId = targets[kind];
  expandAncestors(targets[kind]);
  applyChange(engine, kind);
  renderScene({ toast: messages[kind] });
}

function applyBoundaryScene() {
  newEngine();
  warmEngineTelemetry();
  applyChange(engine, "resize", { boundary: true });
  applyChange(engine, "font", { boundary: true });
  applyChange(engine, "visibility", { boundary: true });
  state.selectedId = "hero";
  expandAncestors("hero");
  renderScene({ toast: "边界参数已应用：280 × 430 · 88 px · 隐藏装饰层" });
}

function deleteSelected() {
  const node = engine.getNode(state.selectedId);
  if (!node || node.id === engine.rootId) return;
  const parentId = node.parentId;
  const name = node.name;
  const result = engine.deleteNode(node.id);
  state.selectedId = parentId;
  expandAncestors(parentId);
  renderScene({
    toast: `已删除「${name}」及 ${result.deletedCount - 1} 个子节点 · 悬空引用 ${result.danglingCount}`,
  });
}

dom.layerTree.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && state.selectedId) selectNode(state.selectedId);
});

document.querySelectorAll(".scenario-button").forEach((button) => {
  button.addEventListener("click", () => runScenario(button.dataset.scenario));
});

$("#resetButton").addEventListener("click", () => resetEditor());
$("#fitButton").addEventListener("click", fitView);
$("#zoomIn").addEventListener("click", () => {
  const centerX = dom.canvasWrap.clientWidth / 2;
  const centerY = dom.canvasWrap.clientHeight / 2;
  const world = screenToWorld(centerX + dom.canvas.getBoundingClientRect().left, centerY + dom.canvas.getBoundingClientRect().top);
  view.scale = Math.min(1.6, view.scale * 1.12);
  view.offsetX = centerX - world.x * view.scale;
  view.offsetY = centerY - world.y * view.scale;
  dom.zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
  drawStage();
});
$("#zoomOut").addEventListener("click", () => {
  const centerX = dom.canvasWrap.clientWidth / 2;
  const centerY = dom.canvasWrap.clientHeight / 2;
  const rect = dom.canvas.getBoundingClientRect();
  const world = screenToWorld(rect.left + centerX, rect.top + centerY);
  view.scale = Math.max(0.2, view.scale / 1.12);
  view.offsetX = centerX - world.x * view.scale;
  view.offsetY = centerY - world.y * view.scale;
  dom.zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
  drawStage();
});

for (const [key, prop] of [["X", "x"], ["Y", "y"], ["W", "width"], ["H", "height"]]) {
  const input = dom[`prop${key}`];
  input.addEventListener("change", () => {
    const value = Number.parseFloat(input.value);
    if (!Number.isFinite(value)) return;
    engine.updateNode(state.selectedId, { [prop]: value }, `inspector:${prop}`);
    renderScene({ toast: `属性 ${prop} 已更新 · ${engine.lastInvalidation.candidateCount} 个候选` });
  });
}

dom.propFont.addEventListener("input", () => {
  const value = Number(dom.propFont.value);
  dom.fontValue.textContent = `${Math.round(value)} px`;
  const rangeValue = ((value - 32) / (96 - 32)) * 100;
  dom.propFont.style.background =
    `linear-gradient(to right, var(--accent) 0 ${rangeValue}%, #dedbd2 ${rangeValue}% 100%)`;
});

dom.propFont.addEventListener("change", () => {
  const value = Number(dom.propFont.value);
  if (!Number.isFinite(value) || !engine.getNode(state.selectedId)) return;
  const node = engine.getNode(state.selectedId);
  if (node.fontSize === null) {
    engine.updateNode(state.selectedId, { fontSize: value }, "font:inherit");
  } else {
    engine.setFontSize(state.selectedId, value);
  }
  renderScene({ toast: `字号已更新为 ${Math.round(value)} px · 字体消费者局部失效` });
});

dom.toggleVisible.addEventListener("click", () => {
  const node = engine.getNode(state.selectedId);
  if (!node) return;
  engine.setVisible(node.id, !node.visible);
  renderScene({ toast: `图层「${node.name}」${node.visible ? "已显示" : "已隐藏"}` });
});

dom.deleteNode.addEventListener("click", deleteSelected);
$("#inspectCache").addEventListener("click", openCacheDrawer);
$("#closeDrawer").addEventListener("click", closeCacheDrawer);
$("#drawerScrim").addEventListener("click", closeCacheDrawer);

$("#openBenchmark").addEventListener("click", () => {
  if (!dom.benchmarkDialog.open) dom.benchmarkDialog.showModal();
  runBenchmark();
});
$("#closeBenchmark").addEventListener("click", () => dom.benchmarkDialog.close());
$("#rerunBenchmark").addEventListener("click", runBenchmark);
$("#applyBoundary").addEventListener("click", () => {
  dom.benchmarkDialog.close();
  applyBoundaryScene();
});
dom.benchmarkDialog.addEventListener("click", (event) => {
  if (event.target === dom.benchmarkDialog) dom.benchmarkDialog.close();
});

dom.canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 && event.button !== 1) return;
  const world = screenToWorld(event.clientX, event.clientY);
  const hit = engine.hitTest(world.x, world.y);
  if (event.button === 1 || event.altKey || !hit) {
    state.panning = true;
    state.moved = false;
    state.panStart = {
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: view.offsetX,
      offsetY: view.offsetY,
      hit: hit?.id ?? null,
    };
    dom.canvas.classList.add("is-panning");
    dom.canvas.setPointerCapture(event.pointerId);
  } else if (hit) {
    selectNode(hit.id);
  }
});

dom.canvas.addEventListener("pointermove", (event) => {
  if (state.panning && state.panStart) {
    const dx = event.clientX - state.panStart.clientX;
    const dy = event.clientY - state.panStart.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 3) state.moved = true;
    view.offsetX = state.panStart.offsetX + dx;
    view.offsetY = state.panStart.offsetY + dy;
    drawStage();
    return;
  }
  const world = screenToWorld(event.clientX, event.clientY);
  dom.canvas.style.cursor = engine.hitTest(world.x, world.y) ? "pointer" : "grab";
});

dom.canvas.addEventListener("pointerup", (event) => {
  if (state.panning) {
    const start = state.panStart;
    state.panning = false;
    state.panStart = null;
    dom.canvas.classList.remove("is-panning");
    if (dom.canvas.hasPointerCapture(event.pointerId)) {
      dom.canvas.releasePointerCapture(event.pointerId);
    }
    if (!state.moved && !start?.hit) {
      state.selectedId = engine.rootId;
      renderTree();
      updateInspector();
      drawStage();
    }
  }
});

dom.canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = dom.canvas.getBoundingClientRect();
  const world = screenToWorld(event.clientX, event.clientY);
  const nextScale = Math.max(
    0.2,
    Math.min(1.6, view.scale * Math.exp(-event.deltaY * 0.0012)),
  );
  view.scale = nextScale;
  view.offsetX = event.clientX - rect.left - world.x * nextScale;
  view.offsetY = event.clientY - rect.top - world.y * nextScale;
  dom.zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
  drawStage();
}, { passive: false });

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target?.isContentEditable;
  if (typing) return;
  if ((event.key === "Backspace" || event.key === "Delete") && !dom.benchmarkDialog.open) {
    event.preventDefault();
    deleteSelected();
  }
  if (event.key === "Escape") closeCacheDrawer();
});

const resizeObserver = new ResizeObserver(() => resizeCanvas());
resizeObserver.observe(dom.canvasWrap);

window.__lattice = {
  get engine() {
    return engine;
  },
  get commands() {
    return commands;
  },
  get benchmark() {
    return currentBenchmark;
  },
  selectNode,
  runScenario,
  runBenchmark,
  applyBoundaryScene,
  resetEditor,
  view,
};

async function bootstrap() {
  try {
    await Promise.all([
      document.fonts.load('400 16px "Noto Sans SC"'),
      document.fonts.load('700 16px "Noto Sans SC"'),
      document.fonts.load('400 16px "Noto Serif SC"'),
    ]);
    await document.fonts.ready;
  } catch (error) {
    console.warn("Font loading failed; using local fallback.", error);
  }
  newEngine();
  hasFit = false;
  resizeCanvas();
  renderScene({ flash: false });
  fitView();
}

bootstrap();
