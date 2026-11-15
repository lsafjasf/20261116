import { ResourceManager, NaiveResourceManager } from './resourceManager.mjs';
import {
  SceneConfigCache, SCENE_LIBRARY, BOUNDARY_LIBRARY,
} from './sceneConfig.mjs';
import { SceneController } from './sceneController.mjs';
import { MetricsCollector, MetricsRenderer } from './metrics.mjs';
import { runScenario, compareReports } from './runner.mjs';
import { drawSeries } from './chart.mjs';

const ITERATIONS = 20;

const els = {
  mode: document.querySelector('#mode-select'),
  library: document.querySelector('#library-select'),
  start: document.querySelector('#start-btn'),
  switch: document.querySelector('#switch-btn'),
  loop: document.querySelector('#loop-btn'),
  stop: document.querySelector('#stop-btn'),
  metrics: document.querySelector('#metrics-root'),
  scene: document.querySelector('#scene-label'),
  count: document.querySelector('#switch-count'),
  audioState: document.querySelector('#audio-state'),
  trend: document.querySelector('#trend-canvas'),
  heap: document.querySelector('#heap-canvas'),
  log: document.querySelector('#log-list'),
  report: document.querySelector('#report-output'),
};

const renderer = new MetricsRenderer(els.metrics);
const metrics = new MetricsCollector();
let app = null;
let switchCount = 0;

function log(message, level = 'ok') {
  const item = document.createElement('li');
  item.className = level;
  item.textContent = `${new Date().toLocaleTimeString()} · ${message}`;
  els.log.prepend(item);
  while (els.log.children.length > 40) els.log.lastChild.remove();
}

function chooseLibrary() {
  return els.library.value === 'boundary' ? BOUNDARY_LIBRARY : SCENE_LIBRARY;
}

async function startAudio() {
  const context = new AudioContext();
  await context.resume();
  const library = chooseLibrary();
  const manager = els.mode.value === 'before'
    ? new NaiveResourceManager(context, { onViolation: (e) => log(`违规：${e.kind}`, 'warn') })
    : new ResourceManager(context, { onViolation: (e) => log(`违规：${e.kind}`, 'warn') });
  const cache = new SceneConfigCache(library.length);
  const controller = new SceneController(context, manager, cache, {
    onError: (entry) => {
      metrics.recordError(entry);
      log(`异常：${entry.where} ${entry.error?.message || ''}`, 'err');
    },
  });
  app = { context, manager, cache, controller, library };
  controller.enterScene(library[0]);
  switchCount = 0;
  updateStatus(library[0].id);
  pushSnapshot('manual-start');
  els.start.disabled = true;
  els.switch.disabled = false;
  els.loop.disabled = false;
  els.stop.disabled = false;
  log(`音频已启动（${els.mode.value === 'before' ? '泄漏基线' : '集中托管'}）`);
}

async function switchOnce() {
  if (!app) return;
  const config = app.library[switchCount % app.library.length];
  await app.controller.switchTo(config);
  switchCount += 1;
  updateStatus(config.id);
  pushSnapshot(`manual#${switchCount}`);
  log(`切换到 ${config.id}（第 ${switchCount} 次）`);
}

async function loopTwenty() {
  if (!app) return;
  setButtonsRunning(true);
  // Detach any manually-started scene first so the measured 20-switch run
  // starts from a clean baseline and its tail snapshot is truly idle.
  app.controller.exitScene();
  metrics.snapshots.length = 0;
  const report = await runScenario({
    context: app.context,
    controller: app.controller,
    manager: app.manager,
    cache: app.cache,
    library: app.library,
    iterations: ITERATIONS,
    label: els.mode.value,
    flush: () => new Promise((resolve) => setTimeout(resolve, 20)),
  });
  for (const point of report.snapshots) metrics.snapshots.push(point);
  switchCount += ITERATIONS;
  renderTrends(report);
  renderer.render(report.snapshots.at(-1));
  els.report.textContent = formatReport(report);
  updateStatus(report.snapshots.at(-2)?.scene || 'idle');
  log(`完成 ${ITERATIONS} 次循环切换，峰值节点 ${report.summary.peakActiveNodes}`, 'ok');
  setButtonsRunning(false);
}

