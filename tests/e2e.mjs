// End-to-end verification for the coupled-oscillator sound field.
// Covers: demo stable->complex->stable, pause/reset, input interruption,
// node destruction, repeated start, snapshot save/restore fidelity, export.
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8575';
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--no-proxy-server'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => { failed++; console.log('  PAGEERROR:', e.message); });
await page.goto(BASE + '/index.html');
await page.waitForFunction(() => window.__app);

// ---------- 1. start & status panel ----------
console.log('\n[1] 启动与状态面板');
await page.click('#btnStart');
await page.waitForFunction(() => window.__app.engine.running);
await page.waitForTimeout(500);
const s1 = await page.evaluate(() => ({
  ctx: window.__app.engine.ctx.state,
  nodes: window.__app.engine.activeNodeCount,
  listeners: window.__app.engine.activeListenerCount,
  rms: window.__app.engine.rms(),
  uiNodes: document.getElementById('stNodes').textContent,
  uiCtx: document.getElementById('stCtx').textContent,
  uiSched: document.getElementById('stSched').textContent,
}));
check('AudioContext running', s1.ctx === 'running', s1.ctx);
check('节点数 = 27 (24 声部 + 3 共享)', s1.nodes === 27, `got ${s1.nodes}`);
check('状态面板显示节点数', s1.uiNodes === '27', s1.uiNodes);
check('状态面板显示 running', s1.uiCtx === 'running' && s1.uiSched === 'running');
check('RMS 有声 (>0.01)', s1.rms > 0.01, s1.rms);

// ---------- 2. demo: stable -> complex -> stable ----------
console.log('\n[2] 演示：稳定→复杂→稳定（12s 实时扫描）');
await page.waitForFunction(() => window.__app.orderParameter(window.__app.engine.sim) > 0.85, null, { timeout: 20000 });
const rBefore = await page.evaluate(() => window.__app.orderParameter(window.__app.engine.sim));
await page.click('#btnDemo');
const rMid = [];
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(1200);
  rMid.push(await page.evaluate(() => window.__app.orderParameter(window.__app.engine.sim)));
}
await page.waitForTimeout(5500); // demo ends + settle
const rAfter = await page.evaluate(() => window.__app.orderParameter(window.__app.engine.sim));
const rMin = Math.min(...rMid);
console.log('  r: start=%s mid=[%s] end=%s', rBefore.toFixed(3), rMid.map(x=>x.toFixed(2)).join(' '), rAfter.toFixed(3));
check('起始稳定 (r>0.85)', rBefore > 0.85, rBefore);
check('中段进入复杂纹理 (min r<0.6)', rMin < 0.6, rMin);
check('结尾回到稳定 (r>0.85)', rAfter > 0.85, rAfter);
const ampBounds = await page.evaluate(() => {
  const a = window.__app.engine.sim.amps;
  return { min: Math.min(...a), max: Math.max(...a) };
});
check('振幅有界：不静默不爆音', ampBounds.min >= 0.08 && ampBounds.max <= 1.0, JSON.stringify(ampBounds));
const rmsLive = await page.evaluate(() => window.__app.engine.rms());
check('复杂段后 RMS 仍健康 (0.01..0.9)', rmsLive > 0.01 && rmsLive < 0.9, rmsLive);

// ---------- 3. pause / resume ----------
console.log('\n[3] 暂停与恢复');
await page.click('#btnPause');
await page.waitForTimeout(200);
const p1 = await page.evaluate(() => ({
  state: window.__app.engine.ctx.state,
  sched: window.__app.engine.running,
  t0: window.__app.engine.ctx.currentTime,
}));
await page.waitForTimeout(200);
const p1b = await page.evaluate(() => window.__app.engine.ctx.currentTime);
check('暂停后 context suspended', p1.state === 'suspended', p1.state);
check('暂停后调度器停止', p1.sched === false);
check('暂停后音频时钟冻结（无残留尾音）', p1b === p1.t0, `${p1.t0} -> ${p1b}`);
await page.click('#btnPause'); // resume
await page.waitForTimeout(400);
const p2 = await page.evaluate(() => ({ state: window.__app.engine.ctx.state, rms: window.__app.engine.rms() }));
check('恢复后重新发声', p2.state === 'running' && p2.rms > 0.01, JSON.stringify(p2));

// ---------- 4. input interruption: stop while dragging a slider ----------
console.log('\n[4] 输入中断（拖动滑杆途中停止）');
const slider = page.locator('#coupling');
const box = await slider.boundingBox();
await page.mouse.move(box.x + 10, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2, { steps: 5 });
await page.evaluate(() => window.__app.stop()); // stop mid-drag
await page.mouse.up();
await page.waitForTimeout(300);
const i1 = await page.evaluate(() => ({
  running: window.__app.engine.running,
  nodes: window.__app.engine.activeNodeCount,
  rms: window.__app.engine.rms(),
}));
check('中断后调度器停止', i1.running === false);
check('中断后声部节点全部释放（仅剩 3 共享）', i1.nodes === 3, `got ${i1.nodes}`);
check('中断后无尾音', i1.rms < 0.001, i1.rms);

