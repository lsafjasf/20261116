import { TRACKS } from '../src/core/constants.js';
import { EXPORT_SCOPE, ERROR } from '../src/core/constants.js';
import { buildProject } from '../src/core/factory.js';
import { exportReport, verifyRoundTrip } from '../src/core/report.js';
import { SAMPLES } from '../src/core/sampleData.js';
import { TimelineModel } from '../src/core/timeline.js';

const STORAGE_KEY = 'multimedia-timeline-project-v1';
const state = {
  model: null,
  selectedUid: null,
  splitAtMs: null,
  exportScope: EXPORT_SCOPE.ALL,
  debugSteps: [],
  toastTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const fmt = (ms) => `${(ms / 1000).toFixed(2)}s`;
const kindOf = (trackId) => TRACKS.find((track) => track.id === trackId)?.kind ?? 'unknown';

function debug(title, payload, level = 'info') {
  state.debugSteps.push({ at: new Date().toISOString(), level, title, payload });
  renderDebug();
}

function toast(message, bad = false) {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { node.className = 'toast'; }, 2600);
}

function loadSample(sampleId) {
  const sample = SAMPLES.find((item) => item.sampleId === sampleId) ?? SAMPLES[0];
  const { model, ingested } = buildProject(sample);
  state.model = model;
  state.selectedUid = null;
  state.debugSteps = [];
  debug('入库完成', {
    ingestStats: ingested.stats,
    decisions: ingested.decisions,
    outlierDiagnostics: ingested.outlierDiagnostics,
  });
  debug('初始标记计算', model.markers);
  renderAll();
  toast(`已载入 ${sample.name}`);
}

function renderHeader() {
  const model = state.model;
  const filter = model.filterSummary();
  $('#meta-name').textContent = model.name;
  $('#meta-version').textContent = `v${model.dataVersion}`;
  $('#meta-duration').textContent = fmt(model.totalDurationMs);
  $('#meta-filter').textContent = `轨道=${filter.trackId}；类型=${filter.kinds.length ? filter.kinds.join('|') : '全部'}；关键字=${filter.keyword || '无'}`;
  $('#meta-scope').textContent = state.exportScope === EXPORT_SCOPE.ALL
    ? '全量导出（筛选不影响导出对象）'
    : '仅导出当前筛选结果';
  $('#meta-clips').textContent = `${model.visibleClips().length}/${model.clips.length} 可见`;
}

function renderRuler(timelineNode) {
  const ruler = document.createElement('div');
  ruler.className = 'ruler';
  const step = state.model.zoomPxPerSecond >= 40 ? 5 : 10;
  const width = (state.model.totalDurationMs / 1000) * state.model.zoomPxPerSecond;
  ruler.style.width = `${width}px`;
  for (let second = 0; second <= state.model.totalDurationMs / 1000; second += step) {
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = `${second * state.model.zoomPxPerSecond}px`;
    tick.textContent = `${second}s`;
    ruler.appendChild(tick);
  }
  timelineNode.appendChild(ruler);
}

