import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2'
};

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const relative = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, relative);
    const data = await readFile(file);
    response.writeHead(200, {
      'Content-Type': mime[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
const errors = [];
const report = { checks: [], screenshots: [] };

page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

const state = () => page.evaluate(() => window.__assemblyGame.state);
const waitTicks = (ticks) => page.waitForTimeout(ticks * 16);

async function screenshot(name) {
  const path = `artifacts/${name}.png`;
  await page.screenshot({ path });
  report.screenshots.push(path);
}

async function waitForPhase(phase, timeout = 20000) {
  await page.waitForFunction(
    (expected) => window.__assemblyGame.state.phase === expected,
    phase,
    { timeout }
  );
}

async function runSynchronizedCycle() {
  const keys = { a: false, l: false };
  const setKey = async (key, down) => {
    if (keys[key] === down) return;
    if (down) await page.keyboard.down(key === 'a' ? 'a' : 'l');
    else await page.keyboard.up(key === 'a' ? 'a' : 'l');
    keys[key] = down;
  };

  const deadline = Date.now() + 19000;
  while (Date.now() < deadline) {
    const current = await state();
    if (current.phase === 'active') {
      if (!current.leftHeld) await setKey('a', true);
      if (!current.rightHeld && current.pressure < 58) await setKey('l', true);
      if (current.rightHeld && current.pressure > 72) await setKey('l', false);
    } else {
      await setKey('a', false);
      await setKey('l', false);
      if (current.phase === 'complete' || current.phase === 'failed') {
        return current;
      }
    }
    await waitTicks(2);
  }
  throw new Error('Synchronized cycle did not settle');
}

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal((await state()).phase, 'idle');
  await screenshot('01-initial');

  await page.click('#startButton');
  await page.waitForFunction(() => window.__assemblyGame.state.phase === 'active');
  await page.keyboard.down('a');
  await page.waitForTimeout(360);
  await page.keyboard.down('l');
  await page.waitForTimeout(360);
  await page.keyboard.up('l');
  await page.keyboard.up('a');
  const inProgress = await page.evaluate(() => {
    const current = window.__assemblyGame.state;
    const payload = {
      phase: current.phase,
      completed: current.completed,
      inventory: current.inventory,
      durability: current.durability,
      offset: current.offset,
      pressure: current.pressure,
      domOffset: Number(document.getElementById('offsetValue').textContent),
      domPressure: Number(document.getElementById('pressureValue').textContent),
      domMission: document.getElementById('missionCount').textContent
    };
    window.__assemblyGame.app.persistSession();
    return payload;
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__assemblyGame.state.phase === 'active');
  const midRestore = await page.evaluate(() => {
    const current = window.__assemblyGame.state;
    return {
      phase: current.phase,
      completed: current.completed,
      inventory: current.inventory,
      durability: current.durability,
      offset: current.offset,
      pressure: current.pressure,
      domMission: document.getElementById('missionCount').textContent
    };
  });
  assert.equal(midRestore.phase, 'active');
  assert.equal(midRestore.completed, inProgress.completed);
  assert.equal(midRestore.inventory, inProgress.inventory);
  assert.equal(midRestore.durability, inProgress.durability);
  assert.ok(Math.abs(midRestore.offset - inProgress.offset) < 5);
  assert.ok(Math.abs(midRestore.pressure - inProgress.pressure) < 5);
  assert.equal(midRestore.domMission, inProgress.domMission);
  report.checks.push('in-progress reload restored live meters, durability and progress');
  report.midRestore = { before: inProgress, after: midRestore };

  await page.click('#resetButton');
  const success = await runSynchronizedCycle();
  assert.equal(success.phase, 'complete');
  assert.equal(success.completed, 3);
  assert.equal(success.inventory, 1);
  assert.equal(success.durability, 94);
  assert.equal(success.timeline.results.filter((item) => item.kind === 'assembly-clear').length, 3);
  report.checks.push('real keyboard run completed 3 assemblies with 1 spare');
  await screenshot('02-success');

  const beforeReload = await page.evaluate(() => ({
    offset: document.getElementById('offsetValue').textContent,
    pressure: document.getElementById('pressureValue').textContent,
    grip: document.getElementById('gripValue').textContent,
    durability: document.getElementById('durabilityValue').textContent,
    mission: document.getElementById('missionCount').textContent
  }));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const restored = await state();
  const afterReload = await page.evaluate(() => ({
    offset: document.getElementById('offsetValue').textContent,
    pressure: document.getElementById('pressureValue').textContent,
    grip: document.getElementById('gripValue').textContent,
    durability: document.getElementById('durabilityValue').textContent,
    mission: document.getElementById('missionCount').textContent
  }));
  assert.equal(restored.phase, 'complete');
  assert.equal(restored.completed, 3);
  assert.equal(restored.inventory, 1);
  assert.equal(restored.durability, 94);
  assert.deepEqual(afterReload, beforeReload);
  report.checks.push('reload restored both side meters, durability and 3/3 progress');
  report.restore = { beforeReload, afterReload };
  await screenshot('03-restored');

  await page.click('#currentReplayButton');
  await page.waitForFunction(() => window.__assemblyGame.mode === 'replay');
  const currentReplayExpected = await page.evaluate(
    () => window.__assemblyGame.replay.record.expected.fingerprint
  );
  await page.evaluate(() => {
    window.__assemblyGame.pauseReplay();
    window.__assemblyGame.seekReplay(window.__assemblyGame.replay.record.endTick);
  });
  const currentReplayFingerprint = await page.evaluate(
    () => window.__assemblyGame.replay.engine.fingerprint()
  );
  assert.equal(currentReplayFingerprint, currentReplayExpected);
  await page.evaluate(() => window.__assemblyGame.exitReplay());
  report.checks.push('current-run replay reproduced its saved final fingerprint');

  await page.click('#resetButton');
  await page.keyboard.down('a');
  await page.waitForTimeout(90);
  await page.keyboard.down('l');
  await waitForPhase('failed');
  await page.keyboard.up('a');
  await page.keyboard.up('l');
  const failure = await state();
  assert.equal(failure.phase, 'failed');
  assert.equal(failure.completed, 0);
  assert.equal(failure.inventory, 3);
  assert.equal(failure.durability, 65);
  assert.equal(failure.timeline.collisions[0].type, 'crush');
  assert.ok(failure.timeline.collisions[0].position.x > 0);
  report.checks.push('real keyboard failure crushed gasket with collision coordinates');
  report.failure = {
    durability: failure.durability,
    collision: failure.timeline.collisions[0]
  };
  await screenshot('04-failure');

  await page.click('#resetButton');
  await page.keyboard.down('a');
  await waitForPhase('failed', 12000);
  await page.keyboard.up('a');
  const soloLeft = await state();
  assert.equal(soloLeft.phase, 'failed');
  assert.equal(soloLeft.completed, 0);
  assert.equal(soloLeft.timeline.collisions[0].type, 'timeout');

  await page.click('#resetButton');
  await page.keyboard.down('l');
  await waitForPhase('failed', 6000);
  await page.keyboard.up('l');
  const soloRight = await state();
  assert.equal(soloRight.phase, 'failed');
  assert.equal(soloRight.completed, 0);
  assert.equal(soloRight.timeline.collisions[0].type, 'lateral');
  report.checks.push('solo left and solo right both fail before completion');

  await page.evaluate(() => window.__assemblyGame.playDemo());
  await page.waitForTimeout(700);
  await page.evaluate(() => window.__assemblyGame.pauseReplay());
  const pausedTick = (await page.evaluate(() => window.__assemblyGame.replay.engine.state.tick));
  await waitTicks(8);
  const stillPausedTick = (await page.evaluate(() => window.__assemblyGame.replay.engine.state.tick));
  assert.equal(stillPausedTick, pausedTick);
  await page.evaluate(() => {
    window.__assemblyGame.stepReplay();
    window.__assemblyGame.stepReplay();
    window.__assemblyGame.stepReplay();
    window.__assemblyGame.setReplaySpeed(4);
    window.__assemblyGame.pauseReplay();
  });
  await page.waitForFunction(
    () => window.__assemblyGame.mode === 'replay' && window.__assemblyGame.replay.done,
    { timeout: 12000 }
  );
  const replayResult = await page.evaluate(() => ({
    fingerprint: window.__assemblyGame.replay.engine.fingerprint(),
    expected: window.__assemblyGame.replay.record.expected.fingerprint,
    verified: window.__assemblyGame.replay.verified,
    verdict: document.getElementById('replayVerdict').textContent,
    conflict: window.__assemblyGame.replay.engine.state.timeline.conflicts[0],
    phase: window.__assemblyGame.replay.engine.state.phase,
    completed: window.__assemblyGame.replay.engine.state.completed,
    inventory: window.__assemblyGame.replay.engine.state.inventory
  }));
  assert.equal(replayResult.verified, true);
  assert.equal(replayResult.fingerprint, replayResult.expected);
  assert.equal(replayResult.phase, 'complete');
  assert.equal(replayResult.completed, 3);
  assert.equal(replayResult.inventory, 1);
  assert.equal(replayResult.conflict.tick, 15);
  assert.ok(replayResult.conflict.position.x > 0);
  report.checks.push('pause, 3 single steps and 4x speed preserved final fingerprint');
  report.replay = replayResult;
  await page.waitForTimeout(180);
  await screenshot('05-replay-verified');

  await page.evaluate(() => window.__assemblyGame.seekReplay(150));
  const midTick = await page.evaluate(() => window.__assemblyGame.replay.engine.state.tick);
  assert.equal(midTick, 150);
  await page.evaluate(() => window.__assemblyGame.seekReplay(window.__assemblyGame.replay.record.endTick));
  const seekFingerprint = await page.evaluate(() => window.__assemblyGame.replay.engine.fingerprint());
  assert.equal(seekFingerprint, replayResult.expected);
  report.checks.push('scrubbing to end reproduced the expected final fingerprint');

  assert.deepEqual(errors, []);
  report.status = 'passed';
  report.errors = errors;
  report.generatedAt = new Date().toISOString();
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/browser-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
