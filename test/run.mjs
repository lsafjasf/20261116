// 三场景对比验证：优化前 / 优化后 / 边界参数。
// 运行：node test/run.mjs
import { runScenario, checkSemanticsPreserved } from '../src/scenarios.js';
import { frameData, subtitleAt, formatTimecode } from '../src/player-core.js';

const FPS = 30;
let failures = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
};

function show(r) {
  console.log(`\n== 场景 ${r.name} (mode=${r.mode}) ==`);
  console.log(`  参数: ${JSON.stringify(r.params)}`);
  console.log(`  最终: t=${r.final.time.toFixed(3)}s 帧=${r.final.frame} 时间码=${r.final.timecode}`);
  console.log(`        音频=${r.final.audioTime.toFixed(3)}s 字幕=${r.final.subtitle}`);
  console.log(`  指标: 候选=${r.metrics.candidates} 丢弃=${r.metrics.dropped} 应用=${r.metrics.applied}` +
    ` 解码=${r.metrics.decodes} 缓存命中率=${(r.metrics.cacheHitRate * 100).toFixed(1)}%` +
    ` 节点数=${r.metrics.cacheNodes} 帧时间avg=${r.metrics.avgFrameMs.toFixed(1)}ms max=${r.metrics.maxFrameMs.toFixed(1)}ms`);
  console.log(`  异常日志: ${r.anomalies.length} 条`);
  for (const a of r.anomalies.slice(0, 3)) {
    console.log(`    [${a.type}] t=${a.t.toFixed(3)}s issue#${a.issue} 在#${a.afterIssue}之后提交 音频=${a.audio.toFixed(3)} 字幕=${a.subtitle}`);
  }
  if (r.anomalies.length > 3) console.log(`    ... 其余 ${r.anomalies.length - 3} 条省略`);
  if (r.problems.length) console.log(`  一致性问题: ${r.problems.join('；')}`);
}

// ---- 场景A：优化前（legacy，复现竞态） ----
const A = runScenario({ name: 'A-优化前', mode: 'legacy' });
show(A);
console.log('  [预期] legacy 复现缺陷：stale-commit / 暂停自动推进');
ok(A.anomalies.length > 0 || A.final.time !== A.expectedT, '场景A 复现了竞态缺陷（用于对照）');

// ---- 场景B：优化后（fixed，相同种子/脚本） ----
const B = runScenario({ name: 'B-优化后', mode: 'fixed' });
show(B);
ok(B.anomalies.length === 0, '场景B 无乱序提交');
ok(B.problems.length === 0, '场景B 帧/时间码/音频/字幕完全一致');
ok(B.final.time === B.expectedT, '场景B 暂停拖动后停在最终帧，未自动推进');
ok(B.final.frame === frameData(Math.round(B.expectedT * FPS)).label, '场景B 最终帧符合确定性映射');
ok(B.final.subtitle === subtitleAt(B.expectedT), '场景B 字幕与最终帧一致');
ok(B.final.timecode === formatTimecode(B.expectedT, FPS), '场景B 时间码与最终帧一致');

// ---- 场景C：边界参数（零延迟+缓存1+越界+重复+播放中暂停） ----
const C = runScenario({
  name: 'C-边界参数', mode: 'fixed', latencyProfile: 'zero', cacheSize: 1, seeks: 40,
  extra: (core, clock) => {
    core.seek(-5); core.seek(999);                 // 越界 → 钳制
    for (let i = 0; i < 10; i++) core.seek(12.5);  // 重复同帧
    core.play(); clock.advance(100); core.pause(); // 播放中暂停
    core.seek(4.2);                                // 暂停态拖动
    return 4.2;                                    // 期望最终时间
  },
});
show(C);
ok(C.anomalies.length === 0, '场景C 边界参数下无异常');
ok(C.problems.length === 0, '场景C 最终状态一致');
ok(C.final.time === 4.2, '场景C 播放中暂停后再拖动，未自动推进');

// ---- 多轮快速拖动（不同脚本种子，验证稳定性） ----
console.log('\n== 多轮快速拖动（fixed, 5 轮 × 80 次） ==');
for (const s of [11, 22, 33, 44, 55]) {
  const r = runScenario({ name: `R${s}`, mode: 'fixed', scriptSeed: s, seeks: 80, latencyProfile: 'spiky' });
  ok(r.anomalies.length === 0 && r.problems.length === 0 && r.final.time === r.expectedT,
    `种子${s}: 最终帧=${r.final.frame} 时间码=${r.final.timecode} 字幕=${r.final.subtitle} 一致`);
}

// ---- 语义保持与资源对比 ----
console.log('\n== 语义保持与资源对比 ==');
for (const r of [A, B, C]) {
  const errs = checkSemanticsPreserved(r);
  ok(errs.length === 0, `场景${r.name} 视觉/数据语义未变${errs.length ? ': ' + errs.join(',') : ''}`);
}
ok(B.metrics.decodes < A.metrics.decodes,
  `解码次数: 优化后${B.metrics.decodes} < 优化前${A.metrics.decodes}（仅性能改善）`);
ok(B.metrics.dropped > 0, `取消标记生效: 丢弃过期请求 ${B.metrics.dropped} 个`);

console.log(`\n${failures === 0 ? '全部通过 ✔' : '失败 ' + failures + ' 项 ✗'}`);
process.exit(failures === 0 ? 0 : 1);
