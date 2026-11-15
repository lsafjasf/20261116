import * as C from './constants.js';
import { createSim, step, setPaused, recover, hashState, currentObjective } from './engine.js';
import { autopilotInput } from './autopilot.js';
import { render } from './render.js';
import { SubAudio } from './audio.js';
import { replayHash } from './replay.js';

const $ = (id) => document.getElementById(id);

class SubApp {
  constructor() {
    this.canvas = $('scene');
    this.ctx = this.canvas.getContext('2d');
    this.audio = new SubAudio();
    this.seed = Number($('seed').value) || 1;
    this.sim = createSim(this.seed);
    this.input = [0, 0, 0, 0, 0, 0, 1, 0];
    this.keys = new Set();
    this.mode = 'manual';       // manual | safe | mistake | extreme
    this.paused = false;
    this.replayHandle = null;
    this.lastFrame = performance.now();
    this.acc = 0;
    this.bindInput();
    this.bindControls();
    requestAnimationFrame((t) => this.loop(t));
    this.refreshPanels();
  }

  bindInput() {
    // Station A: W/S thrust, Q light, E engine, Space sample
    // Station B: arrows up/down ballast, N neutral, B blow, R recover
    const down = (e) => {
      if (e.repeat) return;
      this.audio.resume();
      this.keys.add(e.code);
      this.handleKey(e.code, true);
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    };
    const up = (e) => { this.keys.delete(e.code); this.handleKey(e.code, false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);

    document.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.audio.resume();
        this.handleButton(btn.dataset.act, btn);
      });
    });
  }

  handleKey(code, pressed) {
    const i = this.input;
    switch (code) {
      case 'KeyW': i[C.INPUT.THRUST] = pressed ? 1 : (this.keys.has('KeyS') ? -1 : 0); break;
      case 'KeyS': i[C.INPUT.THRUST] = pressed ? -1 : (this.keys.has('KeyW') ? 1 : 0); break;
      case 'KeyQ': if (pressed) i[C.INPUT.LIGHT] = (i[C.INPUT.LIGHT] + 1) % 3; break;
      case 'KeyE': if (pressed) i[C.INPUT.ENGINE] = this.sim.engineOn ? -1 : 1; break;
      case 'Space': i[C.INPUT.SAMPLE] = pressed ? 1 : 0; break;
      case 'ArrowUp': i[C.INPUT.FLOOD] = pressed ? 1 : 0; break;
      case 'ArrowDown': i[C.INPUT.VENT] = pressed ? 1 : 0; break;
      case 'KeyN': i[C.INPUT.NEUTRAL] = pressed ? 1 : 0; break;
      case 'KeyB': i[C.INPUT.BLOW] = pressed ? 1 : 0; break;
      case 'KeyR': if (pressed) this.doRecover(); break;
      case 'KeyP': if (pressed) this.togglePause(); break;
    }
  }

  handleButton(act, btn) {
    const i = this.input;
    switch (act) {
      case 'thrust-fwd': i[C.INPUT.THRUST] = i[C.INPUT.THRUST] === 1 ? 0 : 1; break;
      case 'thrust-rev': i[C.INPUT.THRUST] = i[C.INPUT.THRUST] === -1 ? 0 : -1; break;
      case 'light': i[C.INPUT.LIGHT] = (i[C.INPUT.LIGHT] + 1) % 3; break;
      case 'engine': i[C.INPUT.ENGINE] = this.sim.engineOn ? -1 : 1; break;
      case 'sample': i[C.INPUT.SAMPLE] = 1; setTimeout(() => { i[C.INPUT.SAMPLE] = 0; }, 150); break;
      case 'flood': i[C.INPUT.FLOOD] = btn.classList.toggle('active') ? 1 : 0; break;
      case 'vent': i[C.INPUT.VENT] = btn.classList.toggle('active') ? 1 : 0; break;
      case 'neutral': i[C.INPUT.NEUTRAL] = 1; setTimeout(() => { i[C.INPUT.NEUTRAL] = 0; }, 150); break;
      case 'blow': i[C.INPUT.BLOW] = btn.classList.toggle('active') ? 1 : 0; break;
      case 'pause': this.togglePause(); break;
      case 'recover': this.doRecover(); break;
      case 'restart': this.restart(); break;
      case 'replay': this.runReplay(); break;
      case 'mode-safe': this.setMode('safe'); break;
      case 'mode-mistake': this.setMode('mistake'); break;
      case 'mode-extreme': this.setMode('extreme'); break;
      case 'mode-manual': this.setMode('manual'); break;
    }
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'manual') this.restart(false);
    $('modeLabel').textContent = {
      manual: '手动', safe: '自动·成功路线', mistake: '自动·操作失误', extreme: '自动·参数极限',
    }[mode];
  }

  togglePause() {
    this.paused = !this.paused;
    setPaused(this.sim, this.paused);
    $('pauseBtn').textContent = this.paused ? '继续 (P)' : '暂停 (P)';
  }

  doRecover() {
    if (recover(this.sim)) {
      this.paused = false;
      $('pauseBtn').textContent = '暂停 (P)';
      this.audio.blip(520, 0.2, 'triangle', 0.12);
    }
  }

  restart(announce = true) {
    this.seed = Number($('seed').value) || 1;
    this.sim = createSim(this.seed);
    this.input = [0, 0, 0, 0, 0, 0, 1, 0];
    this.paused = false;
    this.acc = 0;
    if (this.replayHandle) { this.replayHandle.stop(); this.replayHandle = null; }
    $('pauseBtn').textContent = '暂停 (P)';
    $('replayResult').textContent = '';
    if (announce) this.audio.blip(330, 0.15, 'sine', 0.1);
    this.refreshPanels();
  }

  runReplay() {
    const log = this.sim.inputLog.slice();
    const seed = this.sim.seed;
    if (log.length < 2) { $('replayResult').textContent = '暂无输入记录，先运行一段任务'; return; }
    const liveHash = hashState(this.sim);
    const { hash } = replayHash(seed, log);
    const match = hash === liveHash;
    $('replayResult').innerHTML =
      `重放 ${log.length} 帧 · seed=${seed}<br>实时哈希 <code>${liveHash}</code><br>重放哈希 <code>${hash}</code><br>` +
      (match ? '✅ 完全一致' : '❌ 哈希不一致');
    this.audio.blip(match ? 740 : 200, 0.25, 'sine', 0.12);
  }

  bindControls() {
    $('restartBtn').addEventListener('click', () => this.restart());
    $('seed').addEventListener('change', () => this.restart());
  }

  loop(now) {
    const dt = Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    if (!this.paused) {
      this.acc += dt;
      while (this.acc >= C.TICK_MS) {
        this.tickSim();
        this.acc -= C.TICK_MS;
      }
    }
    render(this.ctx, this.sim, this.canvas.width, this.canvas.height);
    this.audio.update(this.sim);
    this.refreshPanels();
    requestAnimationFrame((t) => this.loop(t));
  }

  tickSim() {
    const s = this.sim;
    if (s.phase === C.PHASE.FAILED || s.phase === C.PHASE.SURFACED) return;
    const input = this.mode === 'manual' ? this.input : autopilotInput(s, this.mode);
    step(s, input);
    s.objective = currentObjective(s);
  }

  refreshPanels() {
    const s = this.sim;
    $('timer').textContent = `${(s.timeMs / 1000).toFixed(1)}s`;
    $('tick').textContent = s.tick;
    $('phase').textContent = s.phase + (s.failReason ? ` (${s.failReason})` : '');
    $('objective').textContent = s.objective ?? currentObjective(s);
    $('hash').textContent = hashState(s);
    const list = s.stateChanges.slice(-6).reverse();
    $('changes').innerHTML = list.map((c) =>
      `<li><span class="t">t${c.tick}</span> <b>${c.phase}</b> ${c.text}</li>`).join('');
    $('warnings').innerHTML = s.warnings.slice(-3).reverse()
      .map((w) => `<li>t${w.tick}: ${w.text}</li>`).join('') || '<li>—</li>';
  }
}

window.addEventListener('DOMContentLoaded', () => { window.app = new SubApp(); });
