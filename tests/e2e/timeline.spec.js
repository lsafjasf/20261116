import { test, expect } from "@playwright/test";

async function openApp(page) {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__timelineApp));
  await page.evaluate(() => window.__timelineApp.whenIdle());
  expect(pageErrors).toEqual([]);
}

async function verify(page) {
  return page.evaluate(() => window.__timelineApp.verifyThumbnails());
}

async function appSnapshot(page) {
  return page.evaluate(() => ({
    project: window.__timelineApp.getProject(),
    revision: window.__timelineApp.getRevision(),
    metrics: window.__timelineApp.getMetrics(),
    tiles: window.__timelineApp.getTileStates(),
    slots: window.__timelineApp.getSlots(),
  }));
}

test.describe("默认参数", () => {
  test("二十次快速拖动后每一格缩略图仍对应正确时间", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.__timelineApp.setZoom(3));
    await page.evaluate(() => window.__timelineApp.whenIdle());
    await page.evaluate(() => window.__timelineApp.debug.setLatency(180, 50));
    await page.evaluate(() => {
      window.__queueMaximum = 0;
      window.__queueSampler = setInterval(() => {
        const value = Number(document.querySelector("#queueLength").textContent);
        window.__queueMaximum = Math.max(window.__queueMaximum, value);
      }, 8);
    });
    const box = await page.locator("#timelineScroll").boundingBox();
    expect(box).not.toBeNull();
    const y = box.y + box.height * 0.48;
    for (let index = 0; index < 20; index += 1) {
      const leftToRight = index % 2 === 0;
      const startX = box.x + box.width * (leftToRight ? 0.84 : 0.16);
      const endX = box.x + box.width * (leftToRight ? 0.16 : 0.84);
      await page.mouse.move(startX, y);
      await page.mouse.down();
      await page.mouse.move(endX, y, { steps: 3 });
      await page.mouse.up();
    }
    const queueMaximum = await page.evaluate(() => {
      clearInterval(window.__queueSampler);
      return window.__queueMaximum;
    });
    expect(queueMaximum).toBeGreaterThan(0);
    await page.evaluate(() => window.__timelineApp.whenIdle());

    const result = await verify(page);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.checked).toBeGreaterThan(5);
    for (const cell of result.cells) {
      expect(cell.key).toContain(`t${cell.timeMs}`);
      expect(cell.key).toContain("192x108");
    }
    const snapshot = await appSnapshot(page);
    expect(snapshot.metrics.queueLength).toBe(0);
    expect(snapshot.metrics.staleDrops).toBeGreaterThan(0);
    for (const tile of snapshot.tiles) {
      expect(tile.state).toBe("ready");
      expect(tile.frameTimeMs).toBe(tile.timeMs);
      expect(tile.frameKey).toBe(tile.key);
    }
    const hitRateText = await page.locator("#hitRate").textContent();
    expect(Number.parseFloat(hitRateText)).toBeGreaterThan(0);
    await expect(page.locator("#verificationStatus")).toContainText("一致性通过");
  });

  test("导出与预览逐像素一致，并保留导出前工程快照", async ({ page }, testInfo) => {
    await openApp(page);
    await page.evaluate(() => window.__timelineApp.setCurrentTime(31_250));
    const downloadEvents = [];
    page.on("download", (download) => downloadEvents.push(download));
    await page.locator("#exportButton").click();
    await expect(page.locator("#exportStatus")).toContainText("逐像素一致");
    await expect.poll(() => downloadEvents.length).toBe(2);
    const savedNames = [];
    for (const [index, download] of downloadEvents.entries()) {
      const name = download.suggestedFilename();
      savedNames.push(name);
      await download.saveAs(testInfo.outputPath(`export-${index}-${name}`));
    }
    expect(savedNames.some((name) => name.endsWith(".png"))).toBe(true);
    expect(savedNames.some((name) => name.includes("before-export.json"))).toBe(true);

    const result = await page.evaluate(() => window.__timelineApp.getLastExport());
    expect(result.pixelDifferences).toBe(0);
    expect(result.previewHash).toBe(result.exportHash);
    expect(result.width).toBe(960);
    expect(result.height).toBe(540);
    const snapshots = await page.evaluate(() => window.__timelineApp.getSnapshots());
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0].reason).toBe("before-export");
    expect(snapshots[0].project).toEqual(await page.evaluate(() => window.__timelineApp.getProject()));
    expect(snapshots[0].ui.currentTimeMs).toBe(31_250);
  });

  test("修改图层后导出、重载仍保留顺序、关键帧、坐标与颜色", async ({ page }) => {
    await openApp(page);
    await page.locator('.layer-item[data-layer-id="orbit-ring"]').click();
    await page.locator('.layer-item[data-layer-id="orbit-ring"] [data-move="1"]').click();
    await page.evaluate(() => window.__timelineApp.setCurrentTime(45_000));
    await page.locator("#layerColor").evaluate((element) => {
      element.value = "#12abef";
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.locator("#layerX").fill("321");
    await page.locator("#layerX").press("Tab");
    await page.locator("#addKeyframeButton").click();
    await page.evaluate(() => window.__timelineApp.setCurrentTime(45_000));

    const beforeReload = await page.evaluate(() => window.__timelineApp.getProject());
    const exportResult = await page.evaluate(() => window.__timelineApp.exportNow({ download: false }));
    expect(exportResult.ok).toBe(true);
    expect(exportResult.pixelDifferences).toBe(0);
    const snapshot = await page.evaluate(() => window.__timelineApp.getLastSnapshot());
    expect(snapshot.project).toEqual(beforeReload);

    await page.reload();
    await page.waitForFunction(() => Boolean(window.__timelineApp));
    await page.evaluate(() => window.__timelineApp.whenIdle());
    const afterReload = await page.evaluate(() => window.__timelineApp.getProject());
    expect(afterReload).toEqual(beforeReload);
    expect(afterReload.layers.map((layer) => layer.id)).toEqual(beforeReload.layers.map((layer) => layer.id));

    const orbitRing = afterReload.layers.find((layer) => layer.id === "orbit-ring");
    const keyframe = orbitRing.keyframes.find((item) => item.timeMs === 45_000);
    expect(keyframe).toBeTruthy();
    expect(keyframe.x).toBe(321);
    expect(keyframe.color).toBe("#12abef");
    const verifyResult = await verify(page);
    expect(verifyResult.ok).toBe(true);
  });
});

