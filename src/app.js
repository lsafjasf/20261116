import { CONFIG, SortingSimulation } from './sim.js';
import { MechanicalAudio } from './audio.js';
import { SortRenderer } from './renderer.js';

const STORAGE_KEY = 'twin-sort-checkpoint-v1';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  canvas: $('#stage'),
  clock: $('#clock'),
  lineLed: $('#line-led'),
  lineStatus: $('#line-status'),
  progressText: $('#progress-text'),
  progressFill: $('#progress-fill'),
  errorRate: $('#error-rate'),
  errorCount: $('#error-count'),
  cacheTotal: $('#cache-total'),
  overflowState: $('#overflow-state'),
  p1Durability: $('#p1-durability'),
  p1Gauge: $('#p1-gauge'),
  p1Scanned: $('#p1-scanned'),
  p2Durability: $('#p2-durability'),
  p2Gauge: $('#p2-gauge'),
  p2Packed: $('#p2-packed'),
  objectiveTitle: $('#objective-title'),
  objectiveCopy: $('#objective-copy'),
  soundBtn: $('#sound-btn'),
  liveSpeedBtn: $('#live-speed-btn'),
  newRunBtn: $('#new-run-btn'),
  replayOpenBtn: $('#replay-open-btn'),
  replayDock: $('#replay-dock'),
  replayVerdict: $('#replay-verdict'),
  replayLive: $('#replay-live'),
  replayPlay: $('#replay-play'),
  replayStep: $('#replay-step'),
  replaySpeed: $('#replay-speed'),
  replaySeek: $('#replay-seek'),
  replayTime: $('#replay-time'),
  timelineTrack: $('#timeline-track'),
  eventList: $('#event-list'),
  conflictCard: $('#conflict-card'),
  digestReadout: $('#digest-readout'),
  loadSuccess: $('#load-success'),
  loadFailure: $('#load-failure'),
  exportRun: $('#export-run'),
  toast: $('#toast'),
};

const renderer = new SortRenderer(elements.canvas);
const audio = new MechanicalAudio();
const liveSpeeds = [1, 2, 4, 8];

let sim;
let liveSpeed = 4;
let currentRecording = null;
let replayMode = false;
let replaySim = null;
let replayRecordingData = null;
let replayPlaying = false;
let replaySpeed = 1;
let replayAccumulator = 0;
let lastFrame = performance.now();
let accumulator = 0;
let lastSaveAt = 0;
let lastUiAt = 0;
let selectedEvent = null;
let lastNotifiedSequence = 0;
let lastConflictKey = null;
let toastTimer = null;
let lastEventListKey = '';
let seekingSlider = false;

const actionNames = {
  scan: '扫码',
  release: '放行',
  stop: '停线',
  resume: '复线',
  repair: '维护',
  laneA: '分流 A',
  laneB: '分流 B',
  pack: '装箱',
};

function createRun(seed = 20261116) {
  return new SortingSimulation({
    seed,
    runId: `RUN-${(seed >>> 0).toString(16).toUpperCase().padStart(8, '0')}`,
  });
}

function restoreCheckpoint() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { restored: false };
    const data = JSON.parse(raw);
    if (data.schema !== 1 || !data.snapshot?.state) return { restored: false };
    sim = SortingSimulation.fromSnapshot(data.snapshot);
    currentRecording = data.recording ?? null;
    lastNotifiedSequence = sim.eventSequence;
    return { restored: true, savedAt: data.savedAt, data };
  } catch (error) {
    console.warn('Checkpoint restore failed', error);
    return { restored: false };
  }
}

function saveCheckpoint(force = false) {
  const now = performance.now();
  if (!force && now - lastSaveAt < 800) return;
  lastSaveAt = now;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schema: 1,
        savedAt: new Date().toISOString(),
        snapshot: sim.snapshot(),
        recording: currentRecording,
      })
    );
  } catch (error) {
    console.warn('Checkpoint save failed', error);
  }
}