// ---------- 5. repeated start: no dup listeners, no node leak ----------
console.log('\n[5] 重复启动（幂等 + 无泄漏）');
await page.click('#btnStart');
await page.waitForTimeout(200);
// 运行中重复触发启动（按钮已禁用，模拟竞态/程序化重复调用）
await page.evaluate(() => Promise.all([window.__app.start(), window.__app.start(), window.__app.start()]));
await page.waitForTimeout(200);
const r1 = await page.evaluate(() => ({
  starts: window.__app.engine.stats.starts,
  nodes: window.__app.engine.activeNodeCount,
  voices: window.__app.engine.voices.length,
}));
check('重复启动被幂等忽略（starts 只 +1）', r1.starts === 2, `starts=${r1.starts}`);
check('重复启动未叠加声部', r1.voices === 8 && r1.nodes === 27, `voices=${r1.voices} nodes=${r1.nodes}`);
for (let k = 0; k < 5; k++) {
  await page.click('#btnStop');
  await page.waitForTimeout(120);
  await page.click('#btnStart');
  await page.waitForTimeout(120);
}
await page.click('#btnStop');
await page.waitForTimeout(300);
const r2 = await page.evaluate(() => ({
  nodes: window.__app.engine.activeNodeCount,
  created: window.__app.engine.stats.nodesCreated,
  released: window.__app.engine.stats.nodesReleased,
  listeners: window.__app.engine.activeListenerCount,
}));
check('5 次起停后节点数回到 3', r2.nodes === 3, `got ${r2.nodes}`);
check('创建数-释放数 = 3（无泄漏）', r2.created - r2.released === 3, `${r2.created}-${r2.released}`);
check('引擎未注册任何残留监听器', r2.listeners === 0, `got ${r2.listeners}`);

// ---------- 6. node destruction via reset ----------
console.log('\n[6] 节点销毁（重置）');
await page.click('#btnStart');
await page.waitForTimeout(300);
await page.click('#btnReset');
await page.waitForTimeout(300);
const d1 = await page.evaluate(() => ({
  ctx: window.__app.engine.ctx,
  nodes: window.__app.engine.activeNodeCount,
  listeners: window.__app.engine.activeListenerCount,
  uiCtx: document.getElementById('stCtx').textContent,
  uiNodes: document.getElementById('stNodes').textContent,
}));
check('重置后 AudioContext 关闭', d1.ctx === null && d1.uiCtx === 'closed');
check('重置后活动节点 = 0', d1.nodes === 0 && d1.uiNodes === '0', `got ${d1.nodes}`);
check('重置后监听器 = 0', d1.listeners === 0);

// ---------- 7. snapshot save/restore fidelity ----------
console.log('\n[7] 快照保存/恢复一致性');
await page.click('#btnStart');
await page.waitForTimeout(1500);
await page.click('#btnPause'); // 冻结仿真，保证捕获与保存同一份状态
await page.waitForTimeout(200);
const snapA = await page.evaluate(() => {
  const app = window.__app;
  const sim = app.engine.sim;
  const gains = [...sim.amps], pans = [...sim.pans];
  const beats = app.beatTimes(sim, 300);
  return { gains, pans, beats, tick: sim.tick };
});
await page.click('#btnSave');
await page.waitForTimeout(100);
await page.click('#btnReset'); // destroy everything
await page.waitForTimeout(300);
await page.click('#btnLoad');  // restore from snapshot
await page.waitForTimeout(300);
const snapB = await page.evaluate(() => {
  const app = window.__app;
  const sim = app.engine.sim;
  return {
    gains: [...sim.amps], pans: [...sim.pans],
    beats: app.beatTimes(sim, 300), tick: sim.tick,
    params: { ...sim.params },
  };
});
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('恢复后 tick 一致', snapA.tick === snapB.tick, `${snapA.tick} vs ${snapB.tick}`);
check('恢复后增益一致', eq(snapA.gains, snapB.gains));
check('恢复后声像一致', eq(snapA.pans, snapB.pans));
check('恢复后节拍点一致', eq(snapA.beats, snapB.beats), `n=${snapA.beats.length}`);
const snapC = await page.evaluate(() => {
  const sim = window.__app.engine.sim;
  for (let i = 0; i < 120; i++) window.__app.engine.sim.tick; // noop
  return window.__app.snapshotOf(sim);
});
check('快照含完整参数', snapB.params.coupling !== undefined && snapB.params.seed !== undefined);

// ---------- 8. export duration ----------
console.log('\n[8] 导出 WAV 时长');
const exp = await page.evaluate(async () => {
  const app = window.__app;
  const snap = app.engine.snapshot();
  const { wav, duration, frames } = await app.renderOffline(snap, 2.0);
  const dv = new DataView(wav);
  const dataLen = dv.getUint32(40, true);
  const sr = dv.getUint32(24, true);
  return { duration, frames, wavSeconds: dataLen / 4 / sr, riff: dv.getUint32(0) };
});
check('渲染时长 = 2.000s', Math.abs(exp.duration - 2.0) < 1e-3, exp.duration);
check('WAV 头时长与请求一致', Math.abs(exp.wavSeconds - 2.0) < 1e-3, exp.wavSeconds);
check('WAV RIFF 头有效', exp.riff === 0x52494646);

// ---------- 9. page reload: params persist & sound field identical ----------
console.log('\n[9] 页面重载后恢复快照');
await page.reload();
await page.waitForFunction(() => window.__app);
await page.click('#btnLoad');
await page.waitForTimeout(300);
const snapD = await page.evaluate(() => {
  const app = window.__app;
  const sim = app.engine.sim;
  return { gains: [...sim.amps], pans: [...sim.pans], beats: app.beatTimes(sim, 300), tick: sim.tick };
});
check('重载后 tick 一致', snapA.tick === snapD.tick, `${snapA.tick} vs ${snapD.tick}`);
check('重载后增益一致', eq(snapA.gains, snapD.gains));
check('重载后声像一致', eq(snapA.pans, snapD.pans));
check('重载后节拍点一致', eq(snapA.beats, snapD.beats));
await page.click('#btnPause'); // 恢复播放（恢复快照后处于暂停态）
await page.waitForTimeout(400);
const finalRms = await page.evaluate(() => window.__app.engine.rms());
check('重载恢复后音场发声正常', finalRms > 0.005, finalRms);

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