test.describe("边界参数", () => {
  test("最小/最大缩放、首尾时间与三种裁切比例均保持正确帧", async ({ page }) => {
    await openApp(page);
    const duration = await page.evaluate(() => window.__timelineApp.getProject().durationMs);

    await page.evaluate(() => window.__timelineApp.setZoom(0.5));
    await page.evaluate(() => window.__timelineApp.scrollToTime(0));
    await page.evaluate(() => window.__timelineApp.whenIdle());
    expect((await verify(page)).ok).toBe(true);

    await page.evaluate((time) => window.__timelineApp.scrollToTime(time), duration);
    await page.evaluate(() => window.__timelineApp.whenIdle());
    let result = await verify(page);
    expect(result.ok).toBe(true);
    const lastThumbnailTime = Math.max(...result.cells.map((cell) => cell.timeMs));
    expect(lastThumbnailTime).toBeLessThanOrEqual(duration);
    expect(lastThumbnailTime).toBeGreaterThan(duration - 10_000);
    await page.evaluate((time) => window.__timelineApp.setCurrentTime(time), duration);
    const boundaryExport = await page.evaluate(() => window.__timelineApp.exportNow({ download: false }));
    expect(boundaryExport.ok).toBe(true);
    expect(boundaryExport.timeMs).toBe(duration);

    await page.evaluate(() => window.__timelineApp.setZoom(4));
    await page.evaluate(() => window.__timelineApp.scrollToTime(0));
    await page.evaluate(() => window.__timelineApp.whenIdle());
    result = await verify(page);
    expect(result.ok).toBe(true);
    expect(result.cells.length).toBeGreaterThan(8);

    for (const aspect of ["9:16", "1:1", "16:9"]) {
      await page.evaluate((value) => window.__timelineApp.setCropAspect(value), aspect);
      await page.evaluate(() => window.__timelineApp.whenIdle());
      result = await verify(page);
      expect(result.ok).toBe(true);
      for (const cell of result.cells) expect(cell.key).toContain(`crop:${aspect}`);
      const canvasSize = await page.locator("#previewCanvas").evaluate((canvas) => ({
        width: canvas.width,
        height: canvas.height,
      }));
      const expected =
        aspect === "9:16"
          ? { width: 540, height: 960 }
          : aspect === "1:1"
            ? { width: 720, height: 720 }
            : { width: 960, height: 540 };
      expect(canvasSize).toEqual(expected);
      const exportResult = await page.evaluate(() => window.__timelineApp.exportNow({ download: false }));
      expect(exportResult.ok).toBe(true);
      expect(exportResult.pixelDifferences).toBe(0);
    }
  });
});

