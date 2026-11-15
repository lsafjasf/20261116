import { AnimationLoop } from "./animation-loop.js";
import { DirtyRenderer } from "./dirty-renderer.js";
import { FullRenderer } from "./full-renderer.js";
import {
  advanceScene,
  createScene,
  deleteVisibleObject,
  panCamera,
  setLayerVisible,
} from "./scene.js";

const canvas = document.querySelector("#scene-canvas");
const number = new Intl.NumberFormat("zh-CN");
const MODES = {
  before: {
    title: "优化前 · 固定高密度场景",
    label: "优化前",
    note: "基准路径每帧清除画布并遍历全部地形、文字与动态对象。",
  },
  after: {
    title: "优化后 · 固定高密度场景",
    label: "优化后",
    note: "静态层复用；文字布局缓存命中；仅合并后的动态脏矩形进入重绘。",
  },
  boundary: {
    title: "边界参数 · 降级全量路径",
    label: "边界参数",
    note: "脏矩形上限 2、合并间距 0、文字缓存 8；频繁退化仍须逐像素一致。",
  },
};

let scene;
let renderer;
let mode = "after";
let lastMetrics = null;
let autoFrameCount = 0;
let pauseBaseline = 0;
let lastUiUpdate = 0;
const exceptions = [];

const createSurface = (width, height) => {
  const surface = document.createElement("canvas");
  surface.width = width;
  surface.height = height;
  return surface;
};

function recordException(error) {
  exceptions.push({
    at: new Date().toISOString(),
    message: error instanceof Error ? error.message : String(error),
  });
  document.querySelector("#exception-count").textContent = String(exceptions.length);
  document.querySelector("#exception-message").textContent = exceptions.at(-1).message;
}

const loop = new AnimationLoop({
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
  onFrame: () => {
    autoFrameCount += 1;
    advanceScene(scene);
    renderScene(false);
    updateMetrics(false);
  },
  onError: (error) => {
    recordException(error);
    syncTransport();
    updateMetrics(true);
  },
});

function makeRenderer() {
  if (mode === "before") return new FullRenderer(canvas, { textCacheCapacity: 1 });
  const options =
    mode === "boundary"
      ? { createSurface, mergeGap: 0, maxDirtyRects: 2, textCacheCapacity: 8 }
      : { createSurface, mergeGap: 6, maxDirtyRects: 64, textCacheCapacity: 512 };
  return new DirtyRenderer(canvas, scene, options);
}

function renderScene(advance = true) {
  if (advance) advanceScene(scene);
  try {
    lastMetrics = renderer.render(scene);
  } catch (error) {
    recordException(error);
    throw error;
  }
}

function rebuildScene() {
  scene = createScene();
  renderer = makeRenderer();
  syncLayerInputs();
  renderScene(false);
  pauseBaseline = autoFrameCount;
  updateMetrics(true);
}

function syncLayerInputs() {
  for (const input of document.querySelectorAll("[data-layer]")) {
    input.checked = scene.layers[input.dataset.layer];
  }
}

function syncTransport() {
  const running = !loop.paused;
  document.querySelector("#run-status").textContent = running ? "运行中" : "已暂停";
  document.querySelector("#play-button").textContent = running ? "暂停" : "继续";
  document.querySelector("#play-button").classList.toggle("primary", !running);
  document.querySelector("#mode-status").textContent = MODES[mode].label;
  document.querySelector("#scenario-title").textContent = MODES[mode].title;
  document.querySelector("#mode-note").textContent = MODES[mode].note;
  document.querySelector("#metric-pause-guard").textContent = running
    ? "已启用"
    : `${autoFrameCount - pauseBaseline} 次重绘`;
  document.querySelector("#pause-proof").textContent = running
    ? "暂停后可验证不再重绘"
    : `暂停后重绘 ${autoFrameCount - pauseBaseline} 次`;
}