function renderTrack(track, timelineNode) {
  const model = state.model;
  const row = document.createElement('div');
  row.className = 'track-row';
  row.style.width = `${(model.totalDurationMs / 1000) * model.zoomPxPerSecond + 118}px`;
  row.dataset.trackId = track.id;

  const label = document.createElement('div');
  label.className = 'track-label';
  label.textContent = track.label;
  row.appendChild(label);

  for (const gap of model.markers.gaps.filter((item) => item.trackId === track.id)) {
    const marker = document.createElement('div');
    marker.className = 'gap-marker';
    marker.style.left = `${118 + gap.startMs / 1000 * model.zoomPxPerSecond}px`;
    marker.style.width = `${Math.max(2, gap.gapMs / 1000 * model.zoomPxPerSecond)}px`;
    marker.title = `空洞 ${fmt(gap.startMs)} → ${fmt(gap.endMs)}（${fmt(gap.gapMs)}）`;
    marker.textContent = gap.gapMs >= 4000 ? '空洞' : '';
    row.appendChild(marker);
  }
  for (const overlap of model.markers.overlaps.filter((item) => item.trackId === track.id)) {
    const marker = document.createElement('div');
    marker.className = 'overlap-marker';
    marker.style.left = `${118 + overlap.startMs / 1000 * model.zoomPxPerSecond}px`;
    marker.style.width = `${Math.max(2, (overlap.endMs - overlap.startMs) / 1000 * model.zoomPxPerSecond)}px`;
    marker.title = `重叠 ${fmt(overlap.startMs)} → ${fmt(overlap.endMs)}`;
    marker.textContent = '重叠';
    row.appendChild(marker);
  }

  const visibleUids = new Set(model.visibleClips().map((clip) => clip.uid));
  for (const clip of model.clips.filter((item) => item.trackId === track.id)) {
    const node = document.createElement('div');
    node.className = `clip kind-${kindOf(track.id)}${clip.outlier ? ' outlier' : ''}${visibleUids.has(clip.uid) ? '' : ' hidden-by-filter'}`;
    node.style.left = `${118 + clip.startMs / 1000 * model.zoomPxPerSecond}px`;
    node.style.width = `${Math.max(8, clip.durationMs / 1000 * model.zoomPxPerSecond)}px`;
    node.draggable = true;
    node.dataset.uid = clip.uid;
    node.textContent = `${clip.name}${clip.outlier ? ' ⚠' : ''}`;
    node.title = `${clip.uid}\n起点 ${fmt(clip.startMs)} 时长 ${fmt(clip.durationMs)}`;
    if (state.selectedUid === clip.uid) node.style.outline = '2px solid #ffd166';
    row.appendChild(node);
  }
  timelineNode.appendChild(row);
}

function renderTimeline() {
  const host = $('#timeline');
  host.innerHTML = '';
  const timelineNode = document.createElement('div');
  timelineNode.className = 'timeline';
  renderRuler(timelineNode);
  for (const track of TRACKS) renderTrack(track, timelineNode);

  const playhead = document.createElement('div');
  playhead.className = 'playhead';
  playhead.id = 'playhead-line';
  playhead.style.left = `${118 + state.model.playheadMs / 1000 * state.model.zoomPxPerSecond}px`;
  playhead.style.top = '26px';
  timelineNode.appendChild(playhead);
  host.appendChild(timelineNode);
  bindTimelineEvents(host);
}

function bindTimelineEvents(host) {
  let dragUid = null;
  host.querySelectorAll('.clip').forEach((node) => {
    node.addEventListener('dragstart', (event) => {
      dragUid = node.dataset.uid;
      state.selectedUid = dragUid;
      node.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', dragUid);
      debug('开始拖拽', { uid: dragUid });
    });
    node.addEventListener('dragend', () => node.classList.remove('dragging'));
  });
  host.querySelectorAll('.track-row').forEach((row) => {
    row.addEventListener('dragover', (event) => event.preventDefault());
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      if (!dragUid) return;
      const rect = row.getBoundingClientRect();
      const x = event.clientX - rect.left - 118;
      const requestedMs = Math.round((x / state.model.zoomPxPerSecond) * 1000);
      const result = state.model.moveClip(dragUid, requestedMs, row.dataset.trackId);
      if (!result.ok) {
        debug('编辑被阻止', { uid: dragUid, requestedMs, code: result.code, rejected: state.model.lastRejected }, 'bad');
        toast(result.code === ERROR.OVERLAP_BLOCKED ? '非法重叠：该位置与同轨片段重叠，操作已阻止' : '越界：片段超出总时长，操作已阻止', true);
      } else {
        debug('移动已提交', { uid: dragUid, requestedMs, dataVersion: state.model.dataVersion }, 'ok');
        toast(`移动成功，数据版本升至 v${state.model.dataVersion}`);
      }
      dragUid = null;
      renderAll();
    });
  });
  host.addEventListener('click', (event) => {
    const clipNode = event.target.closest('.clip');
    if (clipNode) {
      state.selectedUid = clipNode.dataset.uid;
      const clip = state.model.findClip(state.selectedUid);
      state.splitAtMs = Math.min(clip.endMs - 100, clip.startMs + Math.floor(clip.durationMs / 2));
      debug('选中片段（分割点取中点）', { uid: clip.uid, splitAtMs: state.splitAtMs });
      renderAll();
    }
  });
}

