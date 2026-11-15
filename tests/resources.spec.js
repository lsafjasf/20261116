import { expect, test } from "@playwright/test";

async function enterCavern(page) {
  await page.goto("/");
  await page.locator("#enterButton").click();
  await expect(page.locator("#statusPill")).toHaveText("探索中");
}

test("输入中断、节点销毁与重复启动不泄漏资源", async ({ page }) => {
  await enterCavern(page);
  await page.waitForTimeout(200);

  await page.locator('[data-check="interrupt"]').click();
  await expect(page.locator("#checkReport")).toContainText("PASS · 输入中断");

  await page.locator('[data-check="duplicate"]').click();
  await expect(page.locator("#checkReport")).toContainText("PASS · 连续启动");
  const duplicateState = await page.evaluate(() => window.__iceEcho.audio.diagnostics());
  expect(duplicateState.listenerCount).toBe(1);
  expect(duplicateState.ambientSources).toBe(1);
  expect(duplicateState.schedulerRunning).toBe(true);

  await page.locator('[data-check="destroy"]').click();
  await expect(page.locator("#checkReport")).toContainText("PASS · 销毁前");
  const lifecycle = await page.evaluate(() => window.__iceEcho.audio.diagnostics().lifecycle.map((entry) => entry.message));
  expect(lifecycle).toContain("graph:destroyed");

  await page.evaluate(() => window.__iceEcho.pauseRun("尾音检查"));
  await page.waitForTimeout(450);
  const stopped = await page.evaluate(() => ({
    diagnostics: window.__iceEcho.audio.diagnostics(),
    levels: window.__iceEcho.audio.getLevels(),
    controls: window.__iceEcho.diagnostics().controls,
    inputListeners: window.__iceEcho.diagnostics().inputListeners,
  }));
  expect(stopped.diagnostics.voices).toBe(0);
  expect(stopped.diagnostics.schedulerRunning).toBe(false);
  expect(stopped.levels.peak).toBe(0);
  expect(Object.values(stopped.controls).every((value) => !value)).toBe(true);
  expect(stopped.inputListeners).toBe(4);
});

test("参数快照往返与导出时长一致", async ({ page }) => {
  await enterCavern(page);
  await page.waitForTimeout(180);

  await page.locator("#snapshotButton").click();
  await expect(page.locator("#snapshotStatus")).toContainText("已保存 6 个节拍点");
  await expect(page.locator("#restoreButton")).toBeEnabled();
  const before = await page.evaluate(() => ({
    signature: window.__iceEcho.snapshot.signature,
    duration: window.__iceEcho.snapshot.duration,
    fileDuration: window.__iceEcho.snapshot.fileDuration,
    params: window.__iceEcho.snapshot.params,
  }));
  expect(before.signature).toHaveLength(6);
  expect(new Set(before.signature.map((event) => event.beat)).size).toBe(6);
  expect(before.signature.some((event) => Math.abs(event.pan) > 0.01)).toBe(true);
  expect(before.signature.every((event) => event.gain >= 0)).toBe(true);
  expect(before.fileDuration).toBeGreaterThan(6);

  await page.locator("#restoreButton").click();
  await expect(page.locator("#snapshotStatus")).toContainText("快照恢复一致");
  await expect(page.locator("#restoreButton")).toBeDisabled();
  const after = await page.evaluate(() => ({
    used: window.__iceEcho.snapshot.restoreUsed,
    params: window.__iceEcho.params,
    beat: window.__iceEcho.audio.beat,
  }));
  expect(after.used).toBe(true);
  expect(after.params).toMatchObject(before.params);

  const downloadPromise = page.waitForEvent("download");
  await page.locator('[data-check="export"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.wav$/);
  await expect(page.locator("#checkReport")).toContainText("PASS · 已生成");
  expect(await page.evaluate(() => window.__iceEcho.lastExport.fileDuration)).toBeGreaterThan(6);
});