function stopAudio() {
  if (!app) return;
  const released = app.manager.releaseAll();
  app.context.close();
  pushSnapshot('stopped');
  log(`停止并释放 ${released} 个节点，AudioContext 已关闭`, 'warn');
  app = null;
  switchCount = 0;
  els.start.disabled = false;
  els.switch.disabled = true;
  els.loop.disabled = true;
  els.stop.disabled = true;
  els.audioState.textContent = 'AudioContext：已关闭';
  els.scene.textContent = '场景：未启动';
}

function pushSnapshot(label) {
  const point = metrics.snapshot(label, app.manager, app.controller, app.cache);
  renderer.render(point);
  const live = metrics.snapshots;
  drawSeries(els.trend, [
    { data: live.map((p) => p.activeNodes), color: '#6ea8fe', label: '活动节点' },
    { data: live.map((p) => p.activeConnections), color: '#46d39a', label: '连接数' },
    { data: live.map((p) => p.activeListeners), color: '#ffb454', label: '监听器' },
  ]);
  drawSeries(els.heap, [
    { data: live.map((p) => Math.round(p.heapBytes / 1024)), color: '#c792ea', label: '堆内存 KiB' },
  ]);
}

function renderTrends(report) {
  drawSeries(els.trend, [
    { data: report.nodeSeries, color: '#6ea8fe', label: '活动节点' },
    { data: report.snapshots.map((p) => p.activeConnections), color: '#46d39a', label: '连接数' },
    { data: report.snapshots.map((p) => p.activeListeners), color: '#ffb454', label: '监听器' },
  ]);
  drawSeries(els.heap, [
    { data: report.heapSeries.map((v) => Math.round(v / 1024)), color: '#c792ea', label: '堆内存 KiB' },
  ]);
}

function updateStatus(sceneId) {
  els.scene.textContent = `场景：${sceneId}`;
  els.count.textContent = `切换次数：${switchCount}`;
  els.audioState.textContent = `AudioContext：${app?.context.state || '未创建'}`;
  if (app) renderer.render(metrics.latest);
}

function setButtonsRunning(running) {
  els.switch.disabled = running;
  els.loop.disabled = running;
  els.stop.disabled = running;
}

function formatReport(report) {
  const s = report.summary;
  return [
    `标签            : ${report.label}`,
    `样本数          : ${s.samples}`,
    `首/尾活动节点   : ${s.firstActiveNodes} -> ${s.lastActiveNodes}（峰值 ${s.peakActiveNodes}）`,
    `首/尾连接数     : ${s.firstConnections} -> ${s.lastConnections}`,
    `剩余监听器      : ${s.lastListeners}`,
    `候选/实际释放   : ${s.totalCandidates} / ${s.totalReleases}`,
    `拦截迟来回调    : ${s.suppressedCallbacks}`,
    `缓存命中率      : ${(s.finalCacheHitRate * 100).toFixed(1)}%`,
    `帧时间 avg/max  : ${s.avgFrameMs.toFixed(3)} / ${s.maxFrameMs.toFixed(3)} ms`,
    `堆内存首/峰值   : ${kb(s.firstHeapBytes)} / ${kb(s.peakHeapBytes)} KiB`,
    `异常数          : ${s.errorCount}`,
    `输出指纹稳定    : ${report.fingerprintStable}`,
    `唯一指纹数      : ${report.uniqueFingerprints.length}`,
  ].join('\n');
}

function kb(bytes) {
  return bytes ? (bytes / 1024).toFixed(1) : 'n/a';
}

els.start.addEventListener('click', startAudio);
els.switch.addEventListener('click', switchOnce);
els.loop.addEventListener('click', loopTwenty);
els.stop.addEventListener('click', stopAudio);

// Exposed for automated browser verification.
window.__audioLab = {
  runScenario, compareReports, MetricsCollector,
  SCENE_LIBRARY, BOUNDARY_LIBRARY,
  ResourceManager, NaiveResourceManager, SceneConfigCache, SceneController,
};
