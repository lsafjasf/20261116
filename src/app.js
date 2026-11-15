import { createStore } from './state.js';
import { renderChart, exportPng, COLORS } from './chart.js';

const store = createStore();
const $ = (id) => document.getElementById(id);

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function syncControls() {
  const rules = store.rules;
  $('sampleSelect').value = store.sampleId;
  $('dedupe').checked = rules.dedupe;
  $('nullStrategy').value = rules.nullStrategy;
  $('spikeStrategy').value = rules.spikeStrategy;
  $('spikeWindow').value = rules.spikeWindow;
  $('spikeThreshold').value = rules.spikeThreshold;
  document.querySelectorAll('.window-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.window === store.windowId);
    button.setAttribute('aria-selected', button.dataset.window === store.windowId);
  });
}

function renderStatus() {
  const scope = store.exportScope;
  $('currentFilter').textContent =
    `${store.sampleId} / ${store.windowId} / 序列 ${store.seriesIds.join(',')}`;
  $('dataVersion').textContent = store.dataVersion;
  $('exportScope').textContent =
    `窗口行 ${scope.counts.windowRows} · 清洗总行 ${scope.counts.cleanedRows} · ` +
    `原始行 ${scope.counts.rawRows} · 去重 ${scope.counts.duplicatesRemoved} · ` +
    `MAE ${scope.metrics.mae} · 最大偏差 ${scope.metrics.maxDev}`;
  $('revision').textContent = String(store.revision);

  const evaluation = store.windowEvaluation;
  $('overallMetrics').textContent =
    `窗口行数 ${evaluation.rowCount} / 全量 ${evaluation.totalRows} · ` +
    `整体 MAE ${evaluation.overall.mae} · 整体最大偏差 ${evaluation.overall.maxDev}`;
  const tbody = $('seriesMetrics').querySelector('tbody');
  tbody.innerHTML = '';
  for (const seriesId of store.seriesIds) {
    const row = evaluation.perSeries[seriesId];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${seriesId}</td><td>${row.count}</td><td>${row.mae}</td><td>${row.maxDev}</td>`;
    tbody.appendChild(tr);
  }
}

function renderDebug() {
  $('pipelineLog').textContent = JSON.stringify(store.pipeline.log, null, 2);
  const intermediate = {
    revision: store.revision,
    sampleId: store.sampleId,
    windowId: store.windowId,
    rawRowCount: store.rawRows.length,
    dedupedCount: store.pipeline.dedupe.rows.length,
    removedDuplicates: store.pipeline.dedupe.removedCount,
    cleanedRowCount: store.cleanedRows.length,
    windowCounts: Object.fromEntries(
      Object.entries(store.windows).map(([id, rows]) => [id, rows.length])
    ),
    perSeries: Object.fromEntries(
      Object.entries(store.pipeline.perSeries).map(([id, detail]) => [
        id,
        {
          nullFilled: detail.nullCount,
          spikes: detail.spikeCount,
          firstRows: detail.series.slice(0, 3).map((entry) => ({
            index: entry.row.index,
            raw: entry.raw,
            clean: entry.clean,
            filled: entry.filled,
            robustZ: entry.z
          }))
        }
      ])
    ),
    dataVersion: store.dataVersion
  };
  $('debugState').textContent = JSON.stringify(intermediate, null, 2);
  $('replacements').textContent = JSON.stringify(
    Object.fromEntries(
      Object.entries(store.pipeline.perSeries).map(([id, detail]) => [
        id,
        detail.replacements
      ])
    ),
    null,
    2
  );
}

function renderAll() {
  syncControls();
  renderStatus();
  renderChart($('chart'), store);
  renderDebug();
  window.__lastRender = {
    revision: store.revision,
    dataVersion: store.dataVersion,
    exportScope: structuredClone(store.exportScope),
    metrics: structuredClone(store.windowEvaluation),
    colorLegend: COLORS
  };
}

$('sampleSelect').addEventListener('change', (event) =>
  store.setSample(event.target.value)
);
document.querySelectorAll('.window-tab').forEach((button) =>
  button.addEventListener('click', () => store.setWindow(button.dataset.window))
);
$('dedupe').addEventListener('change', (event) =>
  store.patchRules({ dedupe: event.target.checked })
);
$('nullStrategy').addEventListener('change', (event) =>
  store.patchRules({ nullStrategy: event.target.value })
);
$('spikeStrategy').addEventListener('change', (event) =>
  store.patchRules({ spikeStrategy: event.target.value })
);
$('spikeWindow').addEventListener('change', (event) =>
  store.patchRules({ spikeWindow: Number(event.target.value) })
);
$('spikeThreshold').addEventListener('change', (event) =>
  store.patchRules({ spikeThreshold: Number(event.target.value) })
);
$('resetRules').addEventListener('click', () => store.resetRules());

$('exportPng').addEventListener('click', () => {
  const dataUrl = exportPng($('chart'), store);
  const anchor = document.createElement('a');
  anchor.href = dataUrl;
  anchor.download = `compare-${store.sampleId}-${store.windowId}-${store.dataVersion}.png`;
  anchor.click();
  window.__lastExport = { type: 'png', scope: structuredClone(store.exportScope) };
});

$('exportLog').addEventListener('click', () => {
  const log = store.cleaningLog();
  window.__lastExport = { type: 'log', payload: log };
  download(
    `cleaning-log-${store.sampleId}-${store.windowId}.json`,
    JSON.stringify(log, null, 2),
    'application/json'
  );
});

$('saveProject').addEventListener('click', () => {
  const project = store.project();
  window.__lastExport = { type: 'project', payload: project };
  download(
    `project-${store.sampleId}.json`,
    JSON.stringify(project),
    'application/json'
  );
});

$('loadProject').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;
  file.text().then((text) => {
    store.loadProject(JSON.parse(text));
    event.target.value = '';
  });
});

store.subscribe(renderAll);
window.__store = store;

if (document.fonts?.ready) {
  document.fonts.ready.then(renderAll);
}
renderAll();
