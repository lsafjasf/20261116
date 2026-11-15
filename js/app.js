import { DT, TICK_HZ, RUN_LENGTH_TICKS } from './constants.js';
import { createTimeline, recordFrame, findOrderConflicts } from './timeline.js';
import { emptyInput, step } from './sim.js';
import { planSuccess, planFailure, scriptInput } from './bot.js';
import { saveSession, loadSession, clearSession, memoryStorage } from './storage.js';
import { AudioEngine } from './audio.js';
import {
  drawViewfinder, drawLeftPanel, drawRightPanel, reasonLabel,
} from './render.js';

const storage = (() => {
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
  } catch { /* blocked storage */ }
  return memoryStorage();
})();

class App {
  constructor() {
    this.canvas = document.getElementById('stage');
    this.ctx = this.canvas.getContext('2d');
    this.audio = new AudioEngine();
    this.timeline = createTimeline();
    this.mode = 'live';            // live | replay
    this.demoPlan = null;
    this.demoLabel = '';
    this.order = 'lr';
    this.replay = { index: 0, playing: false, speed: 1, state: this.timeline.initial };
    this.keys = new Set();
    this.flash = null;
    this.lastWall = performance.now();
    this.acc = 0;
    this.conflicts = [];
    this.bindUi();
    this.tryRestore();
    requestAnimationFrame((t) => this.loop(t));
  }

