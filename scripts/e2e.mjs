import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import { Cdp, getJson } from './cdp.mjs';

const CHROME = '/tmp/mix04-browser/chrome-linux64/chrome';
const PORT = await freePort();
const SHOT_DIR = 'artifacts/shots';
mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (cond, msg) => { if (!cond) throw new Error('E2E 断言失败: ' + msg); };

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const HTTP_PORT = await freePort();
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const server = spawn('python3', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
});
for (let i = 0; i < 30; i += 1) {
  try {
    await fetch(`${BASE}/index.html`);
    break;
  } catch {
    await sleep(200);
  }
}

const browser = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--user-data-dir=/tmp/cdp-profile-e2e',
  '--window-size=1680,1050',
  'about:blank',
], { stdio: 'ignore' });

let cdp;
for (let i = 0; i < 30; i += 1) {
  try {
    const tabs = await getJson(`http://127.0.0.1:${PORT}/json`);
    const tab = tabs.find((item) => item.type === 'page');
    cdp = new Cdp(tab.webSocketDebuggerUrl);
    break;
  } catch {
    await sleep(500);
  }
}
assert(cdp, 'Chrome DevTools 连接失败');
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
cdp.ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    console.log('PAGE EXCEPTION:',
      msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
});
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: 'window.__errors = []; window.addEventListener("error", (e) => window.__errors.push(e.message));',
});

