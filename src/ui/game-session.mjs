import { WORLD } from '../engine/config.mjs';
import { Recorder } from '../engine/recorder.mjs';
import { createInitialState, checksum } from '../engine/state.mjs';
import { AudioEngine } from '../audio/audio-engine.mjs';

export class GameSession {
  constructor(renderer, logger) {
    this.renderer = renderer;
    this.logger = logger;
    this.audio = new AudioEngine(globalThis);
    this.recorder = null;
    this.mode = 'manual';
    this.scenario = null;
    this.lastRecording = null;
    this.start('manual', null);
  }

  start(mode, scenario) {
    this.mode = mode;
    this.scenario = scenario;
    this.recorder = new Recorder(20261116, mode === 'manual' ? 'manual' : scenario.id);
    this.tickInputs = [];
    this.logger(`新会话开始：${mode === 'manual' ? '手动双人' : scenario.label}`);
    this.render();
  }

  tick(input) {
    if (this.recorder.finished) return null;
    this.tickInputs.push(structuredClone(input));
    const result = this.recorder.push(input);
    for (const ev of result.events) this.handleEvent(ev);
    for (const conflict of result.conflicts) {
      this.logger(`冲突 tick ${conflict.tick} (${conflict.time}s)：${conflict.label} @ ${conflict.position.x},${conflict.position.y}`, 'conflict');
    }
    this.audio.updateTension(this.recorder.state.gauges.tension, this.recorder.state.gauges.stress);
    this.render();
    if (this.recorder.finished) this.finish();
    return result;
  }

  handleEvent(ev) {
    if (ev.type === 'crack') {
      this.audio.crack(0.6);
      this.logger(`冰裂 tick ${ev.tick}：区域 ${ev.zone} @ ${ev.position.x},${ev.position.y}`, 'conflict');
    } else if (ev.type === 'jerk') {
      this.audio.jerk(ev.side);
    } else if (ev.type === 'rope-snap') {
      this.audio.snap();
      this.logger(`绳索断裂 tick ${ev.tick}：${ev.side}`, 'bad');
    } else if (ev.type === 'ice-break') {
      this.audio.crack(1);
      this.logger(`冰面坍塌 tick ${ev.tick}：区域 ${ev.zone}`, 'bad');
    } else if (ev.type === 'collision') {
      this.logger(`碰撞 tick ${ev.tick}：${ev.object} @ ${ev.position.x},${ev.position.y}`);
    } else if (ev.type === 'rescued') {
      this.audio.win();
      this.logger(`物资箱抵达安全区 tick ${ev.tick}`, 'ok');
    } else if (ev.type === 'anchor-limit') {
      this.logger(`锚点限位 tick ${ev.tick}：${ev.side}侧已到锚轨端部`);
    }
  }

  finish() {
    this.lastRecording = this.recorder.build();
    const r = this.lastRecording;
    this.logger(
      `本局结束：${r.result === 'success' ? '成功' : '失败'}（${r.reason}），${r.ticks} tick / ${r.duration}s，checksum 帧 ${r.timeline.length}`,
      r.result === 'success' ? 'ok' : 'bad',
    );
  }

  render(highlight = null, label = '') {
    this.renderer.draw(this.recorder.state, { highlightConflict: highlight, frameLabel: label });
  }

  get state() {
    return this.recorder.state;
  }

  static restoreState(seed) {
    return createInitialState(seed);
  }
}

export { WORLD, checksum };
