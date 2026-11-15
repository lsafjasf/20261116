// 三组固定场景：优化前(legacy) / 优化后(fixed) / 边界参数(fixed+edge)。
// 浏览器 UI 与 Node 测试共用，保证结果一致。
import { PlayerCore, VirtualClock, mulberry32, frameData, subtitleAt, formatTimecode } from './player-core.js';

// 快速拖动脚本：burst 次随机定位，间隔 5..45ms（模拟疯狂拖进度条）
export function buildScrubScript(seed, count, duration) {
  const rand = mulberry32(seed);
  const events = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    at += 5 + Math.floor(rand() * 40);
    events.push({ at, t: rand() * duration });
  }
  return events;
}

// 一致性检查：帧 / 时间码 / 音频 / 字幕 四者必须指向同一时间
export function checkConsistent(core) {
  const problems = [];
  if (core.frame.index !== core.frameIndexFor(core.time)) {
    problems.push(`帧=${core.frame.index} 但时间=${core.time.toFixed(3)}s`);
  }
  if (core.audioTime !== core.time) problems.push(`音频=${core.audioTime} 但时间=${core.time}`);
  if (core.subtitle !== subtitleAt(core.time)) problems.push(`字幕="${core.subtitle}" 与时间不符`);
  if (core.timecode !== formatTimecode(core.time, core.fps)) problems.push('时间码不符');
  return problems;
}

// 运行一个场景：暂停状态下执行快速拖动脚本，然后沉淀并校验
export function runScenario({ name, mode, seed = 1234, scriptSeed = 7, seeks = 60,
  latencyProfile = 'normal', cacheSize = 24, extra = null }) {
  const clock = new VirtualClock();
  const anomalies = [];
  let maxCommittedIssue = -1;
  const core = new PlayerCore({
    mode, seed, latencyProfile, cacheSize, clock,
    oncommit: (c, info) => {
      // 发出序号回退 = 旧请求在新请求之后提交（“显示上一帧、音频字幕停留在旧位置”）
      const issue = info.issueSeq ?? -1;
      if (issue < maxCommittedIssue) {
        anomalies.push({ type: 'stale-commit', at: clock.now(), t: c.time,
          issue, afterIssue: maxCommittedIssue, audio: c.audioTime, subtitle: c.subtitle });
      }
      maxCommittedIssue = Math.max(maxCommittedIssue, issue);
    },
  });

  const script = buildScrubScript(scriptSeed, seeks, core.duration);
  for (const ev of script) {
    clock.advance(ev.at - clock.now());
    core.seek(ev.t);
  }
  let expectedT = core.clampTime(script[script.length - 1].t);
  if (extra) {
    const extraExpected = extra(core, clock); // 边界场景注入额外操作，可返回新的期望时间
    if (typeof extraExpected === 'number') expectedT = core.clampTime(extraExpected);
  }
  clock.settle();
  clock.advance(2000); // 沉淀后再走 2s：暂停态必须保持不动
  clock.settle();

  const problems = checkConsistent(core);
  if (mode === 'fixed' && core.time !== expectedT) {
    problems.push(`最终时间=${core.time} 应为最后拖动点=${expectedT}`);
  }
  return {
    name, mode, params: { seed, scriptSeed, seeks, latencyProfile, cacheSize },
    expectedT, final: {
      time: core.time, timecode: core.timecode, frame: core.frame.label,
      frameIndex: core.frame.index, audioTime: core.audioTime, subtitle: core.subtitle,
    },
    anomalies, problems,
    metrics: { ...core.metrics, avgFrameMs: core.avgFrameMs,
      cacheHitRate: core.cacheHitRate, cacheNodes: core.cacheNodes },
  };
}

// 语义保持校验：同一时间经两种模式映射到同一帧/字幕/时间码
export function checkSemanticsPreserved(result) {
  const { final } = result;
  const fps = 30;
  const errors = [];
  const idx = Math.min(899, Math.round(final.time * fps));
  if (final.frame !== frameData(idx).label) errors.push('帧映射变化');
  if (final.subtitle !== subtitleAt(final.time)) errors.push('字幕映射变化');
  if (final.timecode !== formatTimecode(final.time, fps)) errors.push('时间码格式变化');
  return errors;
}
