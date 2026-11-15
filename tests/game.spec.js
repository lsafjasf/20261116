import { expect, test } from "@playwright/test";

async function enterCavern(page) {
  await page.goto("/");
  await page.locator("#enterButton").click();
  await expect(page.locator("#statusPill")).toHaveText("探索中");
  await expect.poll(async () => page.evaluate(() => window.__iceEcho.audio.context?.state)).toBe("running");
}

test("地图隐藏、同 seed、暂停与错误裂隙路径", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await enterCavern(page);
  await expect(page.locator("#stageCopy")).toHaveClass(/hidden/);
  await expect(page.locator("#resultPanel")).toBeHidden();
  await expect(page.locator("#diagNodes")).not.toHaveText("0");
  await expect(page.locator("#diagListeners")).toHaveText("5");

  await page.locator('[data-check="seed"]').click();
  await expect(page.locator("#checkReport")).toContainText("PASS · 同 seed");

  await page.locator('[data-check="pause"]').click();
  await expect(page.locator("#checkReport")).toContainText("PASS · 暂停冻结");
  expect(await page.evaluate(() => window.__iceEcho.audio.diagnostics().voices)).toBeLessThanOrEqual(1);

  await page.locator('[data-check="wrong"]').click();
  await expect(page.locator("#checkReport")).toContainText("PASS · 错误方向");
  expect(errors).toEqual([]);
});

test("成功路线、结算揭示与 WAV 导出", async ({ page }) => {
  await enterCavern(page);
  for (let index = 0; index < 3; index += 1) {
    await page.evaluate((beaconIndex) => {
      const game = window.__iceEcho.game;
      const beacon = game.level.beacons[beaconIndex];
      game.player.x = beacon.x;
      game.player.z = beacon.z;
      game.update(0.016, {});
    }, index);
  }
  await page.evaluate(() => {
    const game = window.__iceEcho.game;
    game.player.x = 0;
    game.player.z = 0;
    game.update(0.016, {});
  });
  await expect(page.locator("#resultPanel")).toBeVisible();
  await expect(page.locator("#resultTitle")).toHaveText("你回到了入口。");
  await expect(page.locator("#beaconLabel")).toHaveText("3 / 3");
  await expect.poll(async () => page.evaluate(() => window.__iceEcho.audio.diagnostics().voices)).toBe(0);

  const downloadPromise = page.waitForEvent("download");
  await page.locator('[data-check="export"]').click();
  const download = await downloadPromise;
  const path = await download.path();
  const fs = await import("node:fs");
  const header = fs.readFileSync(path).subarray(0, 44);
  expect(header.subarray(0, 4).toString()).toBe("RIFF");
  const bytes = fs.statSync(path).size;
  const sampleRate = header.readUInt32LE(24);
  const channels = header.readUInt16LE(22);
  const fileDuration = (bytes - 44) / (sampleRate * channels * 2);
  expect(fileDuration).toBeGreaterThan(6);
  await expect(page.locator("#checkReport")).toContainText("WAV 头时长");
});
