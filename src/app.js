import {
  AssemblyEngine,
  FIXED_MS,
  ACTION_WINDOW_MS,
  SYNC_MS,
  OFFSET_SAFE,
  PRESSURE_MIN,
  PRESSURE_MAX,
  PRESSURE_CRUSH
} from './engine.js';
import { StageRenderer } from './renderer.js';
import { BenchAudio } from './audio.js';
import { DEMO_REPLAY, FAILURE_REPLAY } from './demo-replay.js';

const STORAGE_KEY = 'tandem-bench-07.session.v1';
const MAX_HISTORY = 4;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function formatTime(milliseconds) {
  const value = Math.max(0, Math.round(milliseconds));
  const minutes = Math.floor(value / 60000);
  const seconds = Math.floor((value % 60000) / 1000);
  const millis = value % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function createRecording(seed) {
  return {
    id: `live-${Date.now()}`,
    title: '本次实时运行',
    seed,
    startTick: 0,
    endTick: null,
    durationMs: null,
    events: [],
    expected: null,
    recordedTimeline: null,
    finalized: false
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class AssemblyGame {
  constructor() {
    this.dom = this.gatherDom();
    this.renderer = new StageRenderer(this.dom.stageCanvas);
    this.audio = new BenchAudio();
    this.mode = 'live';
    this.replay = null;
    this.lastFrame = performance.now();
    this.lastDomUpdate = 0;
    this.lastPersist = 0;
    this.liveAccumulator = 0;
    this.resumePauseUntil = 0;
    this.lastAnnouncedPhase = null;
    this.started = false;
    this.toastTimer = null;

    const session = this.readSession();
    if (session) {
      this.engine = AssemblyEngine.fromSnapshot(session.engine, { releaseInputs: true });
      this.currentRecording = session.recording || createRecording(this.engine.state.seed);
      this.history = Array.isArray(session.history) ? session.history.slice(0, MAX_HISTORY) : [];
      this.started = Boolean(session.started);
      this.resumePauseUntil = performance.now() + 1000;
      this.dom.startOverlay.classList.toggle('hidden', this.started);
      window.setTimeout(() => {
        const state = this.engine.state;
        this.showToast(
          `现场已恢复：进度 ${state.completed}/3 · 耐久 ${state.durability}% · 备件 ${state.inventory}`
        );
      }, 160);
    } else {
      this.engine = new AssemblyEngine({ autoStart: false });
      this.currentRecording = createRecording(this.engine.state.seed);
      this.history = [];
      this.dom.startOverlay.classList.remove('hidden');
    }

    this.bindControls();
    this.bindInputs();
    this.updateDom(performance.now());
    this.requestFrame = this.requestFrame.bind(this);
    requestAnimationFrame(this.requestFrame);
  }

  gatherDom() {
    const byId = (id) => document.getElementById(id);
    return {
      stageCanvas: byId('stageCanvas'),
      startOverlay: byId('startOverlay'),
      startButton: byId('startButton'),
      resetButton: byId('resetButton'),
      soundButton: byId('soundButton'),
      statusChip: byId('statusChip'),
      missionCount: byId('missionCount'),
      kitRail: byId('kitRail'),
      leftKeyState: byId('leftKeyState'),
      rightKeyState: byId('rightKeyState'),
      leftKeyModule: document.querySelector('.operator-left .key-module'),
      rightKeyModule: document.querySelector('.operator-right .key-module'),
      offsetValue: byId('offsetValue'),
      offsetFill: byId('offsetFill'),
      gripValue: byId('gripValue'),
      gripFill: byId('gripFill'),
      leftNote: byId('leftNote'),
      pressureValue: byId('pressureValue'),
      pressureFill: byId('pressureFill'),
      rightNote: byId('rightNote'),
      durabilityValue: byId('durabilityValue'),
      durabilityFill: byId('durabilityFill'),
      stageClock: byId('stageClock'),
      windowValue: byId('windowValue'),
      phaseBanner: byId('phaseBanner'),
      phaseEyebrow: byId('phaseEyebrow'),
      phaseTitle: byId('phaseTitle'),
      phaseDetail: byId('phaseDetail'),
      canvasOffset: byId('canvasOffset'),
      canvasPressure: byId('canvasPressure'),
      syncValue: byId('syncValue'),
      syncFill: byId('syncFill'),
      constraintText: byId('constraintText'),
      demoButton: byId('demoButton'),
      failureDemoButton: byId('failureDemoButton'),
      currentReplayButton: byId('currentReplayButton'),
      pauseButton: byId('pauseButton'),
      stepButton: byId('stepButton'),
      exitReplayButton: byId('exitReplayButton'),
      speedButtons: [...document.querySelectorAll('[data-speed]')],
      scrubber: byId('scrubber'),
      scrubTime: byId('scrubTime'),
      scrubDuration: byId('scrubDuration'),
      timelineMode: byId('timelineMode'),
      replayVerdict: byId('replayVerdict'),
      leftLane: byId('leftLane'),
      rightLane: byId('rightLane'),
      collisionLane: byId('collisionLane'),
      conflictCount: byId('conflictCount'),
      conflictList: byId('conflictList'),
      toast: byId('toast')
    };
  }

  readSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1 || !parsed.engine) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  persistSession() {
    if (this.mode !== 'live') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        started: this.started,
        engine: this.engine.serialize(),
        recording: this.currentRecording,
        history: this.history.slice(0, MAX_HISTORY)
      }));
      this.lastPersist = performance.now();
    } catch {
      this.showToast('本地存储不可用，当前进度不会跨刷新保留', true);
    }
  }

  bindControls() {
    this.dom.startButton.addEventListener('click', () => {
      this.audio.unlock();
      this.startInitialRun();
    });
    this.dom.resetButton.addEventListener('click', () => this.resetStation());
    this.dom.soundButton.addEventListener('click', async () => {
      await this.audio.unlock();
      const muted = this.audio.toggleMuted();
      this.dom.soundButton.classList.toggle('muted', muted);
      this.dom.soundButton.setAttribute('aria-label', muted ? '打开声音' : '关闭声音');
    });
    this.dom.demoButton.addEventListener('click', () => this.startReplay(DEMO_REPLAY, '示范回放'));
    this.dom.failureDemoButton.addEventListener('click', () => this.startReplay(FAILURE_REPLAY, '失败样本'));
    this.dom.currentReplayButton.addEventListener('click', () => {
      if (!this.currentRecording?.expected) return;
      this.startReplay(clone(this.currentRecording), '本次回放');
    });
    this.dom.pauseButton.addEventListener('click', () => this.toggleReplayPause());
    this.dom.stepButton.addEventListener('click', () => this.stepReplay());
    this.dom.exitReplayButton.addEventListener('click', () => this.exitReplay());
    this.dom.speedButtons.forEach((button) => {
      button.addEventListener('click', () => {
        if (!this.replay) return;
        this.replay.speed = Number(button.dataset.speed);
        this.updateReplayControls();
      });
    });
    this.dom.scrubber.addEventListener('input', () => {
      if (!this.replay) return;
      const target = Math.round(
        Number(this.dom.scrubber.value) / 1000 * this.replay.record.endTick
      );
      this.seekReplay(target);
    });
    window.addEventListener('beforeunload', () => this.persistSession());
    document.addEventListener('visibilitychange', () => {
      this.lastFrame = performance.now();
      if (document.hidden) this.persistSession();
    });
  }

  bindInputs() {
    window.addEventListener('keydown', (event) => {
      if (event.repeat) return;
      const code = event.code;

      if (this.mode === 'replay') {
        if (code === 'Space') {
          event.preventDefault();
          this.toggleReplayPause();
        } else if (code === 'ArrowRight') {
          event.preventDefault();
          this.stepReplay();
        } else if (code === 'Escape') {
          this.exitReplay();
        }
        return;
      }

      if (!this.started && (code === 'Enter' || code === 'Space')) {
        event.preventDefault();
        this.audio.unlock();
        this.startInitialRun();
        return;
      }

      if (code === 'KeyA' || code === 'KeyL') {
        event.preventDefault();
        this.audio.unlock();
        this.handlePress(code === 'KeyA' ? 'left' : 'right', 'keyboard');
      }
    });

    window.addEventListener('keyup', (event) => {
      if (this.mode !== 'live') return;
      if (event.code === 'KeyA') this.handleRelease('left', 'keyboard');
      if (event.code === 'KeyL') this.handleRelease('right', 'keyboard');
    });

    this.bindHoldControl(this.dom.leftKeyModule, 'left');
    this.bindHoldControl(this.dom.rightKeyModule, 'right');
    window.addEventListener('blur', () => this.releaseHeldInputs());
  }

  bindHoldControl(element, side) {
    element.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      element.setPointerCapture?.(event.pointerId);
      this.audio.unlock();
      this.handlePress(side, 'pointer');
    });
    const release = (event) => {
      event.preventDefault();
      this.handleRelease(side, 'pointer');
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
  }

  startInitialRun() {
    if (this.started && this.engine.state.phase !== 'idle') return;
    this.engine.startRun();
    this.currentRecording = createRecording(this.engine.state.seed);
    this.started = true;
    this.mode = 'live';
    this.replay = null;
    this.resumePauseUntil = 0;
    this.lastAnnouncedPhase = 'active';
    this.dom.startOverlay.classList.add('hidden');
    this.showToast('第一组已装载：左侧先夹紧，右侧控制压力');
    this.persistSession();
    this.updateDom(performance.now());
  }

  resetStation() {
    if (this.mode === 'replay') this.exitReplay();
    this.releaseHeldInputs();
    this.engine.startRun();
    this.currentRecording = createRecording(this.engine.state.seed);
    this.started = true;
    this.mode = 'live';
    this.replay = null;
    this.liveAccumulator = 0;
    this.resumePauseUntil = 0;
    this.lastAnnouncedPhase = 'active';
    this.dom.startOverlay.classList.add('hidden');
    this.dom.replayVerdict.textContent = '● 实时记录中';
    this.dom.replayVerdict.className = 'replay-verdict';
    this.showToast('工位已重置：4 套零件，目标 3 组并保留 1 组备件');
    this.persistSession();
    this.updateDom(performance.now());
  }

  handlePress(side, source) {
    if (this.mode !== 'live' || !this.started) return false;
    const state = this.engine.state;
    if (state.phase !== 'active' || state[`${side}Held`]) return false;
    const tick = state.tick;
    this.engine.press(side);
    this.currentRecording.events.push({ tick, kind: 'press', side, source });
    this.audio.action(side, 'press');
    this.persistSession();
    this.updateDom(performance.now());
    return true;
  }

  handleRelease(side, source) {
    if (this.mode !== 'live' || !this.started) return false;
    const state = this.engine.state;
    if (state.phase !== 'active' || !state[`${side}Held`]) return false;
    const tick = state.tick;
    this.engine.release(side);
    this.currentRecording.events.push({ tick, kind: 'release', side, source });
    this.audio.action(side, 'release');
    this.persistSession();
    this.updateDom(performance.now());
    return true;
  }

  releaseHeldInputs() {
    if (this.mode !== 'live') return;
    if (this.engine.state.leftHeld) this.handleRelease('left', 'blur');
    if (this.engine.state.rightHeld) this.handleRelease('right', 'blur');
  }

  requestFrame(timestamp) {
    const delta = clamp(timestamp - this.lastFrame, 0, 80);
    this.lastFrame = timestamp;

    if (this.mode === 'live' && this.started && timestamp >= this.resumePauseUntil) {
      this.liveAccumulator += delta;
      let steps = 0;
      while (this.liveAccumulator >= FIXED_MS && steps < 24) {
        this.engine.tick();
        this.liveAccumulator -= FIXED_MS;
        steps += 1;
      }
      this.postLiveTick();
      if (timestamp - this.lastPersist > 350) this.persistSession();
    } else if (this.mode === 'replay' && this.replay && !this.replay.paused && !this.replay.done) {
      this.replay.accumulator += delta * this.replay.speed;
      let steps = 0;
      while (this.replay.accumulator >= FIXED_MS && steps < 80 && !this.replay.done) {
        this.advanceReplayTick();
        this.replay.accumulator -= FIXED_MS;
        steps += 1;
      }
    }

    const state = this.activeState();
    this.renderer.draw(state, timestamp, { replay: this.mode === 'replay' });
    this.audio.update(state, timestamp);

    if (timestamp - this.lastDomUpdate > 70) {
      this.updateDom(timestamp);
    }
    requestAnimationFrame(this.requestFrame);
  }

  activeState() {
    return this.mode === 'replay' && this.replay
      ? this.replay.engine.state
      : this.engine.state;
  }

  postLiveTick() {
    const state = this.engine.state;
    if (state.phase !== this.lastAnnouncedPhase) {
      if (state.phase === 'success') this.audio.result('success');
      if (state.phase === 'complete') this.audio.result('complete');
      if (state.phase === 'failed') this.audio.result('failed');
      this.lastAnnouncedPhase = state.phase;
      this.persistSession();
    }
    this.finalizeRecordingIfNeeded();
  }

  finalizeRecordingIfNeeded() {
    const state = this.engine.state;
    if (!state.timeline.final || this.currentRecording.finalized) return;
    const final = state.timeline.final;
    this.currentRecording.title = final.status === 'complete'
      ? '本次：三组完成 + 备件保留'
      : '本次：装配失败';
    this.currentRecording.endTick = final.tick;
    this.currentRecording.durationMs = final.t * 1;
    this.currentRecording.expected = {
      phase: state.phase,
      completed: state.completed,
      inventory: state.inventory,
      durability: state.durability,
      fingerprint: final.fingerprint
    };
    this.currentRecording.recordedTimeline = {
      conflicts: clone(state.timeline.conflicts),
      collisions: clone(state.timeline.collisions),
      results: clone(state.timeline.results)
    };
    this.currentRecording.finalized = true;
    this.history = [
      clone(this.currentRecording),
      ...this.history.filter((item) => item.id !== this.currentRecording.id)
    ].slice(0, MAX_HISTORY);
    this.persistSession();
  }

  startReplay(record, label) {
    if (!record?.events || record.endTick === null) {
      this.showToast('这段记录尚未结束，暂时不能回放', true);
      return;
    }
    this.releaseHeldInputs();
    this.audio.unlock();
    const replayEngine = new AssemblyEngine({
      seed: record.seed ?? this.engine.state.seed,
      autoStart: false
    });
    replayEngine.startRun();
    this.replay = {
      record: clone(record),
      label,
      engine: replayEngine,
      eventIndex: 0,
      speed: 1,
      paused: false,
      done: false,
      accumulator: 0,
      verified: null
    };
    this.mode = 'replay';
    this.dom.startOverlay.classList.add('hidden');
    this.dom.replayVerdict.textContent = `● ${label} · 正在校验`;
    this.dom.replayVerdict.className = 'replay-verdict replay';
    this.updateReplayControls();
    this.updateDom(performance.now());
  }

  applyReplayEvents() {
    const replay = this.replay;
    const events = replay.record.events;
    while (
      replay.eventIndex < events.length &&
      events[replay.eventIndex].tick <= replay.engine.state.tick
    ) {
      const event = events[replay.eventIndex];
      if (replay.engine.state.phase === 'active') {
        if (event.kind === 'press') replay.engine.press(event.side);
        if (event.kind === 'release') replay.engine.release(event.side);
      }
      replay.eventIndex += 1;
    }
  }

  advanceReplayTick() {
    const replay = this.replay;
    if (!replay || replay.done) return false;
    this.applyReplayEvents();
    replay.engine.tick();
    if (
      replay.engine.state.tick >= replay.record.endTick ||
      Boolean(replay.engine.state.timeline.final)
    ) {
      replay.done = true;
      this.verifyReplay();
    }
    return true;
  }

  verifyReplay() {
    const replay = this.replay;
    const state = replay.engine.state;
    const expected = replay.record.expected;
    const actualFingerprint = replay.engine.fingerprint();
    const matches = Boolean(expected)
      && actualFingerprint === expected.fingerprint
      && state.phase === expected.phase
      && state.completed === expected.completed
      && state.inventory === expected.inventory
      && state.durability === expected.durability;
    replay.verified = matches;
    if (matches) {
      this.dom.replayVerdict.textContent = `✓ 回放校验通过 · ${actualFingerprint}`;
      this.dom.replayVerdict.className = 'replay-verdict';
    } else {
      this.dom.replayVerdict.textContent = `× 最终状态不一致 · ${actualFingerprint}`;
      this.dom.replayVerdict.className = 'replay-verdict error';
    }
    this.updateReplayControls();
  }

  resetReplayEngine() {
    const replay = this.replay;
    const engine = new AssemblyEngine({
      seed: replay.record.seed ?? this.engine.state.seed,
      autoStart: false
    });
    engine.startRun();
    replay.engine = engine;
    replay.eventIndex = 0;
    replay.done = false;
    replay.accumulator = 0;
    replay.verified = null;
    this.dom.replayVerdict.textContent = `● ${replay.label} · 正在校验`;
    this.dom.replayVerdict.className = 'replay-verdict replay';
  }

  seekReplay(targetTick) {
    if (!this.replay) return;
    const record = this.replay.record;
    const target = clamp(Math.round(targetTick), 0, record.endTick);
    this.resetReplayEngine();
    this.replay.paused = true;
    while (this.replay.engine.state.tick < target && !this.replay.done) {
      this.advanceReplayTick();
    }
    if (this.replay.engine.state.tick >= record.endTick) this.verifyReplay();
    this.updateReplayControls();
    this.updateDom(performance.now());
  }

  toggleReplayPause() {
    if (!this.replay || this.replay.done) return;
    this.replay.paused = !this.replay.paused;
    this.updateReplayControls();
  }

  stepReplay() {
    if (!this.replay || this.replay.done) return;
    this.replay.paused = true;
    this.advanceReplayTick();
    this.updateReplayControls();
    this.updateDom(performance.now());
  }

  exitReplay() {
    if (!this.replay) return;
    this.replay = null;
    this.mode = 'live';
    this.dom.startOverlay.classList.toggle('hidden', this.started);
    this.dom.replayVerdict.textContent = this.currentRecording?.expected
      ? '● 实时记录中 | 当前记录可回放'
      : '● 实时记录中';
    this.dom.replayVerdict.className = 'replay-verdict';
    this.updateReplayControls();
    this.updateDom(performance.now());
  }

  updateReplayControls() {
    const replay = this.replay;
    const active = Boolean(replay);
    this.dom.currentReplayButton.disabled = !this.currentRecording?.expected || active;
    this.dom.pauseButton.disabled = !active || replay?.done;
    this.dom.stepButton.disabled = !active || replay?.done;
    this.dom.exitReplayButton.disabled = !active;
    this.dom.scrubber.disabled = !active;
    this.dom.speedButtons.forEach((button) => {
      button.disabled = !active;
      button.classList.toggle('active', Number(button.dataset.speed) === (replay?.speed ?? 1));
    });
    if (!replay) {
      this.dom.pauseButton.textContent = 'Ⅱ';
      this.dom.timelineMode.textContent = 'LIVE · 固定步长 16ms';
      this.dom.scrubber.value = '0';
      this.dom.scrubTime.textContent = formatTime(0);
      this.dom.scrubDuration.textContent = formatTime(0);
      return;
    }
    this.dom.pauseButton.textContent = replay.paused ? '▶' : 'Ⅱ';
    this.dom.pauseButton.classList.toggle('active', replay.paused);
    this.dom.timelineMode.textContent = `REPLAY · ${replay.speed}× · ${replay.paused ? '已暂停' : '推进中'} · 固定步长 16ms`;
    const currentTick = replay.engine.state.tick;
    const ratio = replay.record.endTick > 0 ? currentTick / replay.record.endTick : 0;
    this.dom.scrubber.value = String(Math.round(ratio * 1000));
    this.dom.scrubTime.textContent = formatTime(currentTick * FIXED_MS);
    this.dom.scrubDuration.textContent = formatTime(replay.record.endTick * FIXED_MS);
  }

  updateDom(timestamp) {
    const state = this.activeState();
    const replayMode = this.mode === 'replay';
    const remaining = state.phase === 'active'
      ? Math.max(0, ACTION_WINDOW_MS - (state.tick - state.cycleStartTick) * FIXED_MS)
      : 0;
    const offsetSafe = state.offset <= OFFSET_SAFE;
    const pressureSafe = state.pressure >= PRESSURE_MIN && state.pressure <= PRESSURE_MAX;
    const pressureDanger = state.pressure > PRESSURE_MAX;
    const syncRatio = clamp(state.syncMs / SYNC_MS, 0, 1);

    this.dom.stageClock.textContent = `T+ ${formatTime(state.tick * FIXED_MS)}`;
    this.dom.windowValue.textContent = state.phase === 'active'
      ? `${(remaining / 1000).toFixed(1)}s`
      : state.phase === 'success' ? '锁定' : '—';
    this.dom.offsetValue.textContent = state.offset.toFixed(1);
    this.dom.gripValue.textContent = String(Math.round(100 - state.offset));
    this.dom.pressureValue.textContent = state.pressure.toFixed(1);
    this.dom.durabilityValue.textContent = String(Math.round(state.durability));
    this.dom.canvasOffset.textContent = state.offset.toFixed(1);
    this.dom.canvasPressure.textContent = state.pressure.toFixed(1);
    this.dom.syncValue.textContent = `${Math.round(syncRatio * 100)}%`;
    this.dom.syncFill.style.width = `${syncRatio * 100}%`;
    this.dom.constraintText.textContent = state.lastConstraint;

    this.dom.offsetFill.style.width = `${clamp(state.offset, 0, 100)}%`;
    this.dom.offsetFill.style.background = offsetSafe ? 'var(--cyan)' : 'var(--amber)';
    this.dom.gripFill.style.width = `${clamp(100 - state.offset, 0, 100)}%`;
    this.dom.pressureFill.style.width = `${clamp(state.pressure, 0, 100)}%`;
    this.dom.pressureFill.style.background = pressureDanger
      ? 'var(--red)'
      : pressureSafe ? 'var(--green)' : 'var(--amber)';
    this.dom.durabilityFill.style.width = `${clamp(state.durability, 0, 100)}%`;
    this.dom.durabilityFill.style.background = state.durability < 50 ? 'var(--red)' : 'var(--green)';

    this.dom.leftKeyModule.classList.toggle('active', state.leftHeld && state.phase === 'active');
    this.dom.rightKeyModule.classList.toggle('active', state.rightHeld && state.phase === 'active');
    this.dom.leftNote.textContent = offsetSafe
      ? '底座位于安全偏移区'
      : `还需收回 ${(state.offset - OFFSET_SAFE).toFixed(1)}mm 偏移`;
    this.dom.rightNote.textContent = state.pressure >= PRESSURE_CRUSH
      ? '垫圈已被压溃，工位锁定'
      : state.pressure > PRESSURE_MAX
        ? `超过安全带 ${(state.pressure - PRESSURE_MAX).toFixed(1)}%，立即泄压`
        : `距压溃阈值 ${(PRESSURE_CRUSH - state.pressure).toFixed(1)}%`;

    this.dom.missionCount.textContent = `${state.completed} / 3`;
    this.updateKitRail(state);
    this.updatePhaseBanner(state, remaining);
    this.updateStatusChip(state, replayMode);
    this.renderTimeline(state);
    if (replayMode) this.updateReplayControls();
    else this.dom.currentReplayButton.disabled = !this.currentRecording?.expected;
    this.lastDomUpdate = timestamp;
  }

  updateKitRail(state) {
    const nodes = [...this.dom.kitRail.querySelectorAll('.kit-node')];
    nodes.forEach((node, index) => {
      node.classList.remove('done', 'failed');
      if (index < 3 && index < state.completed) node.classList.add('done');
      if (state.phase === 'failed' && index === state.completed) node.classList.add('failed');
      if (index === 3) {
        if (state.phase === 'complete') {
          node.classList.add(state.inventory > 0 ? 'done' : 'failed');
        } else if (state.inventory <= 0) {
          node.classList.add('failed');
        }
      }
    });
  }

  updateStatusChip(state, replayMode) {
    const text = replayMode
      ? this.replay?.verified === true
        ? '回放通过'
        : this.replay?.verified === false ? '校验失败' : '回放校验'
      : state.phase === 'idle' ? '等待就位'
        : state.phase === 'active' ? '同步中'
          : state.phase === 'success' ? `第 ${state.completed} 组锁定`
            : state.phase === 'complete' ? '任务完成'
              : '装配失败';
    this.dom.statusChip.querySelector('span').textContent = text;
    this.dom.statusChip.classList.toggle('warning', replayMode || state.phase === 'idle');
    this.dom.statusChip.classList.toggle('error', state.phase === 'failed');
  }

  updatePhaseBanner(state, remaining) {
    const banner = this.dom.phaseBanner;
    banner.classList.remove('success', 'failed');
    if (state.phase === 'idle') {
      this.dom.phaseEyebrow.textContent = 'READY';
      this.dom.phaseTitle.textContent = '装载第一组后开始同步窗口';
      this.dom.phaseDetail.textContent = '左侧 A 夹紧 · 右侧 L 加压';
      return;
    }
    if (state.phase === 'active') {
      this.dom.phaseEyebrow.textContent = state.syncMs > 0 ? 'SYNC HOLD' : 'SYNC WINDOW';
      this.dom.phaseTitle.textContent = state.syncMs > 0 ? '同步保持中，不要松手' : '对齐底座与压力安全带';
      this.dom.phaseDetail.textContent = `${(remaining / 1000).toFixed(1)}s · ${state.lastConstraint}`;
      return;
    }
    if (state.phase === 'success') {
      banner.classList.add('success');
      this.dom.phaseEyebrow.textContent = 'LOCKED';
      this.dom.phaseTitle.textContent = `第 ${state.completed} 组同步锁定`;
      this.dom.phaseDetail.textContent = state.completed >= 3
        ? '正在核对备件与耐久'
        : '自动装载下一组，准备再次同步';
      return;
    }
    if (state.phase === 'complete') {
      banner.classList.add('success');
      this.dom.phaseEyebrow.textContent = 'MISSION CLEAR';
      this.dom.phaseTitle.textContent = `三组完成 · 备件保留 ${state.inventory}`;
      this.dom.phaseDetail.textContent = '点击“重置工位”开始新一轮，或回放本次记录';
      return;
    }
    banner.classList.add('failed');
    const collision = state.timeline.collisions[state.timeline.collisions.length - 1];
    this.dom.phaseEyebrow.textContent = 'COLLISION';
    this.dom.phaseTitle.textContent = '装配失败 · 工位已锁定';
    this.dom.phaseDetail.textContent = collision
      ? `${collision.message} @ T+${formatTime(collision.t)}`
      : state.lastConstraint;
  }

  renderTimeline(state) {
    const maxTick = Math.max(
      1,
      this.mode === 'replay' ? this.replay.record.endTick : Math.max(state.tick, 120)
    );
    this.renderHoldLane(this.dom.leftLane, state, 'left', maxTick);
    this.renderHoldLane(this.dom.rightLane, state, 'right', maxTick);
    this.renderCollisionLane(this.dom.collisionLane, state, maxTick);
    this.renderConflictLog(state);
  }

  renderHoldLane(lane, state, side, maxTick) {
    lane.replaceChildren();
    const fragment = document.createDocumentFragment();
    let startTick = null;
    const addSpan = (start, end) => {
      const safeStart = clamp(start, 0, maxTick);
      const safeEnd = clamp(Math.max(end, start + 1), safeStart, maxTick);
      const mark = document.createElement('span');
      mark.className = 'event-mark';
      mark.style.left = `${safeStart / maxTick * 100}%`;
      mark.style.width = `${Math.max(0.18, (safeEnd - safeStart) / maxTick * 100)}%`;
      mark.title = `${side === 'left' ? '左侧夹持' : '右侧加压'} ${formatTime(start * FIXED_MS)}–${formatTime(end * FIXED_MS)}`;
      fragment.append(mark);
    };
    for (const event of state.timeline.events) {
      if (event.kind === 'cycle-start' && startTick !== null) {
        addSpan(startTick, event.tick);
        startTick = null;
      }
      if (event.side !== side) continue;
      if (event.kind === 'press') startTick = event.tick;
      if (event.kind === 'release' && startTick !== null) {
        addSpan(startTick, event.tick);
        startTick = null;
      }
    }
    if (startTick !== null) addSpan(startTick, Math.min(maxTick, state.tick + 1));
    lane.append(fragment);
  }

  renderCollisionLane(lane, state, maxTick) {
    lane.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const collision of state.timeline.collisions) {
      const pin = document.createElement('span');
      pin.className = 'event-pin';
      pin.style.left = `${clamp(collision.tick / maxTick * 100, 0, 100)}%`;
      pin.title = `${collision.message} @ ${formatTime(collision.t)} · (${collision.position.x.toFixed(1)}, ${collision.position.y.toFixed(1)})`;
      fragment.append(pin);
    }
    for (const result of state.timeline.results) {
      const pin = document.createElement('span');
      pin.className = `event-pin result${result.kind === 'assembly-failed' ? ' failed' : ''}`;
      pin.style.left = `${clamp(result.tick / maxTick * 100, 0, 100)}%`;
      pin.title = `${result.kind === 'assembly-clear' ? '同步锁定' : '装配失败'} @ ${formatTime(result.t)}`;
      fragment.append(pin);
    }
    lane.append(fragment);
  }

  renderConflictLog(state) {
    const logs = [];
    for (const conflict of state.timeline.conflicts) {
      logs.push({
        tick: conflict.tick,
        kind: 'conflict',
        title: '动作顺序冲突',
        message: conflict.message,
        object: conflict.object,
        position: conflict.position
      });
    }
    for (const collision of state.timeline.collisions) {
      logs.push({
        tick: collision.tick,
        kind: 'collision',
        title: collision.type === 'crush'
          ? '压力碰撞 · 垫圈压溃'
          : collision.type === 'lateral' ? '偏移碰撞 · 模块错位' : '窗口碰撞 · 超时',
        message: collision.message,
        object: collision.object,
        position: collision.position
      });
    }
    for (const result of state.timeline.results) {
      logs.push({
        tick: result.tick,
        kind: result.kind === 'assembly-clear' ? 'success' : 'collision',
        title: result.kind === 'assembly-clear' ? '同步锁定' : '装配结果',
        message: result.kind === 'assembly-clear'
          ? `完成 ${result.completed}/3，剩余备件 ${result.inventory}`
          : `剩余零件 ${result.inventory}，耐久 ${result.durability}%`,
        object: result.object,
        position: result.position
      });
    }
    logs.sort((a, b) => a.tick - b.tick);

    this.dom.conflictCount.textContent = `${state.timeline.conflicts.length + state.timeline.collisions.length} 条冲突`;
    this.dom.conflictList.replaceChildren();
    if (logs.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-log';
      empty.textContent = '时间线将记录两侧输入、共享状态与碰撞结果。';
      this.dom.conflictList.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const log of logs.slice(-12)) {
      const item = document.createElement('article');
      item.className = `conflict-item ${log.kind}`;
      const header = document.createElement('header');
      const time = document.createElement('time');
      time.textContent = `T+${formatTime(log.tick * FIXED_MS)}`;
      const title = document.createElement('strong');
      title.textContent = log.title;
      header.append(time, title);
      const message = document.createElement('p');
      message.textContent = log.message;
      const location = document.createElement('code');
      const position = log.position;
      location.textContent = position
        ? `${log.object || position.object} · x ${Number(position.x).toFixed(1)} / y ${Number(position.y).toFixed(1)}`
        : `${log.object || '工位'} · 共享状态已记录`;
      item.append(header, message, location);
      fragment.append(item);
    }
    this.dom.conflictList.append(fragment);
    this.dom.conflictList.scrollLeft = this.dom.conflictList.scrollWidth;
  }

  showToast(message, isError = false) {
    this.dom.toast.textContent = message;
    this.dom.toast.classList.toggle('error', isError);
    this.dom.toast.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.dom.toast.classList.remove('show');
    }, 2600);
  }
}

const game = new AssemblyGame();
window.__assemblyGame = {
  app: game,
  get engine() {
    return game.engine;
  },
  get mode() {
    return game.mode;
  },
  get replay() {
    return game.replay;
  },
  get state() {
    return game.activeState();
  },
  get snapshot() {
    return game.activeState();
  },
  get recording() {
    return game.currentRecording;
  },
  start: () => game.startInitialRun(),
  reset: () => game.resetStation(),
  press: (side) => game.handlePress(side, 'debug'),
  release: (side) => game.handleRelease(side, 'debug'),
  playDemo: () => game.startReplay(DEMO_REPLAY, '示范回放'),
  playFailureDemo: () => game.startReplay(FAILURE_REPLAY, '失败样本'),
  playCurrent: () => game.startReplay(clone(game.currentRecording), '本次回放'),
  pauseReplay: () => game.toggleReplayPause(),
  stepReplay: () => game.stepReplay(),
  seekReplay: (tick) => game.seekReplay(tick),
  setReplaySpeed: (speed) => {
    if (!game.replay) return;
    game.replay.speed = Number(speed);
    game.updateReplayControls();
  },
  exitReplay: () => game.exitReplay()
};