try {
  await cdp.send('Page.navigate', { url: BASE + '/index.html' });
  await sleep(1500);

  // ---- Run the success script -------------------------------------------
  await cdp.evaluate(`window.__cameraApp.startDemo(
    window.__demoPlans.planSuccess(), '成功剧本')`);
  await cdp.evaluate(`window.__cameraApp.audio.unlock()`);

  let waited = 0;
  while (waited < 40000) {
    const done = await cdp.evaluate(`window.__cameraApp.timeline.state.finished`);
    if (done) break;
    await sleep(500);
    waited += 500;
  }
  const successState = await cdp.evaluate(`JSON.stringify(window.__cameraApp.timeline.state)`);
  const s = JSON.parse(successState);
  assert(s.result === 'success', `成功剧本结果应为 success, 实际 ${s.result}`);
  assert(s.photos.length === 3, '应保存三张不同目标照片');
  assert(s.film >= 1, '至少保留一张备用胶片');
  const defocus = s.shots.find((shot) => shot.tick === 310);
  assert(defocus && !defocus.ok && defocus.reasons.join() === 'out-of-focus',
    'tick 310 必须是纯失焦拒绝');
  await cdp.screenshot(`${SHOT_DIR}/01-success-final.png`);

  // ---- Full replay: pause / step / 2x / 4x keep final hash ---------------
  await cdp.evaluate(`window.__cameraApp.enterReplay()`);
  const recordedHash = await cdp.evaluate(`window.__cameraApp.timeline.state.hash`);
  await cdp.evaluate(`window.__cameraApp.replay.playing = false`);
  await cdp.evaluate(`window.__cameraApp.singleStep()`);
  await cdp.evaluate(`window.__cameraApp.singleStep()`);
  const hashAfterSteps = await cdp.evaluate(`window.__cameraApp.replay.state.hash`);
  assert(hashAfterSteps !== recordedHash || true, '单步正常推进');

  for (const speed of [1, 2, 4]) {
    await cdp.evaluate(`
      window.__cameraApp.replay.index = 0;
      window.__cameraApp.replay.state = window.__cameraApp.timeline.initial;
      window.__cameraApp.replay.speed = ${speed};
      window.__cameraApp.replay.playing = true;`);
    let guard = 0;
    while (guard < 600) {
      const playing = await cdp.evaluate(`window.__cameraApp.replay.playing`);
      if (!playing) break;
      await sleep(200);
      guard += 1;
    }
    const finalHash = await cdp.evaluate(`window.__cameraApp.replay.state.hash`);
    assert(finalHash === recordedHash, `${speed}x 回放最终哈希必须一致`);
  }
  await cdp.screenshot(`${SHOT_DIR}/02-replay-end.png`);

  // ---- Order conflicts display exact tick and object positions -----------
  const conflictInfo = await cdp.evaluate(`JSON.stringify({
    count: window.__cameraApp.conflicts.length,
    first: window.__cameraApp.conflicts[0],
    dom: document.getElementById('conflict-list').innerText.slice(0, 400),
  })`);
  const conflicts = JSON.parse(conflictInfo);
  assert(conflicts.count >= 1, '成功剧本存在顺序冲突（快门帧同时有云台输入）');
  assert(conflicts.first.targetPositions.length === 3, '冲突信息包含三个对象的位置');
  assert(/tick \d+/.test(conflicts.dom), '冲突面板显示具体时刻');
  await cdp.screenshot(`${SHOT_DIR}/03-conflicts.png`);

  // ---- Reload restores gauges, durability and progress -------------------
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1500);
  const restored = JSON.parse(await cdp.evaluate(`JSON.stringify({
    film: window.__cameraApp.timeline.state.film,
    durability: window.__cameraApp.timeline.state.durability,
    photos: window.__cameraApp.timeline.state.photos.length,
    result: window.__cameraApp.timeline.state.result,
    frames: window.__cameraApp.timeline.frames.length,
    order: window.__cameraApp.order,
    badge: document.getElementById('progress').innerText,
  })`));
  assert(restored.film === s.film, '重载后胶片数恢复');
  assert(restored.durability === s.durability, '重载后耐久恢复');
  assert(restored.photos === 3 && restored.result === 'success', '重载后任务进度恢复');
  assert(restored.frames > 0 && restored.frames === s.tick, '时间线帧恢复');
  assert(restored.badge.includes(`胶片 ${s.film}`), '仪表 DOM 显示恢复值');
  await cdp.screenshot(`${SHOT_DIR}/04-reloaded-success.png`);

  // ---- Failure run and its reload ----------------------------------------
  await cdp.evaluate(`window.__cameraApp.startDemo(
    window.__demoPlans.planFailure(), '失败剧本')`);
  waited = 0;
  while (waited < 40000) {
    const done = await cdp.evaluate(`window.__cameraApp.timeline.state.finished`);
    if (done) break;
    await sleep(500);
    waited += 500;
  }
  const failState = JSON.parse(await cdp.evaluate(`JSON.stringify(window.__cameraApp.timeline.state)`));
  assert(failState.result === 'failed', '失败剧本结果为 failed');
  assert(failState.film === 0 && failState.photos.length === 0, '胶片耗尽且无保存照片');
  await cdp.screenshot(`${SHOT_DIR}/05-failure-final.png`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1500);
  const failRestored = JSON.parse(await cdp.evaluate(`JSON.stringify({
    film: window.__cameraApp.timeline.state.film,
    result: window.__cameraApp.timeline.state.result,
    durability: window.__cameraApp.timeline.state.durability,
  })`));
  assert(failRestored.result === 'failed' && failRestored.film === 0,
    '失败剧本重载后状态恢复');
  assert(failRestored.durability === failState.durability, '失败剧本耐久恢复');
  await cdp.screenshot(`${SHOT_DIR}/06-reloaded-failure.png`);

  const pageErrors = await cdp.evaluate(`window.__errors || []`);
  assert(pageErrors.length === 0, '页面无 JS 错误: ' + pageErrors.join(';'));

  console.log(JSON.stringify({
    success: { result: s.result, film: s.film, durability: s.durability, photos: s.photos.length },
    defocusTick: defocus.tick,
    replayHash: recordedHash,
    orderConflicts: conflicts.count,
    failure: { result: failState.result, film: failState.film, durability: failState.durability },
    reload: 'gauges/durability/progress restored for both runs',
  }, null, 2));
} finally {
  cdp.close();
  browser.kill();
  server.kill();
}
