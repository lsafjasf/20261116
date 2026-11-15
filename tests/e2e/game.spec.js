import { expect, test } from '@playwright/test';

async function boot(page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('#stage')).toBeVisible();
}

test('two-sided keyboard input survives a full page reload', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await boot(page);
  await page.evaluate(() => window.__TWIN_SORT__.newRun());
  await page.evaluate(() => window.__TWIN_SORT__.advanceSeconds(6.2));

  await page.keyboard.press('q');
  await page.waitForFunction(
    () => window.__TWIN_SORT__.getAudioState().context === 'running'
  );
  const audioState = await page.evaluate(() => window.__TWIN_SORT__.getAudioState());
  expect(audioState.enabled).toBe(true);
  expect(audioState.humFrequency).toBeGreaterThan(0);
  await page.evaluate(() => window.__TWIN_SORT__.advanceSeconds(0.5));
  await expect(page.locator('#p1-scanned')).toHaveText('1');

  await page.keyboard.press('e');
  await page.evaluate(() => window.__TWIN_SORT__.advanceSeconds(0.7));
  const destination = await page.evaluate(
    () =>
      window.__TWIN_SORT__.getSim().packages.find((pkg) => pkg.status === 'belt')
        ?.dest
  );
  expect(destination === 'A' || destination === 'B').toBeTruthy();
  await page.keyboard.press(destination === 'A' ? 'j' : 'l');
  await page.evaluate(() => window.__TWIN_SORT__.advanceSeconds(0.5));
  expect(await page.evaluate(() => window.__TWIN_SORT__.getSim().stats.routed)).toBeGreaterThan(0);

  const saved = await page.evaluate(() => {
    const api = window.__TWIN_SORT__;
    const sim = api.getSim();
    let lastScanAt = -10;
    const hasPending = (side, actions) =>
      sim.pending.some(
        (input) => input.side === side && actions.includes(input.action)
      );
    for (let index = 0; index < 1400 && sim.phase === 'running' && sim.time < 125; index += 1) {
      const queue = sim.frontQueued();
      const scanned = sim.scannedPackage();
      const ahead = sim.beltPackages()[0];
      if (queue && !scanned && !hasPending('p1', ['scan']) && sim.time - lastScanAt > 0.7) {
        sim.press('p1', 'scan');
        lastScanAt = sim.time;
      }
      if (scanned && !sim.lineStop && !hasPending('p1', ['release']) && (!ahead || ahead.x > 342)) {
        sim.press('p1', 'release');
      }
      const target = sim.routeTarget();
      if (target && !target.plannedLane && !hasPending('p2', ['laneA', 'laneB'])) {
        sim.press('p2', target.dest === 'A' ? 'laneA' : 'laneB');
      }
      if (sim.cacheLoad() > 0 && sim.cooldowns.pack <= sim.time && !hasPending('p2', ['pack'])) {
        sim.press('p2', 'pack');
      }
      sim.advanceTick();
    }
    for (let index = 0; index < 45; index += 1) sim.advanceTick();
    api.saveCheckpoint(true);
    return {
      time: sim.time,
      p1Durability: sim.durability.p1,
      p2Durability: sim.durability.p2,
      scanned: sim.stats.scanned,
      packed: sim.stats.packed,
      total: sim.total,
      digest: sim.digest(),
    };
  });
  expect(saved.packed).toBeGreaterThan(2);
  expect(saved.p1Durability).toBeLessThan(100);
  expect(saved.p2Durability).toBeLessThan(100);

  await page.reload();
  await expect(page.locator('#toast')).toContainText('已恢复检查点');
  const restored = await page.evaluate(() => {
    const sim = window.__TWIN_SORT__.getSim();
    return {
      time: sim.time,
      p1Durability: sim.durability.p1,
      p2Durability: sim.durability.p2,
      scanned: sim.stats.scanned,
      packed: sim.stats.packed,
      progressText: document.querySelector('#progress-text').textContent,
      p1Gauge: document.querySelector('#p1-durability').textContent,
      p2Gauge: document.querySelector('#p2-durability').textContent,
      scannedUi: document.querySelector('#p1-scanned').textContent,
      packedUi: document.querySelector('#p2-packed').textContent,
    };
  });
  expect(restored.time).toBeGreaterThanOrEqual(saved.time);
  expect(restored.time - saved.time).toBeLessThan(2);
  expect(restored.p1Durability).toBe(saved.p1Durability);
  expect(restored.p2Durability).toBe(saved.p2Durability);
  expect(restored.scanned).toBe(saved.scanned);
  expect(restored.packed).toBe(saved.packed);
  expect(restored.progressText).toBe(`${saved.packed} / ${saved.total}`);
  expect(restored.p1Gauge).toBe(`${saved.p1Durability.toFixed(0)}%`);
  expect(restored.p2Gauge).toBe(`${saved.p2Durability.toFixed(0)}%`);
  expect(errors).toEqual([]);
});

