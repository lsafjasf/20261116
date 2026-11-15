// 页面主控：状态管理、重算流水线、视图同步与导出

import { sanitizeDataset } from './graph.js';
import { runSimulation } from './simulation.js';
import { sampleA } from './samples/sample-a.js';
import { sampleB, recommendedClosureB } from './samples/sample-b.js';
import { renderScene, exportPngDataUrl } from './renderer.js';
import { buildCsvBundle, verifyExport } from './exporter.js';
import { buildProject, parseProject, bumpVersion } from './project.js';
import { runInBrowser } from './browser-verify.js';

const $ = (id) => document.getElementById(id);

const state = {
  sampleId: 'A',
  rawByName: { A: sampleA, B: sampleB },
  dataset: null,
  sanitizeIssues: [],
  overrides: { weights: {}, closures: [] },
  filters: { state: 'all', vehicleId: '' },
  selectedVehicleId: null,
  selectedEdgeId: null,
  heatmapEnabled: false,
  result: null,
  currentTick: 0,
  playTimer: null,
  lastExport: null,
  dataVersion: { version: 1, reason: '初始化加载', history: [] },
  lastProjectJson: null,
};

function loadSample(name, reason = '切换样例') {
  const raw = state.rawByName[name];
  const { data, issues } = sanitizeDataset(raw);
  state.sampleId = name;
  state.dataset = data;
  state.sanitizeIssues = issues;
  state.overrides = { weights: {}, closures: [] };
  state.selectedVehicleId = data.trips[0]?.id || null;
  state.selectedEdgeId = data.edges[0]?.id || null;
  state.currentTick = 0;
  state.lastExport = null;
  state.dataVersion = bumpVersion(state.dataVersion, `${reason}：${data.id}`);
  recompute();
}

function recompute(reason = '参数变更重算') {
  state.result = runSimulation(state.dataset, {
    weights: state.overrides.weights,
    closures: state.overrides.closures,
  });
  state.currentTick = Math.min(state.currentTick, state.result.horizon - 1);
  state.dataVersion = bumpVersion(state.dataVersion, reason);
  renderAll();
}

