// UI 接线：真实时钟播放器 + 实时指标 + 快速拖动验证 + 三场景对比。
import { PlayerCore, VirtualClock, mulberry32, frameData } from './src/player-core.js';
import { runScenario, checkSemanticsPreserved, buildScrubScript } from './src/scenarios.js';

const $ = (id) => document.getElementById(id);
const realClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

let core;
function makeCore(mode, latencyProfile) {
  core = new PlayerCore({ mode, latencyProfile, clock: realClock, seed: 20261116 });
  core.oncommit = render;
  render();
}

const ctx = $('screen').getContext('2d');
function render() {
  const f = core.frame;
  ctx.fillStyle = `hsl(${f.hue} 70% 45%)`;
  ctx.fillRect(0, 0, 320, 180);
  ctx.fillStyle = '#fff';
  ctx.font = '20px monospace';
  ctx.fillText(f.label, 16, 96);
  $('subtitle').textContent = core.subtitle;
  $('tc').textContent = core.timecode;
  $('audio').textContent = core.audioTime.toFixed(3) + 's';
  $('state').textContent = core.playing ? '播放' : '暂停';
  $('seekBar').value = core.time;
}

function refreshMetrics() {
  const m = core.metrics;
  $('mFrame').textContent = `最近 ${m.lastFrameMs.toFixed(1)}ms / 平均 ${core.avgFrameMs.toFixed(1)}ms / 最大 ${m.maxFrameMs.toFixed(1)}ms`;
  $('mCand').textContent = `${m.candidates} / ${m.dropped} / ${m.applied}`;
  $('mHit').textContent = (core.cacheHitRate * 100).toFixed(1) + '%';
  $('mNodes').textContent = core.cacheNodes;
  $('mDec').textContent = `${m.decodes} / ${core.inflight}`;
}
setInterval(refreshMetrics, 100);

function log(msg, cls = '') {
  const el = $('log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

$('playBtn').onclick = () => {
  if (core.playing) { core.pause(); $('playBtn').textContent = '播放'; }
  else { core.play(); $('playBtn').textContent = '暂停'; }
  render();
};
$('seekBar').oninput = (e) => core.seek(parseFloat(e.target.value));
$('modeSel').onchange = () => { makeCore($('modeSel').value, $('latencySel').value); $('playBtn').textContent = '播放'; };
$('latencySel').onchange = () => { makeCore($('modeSel').value, $('latencySel').value); $('playBtn').textContent = '播放'; };

// 快速拖动 ×60：暂停态下连发 60 次定位，沉淀后校验最终帧/时间码/字幕一致
$('scrubBtn').onclick = () => {
  core.pause();
  $('playBtn').textContent = '播放';
  const rand = mulberry32(Date.now() % 100000);
  const n = 60;
  let lastT = 0;
  for (let i = 0; i < n; i++) {
    lastT = rand() * core.duration;
    core.seek(lastT);
  }
  const expected = core.clampTime(lastT);
  setTimeout(() => {
    const okFrame = core.frame.index === core.frameIndexFor(expected);
    const okAudio = core.audioTime === core.time;
    const okTime = core.mode === 'fixed' ? core.time === expected : true;
    const msg = `快速拖动×${n}: 期望t=${expected.toFixed(3)} 实际t=${core.time.toFixed(3)} ` +
      `帧=${core.frame.label} 时间码=${core.timecode} 字幕=${core.subtitle}`;
    if (okFrame && okAudio && okTime) log('✔ ' + msg + ' —— 完全一致', 'ok');
    else log('✗ ' + msg + ` —— 不一致 (帧${okFrame ? '✓' : '✗'} 音频${okAudio ? '✓' : '✗'} 时间${okTime ? '✓' : '✗'})`, 'bad');
  }, 400); // 等待在途解码沉淀
};

// 三场景对比：优化前 / 优化后 / 边界参数（虚拟时钟，确定性复现）
$('scenarioBtn').onclick = () => {
  log('—— 三场景对比开始 ——');
  const A = runScenario({ name: 'A-优化前', mode: 'legacy' });
  const B = runScenario({ name: 'B-优化后', mode: 'fixed' });
  const C = runScenario({
    name: 'C-边界参数', mode: 'fixed', latencyProfile: 'zero', cacheSize: 1, seeks: 40,
    extra: (c, clock) => {
      c.seek(-5); c.seek(999);
      for (let i = 0; i < 10; i++) c.seek(12.5);
      c.play(); clock.advance(100); c.pause();
      c.seek(4.2);
      return 4.2;
    },
  });
  for (const r of [A, B, C]) {
    const sem = checkSemanticsPreserved(r);
    log(`[${r.name}] 最终t=${r.final.time.toFixed(3)} 帧=${r.final.frame} 时间码=${r.final.timecode} 字幕=${r.final.subtitle}`);
    log(`  异常=${r.anomalies.length} 一致性=${r.problems.length === 0 ? 'OK' : r.problems.join('；')} ` +
      `候选=${r.metrics.candidates} 丢弃=${r.metrics.dropped} 解码=${r.metrics.decodes} ` +
      `命中率=${(r.metrics.cacheHitRate * 100).toFixed(1)}% 节点=${r.metrics.cacheNodes} ` +
      `帧时间avg=${r.metrics.avgFrameMs.toFixed(1)}ms 语义${sem.length === 0 ? '保持' : sem.join(',')}`,
      r.anomalies.length === 0 && r.problems.length === 0 ? 'ok' : 'bad');
  }
  log(`资源对比: 解码数 优化前${A.metrics.decodes} → 优化后${B.metrics.decodes}（仅性能/错误处理变化）`);
  log('—— 三场景对比结束 ——');
};

makeCore('fixed', 'normal');