test.describe("异常参数", () => {
  test("旧异步结果晚到不会覆盖新请求，最终帧仍锁定到目标时间", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.__timelineApp.setZoom(4));
    await page.evaluate(() => window.__timelineApp.debug.setLatency(300, 40));
    const targets = [12_000, 48_000, 9_000, 77_000, 21_000, 104_000, 3_000, 65_000, 88_000, 16_000];
    await page.evaluate(async (values) => {
      for (const time of values) {
        window.__timelineApp.scrollToTime(time);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }, targets);
    await page.evaluate(() => window.__timelineApp.whenIdle());
    const result = await verify(page);
    expect(result.ok).toBe(true);
    const state = await appSnapshot(page);
    expect(state.metrics.staleDrops).toBeGreaterThan(0);
    for (const tile of state.tiles) {
      expect(tile.frameTimeMs).toBe(tile.timeMs);
      expect(tile.frameKey).toBe(tile.key);
    }
  });

  test("缓存失效会立即清除旧帧、显示安全占位并自动重建", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.__timelineApp.debug.invalidateCache("测试：模拟缓存失效"));
    const immediate = await page.evaluate(() => ({
      tiles: window.__timelineApp.getTileStates(),
      notice: document.querySelector("#noticeText").textContent,
      noticeVisible: !document.querySelector("#notice").hidden,
    }));
    expect(immediate.noticeVisible).toBe(true);
    expect(immediate.notice).toContain("旧缩略帧已立即隔离");
    expect(immediate.tiles.length).toBeGreaterThan(0);
    for (const tile of immediate.tiles) {
      expect(["fallback", "loading"]).toContain(tile.state);
      expect(tile.frameTimeMs).toBeNaN();
      expect(tile.frameKey).toBeNull();
    }
    await page.evaluate(() => window.__timelineApp.whenIdle());
    expect((await verify(page)).ok).toBe(true);
  });

  test("缩略帧加载/身份校验失败时回退占位，恢复后可重试到全部一致", async ({ page }) => {
    await openApp(page);
    const failuresBefore = await page.evaluate(() => window.__timelineApp.getMetrics().cache.failures);
    await page.evaluate(() => {
      window.__timelineApp.debug.failNextFrames(4);
      window.__timelineApp.debug.invalidateCache("测试：缩略帧解码失败");
    });
    await page.evaluate(() => window.__timelineApp.whenIdle());
    const failedState = await page.evaluate(() => ({
      tiles: window.__timelineApp.getTileStates(),
      metrics: window.__timelineApp.getMetrics(),
      notice: document.querySelector("#noticeText").textContent,
      fallbackPixels: [...document.querySelectorAll('.thumbnail-cell[data-state="error"] canvas')].map(
        (canvas) => canvas.toDataURL().length,
      ),
    }));
    expect(failedState.metrics.cache.failures).toBeGreaterThan(failuresBefore);
    const errors = failedState.tiles.filter((tile) => tile.state === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(failedState.notice).toContain("没有继续显示旧内容");
    expect(failedState.fallbackPixels.length).toBe(errors.length);
    for (const length of failedState.fallbackPixels) expect(length).toBeGreaterThan(2_000);
    for (const tile of errors) {
      expect(tile.frameTimeMs).toBeNaN();
      expect(tile.frameKey).toBeNull();
    }

    await page.evaluate(() => {
      window.__timelineApp.debug.recoverFrames();
      window.__timelineApp.debug.retryFailed();
    });
    await page.evaluate(() => window.__timelineApp.whenIdle());
    expect((await verify(page)).ok).toBe(true);

    await page.evaluate(() => {
      window.__timelineApp.debug.corruptNextFrames(2);
      window.__timelineApp.debug.invalidateCache("测试：异步帧身份损坏");
    });
    await page.evaluate(() => window.__timelineApp.whenIdle());
    const corrupted = await page.evaluate(() => ({
      tiles: window.__timelineApp.getTileStates(),
      notice: document.querySelector("#noticeText").textContent,
    }));
    expect(corrupted.tiles.some((tile) => tile.state === "error")).toBe(true);
    expect(corrupted.notice).toContain("没有继续显示旧内容");
    await page.evaluate(() => {
      window.__timelineApp.debug.recoverFrames();
      window.__timelineApp.debug.retryFailed();
    });
    await page.evaluate(() => window.__timelineApp.whenIdle());
    expect((await verify(page)).ok).toBe(true);
  });
});