function renderPreview() {
  const frame = state.model.frameAt();
  const list = (items, mapper) => (items.length ? items.map(mapper).join('') : '<span class="empty">无命中对象</span>');
  $('#preview-video').innerHTML = list(frame.video, (item) => `<span class="item">${item.name}<br><small>偏移 ${fmt(item.offsetMs)}</small></span>`);
  $('#preview-audio').innerHTML = list(frame.audio, (item) => `<span class="item">${item.name}<br><small>偏移 ${fmt(item.offsetMs)}</small></span>`);
  $('#preview-subtitle').innerHTML = list(frame.subtitles, (item) => `<span class="item">${item.trackId}: ${item.text || item.name}</span>`);
  $('#playhead-value').textContent = fmt(frame.playheadMs);
}

function renderDurationCheck() {
  const check = state.model.totalDurationCheck();
  const rows = check.perTrack.map((row) => `
    <tr>
      <td>${row.trackId}</td>
      <td>${row.clipCount}</td>
      <td>${fmt(row.occupiedMs)}</td>
      <td>${fmt(row.gapMs)}（${row.gapSegments} 段）</td>
      <td>${row.coversTimeline ? '全覆盖' : '存在空洞'}</td>
    </tr>`).join('');
  $('#duration-check').innerHTML = `
    <table class="issue-table">
      <thead><tr><th>轨道</th><th>对象数</th><th>占用</th><th>空洞</th><th>状态</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p>重叠 ${check.overlapCount} 处 · 空洞 ${check.gapCount} 段（合计 ${fmt(check.gapMsTotal)}）· 越界 ${check.outOfBoundsCount} 处 · 对象合计 ${check.clipCount}</p>`;
}

function renderIssues() {
  const issues = state.model.ingestIssues ?? [];
  $('#ingest-issues').innerHTML = issues.length
    ? `<table class="issue-table"><thead><tr><th>#</th><th>类型</th><th>说明</th></tr></thead><tbody>${issues.map((issue, index) => `<tr><td>${issue.index ?? '-'}</td><td>${issue.code}</td><td>${issue.message}</td></tr>`).join('')}</tbody></table>`
    : '<p class="empty">无入库问题</p>';
}

function renderDebug() {
  const node = $('#debug-panel');
  if (!node) return;
  const lines = state.debugSteps.map((step) => {
    const text = JSON.stringify(step.payload, null, 0);
    return `<div class="log-line ${step.level}">[${step.at.slice(11, 19)}] ${step.title} ${text.length > 600 ? `${text.slice(0, 600)}…` : text}</div>`;
  }).join('');
  node.innerHTML = lines || '<div class="empty">暂无中间状态</div>';
  node.scrollTop = node.scrollHeight;
  $('#debug-state').textContent = JSON.stringify({
    dataVersion: state.model?.dataVersion,
    playheadMs: state.model?.playheadMs,
    zoomPxPerSecond: state.model?.zoomPxPerSecond,
    selectedUid: state.selectedUid,
    markers: state.model?.markers,
    filter: state.model?.filterSummary(),
  }, null, 2);
}

function renderAll() {
  renderHeader();
  renderTimeline();
  renderPreview();
  renderDurationCheck();
  renderIssues();
  renderDebug();
}

function download(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  try { anchor.click(); } catch { /* jsdom 等无导航环境忽略 */ }
  URL.revokeObjectURL(url);
}