function download(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function renderCanvas() {
  const canvas = $('scene');
  renderScene(canvas, {
    result: state.result,
    tick: state.currentTick,
    heatmap: state.heatmapEnabled,
    closures: state.overrides.closures,
    selectedEdgeId: state.selectedEdgeId,
    selectedVehicleId: state.selectedVehicleId,
    filters: state.filters,
  });
}

function renderStats() {
  const s = state.result.stats;
  const items = [
    ['车辆总数', s.vehicles], ['已到达', s.arrived], ['进行中', s.inProgress],
    ['不可达', s.unreachable], ['超时', s.late], ['重规划次数', s.reroutes],
    ['总等待 tick', s.totalWait], ['平均等待', s.avgWait],
    ['总行驶 tick', s.totalTravel], ['平均行驶', s.avgTravel],
    ['总距离', s.totalDistance], ['封闭道路', state.overrides.closures.length],
  ];
  $('stats').innerHTML = items.map(([lbl, num]) =>
    `<div class="stat"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`).join('');
}

function renderMeta() {
  $('meta-sample').textContent = `样例：${state.sampleId} (${state.dataset.id})`;
  $('meta-version').textContent = `数据版本：v${state.dataVersion.version}`;
  const f = state.filters;
  const filterText = `筛选：${f.state === 'all' ? '全部状态' : f.state}${f.vehicleId ? ` / ${f.vehicleId}` : ''}`;
  $('meta-filter').textContent = filterText;
  if (state.lastExport) {
    $('meta-export').textContent = `导出口径：v${state.lastExport.dataVersion} · ${state.lastExport.vehicles}车/${state.lastExport.events}事件/${state.lastExport.edges}边`;
  } else {
    $('meta-export').textContent = '导出口径：未导出';
  }
}

function renderDecisionLog() {
  const id = state.selectedVehicleId;
  const select = $('vehicle-select');
  const ids = [...state.result.vehicles.keys()];
  if (select.options.length !== ids.length || select.value !== (id || '')) {
    select.innerHTML = ids.map((v) => `<option value="${v}"${v === id ? ' selected' : ''}>${v}</option>`).join('');
  }
  const filterSelect = $('filter-vehicle');
  const currentFilter = filterSelect.value;
  filterSelect.innerHTML = '<option value="">（不指定）</option>' +
    ids.map((v) => `<option value="${v}">${v}</option>`).join('');
  filterSelect.value = currentFilter;
  const box = $('decision-log');
  if (!id) { box.innerHTML = '<p class="hint">无车辆</p>'; return; }
  const vehicle = state.result.vehicles.get(id);
  const cls = (type) => type.startsWith('reroute') ? 'reroute'
    : type.includes('closure') || type.includes('evacuate') ? 'closure'
      : type === 'arrive' ? 'arrive' : '';
  box.innerHTML = vehicle.events.map((e) => `
    <div class="log-entry ${cls(e.type)}">
      <div><span class="t">t${e.tick}</span> · ${e.type} ${e.edgeId ? '· 边 ' + e.edgeId : ''}</div>
      <div>${e.detail}</div>
      <div class="hint">可达:${e.reachable} 代价:${e.cost ?? '-'} 扩展:${e.expansions}</div>
    </div>`).join('');
}

function renderDebug() {
  const d = state.result.debug[state.currentTick];
  const load = state.result.edgeLoadLog[state.currentTick].load;
  const closedNow = state.overrides.closures
    .filter((c) => state.currentTick >= c.from && state.currentTick <= c.to)
    .map((c) => c.edgeId);
  $('debug-panel').innerHTML = `
    <div class="debug-grid">
      <div>tick: <b>${d.tick}</b></div>
      <div>占用边数: <b>${d.activeEdges}</b></div>
      <div>行驶: <b>${d.moving}</b></div>
      <div>等待: <b>${d.waiting}</b></div>
      <div>到达: <b>${d.arrived}</b></div>
      <div>不可达: <b>${d.unreachable}</b></div>
    </div>
    <div style="margin-top:6px">当前封闭边: ${closedNow.length ? closedNow.join(', ') : '无'}</div>
    <div style="margin-top:4px">边实时占用: ${load.length ? load.map((l) => `${l.id}=${l.count}`).join(' · ') : '无'}</div>
    <div style="margin-top:4px" class="hint">版本 v${state.dataVersion.version} · ${state.dataVersion.reason}</div>`;
}

function renderIssues() {
  $('issues-panel').innerHTML = state.sanitizeIssues.length
    ? state.sanitizeIssues.map((i) =>
      `<div class="issue ${i.level}">[${i.level}] ${i.scope} ${i.ref ?? ''}：${i.reason}</div>`).join('')
    : '<div class="hint">无清洗问题</div>';
}

function renderEdgeEditor() {
  const select = $('edge-select');
  const edges = state.dataset.edges;
  select.innerHTML = edges.map((e) =>
    `<option value="${e.id}"${e.id === state.selectedEdgeId ? ' selected' : ''}>${e.id} (${e.from}→${e.to})</option>`).join('');
  const edge = state.result.graph.edgeById.get(state.selectedEdgeId);
  if (edge) $('edge-weight').value = state.overrides.weights[edge.id] ?? edge.weight;
  const closure = state.overrides.closures.find((c) => c.edgeId === state.selectedEdgeId);
  $('close-from').value = closure ? closure.from : 0;
  $('close-to').value = closure ? closure.to : 10;
}

function renderTickControls() {
  $('tick-range').max = state.result.horizon - 1;
  $('tick-range').value = state.currentTick;
  $('tick-label').textContent = `tick ${state.currentTick} / ${state.result.horizon - 1}`;
}

function renderAll() {
  renderCanvas();
  renderStats();
  renderMeta();
  renderDecisionLog();
  renderDebug();
  renderIssues();
  renderEdgeEditor();
  renderTickControls();
}

function bindEvents() {
  $('sample-select').addEventListener('change', (e) => loadSample(e.target.value));
  $('edge-select').addEventListener('change', (e) => {
    state.selectedEdgeId = e.target.value;
    renderEdgeEditor();
    renderCanvas();
  });
  $('vehicle-select').addEventListener('change', (e) => {
    state.selectedVehicleId = e.target.value;
    renderDecisionLog();
    renderCanvas();
  });
  $('apply-weight').addEventListener('click', () => {
    const id = state.selectedEdgeId;
    const w = Number($('edge-weight').value);
    if (!(w > 0)) { alert('权重必须为正数'); return; }
    state.overrides.weights[id] = Math.min(w, 100);
    state.lastExport = null;
    recompute(`道路 ${id} 权重改为 ${w}`);
  });
  $('reset-weight').addEventListener('click', () => {
    delete state.overrides.weights[state.selectedEdgeId];
    recompute(`道路 ${state.selectedEdgeId} 权重重置`);
  });
  $('apply-closure').addEventListener('click', () => {
    const id = state.selectedEdgeId;
    const from = Math.max(0, Math.trunc(Number($('close-from').value)));
    const to = Math.trunc(Number($('close-to').value));
    if (!(to >= from)) { alert('封路止时刻需不小于起时刻'); return; }
    state.overrides.closures = state.overrides.closures.filter((c) => c.edgeId !== id);
    state.overrides.closures.push({ edgeId: id, from, to });
    state.lastExport = null;
    recompute(`道路 ${id} 封路 [${from},${to}]`);
  });
  $('remove-closure').addEventListener('click', () => {
    state.overrides.closures = state.overrides.closures.filter((c) => c.edgeId !== state.selectedEdgeId);
    recompute(`解除道路 ${state.selectedEdgeId} 封路`);
  });
  $('filter-state').addEventListener('change', (e) => {
    state.filters.state = e.target.value;
    renderMeta();
    renderCanvas();
  });
  $('filter-vehicle').addEventListener('change', (e) => {
    state.filters.vehicleId = e.target.value;
    renderMeta();
    renderCanvas();
  });
  $('heatmap-toggle').addEventListener('change', (e) => {
    state.heatmapEnabled = e.target.checked;
    renderCanvas();
  });
  $('tick-range').addEventListener('input', (e) => {
    state.currentTick = Number(e.target.value);
    renderCanvas();
    renderDebug();
    renderTickControls();
  });
  $('step-back').addEventListener('click', () => setTick(state.currentTick - 1));
  $('step-fwd').addEventListener('click', () => setTick(state.currentTick + 1));
  $('play').addEventListener('click', togglePlay);

  $('scene').addEventListener('click', onCanvasClick);
  $('export-csv').addEventListener('click', exportCsvs);
  $('export-png').addEventListener('click', exportPng);
  $('save-project').addEventListener('click', saveProject);
  $('reload-project').addEventListener('click', reloadProject);
  $('project-file').addEventListener('change', importProject);
  $('run-verify').addEventListener('click', runVerify);
  $('demo-closure').addEventListener('click', demoClosure);
}

function setTick(t) {
  state.currentTick = Math.max(0, Math.min(state.result.horizon - 1, t));
  renderCanvas();
  renderDebug();
  renderTickControls();
}

function togglePlay() {
  if (state.playTimer) {
    clearInterval(state.playTimer);
    state.playTimer = null;
    $('play').textContent = '▶ 播放';
    return;
  }
  $('play').textContent = '⏸ 暂停';
  state.playTimer = setInterval(() => {
    if (state.currentTick >= state.result.horizon - 1) {
      state.currentTick = 0;
    }
    setTick(state.currentTick + 1);
  }, 350);
}

function onCanvasClick(event) {
  const canvas = $('scene');
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (canvas.width / rect.width);
  const y = (event.clientY - rect.top) * (canvas.height / rect.height);
  const snap = state.result.ticks[state.currentTick];
  let best = null;
  let bestD = 14;
  for (const pos of snap.positions) {
    const d = Math.hypot(pos.x - x, pos.y - y);
    if (d < bestD) { bestD = d; best = { kind: 'vehicle', id: pos.id }; }
  }
  if (best) {
    state.selectedVehicleId = best.id;
    renderDecisionLog();
    renderCanvas();
    return;
  }
  for (const edge of state.result.graph.edgeById.values()) {
    const a = state.result.graph.nodeById.get(edge.from);
    const b = state.result.graph.nodeById.get(edge.to);
    if (distToSegment(x, y, a.x, a.y, b.x, b.y) < 8) {
      state.selectedEdgeId = edge.id;
      $('edge-select').value = edge.id;
      renderEdgeEditor();
      renderCanvas();
      return;
    }
  }
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function exportCsvs() {
  const bundle = buildCsvBundle(state.result);
  const verify = verifyExport(state.result, bundle);
  const stamp = `v${state.dataVersion.version}`;
  download(`vehicles_${state.sampleId}_${stamp}.csv`, bundle.vehiclesCsv, 'text/csv');
  download(`events_${state.sampleId}_${stamp}.csv`, bundle.eventsCsv, 'text/csv');
  download(`heatmap_${state.sampleId}_${stamp}.csv`, bundle.heatmapCsv, 'text/csv');
  state.lastExport = {
    dataVersion: state.dataVersion.version,
    vehicles: verify.scope.vehicles,
    events: verify.scope.events,
    edges: verify.scope.heatEdges,
  };
  $('export-verify').innerHTML = verify.checks.map((c) =>
    `<div class="${c.pass ? 'ok' : 'fail'}">${c.pass ? '✓' : '✗'} ${c.name}：期望 ${c.expected} / 实际 ${c.actual}</div>`
  ).join('') + `<div class="${verify.pass ? 'ok' : 'fail'}"><b>总体：${verify.pass ? '导出前后完全一致' : '存在不一致'}</b></div>`;
  renderMeta();
}

function exportPng() {
  const dataUrl = exportPngDataUrl($('scene'), {
    result: state.result,
    tick: state.currentTick,
    heatmap: true,
    closures: state.overrides.closures,
    selectedEdgeId: state.selectedEdgeId,
    selectedVehicleId: state.selectedVehicleId,
    filters: state.filters,
  });
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `heatmap_${state.sampleId}_v${state.dataVersion.version}.png`;
  a.click();
}

function currentProjectState() {
  return {
    sampleId: state.dataset.id,
    dataset: state.dataset,
    sanitizeIssues: state.sanitizeIssues,
    overrides: { weights: { ...state.overrides.weights }, closures: state.overrides.closures.map((c) => ({ ...c })) },
    filters: { ...state.filters },
    selectedVehicleId: state.selectedVehicleId,
    selectedEdgeId: state.selectedEdgeId,
    heatmapEnabled: state.heatmapEnabled,
    dataVersion: state.dataVersion.version,
  };
}

function saveProject() {
  const json = JSON.stringify(buildProject(currentProjectState()), null, 2);
  state.lastProjectJson = json;
  download(`project_${state.sampleId}_v${state.dataVersion.version}.json`, json, 'application/json');
  $('reload-project').disabled = false;
}

function applyRestored(restored) {
  state.dataset = restored.dataset;
  state.sanitizeIssues = restored.sanitizeIssues;
  state.overrides = restored.overrides;
  state.filters = { state: restored.filters.state || 'all', vehicleId: restored.filters.vehicleId || '' };
  state.selectedVehicleId = restored.selectedVehicleId;
  state.selectedEdgeId = restored.selectedEdgeId;
  state.heatmapEnabled = restored.heatmapEnabled;
  state.sampleId = restored.sampleId;
  state.dataVersion = {
    version: restored.dataVersion,
    reason: '载入工程',
    history: [{ version: restored.dataVersion, reason: '载入工程', at: new Date().toISOString() }],
  };
  $('filter-state').value = state.filters.state;
  $('heatmap-toggle').checked = state.heatmapEnabled;
  state.currentTick = 0;
  recompute('载入工程后重算');
}

function reloadProject() {
  if (!state.lastProjectJson) return;
  applyRestored(parseProject(state.lastProjectJson));
}

function importProject(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const restored = parseProject(reader.result);
      state.lastProjectJson = reader.result;
      $('reload-project').disabled = false;
      applyRestored(restored);
      $('verify-output').textContent = '工程载入成功，已按存档配置重新计算。';
    } catch (err) {
      alert(`工程载入失败：${err.message}`);
    }
  };
  reader.readAsText(file);
}

function demoClosure() {
  loadSample('B', '封路演示准备');
  state.overrides.closures = [{ ...recommendedClosureB }];
  state.currentTick = recommendedClosureB.from;
  recompute(`实际封路：AB [${recommendedClosureB.from},${recommendedClosureB.to}]`);
}

async function runVerify() {
  const out = $('verify-output');
  out.textContent = '运行中…';
  const report = await runInBrowser();
  out.textContent = report;
}

function init() {
  bindEvents();
  loadSample('A', '初始化加载');
  const fv = $('filter-vehicle');
  fv.innerHTML = '<option value="">（不指定）</option>';
}

init();