function formatClock(value, tenths = true) {
  const safe = Math.max(0, Number(value) || 0);
  const totalTenths = Math.round(safe * 10);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  if (!tenths) {
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  const tenth = totalTenths % 10;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenth}`;
}

function compactAction(entry) {
  const side = entry.side === 'p1' ? 'P1' : entry.side === 'p2' ? 'P2' : 'SYS';
  if (entry.kind === 'input') {
    return `${side} ${actionNames[entry.action] ?? entry.action} / 延迟 ${entry.delay}s`;
  }
  if (entry.kind === 'conflict') return '动作顺序反转';
  if (entry.kind === 'collision') return `碰撞 · ${collisionLabel(entry.collision)}`;
  if (entry.kind === 'overflow') return `${entry.lane} 缓存溢出`;
  if (entry.kind === 'overflow_chain') return '缓存反压连锁';
  if (entry.kind === 'line_stop') return 'P1 上游停线';
  if (entry.kind === 'line_resume') return 'P1 上游复线';
  if (entry.kind === 'pack_complete') return entry.result?.success ? '正确装箱' : '污染/错分装箱';
  if (entry.kind === 'shift_complete') return entry.result?.success ? '任务成功' : '任务失败';
  return entry.message ?? entry.kind;
}

function showToast(message, danger = false) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('danger', danger);
  elements.toast.classList.add('show');
  toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove('show');
  }, 2600);
}

function collisionLabel(type) {
  return (
    {
      overflow_chain: '缓存溢出连锁',
      belt_feed_collision: '放行口挤压',
      belt_rear_end: '主带追尾',
      diverter_override: '分流臂换向',
    }[type] ?? type
  );
}

function flashButton(side, action) {
  const button = document.querySelector(
    `[data-side="${side}"][data-press="${action}"]`
  );
  if (!button) return;
  button.classList.add('pressed');
  window.setTimeout(() => button.classList.remove('pressed'), 110);
}

function activeSimulation() {
  return replayMode && replaySim ? replaySim : sim;
}

function handleAction(side, action) {
  if (replayMode) {
    showToast('回放模式下输入已锁定，请先返回现场。');
    return null;
  }
  if (sim.phase !== 'running') {
    showToast('本班次已经结束，请开始新班次。', true);
    return null;
  }
  audio.unlock().then(() => audio.cue(action === 'pack' ? 'pack' : action));
  const input = sim.press(side, action);
  flashButton(side, action);
  if (input) {
    const event = sim.timeline[sim.timeline.length - 1];
    if (event) lastNotifiedSequence = Math.max(lastNotifiedSequence, sim.eventSequence);
    saveCheckpoint(true);
  }
  return input;
}

function finishIfNeeded() {
  if (sim.phase === 'running' || currentRecording) return;
  currentRecording = sim.recording();
  audio.cue(sim.phase === 'success' ? 'success' : 'failure');
  showToast(
    sim.phase === 'success'
      ? `成功：${sim.stats.packed} 件完成，错误率 ${(sim.errorRate() * 100).toFixed(1)}%`
      : `失败：${sim.failureReason}`,
    sim.phase !== 'success'
  );
  saveCheckpoint(true);
}

function newRun() {
  if (sim.phase === 'running') {
    const confirmed = window.confirm('当前班次尚未结束，确定放弃并开始新班次？');
    if (!confirmed) return;
  }
  const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  sim = createRun(seed);
  currentRecording = null;
  replayMode = false;
  replaySim = null;
  replayRecordingData = null;
  replayPlaying = false;
  selectedEvent = null;
  lastConflictKey = null;
  lastNotifiedSequence = 0;
  accumulator = 0;
  saveCheckpoint(true);
  renderTimeline([]);
  updateUi(true);
  showToast(`新班次 ${sim.runId} 开始`);
}

function judgeText() {
  if (replayMode) {
    return replayPlaying ? '回放中' : '回放暂停';
  }
  if (sim.phase === 'success') return '本班成功';
  if (sim.phase === 'failure') return '本班失败';
  return currentRecording ? '完整记录就绪' : '等待记录';
}

function setVerdict(text, tone = 'pending') {
  elements.replayVerdict.textContent = text;
  elements.replayVerdict.className = `verdict ${tone}`;
}

function renderTimeline(recording) {
  const track = elements.timelineTrack;
  track.replaceChildren();
  if (!recording?.timeline?.length) {
    const cursor = document.createElement('i');
    cursor.className = 'timeline-cursor';
    cursor.style.left = '0%';
    track.append(cursor);
    return;
  }
  const duration = Math.max(1, recording.duration);
  const fragment = document.createDocumentFragment();
  for (const entry of recording.timeline) {
    if (!['input', 'conflict', 'collision', 'overflow', 'overflow_chain', 'line_stop'].includes(entry.kind)) {
      continue;
    }
    const pin = document.createElement('span');
    pin.className = 'timeline-pin';
    if (entry.kind === 'input' && entry.side === 'p2') pin.classList.add('p2');
    if (entry.kind === 'conflict') pin.classList.add('conflict');
    if (entry.kind === 'collision' || entry.kind === 'overflow' || entry.kind === 'overflow_chain') {
      pin.classList.add('collision');
    }
    pin.style.left = `${Math.min(100, (entry.at / duration) * 100)}%`;
    pin.title = `${formatClock(entry.at)} · ${compactAction(entry)}`;
    fragment.append(pin);
  }
  const cursor = document.createElement('i');
  cursor.className = 'timeline-cursor';
  cursor.id = 'timeline-cursor';
  cursor.style.left = '0%';
  fragment.append(cursor);
  track.append(fragment);
}

function activateRecording(recording, options = {}) {
  if (!recording?.inputs) {
    showToast('记录格式无效。', true);
    return;
  }
  replayRecordingData = recording;
  replayMode = true;
  replaySim = SortingSimulation.fromRecording(recording);
  replayPlaying = false;
  replaySpeed = 1;
  replayAccumulator = 0;
  accumulator = 0;
  selectedEvent = null;
  lastConflictKey = null;
  renderTimeline(recording);
  elements.replaySeek.max = String(Math.round(recording.duration * 10));
  elements.replaySeek.value = '0';
  elements.replaySpeed.textContent = '倍速 1×';
  updateUi(true);
  if (options.scroll) {
    elements.replayDock.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  showToast(`${options.label ?? recording.runId} 已载入，暂停于 00:00.0`);
}

function returnToLive() {
  replayMode = false;
  replayPlaying = false;
  replayAccumulator = 0;
  accumulator = 0;
  updateUi(true);
}

function seekReplay(targetSeconds, pause = true) {
  if (!replayMode || !replayRecordingData) return;
  const target = Math.max(
    0,
    Math.min(targetSeconds, replayRecordingData.duration)
  );
  replaySim = SortingSimulation.fromRecording(replayRecordingData);
  replaySim.advanceTo(target);
  if (pause) replayPlaying = false;
  selectedEvent = null;
  updateUi(true);
}

function toggleReplay() {
  if (!replayMode || !replaySim) {
    if (currentRecording) activateRecording(currentRecording, { label: '本班记录' });
    else showToast('完成一轮后即可回放本班记录。');
    return;
  }
  if (replaySim.phase !== 'running') {
    replaySim = SortingSimulation.fromRecording(replayRecordingData);
    replayPlaying = true;
    replayAccumulator = 0;
    updateUi(true);
    return;
  }
  replayPlaying = !replayPlaying;
  updateUi(true);
}

function stepReplay() {
  if (!replayMode || !replaySim) {
    showToast('请先载入或完成一轮记录。');
    return;
  }
  replayPlaying = false;
  replaySim.advanceTick();
  updateUi(true);
}

function cycleReplaySpeed() {
  const speeds = [1, 2, 4, 8];
  replaySpeed = speeds[(speeds.indexOf(replaySpeed) + 1) % speeds.length];
  elements.replaySpeed.textContent = `倍速 ${replaySpeed}×`;
}

function verifyReplay() {
  if (!replayRecordingData) return null;
  const shadow = SortingSimulation.fromRecording(replayRecordingData);
  shadow.advanceTo(replayRecordingData.duration);
  const digest = shadow.finalDigest ?? shadow.digest();
  const expected = replayRecordingData.finalDigest;
  const match = digest === expected;
  setVerdict(match ? `HASH MATCH · ${digest}` : `HASH MISMATCH · ${digest}`, match ? '' : 'fail');
  return { digest, expected, match, phase: shadow.phase, time: shadow.time };
}

async function loadRecording(name) {
  const labelMap = {
    success: '成功局完整回放',
    failure: '失败局完整回放',
  };
  try {
    const response = await fetch(`./runs/${name}.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const recording = await response.json();
    activateRecording(recording, { label: labelMap[name], scroll: true });
  } catch (error) {
    showToast(`载入 ${name} 回放失败：${error.message}`, true);
  }
}

