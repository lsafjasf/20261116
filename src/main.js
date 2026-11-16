import { Engine, PHASE } from "./engine.js";
import { generateScene } from "./scene.js";

const SCENES = {
  baseline: { nodeCount: 290, seed: 20261116, spread: 9, minScale: 0.28, maxScale: 0.75 },
  optimized: { nodeCount: 290, seed: 20261116, spread: 9, minScale: 0.28, maxScale: 0.75 },
  boundary: { nodeCount: 573, seed: 987654321, spread: 14, minScale: 0.05, maxScale: 1.35 },
};

const els = {
  badge: document.getElementById("status-badge"),
  statusText: document.getElementById("status-text"),
  overlay: document.getElementById("lost-overlay"),
  overlayDetail: document.getElementById("overlay-detail"),
  canvas: document.getElementById("gl-canvas"),
};

const metricEls = {
  "m-frame-ms": (s) => `${s.metrics.frameMs.toFixed(2)} ms`,
  "m-fps": (s) => s.metrics.fps.toFixed(1),
  "m-candidates": (s) => String(s.metrics.candidateCount),
  "m-visible": (s) => String(s.metrics.visibleCount),
  "m-nodes": (s) => String(s.metrics.nodeCount),
  "m-cache": (s) => `${(s.metrics.cacheHitRate * 100).toFixed(1)}%`,
  "m-draws": (s) => String(s.metrics.drawCalls),
  "m-gpu": (s) => `${(s.metrics.gpuBytes / 1048576).toFixed(3)} MB`,
  "m-errors": (s) => String(s.metrics.glErrors),
  "m-blocked": (s) => String(s.metrics.blockedCalls),
  "m-mode": (s) => s.mode,
  "m-loss-count": (s) => String(s.lossCount),
  "m-pick": (s) => (s.selectedId === null ? "无 none" : `节点 node #${s.selectedId}`),
};

const PHASE_LABEL = {
  [PHASE.INIT]: ["init", "初始化中 Initializing…"],
  [PHASE.RUNNING]: ["ok", "渲染中 Running（上下文正常 context OK）"],
  [PHASE.LOST]: ["lost", "上下文已丢失 Context lost — 渲染已暂停 paused"],
  [PHASE.RESTORING]: ["restoring", "恢复中 Restoring：重建 size/texture/shader/buffer/camera…"],
};

function boot() {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode") || "optimized";
  const sceneName = params.get("scene") || mode;
  const scene = generateScene(SCENES[sceneName] ?? SCENES.optimized);

  const engine = new Engine(els.canvas, scene, mode, { onState: renderHUD });
  window.__engine = engine;
  window.__scene = scene;
  engine.start();
  bindMouse(engine, els.canvas);
}

function renderHUD(state, error) {
  const [cls, label] = PHASE_LABEL[state.phase] ?? ["init", state.phase];
  els.badge.className = `badge ${cls}`;
  els.badge.textContent = state.phase;
  els.statusText.textContent = error ? `${label}（${error.message}）` : label;
  els.overlay.classList.toggle("hidden", state.phase !== PHASE.LOST);
  if (state.phase === PHASE.LOST) {
    els.overlayDetail.textContent =
      `已暂停渲染并分离失效资源 Paused & stale resources detached；` +
      `丢失次数 losses=${state.lossCount}，等待 GPU 恢复 waiting…`;
  }
  for (const [id, formatter] of Object.entries(metricEls)) {
    const el = document.getElementById(id);
    if (el) el.textContent = formatter(state);
  }
}

function bindMouse(engine, canvas) {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener("pointerdown", (event) => {
    if (engine.phase !== PHASE.RUNNING) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.classList.add("dragging");
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!dragging || engine.phase !== PHASE.RUNNING) return;
    engine.camera.orbit(event.clientX - lastX, event.clientY - lastY);
    lastX = event.clientX;
    lastY = event.clientY;
  });

  canvas.addEventListener("pointerup", (event) => {
    dragging = false;
    canvas.classList.remove("dragging");
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* noop */ }
  });

  canvas.addEventListener("wheel", (event) => {
    if (engine.phase !== PHASE.RUNNING) return;
    event.preventDefault();
    engine.camera.zoom(event.deltaY);
  }, { passive: false });

  canvas.addEventListener("click", (event) => {
    if (engine.phase !== PHASE.RUNNING) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / rect.width;
    const px = (event.clientX - rect.left) * dpr;
    const py = (event.clientY - rect.top) * dpr;
    engine.handlePick(px, py);
  });
}

boot();