function bindControls() {
  $('#sample-select').addEventListener('change', (event) => loadSample(event.target.value));
  $('#filter-track').addEventListener('change', (event) => {
    state.model.setFilter({ trackId: event.target.value });
    debug('筛选变更', state.model.filterSummary());
    renderAll();
  });
  $('#filter-kind').addEventListener('change', (event) => {
    const kinds = event.target.value === 'all' ? new Set() : new Set([event.target.value]);
    state.model.setFilter({ kinds });
    debug('类型筛选变更', state.model.filterSummary());
    renderAll();
  });
  $('#filter-keyword').addEventListener('input', (event) => {
    state.model.setFilter({ keyword: event.target.value.trim() });
    renderAll();
  });
  $('#zoom-in').addEventListener('click', () => { state.model.setZoom(Math.min(120, state.model.zoomPxPerSecond + 10)); renderAll(); });
  $('#zoom-out').addEventListener('click', () => { state.model.setZoom(Math.max(6, state.model.zoomPxPerSecond - 10)); renderAll(); });
  $('#playhead-input').addEventListener('change', (event) => {
    const frame = state.model.setPlayhead(Number(event.target.value) * 1000);
    debug('播放头跳转', frame);
    renderAll();
  });
  $('#split-button').addEventListener('click', () => {
    if (!state.selectedUid) return toast('请先点击选择一个片段', true);
    const result = state.model.splitClip(state.selectedUid, state.splitAtMs);
    if (!result.ok) return toast(`分割失败：${result.code}`, true);
    debug('分割已提交', { uid: state.selectedUid, splitAtMs: state.splitAtMs, pieces: result.clips.map((clip) => clip.uid) }, 'ok');
    state.selectedUid = null;
    renderAll();
  });
  $('#illegal-button').addEventListener('click', () => {
    const videoClip = state.model.clips.find((clip) => clip.trackId === 'video-1');
    const candidate = state.model.clips.find((clip) => clip.trackId === 'video-1' && clip.uid !== videoClip.uid);
    if (!candidate) return toast('当前样例没有可用于演示的第二个视频片段', true);
    const result = state.model.moveClip(candidate.uid, videoClip.startMs);
    debug('非法重叠演示', { uid: candidate.uid, requestedStartMs: videoClip.startMs, code: result.code }, 'bad');
    toast(result.ok ? '意外成功（数据存在空洞）' : `已阻止：${result.code}`, !result.ok);
    renderAll();
  });
  $('#save-button').addEventListener('click', () => {
    const payload = state.model.toJSON();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    download(`${state.model.projectId}-saved.json`, payload);
    debug('工程已保存', { dataVersion: payload.dataVersion, clipCount: payload.clips.length, playheadMs: payload.playheadMs }, 'ok');
    toast('工程已保存到 localStorage 并下载 JSON');
  });
  $('#reload-button').addEventListener('click', () => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return toast('localStorage 中没有已保存工程', true);
    const restored = TimelineModel.fromJSON(JSON.parse(raw));
    const verification = verifyRoundTrip(state.model, restored);
    state.model = restored;
    debug('工程重新载入', verification, verification.keyValuesConsistent ? 'ok' : 'bad');
    renderAll();
    toast(verification.keyValuesConsistent ? '重载成功：数量、关键数值、播放头、筛选一致' : '重载校验失败', !verification.keyValuesConsistent);
  });
  $('#scope-all').addEventListener('click', () => { state.exportScope = EXPORT_SCOPE.ALL; renderHeader(); });
  $('#scope-filtered').addEventListener('click', () => { state.exportScope = EXPORT_SCOPE.FILTERED; renderHeader(); });
  $('#export-button').addEventListener('click', () => {
    const report = exportReport(state.model, state.exportScope);
    download(`report-${state.model.projectId}-v${state.model.dataVersion}.json`, report);
    debug('导出报告', {
      scope: report.exportScopeLabel,
      before: report.beforeExport,
      after: report.exported,
      consistency: report.consistency,
    }, report.consistency.keyValuesConsistent ? 'ok' : 'bad');
    toast(`报告已导出：${report.exported.count} 个对象，校验和 ${report.exported.checksum}`);
  });
  $('#run-self-check').addEventListener('click', async () => {
    const { runAllScenarios } = await import('../tests/scenarios.js');
    const results = runAllScenarios();
    $('#self-check-results').innerHTML = results.map((item) => `<div class="${item.ok ? 'pass' : 'fail'}">${item.ok ? 'PASS' : 'FAIL'} ${item.name}</div>`).join('');
    toast(`浏览器自检 ${results.filter((item) => item.ok).length}/${results.length} 通过`);
  });
}

bindControls();
loadSample(SAMPLES[0].sampleId);
