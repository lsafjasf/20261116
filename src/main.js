import { FogApp } from './app.js';
import { TestSuite } from './test-suite.js';
import { WEATHER_PRESETS, PRESET_ORDER, presetPatch } from './presets.js';
import { shortHash } from './imghash.js';

const $ = (id) => document.getElementById(id);
const canvas = $('gl');

let app;
try {
  app = new FogApp(canvas);
  $('engine-status').textContent =
    `WebGL2 已就绪 · GL 对象 ${app.engine.objectCount} 个 · 增量更新已启用`;
} catch (err) {
  $('engine-status').textContent = '初始化失败：' + err.message;
  throw err;
}

const suite = new TestSuite(app);
window.__fogApp = app;   // 供 Playwright 自动化调用
window.__suite = suite;
window.__presetPatches = Object.fromEntries(
  PRESET_ORDER.map((id) => [id, presetPatch(id)]));

// ---------- 控件绑定 ----------
const rngMap = [
  ['rng-wind', 'val-wind', 'windSpeed'],
  ['rng-winddir', 'val-winddir', 'windDir'],
  ['rng-hum', 'val-hum', 'humidity'],
  ['rng-sunaz', 'val-sunaz', 'sunAzimuth'],
  ['rng-sunel', 'val-sunel', 'sunElevation'],
  ['rng-camaz', 'val-camaz', 'camAzimuth'],
  ['rng-camel', 'val-camel', 'camElevation'],
];

function syncControls() {
  const s = app.store.state;
  for (const [rngId, valId, key] of rngMap) {
    $(rngId).value = s[key];
    $(valId).textContent = s[key];
  }
  $('sel-quality').value = s.quality;
  $('btn-pause').textContent = s.paused ? '继续' : '暂停';
  $('hud-quality').textContent = 'quality: ' + s.quality;
}

// 任何来源（UI / 测试 / 恢复 / 自动化）的状态变化都同步控件，
// 但同步只读状态、不触发新的写入，因此不会重建场景。
app.store.subscribe(() => syncControls());

for (const [rngId, valId, key] of rngMap) {
  $(rngId).addEventListener('input', (e) => {
    app.set({ [key]: parseFloat(e.target.value) }, 'ui');
    $(valId).textContent = app.store.state[key];
  });
}

$('sel-quality').addEventListener('change', (e) => {
  app.set({ quality: e.target.value }, 'ui');
});

$('btn-pause').addEventListener('click', () => {
  app.store.state.paused ? app.resume() : app.pause();
  syncControls();
});

$('btn-export').addEventListener('click', () => {
  app.exportPNG(`fog-valley-${app.store.state.quality}-t${app.store.state.simTime.toFixed(1)}.png`);
});

$('btn-save').addEventListener('click', () => {
  const snap = app.saveSnapshot();
  $('engine-status').textContent =
    '快照已保存到 localStorage，键 fog-valley.snapshot.v1，参数 ' +
    Object.keys(snap.state).length + ' 项';
});

$('btn-restore').addEventListener('click', () => {
  const ret = app.restoreSnapshot();
  syncControls();
  $('engine-status').textContent = ret.noop
    ? '没有可恢复的快照'
    : `已一键恢复，受影响区域：${ret.changedRegions.join(', ') || '无（状态一致）'}`;
});

const presetBtns = $('preset-btns');
for (const id of PRESET_ORDER) {
  const btn = document.createElement('button');
  btn.textContent = WEATHER_PRESETS[id].label;
  btn.addEventListener('click', () => {
    app.set(presetPatch(id), 'ui-preset');
    syncControls();
  });
  presetBtns.appendChild(btn);
}

// ---------- HUD 与状态摘要 ----------
function refreshHud() {
  const s = app.store.state;
  $('hud-time').textContent = `t = ${s.simTime.toFixed(2)}s${s.paused ? ' (paused)' : ''}`;
  $('hud-frame').textContent = 'frame ' + app.frameCount;
  $('hud-ms').textContent = 'gpu ' + app.averageFrameMs().toFixed(2) + 'ms';
  requestAnimationFrame(refreshHud);
}
refreshHud();