function updateMetrics(force) {
  const now = performance.now();
  if (!force && now - lastUiUpdate < 160) return;
  lastUiUpdate = now;
  const metrics = lastMetrics || renderer.metrics;
  if (!metrics) return;
  const cacheRate = (metrics.cacheHitRate || 0) * 100;
  const alive = metrics.nodes?.dynamic ?? 0;
  document.querySelector("#metric-frame").textContent =
    `${(metrics.emaFrameMs || metrics.frameMs || 0).toFixed(2)} ms`;
  document.querySelector("#metric-area").textContent =
    `${number.format(Math.round(metrics.repaintPixels))} px`;
  document.querySelector("#metric-area-detail").textContent =
    `占视口 ${((metrics.repaintRatio || 0) * 100).toFixed(1)}%`;
  document.querySelector("#metric-cache").textContent = `${cacheRate.toFixed(1)}%`;
  document.querySelector("#metric-cache-detail").textContent =
    `${number.format(metrics.cacheHits || 0)} / ${number.format((metrics.cacheHits || 0) + (metrics.cacheMisses || 0))}`;
  document.querySelector("#metric-candidates").textContent =
    `${metrics.candidateCount} / ${metrics.drawnObjects}`;
  document.querySelector("#metric-rects").textContent =
    `${metrics.dirtyRects} / ${metrics.fullInvalidations}`;
  document.querySelector("#metric-nodes").textContent =
    `${number.format(metrics.nodes?.terrain ?? 0)}/${metrics.nodes?.text ?? 0}/${alive}`;
  document.querySelector("#metric-render-calls").textContent = number.format(
    metrics.renderCalls || 0,
  );
  document.querySelector("#metric-redraw-calls").textContent = number.format(
    metrics.redrawCalls || 0,
  );
  document.querySelector("#invalidation-reason").textContent = metrics.lastReason;
  document.querySelector("#sample-time").textContent =
    new Date().toLocaleTimeString("zh-CN", { hour12: false });
  document.querySelector("#exception-count").textContent = String(exceptions.length);
  if (exceptions.length === 0) {
    document.querySelector("#exception-message").textContent = "无异常";
  }
  syncTransport();
}

function setScenario(nextMode) {
  mode = nextMode;
  for (const button of document.querySelectorAll("[data-scenario]")) {
    button.classList.toggle("active", button.dataset.scenario === mode);
  }
  rebuildScene();
}

function togglePlayback() {
  if (loop.paused) {
    loop.start();
  } else {
    loop.pause();
    pauseBaseline = autoFrameCount;
  }
  syncTransport();
  updateMetrics(true);
}

function stepOnce() {
  if (!loop.paused) loop.pause();
  renderScene(true);
  pauseBaseline = autoFrameCount;
  syncTransport();
  updateMetrics(true);
}

document.querySelector("#play-button").addEventListener("click", togglePlayback);
document.querySelector("#step-button").addEventListener("click", stepOnce);
document.querySelector("#reset-button").addEventListener("click", rebuildScene);
document.querySelector("#delete-button").addEventListener("click", () => {
  deleteVisibleObject(scene);
  updateMetrics(true);
});

for (const button of document.querySelectorAll("[data-scenario]")) {
  button.addEventListener("click", () => setScenario(button.dataset.scenario));
}

for (const input of document.querySelectorAll("[data-layer]")) {
  input.addEventListener("change", () => {
    setLayerVisible(scene, input.dataset.layer, input.checked);
    updateMetrics(true);
  });
}

const pans = {
  "pan-left": [-64, 0],
  "pan-right": [64, 0],
  "pan-up": [0, -54],
  "pan-down": [0, 54],
};
for (const [id, delta] of Object.entries(pans)) {
  document.querySelector(`#${id}`).addEventListener("click", () => {
    panCamera(scene, delta[0], delta[1]);
    updateMetrics(true);
  });
}

let drag = null;
canvas.addEventListener("pointerdown", (event) => {
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!drag || drag.id !== event.pointerId) return;
  const rect = canvas.getBoundingClientRect();
  const dx = Math.round(((event.clientX - drag.x) * canvas.width) / rect.width);
  const dy = Math.round(((event.clientY - drag.y) * canvas.height) / rect.height);
  if (dx !== 0 || dy !== 0) {
    panCamera(scene, -dx, -dy);
    drag.x = event.clientX;
    drag.y = event.clientY;
    updateMetrics(true);
  }
});
canvas.addEventListener("pointerup", () => {
  drag = null;
});

window.addEventListener("error", (event) => recordException(event.error || event.message));
window.addEventListener("unhandledrejection", (event) => recordException(event.reason));

rebuildScene();
loop.start();
syncTransport();
updateMetrics(true);