test('built-in success and failure replays expose conflicts, coordinates and hash match', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await boot(page);

  await page.locator('#load-success').click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'replay');
  await expect(page.locator('#replay-seek')).toHaveAttribute('max', '5068');
  const successMetadata = await page.evaluate(() => ({
    duration: window.__TWIN_SORT__.getRecording().duration,
    digest: window.__TWIN_SORT__.getRecording().finalDigest,
  }));
  expect(successMetadata.duration).toBe(506.8);

  await page.evaluate(() => {
    const api = window.__TWIN_SORT__;
    api.setReplaySpeed(8);
    api.seekReplay(506.6, true);
  });
  await page.locator('#replay-play').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'success');
  await expect(page.locator('#replay-verdict')).toContainText('HASH MATCH');
  await expect(page.locator('#replay-verdict')).toContainText(successMetadata.digest);
  expect(await page.evaluate(() => window.__TWIN_SORT__.verifyReplay().match)).toBe(true);

  await page.evaluate(() => window.__TWIN_SORT__.seekReplay(364, true));
  await expect(page.locator('#conflict-card')).toContainText('动作顺序反转');
  await expect(page.locator('#conflict-card')).toContainText('06:03.2');
  await expect(page.locator('#conflict-card')).toContainText('PKG-035');
  await expect(page.locator('#conflict-card')).toContainText('(48, 318)');
  await expect(page.locator('#conflict-card')).toContainText('PKG-030');
  await expect(page.locator('#conflict-card')).toContainText('(1036, 427)');

  await page.locator('#load-failure').click();
  await page.waitForFunction(
    () => window.__TWIN_SORT__.getRecording().runId === 'DEMO-FAILURE'
  );
  await page.evaluate(() => window.__TWIN_SORT__.seekReplay(144.3, true));
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'failure');
  await expect(page.locator('#conflict-card')).toContainText('缓存溢出连锁');
  await expect(page.locator('#conflict-card')).toContainText('碰撞点 1010,238');
  expect(await page.evaluate(() => window.__TWIN_SORT__.verifyReplay().match)).toBe(true);
  expect(errors).toEqual([]);
});

test('single-step and seek/continue replay reach the exact recorded final hash', async ({ page }) => {
  await boot(page);
  await page.locator('#load-success').click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'replay');
  const result = await page.evaluate(() => {
    const api = window.__TWIN_SORT__;
    const recording = api.getRecording();
    api.setReplaySpeed(8);
    api.seekReplay(recording.duration - 0.4, true);
    for (let index = 0; index < 4; index += 1) api.stepReplay();
    const stepped = api.verifyReplay();
    return { stepped, expected: recording.finalDigest };
  });
  expect(result.stepped.match).toBe(true);
  expect(result.stepped.digest).toBe(result.expected);

  await page.evaluate(() => window.__TWIN_SORT__.seekReplay(0, true));
  await page.evaluate(() => window.__TWIN_SORT__.setReplaySpeed(1));
  await page.locator('#replay-speed').click();
  await expect(page.locator('#replay-speed')).toContainText('2×');
  await page.locator('#replay-speed').click();
  await expect(page.locator('#replay-speed')).toContainText('4×');
  await page.locator('#replay-speed').click();
  await expect(page.locator('#replay-speed')).toContainText('8×');
  const seeked = await page.evaluate(() => {
    const api = window.__TWIN_SORT__;
    const recording = api.getRecording();
    api.seekReplay(recording.duration, true);
    return api.verifyReplay();
  });
  expect(seeked.match).toBe(true);
  expect(seeked.digest).toBe(result.expected);
});
