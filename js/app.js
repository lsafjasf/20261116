(function () {
  "use strict";

  const Core = window.TopoCore;
  const STORAGE_KEY = "topoforge.project.v2";
  const MAX_EVENTS = 120;
  const MAX_HISTORY = 40;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const state = {
    project: null,
    filter: Core.clone(Core.DEFAULT_FILTER),
    selectedNodeId: null,
    selectedLinkId: null,
    selectedRouteId: "route-primary",
    zoom: 1,
    history: [],
    future: [],
    events: [],
    qualityLogs: [],
    verification: null,
    debugTab: "events",
    drag: null,
    dragSnapshot: null,
    lastPathStats: null,
    svgFontDataUri: "",
    lastRenderMetric: null,
    savingTimer: null
  };

  const svg = $("#topologySvg");
  const layers = {
    zones: $("#zoneLayer"),
    edges: $("#edgeLayer"),
    nodes: $("#nodeLayer"),
    overlay: $("#overlayLayer")
  };

  function escapeXml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function nowTime() {
    return new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }

  function shortTime() {
    return new Date().toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function addEvent(level, code, text) {
    state.events.push({ time: nowTime(), level, code, text });
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  }

  function showToast(title, message, tone) {
    const stack = $("#toastStack");
    while (stack.children.length >= 3) stack.firstElementChild.remove();
    const item = document.createElement("div");
    item.className = `toast ${tone || "ok"}`;
    item.innerHTML = `<span class="toast-mark"></span><div><strong>${escapeXml(title)}</strong>${escapeXml(message)}</div>`;
    stack.appendChild(item);
    setTimeout(() => item.remove(), 4200);
  }

  function cloneProject() {
    return Core.clone(state.project);
  }

  function currentVisible() {
    return Core.visibleTopology(state.project, state.filter);
  }

  function snapshotForHistory() {
    return cloneProject();
  }

  function pushHistory(snapshot) {
    state.history.push(snapshot || snapshotForHistory());
    if (state.history.length > MAX_HISTORY) state.history.shift();
    state.future = [];
  }

  function applySnapshot(snapshot, fromRedo) {
    const nextVersion = state.project.dataVersion + 1;
    state.project = Core.clone(snapshot);
    state.project.dataVersion = nextVersion;
    state.project.savedAt = new Date().toISOString();
    if (state.selectedNodeId && !state.project.nodes.some((node) => node.id === state.selectedNodeId)) {
      state.selectedNodeId = null;
    }
    if (state.selectedLinkId && !state.project.links.some((link) => link.id === state.selectedLinkId)) {
      state.selectedLinkId = null;
    }
    persistProject(true);
    addEvent("ok", fromRedo ? "REDO" : "UNDO", `恢复 ${state.project.nodes.length} 节点 / ${state.project.links.length} 链路 · v${nextVersion}`);
    renderAll();
  }

  function persistProject(silent) {
    try {
      const payload = Core.serializeProject(state.project, state.filter);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      const autosave = $("#autosaveState");
      autosave.classList.add("saving");
      autosave.querySelector("span:last-child").textContent = `保存于 ${shortTime()}`;
      clearTimeout(state.savingTimer);
      state.savingTimer = setTimeout(() => autosave.classList.remove("saving"), 380);
      if (!silent) addEvent("ok", "SAVE", `工程已写入本地存储 · v${state.project.dataVersion}`);
      return payload;
    } catch (error) {
      addEvent("err", "SAVE", error.message);
      return null;
    }
  }

  function markChanged(code, text) {
    state.project.dataVersion += 1;
    state.project.savedAt = new Date().toISOString();
    persistProject(true);
    addEvent("ok", code, text);
  }

  function loadSample(sampleId, options) {
    const sample = window.TOPO_SAMPLES.find((item) => item.id === sampleId) || window.TOPO_SAMPLES[0];
    state.project = Core.buildProjectFromSample(sample, 1);
    state.filter = Core.clone(Core.DEFAULT_FILTER);
    state.selectedNodeId = null;
    state.selectedLinkId = null;
    state.selectedRouteId = state.project.routes.find((route) => route.kind === "primary")?.id || state.project.routes[0]?.id;
    state.history = [];
    state.future = [];
    state.qualityLogs = state.project.qualityLogs.slice();
    state.verification = null;
    state.events = [];
    addEvent("ok", "LOAD", `${sample.code} 样例已载入：${state.project.nodes.length} 节点 / ${state.project.links.length} 链路`);
    state.qualityLogs.forEach((entry) => {
      addEvent(entry.level, entry.code, entry.text);
    });
    const metrics = Core.graphMetrics(state.project.nodes, state.project.links);
    addEvent("info", "VERSION", `数据版本初始化 v${state.project.dataVersion} · 指纹 ${metrics.fingerprint}`);
    if (!options || !options.keepFilter) {
      $("#sampleSelect").value = sample.id;
    }
    persistProject(true);
    renderAll();
    if (!options || !options.silent) {
      showToast(`已载入样例 ${sample.code}`, `${metrics.nodeCount} 节点 · ${metrics.linkCount} 链路 · 清洗日志已写入调试面板`);
    }
  }

  function restoreProject() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      addEvent("info", "BOOT", "无本地工程，载入固定样例 A");
      loadSample("sample-a", { silent: true });
      return;
    }
    try {
      const hydrated = Core.hydrateProject(JSON.parse(stored));
      state.project = hydrated;
      state.filter = Core.normalizeFilter(hydrated.filter);
      state.selectedRouteId = state.project.routes.find((route) => route.kind === "primary")?.id || state.project.routes[0]?.id;
      state.qualityLogs = state.project.qualityLogs.slice();
      addEvent("ok", "BOOT", `本地工程恢复：${state.project.nodes.length} 节点 / ${state.project.links.length} 链路 · v${state.project.dataVersion}`);
      state.qualityLogs.slice(-12).forEach((entry) => addEvent(entry.level, entry.code, entry.text));
      const sample = window.TOPO_SAMPLES.find((item) => item.id === state.project.sourceSampleId);
      $("#sampleSelect").value = sample ? sample.id : "";
      renderAll();
    } catch (error) {
      addEvent("err", "BOOT", `本地工程损坏：${error.message}；回退到样例 A`);
      localStorage.removeItem(STORAGE_KEY);
      loadSample("sample-a", { silent: true });
    }
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function safeFilename(name) {
    return String(name || "topology").replace(/[\\/:*?"<>|\s]+/g, "-");
  }

  function nodeIconMarkup(type) {
    if (type === "gateway") {
      return '<circle cx="0" cy="0" r="7.5"/><path d="M-7 0H7M0-7c3.7 4 3.7 10 0 14M0-7c-3.7 4-3.7 10 0 14"/>';
    }
    if (type === "router") {
      return '<path d="M-9-4H8M8-4 4-8M8-4 4 0M9 5H-8M-8 5l4-4M-8 5l4 4"/>';
    }
    return '<rect x="-8" y="-7" width="16" height="12" rx="2"/><path d="M-4 9H4M0 5v4M-5 2.5h4"/>';
  }

  function renderZones(nodes) {
    const groups = new Map();
    nodes.forEach((node) => {
      if (!groups.has(node.zone)) groups.set(node.zone, []);
      groups.get(node.zone).push(node);
    });
    layers.zones.innerHTML = Array.from(groups.entries())
      .map(([zone, items]) => {
        const minX = Math.max(7, Math.min(...items.map((node) => node.x)) - 78);
        const minY = Math.max(7, Math.min(...items.map((node) => node.y)) - 52);
        const maxX = Math.min(1193, Math.max(...items.map((node) => node.x)) + 78);
        const maxY = Math.min(753, Math.max(...items.map((node) => node.y)) + 53);
        return `<g class="zone-group">
          <rect class="zone" x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="12"/>
          <text class="zone-label" x="${minX + 10}" y="${minY + 16}">${escapeXml(zone)}</text>
        </g>`;
      })
      .join("");
  }

  function renderGraph(visible, pathResult, routeAnalyses) {
    const selectedRoute = routeAnalyses.find((route) => route.id === state.selectedRouteId) || null;
    const activeRoute = selectedRoute && selectedRoute.available ? selectedRoute : null;
    const routeNodeIds = new Set(activeRoute ? activeRoute.nodeIds : []);
    const routeLinkIds = new Set(activeRoute ? activeRoute.linkIds : []);
    const routeColor = activeRoute && activeRoute.kind === "backup" ? "var(--blue)" : "var(--mint)";
    const selectedNode = visible.nodes.some((node) => node.id === state.selectedNodeId) ? state.selectedNodeId : null;
    const selectedLink = visible.links.some((link) => link.id === state.selectedLinkId) ? state.selectedLinkId : null;

    renderZones(visible.nodes);
    layers.edges.innerHTML = visible.links
      .map((link) => {
        const plan = pathResult.paths.get(link.id);
        if (!plan) return "";
        const onPath = routeLinkIds.has(link.id);
        const classes = ["edge-group"];
        if (selectedLink === link.id) classes.push("selected");
        if (onPath) classes.push("path-edge");
        if (activeRoute && !onPath) classes.push("dimmed");
        const label = `${Core.formatCapacity(link.capacityMbps)} · ${Core.formatLatency(link.latencyMs)}`;
        const flow = onPath ? `<path class="edge-flow" d="${plan.pathText}"/>` : "";
        return `<g id="edge-${escapeXml(link.id)}" class="${classes.join(" ")}" data-link-id="${escapeXml(link.id)}" style="--route-color:${routeColor}">
          <title>${escapeXml(link.id)} · ${escapeXml(link.source)} → ${escapeXml(link.target)}</title>
          <path class="edge-hit" d="${plan.pathText}"/>
          <path class="edge-line" d="${plan.pathText}"/>
          ${flow}
          <circle class="edge-anchor" cx="${plan.points[0].x}" cy="${plan.points[0].y}" r="2.4"/>
          <circle class="edge-anchor" cx="${plan.points[plan.points.length - 1].x}" cy="${plan.points[plan.points.length - 1].y}" r="2.4"/>
          <g class="edge-label-group" transform="translate(${Math.round(plan.label.x)} ${Math.round(plan.label.y)})">
            <rect class="edge-label-bg" x="-54" y="-9" width="108" height="18" rx="5"/>
            <text class="edge-label" x="0" y="3" text-anchor="middle"><tspan class="capacity">${Core.formatCapacity(link.capacityMbps)}</tspan><tspan> · </tspan><tspan class="latency">${Core.formatLatency(link.latencyMs)}</tspan></text>
          </g>
        </g>`;
      })
      .join("");

    layers.nodes.innerHTML = visible.nodes
      .map((node) => {
        const onPath = routeNodeIds.has(node.id);
        const classes = ["node-group"];
        if (selectedNode === node.id) classes.push("selected");
        if (onPath) {
          classes.push("path-node");
          classes.push(activeRoute.kind === "backup" ? "backup-node" : "primary-node");
        }
        if (activeRoute && !onPath) classes.push("dimmed");
        const rank = onPath ? activeRoute.nodeIds.indexOf(node.id) + 1 : 0;
        return `<g id="node-${escapeXml(node.id)}" class="${classes.join(" ")}" data-node-id="${escapeXml(node.id)}" data-type="${node.type}" transform="translate(${Math.round(node.x)} ${Math.round(node.y)})">
          <title>${escapeXml(node.name)} · ${escapeXml(node.id)}</title>
          <rect class="node-card" x="-64" y="-29" width="128" height="58" rx="9" filter="url(#nodeShadow)"/>
          <rect class="node-accent" x="-60" y="-17" width="3" height="34" rx="1.5"/>
          <rect class="node-icon-bg" x="-48" y="-14" width="30" height="28" rx="7"/>
          <g class="node-icon" transform="translate(-33 0)">${nodeIconMarkup(node.type)}</g>
          <text class="node-name" x="-8" y="-5">${escapeXml(node.name.length > 13 ? node.name.slice(0, 12) + "…" : node.name)}</text>
          <text class="node-id" x="-8" y="8">${escapeXml(node.id)}</text>
          <circle class="node-status-ring ${node.status === "degraded" ? "degraded" : ""}" cx="52" cy="-14" r="4"/>
          <circle class="node-status ${node.status === "degraded" ? "degraded" : ""}" cx="52" cy="-14" r="1.7"/>
          <circle class="node-port" cx="-68" cy="0" r="2.7"/>
          <circle class="node-port" cx="68" cy="0" r="2.7"/>
          ${onPath ? `<g transform="translate(-63 -28)"><circle class="node-path-rank" r="8"/><text class="node-path-rank-text" x="0" y="2.5" text-anchor="middle">${rank}</text></g>` : ""}
        </g>`;
      })
      .join("");

    if (!visible.nodes.length) {
      layers.nodes.innerHTML = `<g transform="translate(600 370)">
        <circle r="27" fill="none" stroke="#2a4053" stroke-dasharray="4 5"/>
        <text x="0" y="4" fill="#657c90" font-family="sans-serif" font-size="11" text-anchor="middle">当前筛选无匹配对象</text>
        <text x="0" y="23" fill="#40576a" font-family="monospace" font-size="8" text-anchor="middle">RESET FILTER TO RESTORE VIEW</text>
      </g>`;
    }
    state.lastPathStats = pathResult.stats;
    state.pathResult = pathResult;
  }

  function renderRoutes() {
    const routes = state.routeAnalyses || [];
    const backupTotal = routes.filter((route) => route.kind === "backup").length;
    $("#routeCountBadge").textContent = String(routes.length);
    $("#routeList").innerHTML = routes
      .map((route) => {
        const active = route.id === state.selectedRouteId;
        const backupIndex = route.kind === "backup" ? routes.filter((item) => item.kind === "backup").indexOf(route) + 1 : 0;
        const kindText = route.kind === "primary" ? "PRIMARY" : `BACKUP ${backupIndex}/${backupTotal}`;
        const stateText = route.available
          ? `可达 · 瓶颈 ${Core.formatCapacity(route.bottleneck)} · 自动绕行`
          : route.reason;
        return `<button class="route-card ${route.kind} ${active ? "active" : ""} ${route.available ? "" : "unavailable"}" type="button" data-route-id="${escapeXml(route.id)}" aria-pressed="${active}">
          <div class="route-top">
            <span class="route-name">${escapeXml(route.name)}</span>
            <span class="route-kind ${route.kind}">${kindText}</span>
          </div>
          <div class="route-meta">
            <strong>${route.available ? `${route.totalLatency.toFixed(1)} ms` : "— ms"}</strong>
            <span>${route.hops} 跳</span>
            <div class="route-hop-dots">${route.nodeIds.map(() => '<i class="on"></i>').join("")}</div>
          </div>
          <div class="route-state ${route.available ? "ok" : "blocked"}"><span>${route.available ? "●" : "○"}</span>${escapeXml(stateText)}</div>
        </button>`;
      })
      .join("");
  }

  function renderFilters(visible) {
    $$(".type-chip").forEach((button) => {
      button.classList.toggle("active", Boolean(state.filter.types[button.dataset.type]));
    });
    const range = $("#capacityFilter");
    range.value = String(state.filter.minCapacity);
    range.style.setProperty("--range-fill", `${(state.filter.minCapacity / Number(range.max)) * 100}%`);
    $("#capacityFilterLabel").textContent = state.filter.minCapacity
      ? `≥ ${Core.formatCapacity(state.filter.minCapacity)}`
      : "不限";
    const summary = Core.filterLabel(state.filter, visible, state.project);
    $("#filterSummary").textContent = summary;
    $("#filterSummary").title = summary;
    $("#contractFilter").textContent = summary;
    $("#contractFilter").title = summary;
    $("#searchInput").value = state.filter.query;
    const quality = state.project.quality;
    const sample = window.TOPO_SAMPLES.find((item) => item.id === state.project.sourceSampleId);
    $("#sampleStatus").textContent = state.project.sampleCode || sample?.code || "I";
    $("#qualityMini").innerHTML = [
      `<span class="quality-pill">有效 <b>${state.project.nodes.length}/${state.project.links.length}</b></span>`,
      `<span class="quality-pill ${quality.duplicateNodes + quality.duplicateLinks ? "warn" : "ok"}">去重 <b>${quality.duplicateNodes + quality.duplicateLinks}</b></span>`,
      `<span class="quality-pill ${quality.nullFields ? "warn" : "ok"}">空值 <b>${quality.nullFields}</b></span>`,
      `<span class="quality-pill ${quality.anomalies ? "warn" : "ok"}">异常 <b>${quality.anomalies}</b></span>`,
      `<span class="quality-pill">丢弃 <b>${quality.droppedRecords}</b></span>`
    ].join("");
  }

  function statusBadge(status) {
    return `<span class="status-badge" style="color:${status === "degraded" ? "var(--amber)" : "var(--mint)"}"><i></i>${status === "degraded" ? "降级" : "在线"}</span>`;
  }

  function nodeDegree(nodeId) {
    return state.project.links.filter((link) => link.source === nodeId || link.target === nodeId).length;
  }

  function renderInspector() {
    const selectedNode = state.project.nodes.find((node) => node.id === state.selectedNodeId);
    const selectedLink = state.project.links.find((link) => link.id === state.selectedLinkId);
    const toolbar = $("#selectionToolbar");
    const context = $("#contextChip");
    if (!selectedNode && !selectedLink) {
      toolbar.hidden = true;
      context.textContent = "未选择";
      $("#inspectorContent").className = "inspector-empty";
      $("#inspectorContent").innerHTML = `
        <div class="empty-orbit"><span></span><i></i></div>
        <p>选择节点或链路查看详情</p>
        <small>Delete 删除节点及其相连链路</small>`;
      return;
    }
    toolbar.hidden = false;
    if (selectedNode) {
      const degree = nodeDegree(selectedNode.id);
      const visible = currentVisible();
      const visibleDegree = visible.links.filter((link) => link.source === selectedNode.id || link.target === selectedNode.id).length;
      context.textContent = "节点";
      $("#selectionKind").textContent = "节点";
      $("#selectionName").textContent = selectedNode.name;
      $("#inspectorContent").className = "";
      $("#inspectorContent").innerHTML = `
        <div class="inspector-head">
          <div class="inspector-glyph ${selectedNode.type}"><svg viewBox="0 0 24 24">${nodeIconMarkup(selectedNode.type)}</svg></div>
          <div class="inspector-head-text"><strong>${escapeXml(selectedNode.name)}</strong><span>${escapeXml(selectedNode.id)} · ${Core.TYPE_LABELS[selectedNode.type]}</span></div>
        </div>
        <dl class="detail-list">
          <div class="detail-row"><dt>运行状态</dt><dd class="ok">${statusBadge(selectedNode.status)}</dd></div>
          <div class="detail-row"><dt>所属区域</dt><dd>${escapeXml(selectedNode.zone)}</dd></div>
          <div class="detail-row"><dt>管理地址</dt><dd>${escapeXml(selectedNode.ip)}</dd></div>
          <div class="detail-row"><dt>设备型号</dt><dd>${escapeXml(selectedNode.model)}</dd></div>
          <div class="detail-row"><dt>相连链路</dt><dd>${degree} 条${visibleDegree !== degree ? ` · 可见 ${visibleDegree}` : ""}</dd></div>
          <div class="detail-row"><dt>画布坐标</dt><dd>${Math.round(selectedNode.x)}, ${Math.round(selectedNode.y)}</dd></div>
        </dl>
        <div class="inspector-actions"><button class="mini-button" data-inspector-action="focus">定位节点</button><button class="mini-button danger" data-inspector-action="delete-node">删除节点</button></div>`;
    } else {
      const source = state.project.nodes.find((node) => node.id === selectedLink.source);
      const target = state.project.nodes.find((node) => node.id === selectedLink.target);
      const plan = state.pathResult?.paths.get(selectedLink.id);
      context.textContent = "链路";
      $("#selectionKind").textContent = "链路";
      $("#selectionName").textContent = selectedLink.id;
      $("#inspectorContent").className = "";
      $("#inspectorContent").innerHTML = `
        <div class="inspector-head">
          <div class="inspector-glyph router"><svg viewBox="0 0 24 24"><path d="M3 8h18M18 8l-4-4M18 8l-4 4M21 16H3M6 16l4-4M6 16l4 4"/></svg></div>
          <div class="inspector-head-text"><strong>${escapeXml(source?.name || selectedLink.source)} ↔ ${escapeXml(target?.name || selectedLink.target)}</strong><span>${escapeXml(selectedLink.id)}</span></div>
        </div>
        <dl class="detail-list">
          <div class="detail-row"><dt>链路容量</dt><dd>${Core.formatCapacity(selectedLink.capacityMbps)} · ${selectedLink.capacityMbps} Mbps</dd></div>
          <div class="detail-row"><dt>单向延迟</dt><dd>${Core.formatLatency(selectedLink.latencyMs)}</dd></div>
          <div class="detail-row"><dt>源 / 宿</dt><dd>${escapeXml(selectedLink.source)} → ${escapeXml(selectedLink.target)}</dd></div>
          <div class="detail-row"><dt>避障状态</dt><dd class="${plan?.detoured ? "warn" : "ok"}">${plan?.detoured ? `绕行 · ${plan.bendCount} 拐点` : "直线可达"}</dd></div>
          <div class="detail-row"><dt>搜索节点</dt><dd>${plan?.iterations || 0} iterations</dd></div>
        </dl>
        <div class="inspector-actions"><button class="mini-button" data-inspector-action="focus-link">定位链路</button><button class="mini-button danger" data-inspector-action="delete-link">删除链路</button></div>`;
    }
  }

  function renderPathAnalysis() {
    const route = (state.routeAnalyses || []).find((item) => item.id === state.selectedRouteId);
    const container = $("#pathAnalysis");
    const chip = $("#pathLiveChip");
    if (!route) {
      chip.classList.remove("active");
      chip.innerHTML = "<i></i>READY";
      container.className = "path-analysis-empty";
      container.innerHTML = `<div class="path-prompt"><svg viewBox="0 0 40 40"><circle cx="8" cy="20" r="4"/><circle cx="32" cy="20" r="4"/><path d="M12 20h8m0-5 5 5-5 5m0-5h8"/></svg><span>从左侧选择一条路径</span></div>`;
      return;
    }
    chip.classList.toggle("active", route.available);
    chip.innerHTML = `<i></i>${route.available ? "HIGHLIGHT ON" : "BLOCKED"}`;
    container.className = "path-summary";
    const nodes = route.nodeIds.map((id) => state.project.nodes.find((node) => node.id === id)).filter(Boolean);
    const chain = nodes.map((node, index) => `${index ? '<span class="path-arrow">›</span>' : ""}<span class="path-node-pill">${escapeXml(node.id)}</span>`).join("");
    container.innerHTML = `
      <div class="path-summary-head">
        <div class="path-summary-name">${escapeXml(route.name)}<small>${route.kind === "primary" ? "PRIMARY ROUTE" : "STANDBY ROUTE"} · ${escapeXml(route.id)}</small></div>
        <div class="latency-hero"><strong>${route.available ? route.totalLatency.toFixed(1) : "—"}</strong><span>END-TO-END MS</span></div>
      </div>
      <div class="path-metrics">
        <div><span>节点数</span><strong>${nodes.length}</strong></div>
        <div><span>链路跳数</span><strong>${route.hops}</strong></div>
        <div><span>瓶颈容量</span><strong>${route.available ? Core.formatCapacity(route.bottleneck) : "—"}</strong></div>
      </div>
      <div class="path-route-chain">${chain}</div>
      ${route.available ? "" : `<div class="path-warning">${escapeXml(route.reason)}</div>`}`;
  }

  function renderContract(visible) {
    const metrics = Core.graphMetrics(visible.nodes, visible.links);
    const summary = Core.filterLabel(state.filter, visible, state.project);
    $("#headerProjectName").textContent = state.project.name;
    $("#headerVersion").textContent = String(state.project.dataVersion);
    $("#contractVersion").textContent = `v${state.project.dataVersion} · ${state.project.sampleCode || "I"}`;
    $("#auditNodes").textContent = String(metrics.nodeCount);
    $("#auditLinks").textContent = String(metrics.linkCount);
    $("#auditDegrees").textContent = String(metrics.endpointCount);
    $("#auditHash").textContent = metrics.fingerprint.slice(0, 6);
    $("#auditHash").title = metrics.fingerprint;
    $("#stageObjectCount").textContent = `${visible.nodes.length}/${state.project.nodes.length} 节点 · ${visible.links.length}/${state.project.links.length} 链路`;
    $("#debugHash").textContent = `fp · ${metrics.fingerprint}`;
    $("#debugFootText").textContent = `trace · ${state.events.length} events · ${summary}`;
    $("#undoBtn").disabled = state.history.length === 0;
    $("#redoBtn").disabled = state.future.length === 0;
    $("#zoomValue").textContent = `${Math.round(state.zoom * 100)}%`;
  }

  function renderDebug() {
    const eventView = $("#debug-events");
    eventView.innerHTML = state.events.length
      ? state.events
          .map(
            (entry) => `<div class="log-line">
              <span class="log-time">${entry.time}</span>
              <span class="log-kind ${entry.level}">${escapeXml(entry.code)}</span>
              <span class="log-message">${escapeXml(entry.text)}</span>
            </div>`
          )
          .join("")
      : `<div class="debug-empty"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h13"/></svg>等待事件</div>`;
    eventView.scrollTop = eventView.scrollHeight;
    $("#eventCount").textContent = String(state.events.length);
    $("#qualityCount").textContent = String(state.qualityLogs.length);

    const quality = state.project.quality;
    $("#debug-quality").innerHTML = `
      <table class="quality-table">
        <thead><tr><th>阶段</th><th>记录</th><th>数值</th></tr></thead>
        <tbody>
          <tr><td>原始输入</td><td>nodes / links</td><td class="num">${quality.rawNodes} / ${quality.rawLinks}</td></tr>
          <tr><td>去重</td><td>节点 / 链路</td><td class="num">${quality.duplicateNodes} / ${quality.duplicateLinks}</td></tr>
          <tr class="highlight"><td>空值处理</td><td>字段插补</td><td class="num">${quality.nullFields}</td></tr>
          <tr class="highlight"><td>异常修正</td><td>坐标、容量、延迟</td><td class="num">${quality.anomalies}</td></tr>
          <tr><td>无效丢弃</td><td>断链 / 自环</td><td class="num">${quality.invalidLinks}</td></tr>
          <tr><td>有效输出</td><td>nodes / links</td><td class="num">${state.project.nodes.length} / ${state.project.links.length}</td></tr>
          <tr><td>中位数基线</td><td>Mbps / ms</td><td class="num">${state.project.capacityFallback} / ${state.project.latencyFallback}</td></tr>
        </tbody>
      </table>
      ${state.qualityLogs
        .map(
          (entry) => `<div class="log-line"><span class="log-time">CLEAN</span><span class="log-kind ${entry.level}">${escapeXml(entry.code)}</span><span class="log-message">${escapeXml(entry.text)}</span></div>`
        )
        .join("")}`;

    renderVerification();
  }

  function renderVerification() {
    const container = $("#debug-verify");
    const verification = state.verification;
    $("#verifyCount").textContent = verification ? String(verification.steps.length) : "0";
    if (!verification) {
      container.innerHTML = `
        <div class="debug-empty">
          <svg viewBox="0 0 24 24"><path d="M12 3 20 6.5v5.2c0 4.5-3.2 7.2-8 8.8-4.8-1.6-8-4.3-8-8.8V6.5L12 3Z"/><path d="m8.5 12 2.4 2.4 4.6-4.6"/></svg>
          <span>点击“运行完整性验证”执行删除、撤销、重载与导出一致性检查</span>
        </div>`;
      return;
    }
    const passedCount = verification.steps.filter((step) => step.pass).length;
    const cards = [
      ["备用路径", verification.workflow?.backupCount != null ? `${verification.workflow.backupCount} 条` : "—", verification.workflow?.backupsAvailable],
      ["删除同步", verification.workflow?.deletedIncidentLinks != null ? `${verification.workflow.deletedIncidentLinks} 链路` : "—", verification.workflow?.deletePass],
      ["重载一致", verification.workflow?.reloadPass ? "指纹一致" : "—", verification.workflow?.reloadPass],
      ["JSON 对象", verification.exportAudit ? `${verification.exportAudit.jsonNodes}/${verification.exportAudit.jsonLinks}` : "—", verification.exportAudit?.countsMatch],
      ["SVG 对象", verification.exportAudit ? `${verification.exportAudit.svgNodes}/${verification.exportAudit.svgLinks}` : "—", verification.exportAudit?.countsMatch],
      ["关键数值", verification.exportAudit?.valuesMatch ? "完全一致" : "—", verification.exportAudit?.valuesMatch]
    ];
    container.innerHTML = `
      <div class="verify-summary">
        <strong>${verification.passed ? "全部检查通过" : "存在失败项"}</strong>
        <span>${passedCount}/${verification.steps.length} checks</span>
        <span class="verify-time">${new Date(verification.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}</span>
      </div>
      <div class="verify-grid">
        ${cards
          .map(
            ([label, value, pass]) => `<div class="verify-card ${pass ? "pass" : ""}"><div class="v-label">${label}</div><div class="v-value">${escapeXml(value)}</div></div>`
          )
          .join("")}
      </div>
      ${verification.steps
        .map(
          (step) => `<div class="verify-step ${step.pass ? "" : "fail"}">
            <span class="step-tag">${escapeXml(step.tag)}</span>
            <span class="step-text">${escapeXml(step.text)}${step.detail ? ` <code>${escapeXml(step.detail)}</code>` : ""}</span>
            <span class="step-status">${step.pass ? "PASS" : "FAIL"}</span>
          </div>`
        )
        .join("")}`;
  }

  function recalculateRoutes() {
    state.routeAnalyses = state.project.routes.map((route) => Core.analyzeRoute(state.project, route, state.filter));
    if (!state.routeAnalyses.some((route) => route.id === state.selectedRouteId)) {
      state.selectedRouteId = state.routeAnalyses.find((route) => route.kind === "primary")?.id || state.routeAnalyses[0]?.id || null;
    }
  }

  function renderAll() {
    const visible = currentVisible();
    if (state.selectedNodeId && !visible.nodes.some((node) => node.id === state.selectedNodeId)) {
      state.selectedNodeId = null;
    }
    if (state.selectedLinkId && !visible.links.some((link) => link.id === state.selectedLinkId)) {
      state.selectedLinkId = null;
    }
    recalculateRoutes();
    const pathResult = Core.planLinkPaths(visible.nodes, visible.links);
    renderGraph(visible, pathResult, state.routeAnalyses);
    renderRoutes();
    renderFilters(visible);
    renderInspector();
    renderPathAnalysis();
    renderContract(visible);
    renderDebug();
  }

  function applyZoom(nextZoom) {
    state.zoom = Math.max(0.75, Math.min(1.8, nextZoom));
    if (state.zoom === 1) {
      svg.setAttribute("viewBox", "0 0 1200 760");
    } else {
      const width = 1200 / state.zoom;
      const height = 760 / state.zoom;
      svg.setAttribute("viewBox", `${(1200 - width) / 2} ${(760 - height) / 2} ${width} ${height}`);
    }
    $("#zoomValue").textContent = `${Math.round(state.zoom * 100)}%`;
  }

  function svgPoint(event) {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const matrix = svg.getScreenCTM();
    return matrix ? point.matrixTransform(matrix.inverse()) : point;
  }

  function buildTopologyJsonString() {
    const payload = Core.createTopologyExport(state.project, state.filter);
    return JSON.stringify(payload, null, 2);
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize)));
    }
    return window.btoa(chunks.join(""));
  }

  async function loadExportFont() {
    try {
      const response = await fetch("assets/fonts/topoforge-ui.woff2");
      if (!response.ok) return;
      state.svgFontDataUri = arrayBufferToBase64(await response.arrayBuffer());
    } catch (error) {
      addEvent("warn", "FONT", `SVG 字体嵌入不可用：${error.message}`);
    }
  }

  function buildSvgString() {
    const visible = currentVisible();
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", "1200");
    clone.setAttribute("height", "760");
    clone.setAttribute("viewBox", "0 0 1200 760");
    clone.querySelectorAll(".edge-flow, .node-path-rank, .node-path-rank-text").forEach((element) => element.remove());
    clone.querySelectorAll(".edge-group, .node-group").forEach((element) => {
      element.classList.remove("selected", "path-edge", "dimmed", "path-node", "primary-node", "backup-node", "dragging");
    });
    const overlay = clone.querySelector("#overlayLayer");
    if (overlay) overlay.innerHTML = "";

    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    let styleText = Core.buildSvgExportStyle();
    if (state.svgFontDataUri) {
      styleText =
        `@font-face{font-family:"TopoExportSC";src:url(data:font/woff2;base64,${state.svgFontDataUri}) format("woff2")}` +
        styleText.replace(/font-family:(sans-serif|monospace)/g, 'font-family:"TopoExportSC",sans-serif');
    }
    style.textContent = styleText;
    const defs = clone.querySelector("defs");
    if (defs) defs.insertAdjacentElement("afterend", style);
    else clone.insertBefore(style, clone.firstChild);

    const metadata = document.createElementNS("http://www.w3.org/2000/svg", "metadata");
    metadata.textContent = JSON.stringify({
      generator: "TopoForge Workbench 2.4",
      dataVersion: state.project.dataVersion,
      filter: Core.filterLabel(state.filter, visible, state.project),
      nodeCount: visible.nodes.length,
      linkCount: visible.links.length,
      exportScope: "当前筛选后的全拓扑"
    });
    clone.insertBefore(metadata, clone.firstChild);

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${state.project.name} · 网络拓扑`;
    clone.insertBefore(title, metadata);

    const background = clone.querySelector('rect[width="1200"][height="760"]');
    if (background) {
      background.setAttribute("fill", "#0a1119");
      const grid = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      grid.setAttribute("width", "1200");
      grid.setAttribute("height", "760");
      grid.setAttribute("fill", "url(#majorGrid)");
      background.insertAdjacentElement("afterend", grid);
    }

    const footer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    footer.innerHTML = `
      <g transform="translate(16 738)">
        <circle cx="3" cy="-2" r="2" fill="#52e0b0"/>
        <text class="export-title" x="11" y="0">TOPOFORGE · ${escapeXml(state.project.name)}</text>
        <text class="export-meta" x="408" y="0">v${state.project.dataVersion} · ${visible.nodes.length} NODES / ${visible.links.length} LINKS · FILTERED FULL TOPOLOGY</text>
      </g>`;
    clone.appendChild(footer);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${clone.outerHTML}`;
  }

  function exportAudit(jsonString, svgString) {
    const visible = currentVisible();
    let payload = null;
    let svgDocument = null;
    try {
      payload = JSON.parse(jsonString);
      svgDocument = new DOMParser().parseFromString(svgString, "image/svg+xml");
    } catch (error) {
      return {
        passed: false,
        error: error.message,
        countsMatch: false,
        valuesMatch: false,
        versionMatch: false,
        jsonNodes: 0,
        jsonLinks: 0,
        svgNodes: 0,
        svgLinks: 0
      };
    }
    const svgNodes = svgDocument.querySelectorAll("[data-node-id]").length;
    const svgLinks = svgDocument.querySelectorAll("[data-link-id]").length;
    const jsonNodes = payload.nodes.length;
    const jsonLinks = payload.links.length;
    const countsMatch = jsonNodes === visible.nodes.length && jsonLinks === visible.links.length && svgNodes === jsonNodes && svgLinks === jsonLinks;
    const sourceCapacity = Number(visible.links.reduce((sum, link) => sum + link.capacityMbps, 0).toFixed(2));
    const sourceLatency = Number(visible.links.reduce((sum, link) => sum + link.latencyMs, 0).toFixed(2));
    const currentRouteValues = Object.fromEntries(
      state.routeAnalyses.map((route) => [route.id, route.available ? route.totalLatency.toFixed(1) : null])
    );
    const exportedRouteValues = Object.fromEntries(
      payload.routes.map((route) => [route.id, route.available ? Number(route.totalLatencyMs).toFixed(1) : null])
    );
    const valuesMatch =
      Number(payload.stats.totalCapacityMbps.toFixed(2)) === sourceCapacity &&
      Number(payload.stats.totalLatencyMs.toFixed(2)) === sourceLatency &&
      JSON.stringify(currentRouteValues) === JSON.stringify(exportedRouteValues);
    const versionMatch = payload.dataVersion === state.project.dataVersion;
    return {
      passed: countsMatch && valuesMatch && versionMatch && svgDocument.querySelector("parsererror") === null,
      countsMatch,
      valuesMatch,
      versionMatch,
      jsonNodes,
      jsonLinks,
      svgNodes,
      svgLinks,
      sourceCapacity,
      sourceLatency,
      sourcePathLatencies: currentRouteValues,
      exportedPathLatencies: exportedRouteValues
    };
  }

  function downloadTopologyJson(recordEvent) {
    const jsonString = buildTopologyJsonString();
    const svgString = buildSvgString();
    const audit = exportAudit(jsonString, svgString);
    if (!audit.passed) {
      addEvent("err", "EXPORT", `JSON 审计失败：对象 ${audit.jsonNodes}/${audit.jsonLinks}，数值一致=${audit.valuesMatch}`);
      showToast("导出已阻止", "对象数量或关键数值与当前视图不一致", "warn");
      return audit;
    }
    downloadFile(`${safeFilename(state.project.name)}-topology-v${state.project.dataVersion}.json`, jsonString, "application/json;charset=utf-8");
    if (recordEvent !== false) {
      addEvent("ok", "EXPORT", `JSON 导出一致：${audit.jsonNodes} 节点 / ${audit.jsonLinks} 链路 · Σ延迟 ${audit.sourceLatency} ms · v${state.project.dataVersion}`);
      showToast("拓扑 JSON 已导出", `${audit.jsonNodes} 节点 · ${audit.jsonLinks} 链路 · 对象与数值审计通过`);
    }
    renderDebug();
    return audit;
  }

  function downloadSvg(recordEvent) {
    const svgString = buildSvgString();
    const jsonString = buildTopologyJsonString();
    const audit = exportAudit(jsonString, svgString);
    if (!audit.passed) {
      addEvent("err", "EXPORT", `SVG 审计失败：SVG ${audit.svgNodes}/${audit.svgLinks}`);
      showToast("导出已阻止", "SVG 对象数量与当前视图不一致", "warn");
      return audit;
    }
    downloadFile(`${safeFilename(state.project.name)}-topology-v${state.project.dataVersion}.svg`, svgString, "image/svg+xml;charset=utf-8");
    if (recordEvent !== false) {
      addEvent("ok", "EXPORT", `SVG 导出一致：${audit.svgNodes} 节点 / ${audit.svgLinks} 链路 · 1200×760 · v${state.project.dataVersion}`);
      showToast("拓扑 SVG 已导出", `${audit.svgNodes} 节点 · ${audit.svgLinks} 链路 · 可在矢量软件中无损编辑`);
    }
    renderDebug();
    return audit;
  }

  function downloadProjectFile(showFeedback) {
    const payload = persistProject(true);
    if (!payload) return false;
    const content = JSON.stringify(payload, null, 2);
    downloadFile(`${safeFilename(state.project.name)}-project-v${state.project.dataVersion}.topoforge.json`, content, "application/json;charset=utf-8");
    addEvent("ok", "PROJECT", `工程已保存：${payload.nodes.length} 节点 / ${payload.links.length} 链路 · 可重新载入`);
    renderDebug();
    if (showFeedback !== false) showToast("工程已保存", "自动保存已更新，同时下载可重新载入的工程文件");
    return true;
  }

  function selectDebugTab(tab) {
    state.debugTab = tab;
    $$(".debug-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.debugTab === tab));
    $$(".debug-view").forEach((view) => view.classList.toggle("active", view.id === `debug-${tab}`));
  }

  function runVerification() {
    const button = $("#runVerificationBtn");
    button.disabled = true;
    addEvent("info", "VERIFY", "开始完整性验证：备用路径、节点删除、撤销、工程重载、JSON/SVG 导出一致性");
    try {
      const workflow = Core.runWorkflowVerification(state.project, state.filter);
      const jsonString = buildTopologyJsonString();
      const svgString = buildSvgString();
      const audit = exportAudit(jsonString, svgString);
      const steps = workflow.steps.slice();
      steps.push({
        tag: "JSON",
        text: `JSON 对象 ${audit.jsonNodes} 节点 / ${audit.jsonLinks} 链路，与视图 ${audit.countsMatch ? "一致" : "不一致"}`,
        pass: audit.countsMatch,
        detail: `v${state.project.dataVersion}`
      });
      steps.push({
        tag: "SVG",
        text: `SVG 对象 ${audit.svgNodes} 节点 / ${audit.svgLinks} 链路，与 JSON 对象 ${audit.countsMatch ? "一致" : "不一致"}`,
        pass: audit.countsMatch,
        detail: "1200×760"
      });
      steps.push({
        tag: "VALUES",
        text: `容量 ${audit.sourceCapacity} Mbps · 延迟 ${audit.sourceLatency} ms · 三条路径延迟${audit.valuesMatch ? "一致" : "不一致"}`,
        pass: audit.valuesMatch && audit.versionMatch,
        detail: Object.keys(audit.sourcePathLatencies).length ? `${Object.values(audit.sourcePathLatencies).join(" / ")} ms` : "无路径"
      });
      const passed = workflow.passed && audit.passed;
      state.verification = {
        passed,
        steps,
        checkedAt: new Date().toISOString(),
        workflow,
        exportAudit: audit
      };
      steps.forEach((step) => {
        addEvent(step.pass ? "ok" : "err", `CHECK:${step.tag}`, `${step.text}${step.detail ? ` · ${step.detail}` : ""}`);
      });
      addEvent(passed ? "ok" : "err", "VERIFY", passed ? `完整性验证通过：${steps.filter((step) => step.pass).length}/${steps.length} 项` : "完整性验证未通过，请检查失败项");
      selectDebugTab("verify");
      renderDebug();
      showToast(
        passed ? "完整性验证通过" : "验证存在失败项",
        passed ? `删除 ${workflow.deletionNodeId} → 撤销 → 重载 → 导出均一致` : "展开调试面板查看失败步骤",
        passed ? "ok" : "warn"
      );
      return state.verification;
    } catch (error) {
      addEvent("err", "VERIFY", `验证执行异常：${error.message}`);
      showToast("验证执行异常", error.message, "warn");
      renderDebug();
      return null;
    } finally {
      button.disabled = false;
    }
  }

  function deleteNode(nodeId) {
    const node = state.project.nodes.find((item) => item.id === nodeId);
    if (!node) return false;
    const incident = state.project.links.filter((link) => link.source === nodeId || link.target === nodeId);
    pushHistory();
    const result = Core.removeNodeAndLinks(state.project, nodeId);
    state.project = result.project;
    state.selectedNodeId = null;
    state.selectedLinkId = null;
    markChanged("DELETE", `删除节点 ${node.id}；同步移除 ${incident.length} 条相连链路`);
    const brokenRoutes = state.project.routes.map((route) => Core.analyzeRoute(state.project, route, state.filter)).filter((route) => !route.available);
    if (brokenRoutes.length) {
      addEvent("warn", "ROUTE", `${brokenRoutes.length} 条路径因缺少节点或链路不可用：${brokenRoutes.map((route) => route.name).join("、")}`);
    }
    renderAll();
    showToast("节点与相连链路已删除", `${node.id} · 移除 ${incident.length} 条链路 · 可撤销`, "warn");
    return true;
  }

  function deleteLink(linkId) {
    const link = state.project.links.find((item) => item.id === linkId);
    if (!link) return false;
    pushHistory();
    state.project.links = state.project.links.filter((item) => item.id !== linkId);
    state.selectedLinkId = null;
    state.selectedNodeId = null;
    markChanged("DELETE", `删除链路 ${link.id}（${link.source} → ${link.target}）`);
    renderAll();
    showToast("链路已删除", `${link.id} · 可撤销`, "warn");
    return true;
  }

  function deleteSelection() {
    if (state.selectedNodeId) return deleteNode(state.selectedNodeId);
    if (state.selectedLinkId) return deleteLink(state.selectedLinkId);
    return false;
  }

  function undo() {
    if (!state.history.length) return false;
    const current = snapshotForHistory();
    const snapshot = state.history.pop();
    state.future.push(current);
    applySnapshot(snapshot, false);
    showToast("已撤销", `恢复 ${state.project.nodes.length} 节点 / ${state.project.links.length} 链路`);
    return true;
  }

  function redo() {
    if (!state.future.length) return false;
    const current = snapshotForHistory();
    const snapshot = state.future.pop();
    state.history.push(current);
    applySnapshot(snapshot, true);
    showToast("已重做", `当前 ${state.project.nodes.length} 节点 / ${state.project.links.length} 链路`);
    return true;
  }

  function selectRoute(routeId, withLog) {
    const route = (state.routeAnalyses || []).find((item) => item.id === routeId);
    if (!route) return false;
    state.selectedRouteId = routeId;
    state.selectedNodeId = null;
    state.selectedLinkId = null;
    if (withLog !== false) {
      const visible = currentVisible();
      if (route.available) {
        addEvent(
          "path",
          "PATH",
          `${route.name} · ${route.nodeIds.join(" → ")} · Σ ${route.totalLatency.toFixed(1)} ms · bottleneck ${Core.formatCapacity(route.bottleneck)}`
        );
        const start = route.nodeIds[0];
        const end = route.nodeIds[route.nodeIds.length - 1];
        const dijkstra = Core.shortestPath(state.project, start, end, visible.linkIds);
        if (dijkstra.available) {
          addEvent(
            "info",
            "DIJKSTRA",
            `${start}→${end} · shortest ${dijkstra.totalLatency.toFixed(1)} ms · explored ${dijkstra.explored} nodes · 与手工路径${Math.abs(dijkstra.totalLatency - route.totalLatency) < 0.05 ? "一致" : "不同"}`
          );
        }
      } else {
        addEvent("warn", "PATH", `${route.name} 不可用：${route.reason}`);
      }
    }
    renderAll();
    return true;
  }

  function updateFilterFromControls(source) {
    const before = Core.filterLabel(state.filter, currentVisible(), state.project);
    state.filter = Core.normalizeFilter({
      ...state.filter,
      query: $("#searchInput").value,
      minCapacity: Number($("#capacityFilter").value)
    });
    persistProject(true);
    const visible = currentVisible();
    const after = Core.filterLabel(state.filter, visible, state.project);
    if (source === "capacity" || source === "type" || source === "reset") {
      addEvent("info", "FILTER", `当前筛选已更新：${after}`);
    }
    renderAll();
    return before !== after;
  }

  function selectNode(nodeId) {
    state.selectedNodeId = nodeId;
    state.selectedLinkId = null;
    renderAll();
  }

  function selectLink(linkId) {
    state.selectedLinkId = linkId;
    state.selectedNodeId = null;
    renderAll();
  }

  function beginNodeDrag(event, nodeElement) {
    const nodeId = nodeElement.dataset.nodeId;
    const node = state.project.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const point = svgPoint(event);
    state.selectedNodeId = nodeId;
    state.selectedLinkId = null;
    state.dragSnapshot = snapshotForHistory();
    state.drag = {
      nodeId,
      offsetX: point.x - node.x,
      offsetY: point.y - node.y,
      startX: node.x,
      startY: node.y,
      moved: false
    };
    svg.classList.add("dragging");
    renderGraph(currentVisible(), state.pathResult, state.routeAnalyses);
    renderInspector();
  }

  function handlePointerMove(event) {
    if (!state.drag) return;
    const node = state.project.nodes.find((item) => item.id === state.drag.nodeId);
    if (!node) return;
    event.preventDefault();
    const point = svgPoint(event);
    const nextX = Math.max(72, Math.min(Core.CANVAS.width - 72, point.x - state.drag.offsetX));
    const nextY = Math.max(62, Math.min(Core.CANVAS.height - 62, point.y - state.drag.offsetY));
    if (Math.hypot(nextX - node.x, nextY - node.y) > 0.1) state.drag.moved = true;
    node.x = Math.round(nextX);
    node.y = Math.round(nextY);
    const visible = currentVisible();
    const paths = Core.planLinkPaths(visible.nodes, visible.links);
    renderGraph(visible, paths, state.routeAnalyses);
  }

  function endNodeDrag() {
    if (!state.drag) return;
    const drag = state.drag;
    state.drag = null;
    svg.classList.remove("dragging");
    if (drag.moved) {
      pushHistory(state.dragSnapshot);
      const node = state.project.nodes.find((item) => item.id === drag.nodeId);
      const paths = state.pathResult;
      markChanged(
        "MOVE",
        `拖动 ${drag.nodeId} 至 ${Math.round(node?.x || 0)},${Math.round(node?.y || 0)}；重算 ${paths?.stats.detourCount || 0} 条绕行链路 / ${state.project.links.length} 条可见链路`
      );
      addEvent("info", "AVOID", `避障重算：${paths?.stats.detourCount || 0} 条绕行 · ${paths?.stats.straightCount || 0} 条直线 · 平均顶点 ${paths?.stats.averagePoints || 0}`);
    }
    state.dragSnapshot = null;
    renderAll();
  }

  function autoLayout() {
    pushHistory();
    state.project = Core.autoLayoutNodes(state.project);
    markChanged("LAYOUT", `自动整理 ${state.project.nodes.length} 个节点，链路避障已重新计算`);
    renderAll();
    showToast("布局已整理", "节点按网关 → 核心 → 汇聚 → 接入 → 终端分层");
  }

  function focusInspectorSelection() {
    if (!state.selectedNodeId && !state.selectedLinkId) return;
    applyZoom(1);
    addEvent("info", "FOCUS", `定位 ${state.selectedNodeId || state.selectedLinkId} · 恢复全图 100%`);
    showToast("已定位对象", state.selectedNodeId || state.selectedLinkId);
  }

  async function importProjectFile(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const hydrated = Core.hydrateProject(parsed);
      state.project = hydrated;
      state.filter = Core.normalizeFilter(hydrated.filter);
      state.selectedNodeId = null;
      state.selectedLinkId = null;
      state.selectedRouteId = hydrated.routes.find((route) => route.kind === "primary")?.id || hydrated.routes[0]?.id || null;
      state.history = [];
      state.future = [];
      state.verification = null;
      state.qualityLogs = hydrated.qualityLogs.slice();
      state.events = [];
      addEvent("ok", "IMPORT", `载入 ${file.name}：${hydrated.nodes.length} 节点 / ${hydrated.links.length} 链路 · v${hydrated.dataVersion}`);
      const matchedSample = window.TOPO_SAMPLES.find((sample) => sample.id === hydrated.sourceSampleId);
      $("#sampleSelect").value = matchedSample ? matchedSample.id : "";
      persistProject(true);
      renderAll();
      showToast("工程载入完成", `${hydrated.nodes.length} 节点 · ${hydrated.links.length} 链路 · 拓扑指纹已重新计算`);
    } catch (error) {
      addEvent("err", "IMPORT", `载入失败：${error.message}`);
      showToast("工程载入失败", error.message, "warn");
    }
  }

  function initSampleSelect() {
    $("#sampleSelect").innerHTML = window.TOPO_SAMPLES.map(
      (sample) => `<option value="${escapeXml(sample.id)}">${escapeXml(sample.shortName)}</option>`
    ).join("");
  }

  function bindEvents() {
    $("#routeList").addEventListener("click", (event) => {
      const card = event.target.closest("[data-route-id]");
      if (card) selectRoute(card.dataset.routeId, true);
    });

    $("#searchInput").addEventListener("input", () => updateFilterFromControls("search"));
    $("#capacityFilter").addEventListener("input", () => updateFilterFromControls("capacity"));
    $("#capacityFilter").addEventListener("change", () => addEvent("info", "FILTER", `容量阈值 ${state.filter.minCapacity || "不限"}`));
    $("#typeFilter").addEventListener("click", (event) => {
      const button = event.target.closest("[data-type]");
      if (!button) return;
      const type = button.dataset.type;
      const nextTypes = { ...state.filter.types, [type]: !state.filter.types[type] };
      if (!nextTypes.gateway && !nextTypes.router && !nextTypes.terminal) {
        showToast("至少保留一种类型", "三类节点全部关闭会得到空视图", "warn");
        return;
      }
      state.filter = { ...state.filter, types: nextTypes };
      updateFilterFromControls("type");
    });
    $("#resetFilterBtn").addEventListener("click", () => {
      state.filter = Core.clone(Core.DEFAULT_FILTER);
      persistProject(true);
      addEvent("info", "FILTER", "筛选已重置：全部节点 · 全部链路 · 容量不限");
      renderAll();
    });

    $("#sampleSelect").addEventListener("change", (event) => {
      if (event.target.value) loadSample(event.target.value);
    });
    $("#undoBtn").addEventListener("click", undo);
    $("#redoBtn").addEventListener("click", redo);
    $("#autoLayoutBtn").addEventListener("click", autoLayout);
    $("#deleteSelectionBtn").addEventListener("click", deleteSelection);
    $("#inspectorContent").addEventListener("click", (event) => {
      const button = event.target.closest("[data-inspector-action]");
      if (!button) return;
      const action = button.dataset.inspectorAction;
      if (action === "delete-node" || action === "delete-link") deleteSelection();
      else focusInspectorSelection();
    });

    $("#zoomInBtn").addEventListener("click", () => applyZoom(state.zoom + 0.1));
    $("#zoomOutBtn").addEventListener("click", () => applyZoom(state.zoom - 0.1));
    $("#zoomValue").addEventListener("click", () => applyZoom(1));
    $("#fitBtn").addEventListener("click", () => applyZoom(1));

    $("#saveProjectBtn").addEventListener("click", () => downloadProjectFile(true));
    $("#projectFileInput").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (file) importProjectFile(file);
      event.target.value = "";
    });
    $("#exportMenuBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = $("#exportMenu");
      menu.hidden = !menu.hidden;
      $("#exportMenuBtn").setAttribute("aria-expanded", String(!menu.hidden));
    });
    $("#exportMenu").addEventListener("click", (event) => {
      const button = event.target.closest("[data-export]");
      if (!button) return;
      $("#exportMenu").hidden = true;
      $("#exportMenuBtn").setAttribute("aria-expanded", "false");
      if (button.dataset.export === "json") downloadTopologyJson();
      if (button.dataset.export === "svg") downloadSvg();
      if (button.dataset.export === "project") downloadProjectFile(true);
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#exportMenu, #exportMenuBtn")) {
        $("#exportMenu").hidden = true;
        $("#exportMenuBtn").setAttribute("aria-expanded", "false");
      }
    });

    $$(".debug-tabs button").forEach((button) => {
      button.addEventListener("click", () => selectDebugTab(button.dataset.debugTab));
    });
    $("#debugCollapseBtn").addEventListener("click", () => $("#debugPanel").classList.toggle("collapsed"));
    $("#runVerificationBtn").addEventListener("click", runVerification);

    svg.addEventListener("pointerdown", (event) => {
      const nodeElement = event.target.closest(".node-group");
      if (nodeElement) {
        event.preventDefault();
        beginNodeDrag(event, nodeElement);
        return;
      }
      if (!event.target.closest(".edge-group")) {
        state.selectedNodeId = null;
        state.selectedLinkId = null;
        renderAll();
      }
    });
    svg.addEventListener("click", (event) => {
      if (state.drag) return;
      const nodeElement = event.target.closest(".node-group");
      if (nodeElement) {
        selectNode(nodeElement.dataset.nodeId);
        return;
      }
      const edgeElement = event.target.closest(".edge-group");
      if (edgeElement) selectLink(edgeElement.dataset.linkId);
    });
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", endNodeDrag);
    window.addEventListener("pointercancel", endNodeDrag);

    window.addEventListener("keydown", (event) => {
      const editing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (!editing && (event.key === "Delete" || event.key === "Backspace")) {
        if (state.selectedNodeId || state.selectedLinkId) {
          event.preventDefault();
          deleteSelection();
        }
      }
      if (!editing && event.key === "/") {
        event.preventDefault();
        $("#searchInput").focus();
      }
      if (!editing && event.key === "Escape") {
        state.selectedNodeId = null;
        state.selectedLinkId = null;
        renderAll();
      }
    });
  }

  function reloadSavedProject() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const hydrated = Core.hydrateProject(JSON.parse(raw));
    state.project = hydrated;
    state.filter = Core.normalizeFilter(hydrated.filter);
    state.selectedNodeId = null;
    state.selectedLinkId = null;
    state.selectedRouteId = hydrated.routes.find((route) => route.kind === "primary")?.id || hydrated.routes[0]?.id || null;
    state.history = [];
    state.future = [];
    addEvent("ok", "RELOAD", `本地工程重新载入：${hydrated.nodes.length} 节点 / ${hydrated.links.length} 链路 · v${hydrated.dataVersion}`);
    renderAll();
    return true;
  }

  function stateSummary() {
    const visible = currentVisible();
    const metrics = Core.graphMetrics(visible.nodes, visible.links);
    return {
      ready: true,
      project: state.project.name,
      dataVersion: state.project.dataVersion,
      sampleCode: state.project.sampleCode,
      filter: Core.filterLabel(state.filter, visible, state.project),
      visibleNodes: visible.nodes.length,
      visibleLinks: visible.links.length,
      totalNodes: state.project.nodes.length,
      totalLinks: state.project.links.length,
      fingerprint: metrics.fingerprint,
      selectedRouteId: state.selectedRouteId,
      selectedNodeId: state.selectedNodeId,
      selectedLinkId: state.selectedLinkId,
      historyDepth: state.history.length,
      futureDepth: state.future.length,
      routeValues: Object.fromEntries((state.routeAnalyses || []).map((route) => [route.id, route.totalLatency])),
      routeAvailability: Object.fromEntries((state.routeAnalyses || []).map((route) => [route.id, route.available])),
      routeCount: state.project.routes.length,
      backupRouteCount: state.project.routes.filter((route) => route.kind === "backup").length,
      detourCount: state.pathResult?.stats.detourCount || 0,
      verification: state.verification
        ? {
            passed: state.verification.passed,
            checks: state.verification.steps.length,
            checkedAt: state.verification.checkedAt
          }
        : null
    };
  }

  async function initialize() {
    initSampleSelect();
    bindEvents();
    restoreProject();
    const visible = currentVisible();
    addEvent(
      "info",
      "RENDER",
      `首屏同步：可见 ${visible.nodes.length} 节点 / ${visible.links.length} 链路 · 路径 ${state.project.routes.length} 条 · 避障 ${state.pathResult?.stats.detourCount || 0} 条`
    );
    renderDebug();
    applyZoom(1);
    await loadExportFont();
    window.TopoForge = {
      getState: stateSummary,
      getProject: () => cloneProject(),
      getVisible: () => {
        const visible = currentVisible();
        return { nodes: Core.clone(visible.nodes), links: Core.clone(visible.links) };
      },
      getDebugSnapshot: () => ({
        state: stateSummary(),
        filter: Core.clone(state.filter),
        routes: Core.clone(state.routeAnalyses || []),
        pathPlans: Array.from(state.pathResult?.paths || []).map(([id, plan]) => ({ id, ...Core.clone(plan) })),
        events: Core.clone(state.events),
        verification: Core.clone(state.verification)
      }),
      selectPath: (routeId) => selectRoute(routeId, true),
      deleteNode: (nodeId) => deleteNode(nodeId),
      deleteSelection,
      undo,
      redo,
      loadSample: (sampleId) => {
        loadSample(sampleId);
        return stateSummary();
      },
      setFilter: (filter) => {
        state.filter = Core.normalizeFilter(filter);
        persistProject(true);
        renderAll();
        return stateSummary();
      },
      runVerification,
      getVerification: () => Core.clone(state.verification),
      exportJsonString: buildTopologyJsonString,
      exportSvgString: buildSvgString,
      auditExports: () => exportAudit(buildTopologyJsonString(), buildSvgString()),
      downloadJson: downloadTopologyJson,
      downloadSvg,
      saveProject: downloadProjectFile,
      reloadProject: reloadSavedProject,
      getMetrics: () => {
        const visible = currentVisible();
        return Core.graphMetrics(visible.nodes, visible.links);
      },
      hashText: Core.hashText
    };
    document.documentElement.dataset.ready = "true";
  }

  initialize();
})();