function dumpState() {
  const s = app.store.state;
  const counts = app.store.regionCounts();
  const lines = [
    '【渲染参数】',
    `quality=${s.quality}  内部目标=${app.engine.target.width}×${app.engine.target.height}  画布=${canvas.width}×${canvas.height}`,
    `simTime=${s.simTime.toFixed(3)}s  paused=${s.paused}  frames=${app.frameCount}`,
    `wind=${s.windSpeed}m/s @${s.windDir}°  humidity=${s.humidity}`,
    `sun az/el=${s.sunAzimuth}°/${s.sunElevation}°  cam az/el=${s.camAzimuth}°/${s.camElevation}°`,
    '',
    '【算法状态】',
    `地形 raymarch: 固定 96 步 × ${(180 / 96).toFixed(2)} 世界单位（两质量档相同 → 轮廓一致）`,
    `雾积分: ${app.engine.cfg.fogSteps} 步, fbm3 ${app.engine.cfg.fogOctaves} octaves, 内部分辨率 ${app.engine.cfg.internalScale}×`,
    `GL 存活对象=${app.engine.objectCount}  累计 shader/program/buffer/texture/fbo/rbo=` +
      JSON.stringify(app.engine.created),
    '',
    '【各区域累计更新次数】',
    JSON.stringify(counts),
    `updateLog 条目=${app.store.updateLog.length}  被拒绝写入=${app.store.rejected.length}`,
  ];
  $('state-dump').textContent = lines.join('\n');
}
setInterval(dumpState, 1000);
dumpState();

function renderRegionLog() {
  const tbody = $('region-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const rec of app.store.updateLog.slice(-12).reverse()) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="mono">${rec.seq}</td>` +
      `<td>${rec.source}</td>` +
      `<td class="mono">${rec.changedKeys.join(', ')}</td>` +
      `<td class="mono">${rec.changedRegions.join(', ')}</td>` +
      `<td>${rec.fullRebuild ? '<span class="fail">是</span>' : '否'}</td>`;
    tbody.appendChild(tr);
  }
}
setInterval(renderRegionLog, 1000);
renderRegionLog();
syncControls();
// ---------- 测试结果渲染 ----------
function frameToDataURL(frame) {
  const c = document.createElement('canvas');
  c.width = frame.width;
  c.height = frame.height;
  const ctx = c.getContext('2d');
  const flipped = new Uint8ClampedArray(frame.pixels.length);
  // readPixels 原点在左下，导出前按行翻转。
  const row = frame.width * 4;
  for (let y = 0; y < frame.height; y++) {
    flipped.set(frame.pixels.subarray((frame.height - 1 - y) * row,
      (frame.height - y) * row), y * row);
  }
  ctx.putImageData(new ImageData(flipped, frame.width, frame.height), 0, 0);
  return c.toDataURL('image/png');
}

function renderTestResults(summary) {
  const tbody = $('test-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const r of suite.results) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${r.group}</td><td>${r.name}</td>` +
      `<td class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</td>` +
      `<td class="mono">${r.detail}</td>`;
    tbody.appendChild(tr);
  }

  $('test-summary').innerHTML = [
    ['通过 / 总数', `${summary.passed} / ${summary.total}`],
    ['高质量 GL 对象', summary.objectsHigh],
    ['低质量 GL 对象', summary.objectsLow],
    ['轮廓掩码漂移', (summary.silhouetteDrift * 100).toFixed(3) + '%'],
  ].map(([lbl, num]) =>
    `<div class="card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`
  ).join('');

  const ptbody = $('preset-table').querySelector('tbody');
  ptbody.innerHTML = '';
  for (const row of summary.presets) {
    const p = WEATHER_PRESETS[row.id];
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${p.label}</td>` +
      `<td class="mono">${p.windSpeed}</td>` +
      `<td class="mono">${p.windDir}°</td>` +
      `<td class="mono">${p.humidity}</td>` +
      `<td class="mono">${p.sunAzimuth}° / ${p.sunElevation}°</td>` +
      `<td class="mono">${shortHash(row.hash, 16)}</td>` +
      `<td class="mono">${shortHash(row.maskHash, 16)}</td>` +
      `<td><img class="thumb" src="${frameToDataURL(row.frame)}" alt="${p.label}"></td>`;
    ptbody.appendChild(tr);
  }

  const allPass = summary.failed === 0;
  const verdict = $('verdict');
  verdict.classList.toggle('bad', !allPass);
  const driftPct = (summary.silhouetteDrift * 100).toFixed(3);
  verdict.textContent = allPass
    ? `一致性结论：全部 ${summary.total} 项检查通过。暂停态重渲染哈希逐位一致，` +
      `说明画面与数据完全一致；高/低质量档遮挡掩码漂移仅 ${driftPct}%（<1%），` +
      `主要山脊轮廓未跳变，雾细节差异为预期行为。普通参数变化期间 GL 对象数恒定，` +
      `仅质量档切换触发一次受控重建，界面刷新未重建任何场景资源。`
    : `有 ${summary.failed} 项检查未通过，请查看上表 FAIL 行，画面与数据可能不一致。`;
  renderRegionLog();
  dumpState();
}

$('btn-test').addEventListener('click', async () => {
  $('btn-test').disabled = true;
  $('test-progress').textContent = '测试运行中…';
  const summary = await suite.runAll((phase) => {
    $('test-progress').textContent = '阶段：' + phase;
  });
  $('test-progress').textContent = '完成';
  $('btn-test').disabled = false;
  window.__lastSummary = summary;
  renderTestResults(summary);
  syncControls();
});