function exportRecording() {
  const recording =
    replayMode && replayRecordingData
      ? replayRecordingData
      : currentRecording ?? sim.recording();
  const blob = new Blob([JSON.stringify(recording, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${recording.runId}-${recording.success ? 'success' : 'failure'}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast('当前记录已导出。');
}

function timelineSource(view) {
  if (replayMode && replayRecordingData) {
    return replayRecordingData.timeline.filter((entry) => entry.at <= view.time + 0.05);
  }
  return sim.timeline;
}

function focusIncident(view) {
  if (selectedEvent) return selectedEvent;
  const incidents = timelineSource(view).filter((entry) =>
    ['conflict', 'collision', 'overflow', 'overflow_chain'].includes(entry.kind)
  );
  return incidents.at(-1) ?? null;
}

function incidentSide(entry) {
  if (entry.side) return entry.side;
  if (entry.kind === 'collision' || entry.kind === 'overflow_chain') return 'sys';
  return 'sys';
}

function eventKey(entry) {
  return `${entry.id}:${entry.at}:${entry.kind}`;
}

function renderEventList(view) {
  const source = timelineSource(view);
  const filtered = source.filter(
    (entry) =>
      !['checkpoint', 'spawn', 'replay_loaded'].includes(entry.kind) &&
      entry.at >= view.time - 18
  );
  const events = filtered.slice(-9).reverse();
  const key = events.map(eventKey).join('|') + `:${selectedEvent?.id ?? ''}`;
  if (key === lastEventListKey) return;
  lastEventListKey = key;
  elements.eventList.replaceChildren();
  if (events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'event-line';
    empty.innerHTML = '<time>--:--.-</time><span class="event-side sys">SYS</span><span class="event-copy">等待事件</span>';
    elements.eventList.append(empty);
    return;
  }
  for (const entry of events) {
    const line = document.createElement('button');
    line.type = 'button';
    line.className = 'event-line';
    if (entry.kind === 'conflict' || entry.kind === 'collision' || entry.kind === 'overflow_chain') {
      line.classList.add('alert');
    }
    line.dataset.eventId = entry.id;
    line.style.cssText =
      'width:100%;border-left:0;border-right:0;border-top:0;background:transparent;text-align:left;cursor:pointer;font:inherit;';
    const time = document.createElement('time');
    time.textContent = formatClock(entry.at);
    const side = document.createElement('span');
    side.className = `event-side ${entry.side ?? incidentSide(entry)}`;
    side.textContent =
      entry.side === 'p1' ? 'P1' : entry.side === 'p2' ? 'P2' : 'SYS';
    const copy = document.createElement('span');
    copy.className = 'event-copy';
    copy.textContent = compactAction(entry);
    line.append(time, side, copy);
    line.addEventListener('click', () => {
      seekReplay(entry.at, true);
      selectedEvent = entry;
      updateUi(true);
    });
    elements.eventList.append(line);
  }
}

function renderConflict(view) {
  const incident = focusIncident(view);
  if (!incident) {
    elements.conflictCard.className = 'conflict-card';
    elements.conflictCard.innerHTML =
      '<span class="micro-label">冲突定位</span><p>尚无动作顺序冲突或碰撞。点击时间线红色标记可定位。</p>';
    lastConflictKey = null;
    return;
  }
  const key = eventKey(incident);
  if (key === lastConflictKey) return;
  lastConflictKey = key;
  const title =
    incident.kind === 'conflict'
      ? '动作顺序反转'
      : incident.kind === 'collision'
        ? `碰撞 · ${collisionLabel(incident.collision)}`
        : incident.kind === 'overflow_chain'
          ? '缓存溢出连锁'
          : '缓存溢出';
  const incidentTime = incident.atExecution ?? incident.at;
  const positions = (incident.objects ?? [])
    .filter((item) => item.position?.x > 0)
    .map(
      (item) =>
        `${item.serial ?? '未知包裹'} (${Math.round(item.position.x)}, ${Math.round(item.position.y)})`
    )
    .join(' · ');
  let detail = '';
  if (incident.kind === 'conflict') {
    const inputOrder = incident.inputOrder
      .map((item) => `${item.side.toUpperCase()} ${actionNames[item.action]} @${formatClock(item.at)}`)
      .join(' → ');
    const executionOrder = incident.executionOrder
      .map((item) => `${item.side.toUpperCase()} ${actionNames[item.action]} @${formatClock(item.effectiveAt)}`)
      .join(' → ');
    detail = `<span>输入：${inputOrder}</span><span>执行：${executionOrder}</span>`;
  } else if (incident.result) {
    detail = `<span>${incident.result.result ?? incident.result.reason ?? '状态已改变'}</span>`;
  }
  elements.conflictCard.className = 'conflict-card active';
  elements.conflictCard.innerHTML = `
    <span class="micro-label">冲突定位 · ${formatClock(incidentTime)}</span>
    <strong>${title}</strong>
    <p>${detail}</p>
    <span class="coords">对象：${positions || '无活跃包裹'}${incident.point ? ` / 碰撞点 ${incident.point.x},${incident.point.y}` : ''}</span>
  `;
}

function updateUi(force = false) {
  const view = activeSimulation();
  const viewIsReplay = replayMode && view === replaySim;
  const remaining = Math.max(0, CONFIG.duration - view.time);
  elements.clock.textContent = formatClock(remaining);
  elements.progressText.textContent = `${view.stats.packed} / ${view.total}`;
  elements.progressFill.style.width = `${(view.stats.packed / view.total) * 100}%`;
  elements.errorRate.textContent = `${(view.errorRate() * 100).toFixed(1)}%`;
  elements.errorCount.textContent = `${view.stats.errors} 污染事件`;
  elements.errorRate.classList.toggle('danger', view.stats.errors > 2);
  elements.cacheTotal.textContent = `${view.cacheLoad()} / 12`;
  elements.cacheTotal.classList.toggle('danger', Boolean(view.overflow.A || view.overflow.B));
  elements.p1Durability.textContent = `${view.durability.p1.toFixed(0)}%`;
  elements.p2Durability.textContent = `${view.durability.p2.toFixed(0)}%`;
  elements.p1Gauge.style.width = `${view.durability.p1}%`;
  elements.p2Gauge.style.width = `${view.durability.p2}%`;
  elements.p1Gauge.classList.toggle('low', view.durability.p1 < 30);
  elements.p2Gauge.classList.toggle('low', view.durability.p2 < 30);
  elements.p1Scanned.textContent = String(view.stats.scanned);
  elements.p2Packed.textContent = String(view.stats.packed);

  const overflow = Boolean(view.overflow.A || view.overflow.B);
  let status = '运行中';
  let led = '';
  if (view.phase === 'success') {
    status = '班次成功';
  } else if (view.phase === 'failure') {
    status = '班次失败';
    led = 'stop';
  } else if (overflow) {
    status = '缓存溢出';
    led = 'stop';
  } else if (view.lineStop) {
    status = '上游停线';
    led = 'warn';
  } else if (view.packages.some((pkg) => pkg.status === 'blocked')) {
    status = '缓存阻塞';
    led = 'warn';
  }
  elements.lineStatus.textContent = status;
  elements.lineLed.className = `status-led ${led}`;
  elements.overflowState.textContent = overflow
    ? '需停线'
    : view.cacheLoad() >= 10
      ? '接近上限'
      : '稳定';

  if (view.phase === 'success') {
    elements.objectiveTitle.textContent = '任务完成';
    elements.objectiveCopy.textContent = `全部 ${view.total} 件已装箱，错误率 ${(view.errorRate() * 100).toFixed(1)}%。`;
  } else if (view.phase === 'failure') {
    elements.objectiveTitle.textContent = '任务失败';
    elements.objectiveCopy.textContent = `班次终止：${view.failureReason ?? 'unknown'}。可打开回放定位原因。`;
  } else if (overflow) {
    elements.objectiveTitle.textContent = '缓存溢出';
    elements.objectiveCopy.textContent = 'P1 必须在 3 秒内停线；P2 连续装箱泄压后再复线。';
  } else if (view.lineStop) {
    elements.objectiveTitle.textContent = '上游等待';
    elements.objectiveCopy.textContent = '缓存泄压后由 P1 按 W 复线。';
  } else {
    elements.objectiveTitle.textContent = `${view.total} 件内完成`;
    elements.objectiveCopy.textContent = '错误率低于 6.0%。缓存满 6 件时，P1 必须在 3 秒内停线。';
  }

  elements.soundBtn.textContent = audio.enabled ? '音频 开' : '音频 关';
  elements.soundBtn.setAttribute('aria-pressed', String(audio.enabled));
  elements.liveSpeedBtn.textContent = `班次 ${liveSpeed}×`;
  elements.replayPlay.textContent = replayPlaying ? '暂停' : '播放';
  elements.replayLive.disabled = !replayMode;
  elements.replayStep.disabled = !replayMode;
  elements.replaySpeed.disabled = !replayMode;
  elements.replaySeek.disabled = !replayMode;
  $$('[data-press]').forEach((button) => {
    button.disabled = replayMode;
  });

  if (viewIsReplay) {
    const duration = Math.max(0.1, replayRecordingData?.duration ?? view.time);
    const percent = Math.min(100, (view.time / duration) * 100);
    const cursor = $('#timeline-cursor');
    if (cursor) cursor.style.left = `${percent}%`;
    if (!seekingSlider) {
      elements.replaySeek.value = String(Math.round(view.time * 10));
    }
    elements.replayTime.textContent = `${formatClock(view.time)} / ${formatClock(duration)}`;
    if (view.phase !== 'running') {
      const expected = replayRecordingData?.finalDigest;
      const digest = view.finalDigest ?? view.digest();
      const match = digest === expected;
      setVerdict(match ? `HASH MATCH · ${digest}` : `HASH MISMATCH · ${digest}`, match ? '' : 'fail');
    } else {
      setVerdict(replayPlaying ? `回放中 · ${replaySpeed}×` : `回放暂停 · ${formatClock(view.time)}`);
    }
    elements.digestReadout.textContent = `LIVE HASH ${view.digest()} · EXPECTED ${replayRecordingData?.finalDigest ?? '—'}`;
  } else {
    elements.replaySeek.value = '0';
    elements.replayTime.textContent = `00:00.0 / ${formatClock(currentRecording?.duration ?? CONFIG.duration)}`;
    setVerdict(judgeText(), sim.phase === 'failure' ? 'fail' : sim.phase === 'success' ? '' : 'pending');
    elements.digestReadout.textContent = `FINAL HASH ${sim.finalDigest ?? currentRecording?.finalDigest ?? '—'}`;
    const cursor = $('#timeline-cursor');
    if (cursor) cursor.style.left = '0%';
  }
  renderEventList(view);
  renderConflict(view);
  document.body.dataset.phase = view.phase;
  document.body.dataset.mode = replayMode ? 'replay' : 'live';
  document.body.dataset.time = view.time.toFixed(1);
}

function notifyNewEvents(view) {
  if (replayMode) return;
  const fresh = sim.timeline
    .filter((entry) => Number(entry.id.slice(1)) > lastNotifiedSequence)
    .filter((entry) =>
      ['conflict', 'collision', 'overflow', 'overflow_chain', 'shift_complete'].includes(entry.kind)
    );
  if (fresh.length === 0) return;
  lastNotifiedSequence = sim.eventSequence;
  const event = fresh.at(-1);
  if (event.kind === 'conflict') {
    showToast(`动作顺序冲突 @ ${formatClock(event.atExecution ?? event.at)}`, true);
    audio.cue('collision');
  } else if (event.kind === 'collision') {
    showToast(`碰撞：${event.result?.result ?? event.collision}`, true);
    audio.cue('collision');
  } else if (event.kind === 'overflow') {
    showToast(`${event.lane} 缓存已满 · 3 秒内停线`, true);
    audio.cue('overflow');
  } else if (event.kind === 'overflow_chain') {
    showToast(`缓存溢出连锁：主带反压 ${event.result?.overflowHits ?? ''} 次`, true);
    audio.cue('collision');
  }
}

function frame(now) {
  const elapsed = Math.min(0.25, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;

  if (!replayMode) {
    if (sim.phase === 'running') {
      accumulator += elapsed * liveSpeed;
      let steps = 0;
      while (accumulator >= CONFIG.tick - 1e-9 && steps < 48) {
        sim.advanceTick();
        accumulator -= CONFIG.tick;
        steps += 1;
        if (sim.phase !== 'running') break;
      }
      finishIfNeeded();
      notifyNewEvents(sim);
      saveCheckpoint();
    }
  } else if (replaySim && replayPlaying) {
    replayAccumulator += elapsed * replaySpeed;
    let steps = 0;
    while (
      replayAccumulator >= CONFIG.tick - 1e-9 &&
      replaySim.phase === 'running' &&
      steps < 160
    ) {
      replaySim.advanceTick();
      replayAccumulator -= CONFIG.tick;
      steps += 1;
    }
    if (replaySim.phase !== 'running') {
      replayPlaying = false;
      replayAccumulator = 0;
    }
  }

  const view = activeSimulation();
  const incident = focusIncident(view);
  renderer.render(view, {
    replay: replayMode,
    replaySpeed,
    conflict: incident?.kind === 'conflict' || incident?.kind === 'collision' ? incident : null,
    now,
  });
  audio.update(
    view,
    replayMode ? replaySpeed : liveSpeed,
    replayMode ? replayPlaying : view.phase === 'running'
  );
  if (now - lastUiAt > 75) {
    lastUiAt = now;
    updateUi();
  }
  requestAnimationFrame(frame);
}

function cycleLiveSpeed() {
  liveSpeed = liveSpeeds[(liveSpeeds.indexOf(liveSpeed) + 1) % liveSpeeds.length];
  updateUi(true);
}

function bindEvents() {
  $$('[data-press]').forEach((button) => {
    button.addEventListener('click', () => {
      handleAction(button.dataset.side, button.dataset.press);
    });
  });
  elements.soundBtn.addEventListener('click', async () => {
    await audio.unlock();
    audio.toggle();
    updateUi(true);
  });
  elements.liveSpeedBtn.addEventListener('click', cycleLiveSpeed);
  elements.newRunBtn.addEventListener('click', newRun);
  elements.replayOpenBtn.addEventListener('click', () => {
    if (currentRecording) {
      activateRecording(currentRecording, { label: '本班完整回放', scroll: true });
    } else {
      elements.replayDock.scrollIntoView({ behavior: 'smooth', block: 'start' });
      showToast(
        currentRecording
          ? '完整回放已就绪。'
          : '完成一轮后自动生成完整回放；也可载入内置成功/失败局。'
      );
    }
  });
  elements.replayLive.addEventListener('click', returnToLive);
  elements.replayPlay.addEventListener('click', toggleReplay);
  elements.replayStep.addEventListener('click', stepReplay);
  elements.replaySpeed.addEventListener('click', cycleReplaySpeed);
  elements.replaySeek.addEventListener('pointerdown', () => {
    seekingSlider = true;
  });
  window.addEventListener('pointerup', () => {
    seekingSlider = false;
  });
  elements.replaySeek.addEventListener('input', () => {
    if (!replayMode) return;
    seekReplay(Number(elements.replaySeek.value) / 10, true);
  });
  elements.timelineTrack.addEventListener('click', (event) => {
    if (!replayMode || !replayRecordingData) return;
    const rect = elements.timelineTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seekReplay(ratio * replayRecordingData.duration, true);
  });
  elements.replayVerdict.addEventListener('click', () => {
    const result = verifyReplay();
    if (result) {
      showToast(
        result.match
          ? `回放校验通过：${result.digest}`
          : `回放校验失败：${result.digest} ≠ ${result.expected}`,
        !result.match
      );
    }
  });
  elements.loadSuccess.addEventListener('click', () => loadRecording('success'));
  elements.loadFailure.addEventListener('click', () => loadRecording('failure'));
  elements.exportRun.addEventListener('click', exportRecording);

  window.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const key = event.key.toLowerCase();
    const map = {
      q: ['p1', 'scan'],
      e: ['p1', 'release'],
      s: ['p1', 'stop'],
      w: ['p1', 'resume'],
      r: ['p1', 'repair'],
      j: ['p2', 'laneA'],
      l: ['p2', 'laneB'],
      k: ['p2', 'pack'],
      i: ['p2', 'repair'],
    };
    if (map[key]) {
      event.preventDefault();
      handleAction(...map[key]);
    } else if (event.code === 'Space' && replayMode) {
      event.preventDefault();
      toggleReplay();
    } else if (event.code === 'ArrowRight' && replayMode) {
      event.preventDefault();
      stepReplay();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveCheckpoint(true);
  });
  window.addEventListener('beforeunload', () => saveCheckpoint(true));
}

function installDebugApi() {
  window.__TWIN_SORT__ = {
    getSim: () => sim,
    getView: () => activeSimulation(),
    getMode: () => (replayMode ? 'replay' : 'live'),
    getAudioState: () => ({
      enabled: audio.enabled,
      context: audio.context?.state ?? 'uninitialized',
      humFrequency: audio.hum?.frequency.value ?? null,
    }),
    getRecording: () =>
      replayMode && replayRecordingData
        ? replayRecordingData
        : currentRecording ?? sim.recording(),
    press: (side, action) => handleAction(side, action),
    advanceSeconds(seconds) {
      if (replayMode) return;
      const target = sim.time + seconds;
      while (sim.phase === 'running' && sim.time < target - 1e-7) sim.advanceTick();
      finishIfNeeded();
      updateUi(true);
      return sim.snapshot();
    },
    runController(options = {}) {
      const maxSeconds = options.maxSeconds ?? CONFIG.duration;
      const target = sim.time + maxSeconds;
      while (sim.phase === 'running' && sim.time < target - 1e-7) {
        if (options.controller) options.controller(sim);
        sim.advanceTick();
      }
      finishIfNeeded();
      updateUi(true);
      return sim.recording();
    },
    activateRecording,
    seekReplay,
    stepReplay,
    toggleReplay,
    setReplaySpeed(speed) {
      replaySpeed = speed;
      elements.replaySpeed.textContent = `倍速 ${replaySpeed}×`;
    },
    verifyReplay,
    newRun,
    saveCheckpoint,
    loadRecording,
    returnToLive,
  };
}

const restoreResult = restoreCheckpoint();
if (!sim) sim = createRun(20261116);
if (currentRecording?.timeline) renderTimeline(currentRecording);
else renderTimeline([]);
bindEvents();
installDebugApi();
updateUi(true);
saveCheckpoint(true);
requestAnimationFrame((now) => {
  lastFrame = now;
  requestAnimationFrame(frame);
});

if (restoreResult.restored) {
  showToast(
    `已恢复检查点：${formatClock(sim.time)} · ${sim.stats.packed}/${sim.total} 件 · 耐久 ${sim.durability.p1.toFixed(0)}/${sim.durability.p2.toFixed(0)}%`
  );
} else {
  showToast('双人班次已就绪：P1 扫码/放行，P2 分流/装箱。');
}
