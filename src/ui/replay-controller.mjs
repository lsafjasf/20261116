import { WORLD } from '../engine/config.mjs';
import { replay, restoreState, scanOrderConflicts } from '../engine/recorder.mjs';
import { checksum } from '../engine/state.mjs';

export class ReplayController {
  constructor(renderer, logger) {
    this.renderer = renderer;
    this.logger = logger;
    this.recording = null;
    this.cursor = 0;
    this.playing = false;
    this.speed = 1;
    this.acc = 0;
    this.lastTs = 0;
    this.raf = 0;
  }

  load(recording) {
    this.recording = recording;
    this.cursor = 0;
    this.playing = false;
    const verify = replay(recording);
    return verify;
  }

  play(speed = this.speed) {
    if (!this.recording) return null;
    this.speed = speed;
    const verify = replay(this.recording);
    this.playing = true;
    this.acc = 0;
    this.lastTs = performance.now();
    cancelAnimationFrame(this.raf);
    const loop = (ts) => {
      if (!this.playing) return;
      const realDt = (ts - this.lastTs) / 1000;
      this.lastTs = ts;
      this.acc += realDt * this.speed;
      const stepTicks = Math.floor(this.acc / WORLD.dt);
      this.acc -= stepTicks * WORLD.dt;
      for (let i = 0; i < stepTicks; i += 1) {
        this.cursor = Math.min(this.recording.timeline.length - 1, this.cursor + 1);
        if (this.cursor >= this.recording.timeline.length - 1) {
          this.playing = false;
          break;
        }
      }
      this.paint();
      if (this.playing) this.raf = requestAnimationFrame(loop);
      else this.assertFinal(verify);
    };
    this.raf = requestAnimationFrame(loop);
    return verify;
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.paint();
  }

  stepOnce() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    if (!this.recording) return;
    this.cursor = Math.min(this.recording.timeline.length - 1, this.cursor + 1);
    this.paint();
    if (this.cursor === this.recording.timeline.length - 1) {
      this.assertFinal(replay(this.recording));
    }
  }

  paint() {
    const frame = this.recording.timeline[this.cursor];
    const state = restoreState(this.recording, frame.tick);
    const liveChecksum = checksum(state);
    const conflict = frame.conflicts && frame.conflicts[0];
    const label = `回放 ${this.speed}x 帧 ${this.cursor}/${this.recording.timeline.length - 1} ${liveChecksum === frame.checksum ? '✓' : '✗'}`;
    this.renderer.draw(state, { highlightConflict: conflict, frameLabel: label });
  }

  assertFinal(verify) {
    const last = this.recording.timeline[this.recording.timeline.length - 1];
    const state = restoreState(this.recording, last.tick);
    const ok = checksum(state) === last.checksum && verify.ok;
    this.logger(
      `回放结束：${ok ? '终态一致 ✓' : '校验失败 ✗'} 终态 checksum=${last.checksum}`,
      ok ? 'ok' : 'bad',
    );
    return ok;
  }

  scanConflicts() {
    if (!this.recording) return null;
    const report = scanOrderConflicts(this.recording);
    if (report.first) {
      const f = report.first;
      this.logger(
        `顺序冲突首现 tick ${f.tick} (${f.time}s)：${f.object} 原顺序位置 ${f.basePosition.x},${f.basePosition.y}；交换后 ${f.swappedPosition.x},${f.swappedPosition.y}`,
        'conflict',
      );
      this.paint();
    } else {
      this.logger('顺序扫描：两侧动作交换后终态完全一致，无顺序敏感冲突', 'ok');
    }
    return report;
  }
}
