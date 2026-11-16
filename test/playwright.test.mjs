import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = path.join(root, 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });

const results = [];
function assert(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitUntil(predicate, { tries = 12, gapMs = 4000 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return true;
    await page.waitForTimeout(gapMs);
  }
  return predicate();
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});

await page.goto('http://127.0.0.1:4783/', { waitUntil: 'networkidle' });
await page.locator('#game').screenshot({ path: path.join(shotDir, 'browser-initial.png') });

// Real two-player keyboard run: P1 winch + P2 steering for a couple seconds.
await page.click('#btnManual');
await page.keyboard.down('w');
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(1400);
await page.keyboard.up('w');
await page.keyboard.up('ArrowUp');
await page.keyboard.press('q');
await page.waitForTimeout(200);
const manualTick = await page.evaluate(() => window.__iceRescue.session.state.tick);
assert('浏览器手动双人：固定节拍推进且无报错', manualTick > 20 && errors.length === 0, `tick=${manualTick}`);

// Autopilot success run and wait until finished.
await page.click('#btnDemoSuccess');
await waitUntil(() => page.evaluate(
  () => window.__iceRescue.session.lastRecording && window.__iceRescue.session.lastRecording.result === 'success',
));
const successRec = await page.evaluate(() => window.__iceRescue.session.lastRecording);
assert('浏览器自动演示：成功救援', successRec.result === 'success' && successRec.reason === 'safe',
  `ticks=${successRec.ticks} integrity=${successRec.finalState.integrity}`);
await page.locator('#game').screenshot({ path: path.join(shotDir, 'browser-success.png') });

// Replay with pause, single step and 2x/4x; final state must stay identical.
await page.click('#btnReplay');
await page.waitForTimeout(300);
await page.click('#btnPause');
const pausedFrame = await page.evaluate(() => window.__iceRescue.replayer.cursor);
await page.click('#btnStep');
const steppedFrame = await page.evaluate(() => window.__iceRescue.replayer.cursor);
assert('浏览器回放：暂停后单步只前进一帧', steppedFrame === pausedFrame + 1,
  `${pausedFrame} -> ${steppedFrame}`);
const checksumAtStep = await page.evaluate(() => {
  const r = window.__iceRescue.replayer;
  return r.recording.timeline[r.cursor].checksum;
});
await page.click('[data-speed="4"]');
await waitUntil(() => page.evaluate(() => window.__iceRescue.replayer.playing === false));
const replayFinal = await page.evaluate(() => {
  const r = window.__iceRescue.replayer;
  const last = r.recording.timeline[r.recording.timeline.length - 1];
  return { cursor: r.cursor, checksum: last.checksum, status: r.recording.result };
});
assert('浏览器回放：4x 倍速后到达同一终态',
  replayFinal.status === 'success' && typeof replayFinal.checksum === 'string',
  `finalChecksum=${replayFinal.checksum}`);
const replayText = await page.textContent('#replayResult');
assert('浏览器回放：UI 显示逐帧校验通过', replayText.includes('通过'));
await page.locator('#game').screenshot({ path: path.join(shotDir, 'browser-replay-end.png') });

// Save / reload restores gauges, integrity and progress.
await page.click('#btnReset');
await page.click('#btnDemoSuccess');
await waitUntil(() => page.evaluate(() => window.__iceRescue.session.state.tick > 120), { tries: 6 });
await page.evaluate(() => { window.__iceRescue.session.recorder.finished; });
await page.click('#btnSave');
const savedBaseline = await page.evaluate(() => {
  const save = window.__iceRescue.loadGame();
  return {
    tick: save.tick,
    checksum: window.__iceRescue.checksum(save.state),
    progress: save.state.progress,
    integrity: save.state.integrity,
    tension: save.state.gauges.tension,
  };
});
await page.evaluate(() => {
  // Wipe the live session, then reload purely from persistence.
  window.__iceRescue.session.start('manual', null);
});
await page.click('#btnReload');
await page.waitForTimeout(300);
const reloadText = await page.textContent('#reloadResult');
const reloadValues = await page.evaluate(() => {
  const s = window.__iceRescue.loadGame();
  const report = window.__iceRescue.verifyReload(s, {
    createState: window.__iceRescue.session.constructor.restoreState,
    runStep: (st, input) => { window.__iceRescue.step(st, input); return st; },
    checksumOf: window.__iceRescue.checksum,
  });
  return report;
});
assert('浏览器重载：仪表/耐久/进度恢复且 checksum 一致',
  reloadText.includes('一致')
  && reloadValues.ok
  && reloadValues.tick === savedBaseline.tick
  && Math.abs(reloadValues.progress - savedBaseline.progress) < 0.01
  && Math.abs(reloadValues.integrity - savedBaseline.integrity) < 0.01
  && Math.abs(reloadValues.gauges.tension - savedBaseline.tension) < 0.001
  && reloadValues.rebuiltChecksum === savedBaseline.checksum
  && reloadValues.savedChecksum === savedBaseline.checksum,
  `tick=${reloadValues.tick} checksum=${reloadValues.rebuiltChecksum}`);
await page.locator('#game').screenshot({ path: path.join(shotDir, 'browser-reload.png') });

// Failure autopilot + conflict scan.
await page.click('#btnDemoFailure');
await waitUntil(() => page.evaluate(
  () => window.__iceRescue.session.lastRecording && window.__iceRescue.session.lastRecording.result === 'failure',
), { tries: 8 });
const failRec = await page.evaluate(() => window.__iceRescue.session.lastRecording);
assert('浏览器自动演示：冰面断裂失败', failRec.reason === 'ice-break' && failRec.conflicts.length > 0,
  `conflicts=${failRec.conflicts.length}`);
await page.click('#btnReplay');
await page.waitForTimeout(200);
await page.click('#btnConflictScan');
await page.waitForTimeout(300);
const conflictLog = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('#log div.conflict')];
  return nodes.map((n) => n.textContent).filter((t) => t.includes('顺序冲突'));
});
assert('浏览器冲突扫描：显示具体时刻与对象位置',
  conflictLog.length > 0 && conflictLog[0].includes('tick') && conflictLog[0].includes('物资箱'),
  conflictLog[0] || '');
await page.locator('#game').screenshot({ path: path.join(shotDir, 'browser-conflict.png') });

assert('浏览器全程无控制台错误', errors.length === 0, errors.join(' | '));

await browser.close();
const ok = results.every((r) => r.ok);
fs.writeFileSync(path.join(root, 'recordings', 'playwright-results.json'), JSON.stringify(results, null, 2));
console.log(`\n${ok ? 'BROWSER CHECKS PASSED' : 'BROWSER CHECKS FAILED'} (${results.filter((r) => r.ok).length}/${results.length})`);
process.exit(ok ? 0 : 1);
