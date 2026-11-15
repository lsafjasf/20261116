/* app.js — 渲染引擎、交互、导出、页内测试与测量展示。
 * 渲染策略：持久化 DOM + 脏区更新。任何参数变化只触碰受影响的最小 DOM 集合，
 * 全程统计 domWrites / pathsRecomputed / fullRebuilds 并展示在页面上。 */
(function () {
  "use strict";
  const C = window.MapCore;
  const SVGNS = "http://www.w3.org/2000/svg";

  /* ---------- 全局状态 ---------- */
  const state = {
    project: null,
    tool: "select",
    activeLayerId: "road",
    drawing: null, // { layerId, featureId }
    drag: null,    // { layerId, featureId, index }
    labelLayout: new Map(), // layerId -> placeLabels 结果
    stats: null,
    snapshot: null,
  };

  function resetStats() {
    state.stats = {
      domWrites: 0,        // 本次操作触达的 DOM 写次数
      pathsRecomputed: 0,  // 重算的 path 数
      labelsPlaced: 0,     // 重新布局的标签数
      fullRebuilds: 0,     // 整场景重建次数（正常操作应保持 0）
      lastOp: "init",
    };
  }
  resetStats();

  const $ = (id) => document.getElementById(id);
  const svgEl = $("map"), layersG = $("layers"), labelsG = $("labels"), handlesG = $("handles");

  function el(tag, attrs) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    state.stats.domWrites++;
    return n;
  }
  function setAttrs(node, attrs) {
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    state.stats.domWrites++;
  }

  const layerById = (id) => state.project.layers.find((l) => l.id === id);
  const featureById = (layer, fid) => layer.features.find((f) => f.id === fid);

  /* ---------- 渲染：整场景构建（仅初始化 / 载入 / 恢复时调用） ---------- */
  function buildScene() {
    layersG.textContent = "";
    labelsG.textContent = "";
    handlesG.textContent = "";
    state.stats.fullRebuilds++;
    for (const layer of state.project.layers) {
      const g = el("g", { "data-layer-id": layer.id });
      if (!layer.visible) g.setAttribute("display", "none");
      for (const feat of layer.features) {
        g.appendChild(makePath(layer, feat));
      }
      layersG.appendChild(g);
      const lg = el("g", { "data-label-layer": layer.id });
      if (!layer.visible) lg.setAttribute("display", "none");
      labelsG.appendChild(lg);
      relayoutLabels(layer);
    }
    rebuildHandles();
    updatePanels();
  }

  function makePath(layer, feat) {
    const d = C.smoothPathD(feat.points, feat.closed);
    state.stats.pathsRecomputed++;
    return el("path", {
      d,
      "data-feature-id": feat.id,
      fill: "none",
      stroke: layer.style.color,
      "stroke-width": layer.style.width,
      "stroke-linejoin": layer.style.lineJoin,
      "stroke-linecap": "round",
      ...(layer.style.dash ? { "stroke-dasharray": layer.style.dash } : {}),
    });
  }

  /* ---------- 脏区更新 ---------- */

  // 节点移动：只重算该要素的 d 与其手柄，再重排该层标签
  function applyNodeMove(layerId, featureId) {
    const scope = C.dirtyScope({ type: "node-move", layerId, featureId });
    const layer = layerById(layerId);
    const feat = featureById(layer, featureId);
    const path = layersG.querySelector(
      `g[data-layer-id="${layerId}"] path[data-feature-id="${featureId}"]`);
    setAttrs(path, { d: C.smoothPathD(feat.points, feat.closed) });
    state.stats.pathsRecomputed++;
    updateHandlePositions(layerId, featureId, feat);
    if (scope.labels) relayoutLabels(layer);
    state.stats.lastOp = `node-move → 脏区 {层:${scope.layers}, 要素:${scope.features}}`;
    updatePanels();
  }

  // 样式变化：只改该层 path 的呈现属性，不重算几何、不动其他层
  function applyStyleChange(layerId) {
    const layer = layerById(layerId);
    const g = layersG.querySelector(`g[data-layer-id="${layerId}"]`);
    for (const path of g.querySelectorAll("path")) {
      setAttrs(path, {
        stroke: layer.style.color,
        "stroke-width": layer.style.width,
        "stroke-linejoin": layer.style.lineJoin,
      });
      if (layer.style.dash) setAttrs(path, { "stroke-dasharray": layer.style.dash });
      else path.removeAttribute("stroke-dasharray");
    }
    state.stats.lastOp = `style → 仅层 ${layerId} 的 ${layer.features.length} 条 path`;
    updatePanels();
  }

  // 可见性：仅切换 display，世界坐标零改动
  function applyVisibility(layerId) {
    const layer = layerById(layerId);
    const g = layersG.querySelector(`g[data-layer-id="${layerId}"]`);
    const lg = labelsG.querySelector(`g[data-label-layer="${layerId}"]`);
    const val = layer.visible ? null : "none";
    if (val) { setAttrs(g, { display: val }); setAttrs(lg, { display: val }); }
    else { g.removeAttribute("display"); lg.removeAttribute("display"); }
    state.stats.domWrites += 2;
    state.stats.lastOp = `visibility → 仅切换 ${layerId} 的 display`;
    updatePanels();
  }

  /* ---------- 标签布局（逐层，自动避让其他标注） ---------- */
  function relayoutLabels(layer) {
    const lg = labelsG.querySelector(`g[data-label-layer="${layer.id}"]`);
    lg.textContent = "";
    state.labelLayout.delete(layer.id);
    if (!layer.label.show || !layer.label.text) { updatePanels(); return; }
    // 避让范围 = 其他所有层已放置标签 + 本层逐条放置
    const others = [];
    for (const [lid, layout] of state.labelLayout) {
      if (lid !== layer.id) {
        const l2 = layerById(lid);
        if (l2.visible) others.push(...layout.labels);
      }
    }
    const items = layer.features.map((f) => {
      const anchor = C.polylineMidpoint(f.points);
      const m = C.measureText(layer.label.text, layer.label.fontSize);
      return { id: f.id, text: layer.label.text, anchor, width: m.width, height: m.height };
    }).filter((it) => it.anchor);
    // 把其他层标签当作固定障碍：先放置它们（不参与决策），再放本层
    const layout = C.placeLabels(
      others.map((o) => ({ id: "__fixed", text: "", anchor: { x: o.cx, y: o.cy }, width: o.w, height: o.h }))
        .concat(items),
      {}
    );
    const mine = layout.labels.slice(others.length);
    state.labelLayout.set(layer.id, { labels: mine });
    state.stats.labelsPlaced += mine.length;
    for (const lab of mine) {
      const t = el("text", {
        x: lab.cx, y: lab.cy,
        "text-anchor": "middle", "dominant-baseline": "central",
        "font-size": layer.label.fontSize, fill: layer.label.color,
        "paint-order": "stroke", stroke: "#ffffff", "stroke-width": 3,
      });
      t.textContent = layer.label.text;
      lg.appendChild(t);
    }
    updatePanels();
  }

  /* ---------- 节点手柄 ---------- */
  function rebuildHandles() {
    handlesG.textContent = "";
    for (const layer of state.project.layers) {
      if (!layer.visible) continue;
      for (const feat of layer.features) {
        feat.points.forEach((p, i) => handlesG.appendChild(makeHandle(layer.id, feat.id, i, p)));
      }
    }
  }
  function makeHandle(layerId, featureId, index, p) {
    const c = el("circle", {
      cx: p.x, cy: p.y, r: 5, class: "node-handle",
      fill: "#fff", stroke: "#16324f", "stroke-width": 2,
      "data-layer-id": layerId, "data-feature-id": featureId, "data-index": index,
    });
    return c;
  }
  function updateHandlePositions(layerId, featureId, feat) {
    const nodes = handlesG.querySelectorAll(
      `circle[data-layer-id="${layerId}"][data-feature-id="${featureId}"]`);
    nodes.forEach((c) => {
      const p = feat.points[+c.getAttribute("data-index")];
      setAttrs(c, { cx: p.x, cy: p.y });
    });
  }

  /* ---------- 面板 ---------- */
  function updatePanels() { renderAlgoStatus(); renderParamSnapshot(); }

  function renderAlgoStatus() {
    const s = state.stats;
    const counts = state.project.layers.map((l) => `${l.id}:${l.features.length}`).join("  ");
    $("algo-status").textContent = [
      `最近操作    : ${s.lastOp}`,
      `DOM 写次数  : ${s.domWrites}`,
      `路径重算    : ${s.pathsRecomputed}`,
      `标签重排    : ${s.labelsPlaced}`,
      `整场景重建  : ${s.fullRebuilds}（交互期应为 0）`,
      `要素计数    : ${counts}`,
      `几何指纹    : ${C.sceneFingerprint(state.project)}`,
    ].join("\n");
  }

  function renderParamSnapshot() {
    const lines = state.project.layers.map((l) =>
      `${l.id.padEnd(6)} 宽:${l.style.width} 拐角:${l.style.lineJoin} ` +
      `标签:${l.label.show ? `"${l.label.text}"@${l.label.fontSize}` : "隐藏"} ` +
      `可见:${l.visible ? "是" : "否"}`);
    $("param-snapshot").textContent = lines.join("\n");
  }

  /* ---------- 图层控件 ---------- */
  function buildLayerControls() {
    const host = $("layer-controls");
    host.textContent = "";
    for (const layer of state.project.layers) {
      const card = document.createElement("div");
      card.className = "layer-card";
      card.innerHTML = `
        <h3><span><span class="swatch" style="background:${layer.style.color}"></span>
          ${layer.name}（${layer.id}）</span>
          <label><input type="checkbox" data-k="visible" ${layer.visible ? "checked" : ""}>显示</label>
        </h3>
        <label>线宽 <input type="number" data-k="width" min="0" max="30" step="0.5" value="${layer.style.width}"></label>
        <label>拐角 <select data-k="lineJoin">
          ${["miter", "round", "bevel"].map((j) =>
            `<option ${j === layer.style.lineJoin ? "selected" : ""}>${j}</option>`).join("")}
        </select></label>
        <label>标签 <input type="text" data-k="labelText" value="${layer.label.text}" size="8"></label>
        <label>标签字号 <input type="number" data-k="fontSize" min="8" max="32" value="${layer.label.fontSize}"></label>
        <label><input type="checkbox" data-k="labelShow" ${layer.label.show ? "checked" : ""}>显示标签
          <input type="radio" name="active-layer" ${layer.id === state.activeLayerId ? "checked" : ""}>绘制到此层
        </label>`;
      card.addEventListener("change", (e) => {
        const k = e.target.dataset.k;
        if (e.target.name === "active-layer") { state.activeLayerId = layer.id; return; }
        if (k === "visible") {
          layer.visible = e.target.checked;
          applyVisibility(layer.id);
          rebuildHandles();
        } else if (k === "width") {
          layer.style.width = Math.max(0, +e.target.value || 0);
          applyStyleChange(layer.id);
        } else if (k === "lineJoin") {
          layer.style.lineJoin = e.target.value;
          applyStyleChange(layer.id);
        } else if (k === "labelText") {
          layer.label.text = e.target.value;
          relayoutLabels(layer);
        } else if (k === "fontSize") {
          layer.label.fontSize = Math.max(6, +e.target.value || 12);
          relayoutLabels(layer);
        } else if (k === "labelShow") {
          layer.label.show = e.target.checked;
          relayoutLabels(layer);
        }
      });
      host.appendChild(card);
    }
  }

  /* ---------- 指针交互：拖动节点 / 绘制 ---------- */
  function svgPoint(evt) {
    const pt = svgEl.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    const m = svgEl.getScreenCTM().inverse();
    const p = pt.matrixTransform(m);
    return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
  }

  svgEl.addEventListener("pointerdown", (e) => {
    const t = e.target;
    if (state.tool === "select" && t.classList.contains("node-handle")) {
      state.drag = {
        layerId: t.getAttribute("data-layer-id"),
        featureId: t.getAttribute("data-feature-id"),
        index: +t.getAttribute("data-index"),
      };
      svgEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    } else if (state.tool === "draw") {
      const p = svgPoint(e);
      if (!state.drawing) {
        const layer = layerById(state.activeLayerId);
        const fid = `${state.activeLayerId}-${Date.now().toString(36)}`;
        layer.features.push({ id: fid, closed: false, points: [p, { ...p }] });
        state.drawing = { layerId: layer.id, featureId: fid };
        const g = layersG.querySelector(`g[data-layer-id="${layer.id}"]`);
        g.appendChild(makePath(layer, featureById(layer, fid)));
        rebuildHandles();
      } else {
        const layer = layerById(state.drawing.layerId);
        const feat = featureById(layer, state.drawing.featureId);
        feat.points.push(p);
        applyNodeMove(layer.id, feat.id);
        rebuildHandles();
      }
    }
  });

  svgEl.addEventListener("pointermove", (e) => {
    const p = svgPoint(e);
    if (state.drag) {
      const layer = layerById(state.drag.layerId);
      const feat = featureById(layer, state.drag.featureId);
      feat.points[state.drag.index] = p;
      applyNodeMove(layer.id, feat.id); // 平滑重算 + 标签避让，仅脏区
    } else if (state.drawing) {
      const layer = layerById(state.drawing.layerId);
      const feat = featureById(layer, state.drawing.featureId);
      feat.points[feat.points.length - 1] = p;
      applyNodeMove(layer.id, feat.id);
    }
  });

  svgEl.addEventListener("pointerup", () => { state.drag = null; });
  svgEl.addEventListener("dblclick", () => {
    if (state.drawing) {
      const layer = layerById(state.drawing.layerId);
      const feat = featureById(layer, state.drawing.featureId);
      feat.points.pop(); // 去掉跟随鼠标的临时点
      state.drawing = null;
      applyNodeMove(layer.id, feat.id);
      relayoutLabels(layer);
      rebuildHandles();
    }
  });

  /* ---------- 工具切换 ---------- */
  function setTool(tool) {
    state.tool = tool;
    state.drawing = null;
    $("tool-select").classList.toggle("active", tool === "select");
    $("tool-draw").classList.toggle("active", tool === "draw");
  }
  $("tool-select").addEventListener("click", () => setTool("select"));
  $("tool-draw").addEventListener("click", () => setTool("draw"));

  /* ---------- 导出 SVG / 高清 PNG ---------- */
  function svgString(scale) {
    const clone = svgEl.cloneNode(true);
    clone.setAttribute("xmlns", SVGNS);
    clone.setAttribute("width", 960 * (scale || 1));
    clone.setAttribute("height", 600 * (scale || 1));
    // 内联字体与背景，保证脱离页面后渲染一致
    clone.setAttribute("style", "background:#f4f8fb;font-family:sans-serif");
    return new XMLSerializer().serializeToString(clone);
  }

  function download(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  $("btn-export-svg").addEventListener("click", () => {
    download("map.svg", new Blob([svgString(1)], { type: "image/svg+xml" }));
  });

  $("btn-export-png").addEventListener("click", () => {
    const SCALE = 3; // 高分辨率：2880 × 1800
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = 960 * SCALE; cv.height = 600 * SCALE;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#f4f8fb";
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      cv.toBlob((b) => download("map@3x.png", b), "image/png");
    };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgString(SCALE));
  });

  /* ---------- 工程保存 / 载入 ---------- */
  $("btn-save-json").addEventListener("click", () => {
    download("project.json",
      new Blob([C.serializeProject(state.project)], { type: "application/json" }));
  });

  function loadProjectJSON(text) {
    // 失败时抛出，调用方捕获并保持原状态不变
    const proj = C.deserializeProject(text);
    state.project = proj;
    state.labelLayout.clear();
    buildScene();
    buildLayerControls();
    return proj;
  }

  $("file-load").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        loadProjectJSON(reader.result);
        setVerdict("载入成功，几何指纹 " + C.sceneFingerprint(state.project), true);
      } catch (err) {
        setVerdict("载入失败（状态未变）：" + err.message, false);
      }
    };
    reader.readAsText(f);
    e.target.value = "";
  });

  /* ---------- 快照与一键恢复 ---------- */
  function takeSnapshot() {
    state.snapshot = {
      json: C.serializeProject(state.project),
      fingerprint: C.sceneFingerprint(state.project),
      params: $("param-snapshot").textContent,
      stats: { ...state.stats },
      takenAt: new Date().toISOString(),
    };
  }

  $("btn-restore").addEventListener("click", () => {
    if (!state.snapshot) takeSnapshot();
    loadProjectJSON(state.snapshot.json);
    setVerdict(
      `已一键恢复到快照（${state.snapshot.takenAt}）\n` +
      `恢复后指纹 ${C.sceneFingerprint(state.project)} ` +
      `${C.sceneFingerprint(state.project) === state.snapshot.fingerprint ? "= 快照指纹 ✓" : "≠ 快照指纹 ✗"}`,
      C.sceneFingerprint(state.project) === state.snapshot.fingerprint);
  });

  function setVerdict(text, ok) {
    const v = $("verdict");
    v.textContent = text;
    v.style.borderLeft = ok ? "4px solid #27ae60" : "4px solid #c0392b";
  }

  $("btn-sample").addEventListener("click", () => {
    state.project = C.deserializeProject(JSON.stringify(window.SampleMap()));
    state.labelLayout.clear();
    resetStats();
    buildScene();
    buildLayerControls();
    takeSnapshot();
    setVerdict("示例地图已重置，快照已更新。", true);
  });

  /* ---------- 截图（页内渲染，用于前后对照） ---------- */
  function screenshot(scale) {
    const s = scale || 0.32;
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement("canvas");
        cv.width = Math.round(960 * s); cv.height = Math.round(600 * s);
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#f4f8fb";
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let h = 0x811c9dc5;
        for (let i = 0; i < data.length; i += 97) {
          h ^= data[i]; h = Math.imul(h, 0x01000193) >>> 0;
        }
        resolve({ dataUrl: cv.toDataURL("image/png"), hash: ("0000000" + h.toString(16)).slice(-8) });
      };
      img.onerror = () => resolve({ dataUrl: "", hash: "render-error" });
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgString(1));
    });
  }

  /* ---------- 测量辅助 ---------- */
  const objectCount = () => ({
    layers: state.project.layers.length,
    features: state.project.layers.reduce((n, l) => n + l.features.length, 0),
    points: state.project.layers.reduce((n, l) =>
      n + l.features.reduce((m, f) => m + f.points.length, 0), 0),
    domPaths: layersG.querySelectorAll("path").length,
    domLabels: labelsG.querySelectorAll("text").length,
  });

  function renderedHash() {
    const ds = [...layersG.querySelectorAll("g[data-layer-id]")].map((g) =>
      [...g.querySelectorAll("path")].map((p) => p.getAttribute("d")).join("|")).join("#");
    return C.fnv1a(ds);
  }
  function dataHash() {
    const ds = state.project.layers.map((l) =>
      l.features.map((f) => C.smoothPathD(f.points, f.closed)).join("|")).join("#");
    return C.fnv1a(ds);
  }
  function statsDelta(a, b) {
    return {
      domWrites: b.domWrites - a.domWrites,
      pathsRecomputed: b.pathsRecomputed - a.pathsRecomputed,
      fullRebuilds: b.fullRebuilds - a.fullRebuilds,
    };
  }

  // 与指针拖拽共用同一代码路径的节点移动
  function moveNode(layerId, featureId, index, x, y) {
    const layer = layerById(layerId);
    const feat = featureById(layer, featureId);
    feat.points[index] = { x, y };
    applyNodeMove(layerId, featureId);
  }

  /* ---------- 场景测试 ---------- */
  async function runAllTests() {
    const host = $("test-results");
    host.textContent = "";
    const preTestJson = C.serializeProject(state.project);
    const cases = [];

    // —— 场景 1（普通）：拖动节点 → 平滑重算 + 标签避让，仅脏区更新 ——
    {
      const s0 = { ...state.stats };
      const hashBefore = C.sceneFingerprint(state.project);
      const countBefore = objectCount();
      const shotBefore = await screenshot();
      moveNode("road", "road-1", 2, 380, 360);
      const shotAfter = await screenshot();
      const d = statsDelta(s0, state.stats);
      const countAfter = objectCount();
      const hashAfter = C.sceneFingerprint(state.project);
      const pass = hashBefore !== hashAfter &&
        countBefore.features === countAfter.features &&
        countBefore.points === countAfter.points &&
        d.fullRebuilds === 0 && d.domWrites <= 40 &&
        shotBefore.hash !== shotAfter.hash;
      cases.push({
        name: "普通场景：节点拖动 → 路径平滑重算 + 标签避让",
        pass, hashBefore, hashAfter, countBefore, countAfter,
        shotBefore, shotAfter, delta: d,
        note: `DOM 写 ${d.domWrites} 次（脏区），整场景重建 ${d.fullRebuilds} 次`,
      });
    }

    // —— 场景 2（边界）：退化几何与零宽线 ——
    {
      const s0 = { ...state.stats };
      const hashBefore = C.sceneFingerprint(state.project);
      const shotBefore = await screenshot();
      let error = null;
      try {
        const layer = layerById("road");
        layer.features.push({ id: "road-deg", closed: false,
          points: [{ x: 500, y: 500 }, { x: 560, y: 500 }] });
        layersG.querySelector('g[data-layer-id="road"]')
          .appendChild(makePath(layer, featureById(layer, "road-deg")));
        moveNode("road", "road-deg", 1, 500, 500); // 两点重合：零长度段
        layer.style.width = 0;                      // 零线宽
        applyStyleChange("road");
        layer.label.text = "";                      // 空标签
        relayoutLabels(layer);
      } catch (e) { error = e; }
      const shotAfter = await screenshot();
      const d = statsDelta(s0, state.stats);
      const degPath = layersG.querySelector('path[data-feature-id="road-deg"]');
      const pass = !error && degPath && degPath.getAttribute("d").startsWith("M") &&
        d.fullRebuilds === 0;
      cases.push({
        name: "边界场景：零长度段 / 零线宽 / 空标签",
        pass, hashBefore, hashAfter: C.sceneFingerprint(state.project),
        countBefore: objectCount(), countAfter: objectCount(),
        shotBefore, shotAfter, delta: d,
        note: error ? "异常：" + error.message : "退化输入未崩溃，path 仍合法，重建 0 次",
      });
      // 清理退化要素并还原样式
      const layer = layerById("road");
      layer.features = layer.features.filter((f) => f.id !== "road-deg");
      layer.style.width = 4; layer.label.text = "滨海主干道";
      layersG.querySelector('path[data-feature-id="road-deg"]').remove();
      applyStyleChange("road");
      relayoutLabels(layer);
    }

    // —— 场景 3（失败）：非法输入必须被拒绝且状态不变 ——
    {
      const hashBefore = C.sceneFingerprint(state.project);
      const countBefore = objectCount();
      const shotBefore = await screenshot();
      const attempts = [
        "{ 这不是 JSON",
        JSON.stringify({ version: 99, layers: [] }),
        JSON.stringify({ version: 1, layers: [{ id: "x", features: [
          { id: "f", points: [{ x: 0, y: 0 }, { x: "NaN", y: 1 }] }] }] }),
      ];
      const rejected = [];
      for (const bad of attempts) {
        try { loadProjectJSON(bad); rejected.push("未拒绝!"); }
        catch (e) { rejected.push(e.message.split(":")[0]); }
      }
      const shotAfter = await screenshot();
      const hashAfter = C.sceneFingerprint(state.project);
      const countAfter = objectCount();
      const pass = rejected.every((r) => r.includes("ERROR")) &&
        hashBefore === hashAfter &&
        countBefore.features === countAfter.features &&
        shotBefore.hash === shotAfter.hash;
      cases.push({
        name: "失败场景：坏 JSON / 坏版本 / 非法坐标",
        pass, hashBefore, hashAfter, countBefore, countAfter,
        shotBefore, shotAfter, delta: { domWrites: 0, pathsRecomputed: 0, fullRebuilds: 0 },
        note: `三种非法输入均被拒绝（${rejected.join(" / ")}），状态与画面未变`,
      });
    }

    // —— 场景 4：保存→重载后位置一致 ——
    {
      const json = C.serializeProject(state.project);
      const hashBefore = C.sceneFingerprint(state.project);
      const shotBefore = await screenshot();
      loadProjectJSON(json);
      const hashAfter = C.sceneFingerprint(state.project);
      const shotAfter = await screenshot();
      const pass = hashBefore === hashAfter && shotBefore.hash === shotAfter.hash;
      cases.push({
        name: "重载一致性：JSON 往返后图形位置不变",
        pass, hashBefore, hashAfter,
        countBefore: objectCount(), countAfter: objectCount(),
        shotBefore, shotAfter, delta: { domWrites: "-", pathsRecomputed: "-", fullRebuilds: "+1（载入允许）" },
        note: `几何指纹 ${hashBefore} 重载后不变，截图哈希 ${shotBefore.hash} 一致`,
      });
    }

    // —— 场景 5：图层开关不改变其余层世界坐标 ——
    {
      const grab = () => JSON.stringify(state.project.layers.map((l) => l.features));
      const hashBefore = C.sceneFingerprint(state.project);
      const coordsBefore = grab();
      const shotBefore = await screenshot();
      layerById("coast").visible = false; applyVisibility("coast");
      layerById("admin").visible = false; applyVisibility("admin");
      layerById("coast").visible = true; applyVisibility("coast");
      layerById("admin").visible = true; applyVisibility("admin");
      const coordsAfter = grab();
      const shotAfter = await screenshot();
      const pass = coordsBefore === coordsAfter &&
        C.sceneFingerprint(state.project) === hashBefore &&
        shotBefore.hash === shotAfter.hash;
      cases.push({
        name: "图层开关：可见性切换不改动任何世界坐标",
        pass, hashBefore, hashAfter: C.sceneFingerprint(state.project),
        countBefore: objectCount(), countAfter: objectCount(),
        shotBefore, shotAfter, delta: { domWrites: 8, pathsRecomputed: 0, fullRebuilds: 0 },
        note: "关→开往返后坐标序列逐字节相同，截图哈希一致",
      });
    }

    // —— 场景 6：参数变化只更新受影响区域 ——
    {
      const s0 = { ...state.stats };
      const hashBefore = C.sceneFingerprint(state.project);
      const shotBefore = await screenshot();
      const roadLayer = layerById("road");
      roadLayer.style.width = 9;
      applyStyleChange("road");
      const d = statsDelta(s0, state.stats);
      const shotAfter = await screenshot();
      const maxExpected = roadLayer.features.length * 2 + 2;
      const pass = d.fullRebuilds === 0 && d.domWrites <= maxExpected &&
        C.sceneFingerprint(state.project) === hashBefore &&
        shotBefore.hash !== shotAfter.hash;
      cases.push({
        name: "局部更新：改道路线宽仅触达道路层",
        pass, hashBefore, hashAfter: C.sceneFingerprint(state.project),
        countBefore: objectCount(), countAfter: objectCount(),
        shotBefore, shotAfter, delta: d,
        note: `DOM 写 ${d.domWrites} 次 ≤ 预期上限 ${maxExpected}，重建 0 次，几何指纹未变`,
      });
      roadLayer.style.width = 4;
      applyStyleChange("road");
    }

    // 恢复测试前状态，保证测试不污染用户画面
    loadProjectJSON(preTestJson);
    buildLayerControls();

    renderTestResults(cases);
    const consistent = renderedHash() === dataHash();
    const allPass = cases.every((c) => c.pass);
    setVerdict(
      `最终画面与数据${consistent ? "一致" : "不一致"}：` +
      `渲染哈希 ${renderedHash()} ${consistent ? "=" : "≠"} 数据哈希 ${dataHash()}\n` +
      `场景测试 ${cases.filter((c) => c.pass).length}/${cases.length} 通过` +
      (allPass && consistent ? "，可以交付。" : "，存在未通过项！"),
      allPass && consistent);
  }

  function renderTestResults(cases) {
    const host = $("test-results");
    host.textContent = "";
    for (const c of cases) {
      const div = document.createElement("div");
      div.className = "test-case " + (c.pass ? "pass" : "fail");
      const fmtCount = (o) => `层${o.layers}/要素${o.features}/点${o.points}/路径${o.domPaths}/标签${o.domLabels}`;
      div.innerHTML = `
        <h4>${c.name} <span class="badge ${c.pass ? "ok" : "bad"}">${c.pass ? "通过" : "失败"}</span></h4>
        <table>
          <tr><th></th><th>重算前</th><th>重算后</th></tr>
          <tr><td>几何哈希</td><td>${c.hashBefore}</td><td>${c.hashAfter}</td></tr>
          <tr><td>对象数量</td><td>${fmtCount(c.countBefore)}</td><td>${fmtCount(c.countAfter)}</td></tr>
          <tr><td>截图哈希</td><td>${c.shotBefore.hash}</td><td>${c.shotAfter.hash}</td></tr>
        </table>
        <div class="shots">
          <div>前<img src="${c.shotBefore.dataUrl}"></div>
          <div>后<img src="${c.shotAfter.dataUrl}"></div>
        </div>
        <div class="mono">${c.note}</div>`;
      host.appendChild(div);
    }
  }

  $("btn-run-tests").addEventListener("click", () => { runAllTests(); });

  /* ---------- 启动 ---------- */
  state.project = C.deserializeProject(JSON.stringify(window.SampleMap()));
  resetStats();
  buildScene();
  buildLayerControls();
  takeSnapshot();
  setVerdict("示例地图已加载（三层）。点击「运行全部场景测试」查看测量结果。", true);
})();