  bindUi() {
    window.addEventListener('keydown', (event) => {
      if (event.repeat) return;
      this.keys.add(event.code);
      this.audio.unlock();
      if (event.code === 'Space') event.preventDefault();
    });
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));

    const click = (id, fn) => document.getElementById(id).addEventListener('click', () => fn());
    click('btn-demo-success', () => this.startDemo(planSuccess(), '成功剧本'));
    click('btn-demo-fail', () => this.startDemo(planFailure(), '失败剧本'));
    click('btn-reset', () => this.reset());
    click('btn-replay', () => this.enterReplay());
    click('btn-play', () => this.togglePlay());
    click('btn-step', () => this.singleStep());
    click('btn-order', () => this.toggleOrder());
    document.getElementById('sel-speed').addEventListener('change', (event) => {
      this.replay.speed = Number(event.target.value);
    });
    click('btn-save', () => this.persist());
    click('btn-clear', () => { clearSession(storage); this.setStatus('本地存档已清除'); });
  }

  setStatus(text) {
    document.getElementById('status').textContent = text;
  }

  startDemo(plan, label) {
    this.reset();
    this.demoPlan = plan;
    this.demoLabel = label;
    this.mode = 'live';
    this.setStatus(`${label}录制中：两名玩家的输入写入同一时间线`);
  }

  reset() {
    this.timeline = createTimeline();
    this.mode = 'live';
    this.demoPlan = null;
    this.flash = null;
    this.conflicts = [];
    this.replay = { index: 0, playing: false, speed: 1, state: this.timeline.initial };
    document.getElementById('conflict-list').innerHTML = '';
    this.setStatus('已复位，等待双人输入或演示剧本');
  }

  readHumanInput() {
    const input = emptyInput();
    const k = this.keys;
    input.left.pan = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    input.left.tilt = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    input.right.focusDir = (k.has('KeyI') ? 1 : 0) - (k.has('KeyK') ? 1 : 0);
    input.right.zoomDir = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    if (k.has('KeyT')) input.right.apertureStep = 1;
    if (k.has('KeyG')) input.right.apertureStep = -1;
    if (k.has('KeyR')) input.right.shutterStep = -1;
    if (k.has('KeyF')) input.right.shutterStep = 1;
    input.right.shutter = k.has('Space');
    return input;
  }

  liveTick() {
    if (this.timeline.state.finished) return;
    const tick = this.timeline.state.tick + 1;
    const input = this.demoPlan
      ? scriptInput(this.timeline.state, tick, this.demoPlan)
      : this.readHumanInput();
    const out = recordFrame(this.timeline, input, this.order);
    const load = Math.max(
      Math.hypot(input.left.pan, input.left.tilt),
      Math.abs(input.right.focusDir) + Math.abs(input.right.zoomDir),
    );
    this.audio.updateMotor(load);
    if (out.verdict) {
      this.audio.shutter(out.verdict.ok);
      this.flash = { ok: out.verdict.ok, reasons: out.verdict.reasons, at: performance.now() / 1000 };
      this.setStatus(out.verdict.ok
        ? `tick ${out.verdict.tick} 照片已保存（${out.verdict.target}）`
        : `tick ${out.verdict.tick} 拒绝：${out.verdict.reasons.map(reasonLabel).join('、')}`);
    }
    if (this.timeline.state.finished) {
      this.persist();
      this.setStatus(`${this.demoLabel || '本局'}结束：${this.timeline.state.result === 'success' ? '成功' : '失败'}，已自动存档`);
    }
  }

  enterReplay() {
    if (this.timeline.frames.length === 0) {
      this.setStatus('时间线为空，先录制一局再回放');
      return;
    }
    this.mode = 'replay';
    this.replay = { index: 0, playing: true, speed: this.replay.speed, state: this.timeline.initial };
    this.conflicts = findOrderConflicts(this.timeline, this.order);
    this.renderConflicts();
    this.setStatus(`回放中（${this.order.toUpperCase()} 顺序），倍速不改变最终状态`);
  }

  togglePlay() {
    if (this.mode !== 'replay') this.enterReplay();
    this.replay.playing = !this.replay.playing;
    this.audio.unlock();
    if (this.replay.playing) this.audio.resume(); else this.audio.suspend();
  }

  singleStep() {
    if (this.mode !== 'replay') this.enterReplay();
    this.replay.playing = false;
    this.replayStep(1);
  }

  replayStep(count) {
    for (let i = 0; i < count; i += 1) {
      if (this.replay.index >= this.timeline.frames.length) {
        this.replay.playing = false;
        const match = this.replay.state.hash === this.timeline.state.hash;
        this.setStatus(`回放结束：最终哈希 ${this.replay.state.hash}，与录制${match ? '一致' : '不一致'}`);
        return;
      }
      const frame = this.timeline.frames[this.replay.index];
      const out = step(this.replay.state, { left: frame.left, right: frame.right }, this.order);
      this.replay.state = out.state;
      this.replay.index += 1;
      // At 2x/4x only voice the last verdict of the batch to avoid stacking
      // dozens of synthesized shutter sounds into one moment.
      if (out.verdict && (i === count - 1 || this.replay.index >= this.timeline.frames.length)) {
        this.audio.shutter(out.verdict.ok);
        this.flash = { ok: out.verdict.ok, reasons: out.verdict.reasons, at: performance.now() / 1000 };
      }
    }
  }

  toggleOrder() {
    this.order = this.order === 'lr' ? 'rl' : 'lr';
    document.getElementById('order-badge').textContent = `顺序: ${this.order.toUpperCase()}`;
    if (this.mode === 'replay') {
      this.replay = { index: 0, playing: this.replay.playing, speed: this.replay.speed, state: this.timeline.initial };
      this.conflicts = findOrderConflicts(this.timeline, this.order);
      this.renderConflicts();
      this.setStatus(`已切换到 ${this.order.toUpperCase()} 顺序重新回放`);
    }
  }

  renderConflicts() {
    const box = document.getElementById('conflict-list');
    if (this.conflicts.length === 0) {
      box.innerHTML = '<p class="muted">未发现顺序冲突</p>';
      return;
    }
    box.innerHTML = this.conflicts.map((c) => `
      <div class="conflict">
        <strong>tick ${c.tick}</strong>：${c.recordedOrder.toUpperCase()} 与 ${c.altOrder.toUpperCase()} 结果不同
        <div>对象位置：${c.targetPositions.map((p) => `${p.id}(${p.x}, ${p.y}, ${p.z})`).join('；')}</div>
        <div>哈希 ${c.stateA.hash} ≠ ${c.stateB.hash}，胶片 ${c.stateA.film}/${c.stateB.film}</div>
      </div>`).join('');
  }

  persist() {
    saveSession({
      timeline: this.timeline,
      mode: this.mode,
      order: this.order,
      label: this.demoLabel,
    }, storage);
    this.setStatus('已保存到 localStorage（含两侧输入、共享状态与碰撞结果）');
  }

  tryRestore() {
    const saved = loadSession(storage);
    if (!saved) {
      this.setStatus('无存档。键盘双人操作或点击演示剧本开始');
      return;
    }
    this.timeline = {
      initial: saved.initial,
      frames: saved.frames,
      state: saved.state,
    };
    this.order = saved.order || 'lr';
    this.demoLabel = saved.label || '';
    this.replay.state = saved.state;
    this.replay.index = saved.frames.length;
    document.getElementById('order-badge').textContent = `顺序: ${this.order.toUpperCase()}`;
    this.setStatus(`已恢复存档：${saved.label || '对局'}，结果 ${saved.state.result ?? '进行中'}，胶片 ${saved.state.film}，耐久 ${saved.state.durability}%`);
  }

  loop(now) {
    const wall = Math.min(0.1, (now - this.lastWall) / 1000);
    this.lastWall = now;
    this.acc += wall;
    while (this.acc >= DT) {
      if (this.mode === 'live') this.liveTick();
      else if (this.replay.playing) this.replayStep(this.replay.speed);
      this.acc -= DT;
    }
    if (this.flash && now / 1000 - this.flash.at > 0.6) this.flash = null;
    this.draw(now);
    requestAnimationFrame((t) => this.loop(t));
  }

  draw(now) {
    const state = this.mode === 'replay' ? this.replay.state : this.timeline.state;
    const tick = state.tick;
    drawViewfinder(this.ctx, state, tick, this.flash);
    const input = this.mode === 'live' && this.demoPlan
      ? scriptInput(state, tick + 1, this.demoPlan)
      : this.readHumanInput();
    drawLeftPanel(this.sideCtx('left'), state, input);
    drawRightPanel(this.sideCtx('right'), state);
    document.getElementById('tick-badge').textContent =
      `tick ${tick}/${RUN_LENGTH_TICKS} · ${this.mode === 'live' ? '录制' : '回放'} · ${TICK_HZ}Hz 固定步长`;
    document.getElementById('progress').textContent =
      `照片 ${state.photos.length}/3 · 胶片 ${state.film} · 耐久 ${state.durability.toFixed(0)}% · 结果 ${state.result ?? '进行中'}`;
  }

  sideCtx(side) {
    if (!this._side) {
      this._side = {
        left: document.getElementById('left-panel').getContext('2d'),
        right: document.getElementById('right-panel').getContext('2d'),
      };
    }
    return this._side[side];
  }
}

window.__cameraApp = new App();
window.__demoPlans = { planSuccess, planFailure };
