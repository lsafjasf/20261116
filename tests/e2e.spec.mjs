import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.errors = errors;
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.reportApi?.ready === true);
});

test.afterEach(async ({ page }) => {
  expect(page.errors, "页面不应产生运行错误").toEqual([]);
});

test("滚动会同步章节、地图与图表，筛选信息始终可见", async ({ page }) => {
  await expect(page.locator("#datasetVersion")).toContainText("LT-2026.11-A");
  await expect(page.locator("#currentFilter")).toContainText("全部片区");
  await expect(page.locator("#debugState")).toContainText('"raw": 160');

  await page.evaluate(() => document.querySelector("#chapter-speed").scrollIntoView({ block: "start" }));
  await page.waitForTimeout(450);
  await expect(page.locator("#visualChapterTitle")).toHaveText("拥堵如何蔓延");
  await expect(page.locator('[data-chapter-target="speed"]')).toHaveAttribute("aria-current", "step");
  await expect(page.locator("#chartTitle")).toHaveText("走廊速度排行");
  await expect(page.locator("#mapModeLabel")).toHaveText("颜色 = 加权速度");

  await page.evaluate(() => document.querySelector("#chapter-transit").scrollIntoView({ block: "start" }));
  await page.waitForTimeout(450);
  await expect(page.locator("#visualChapterTitle")).toHaveText("公交承担了什么");
  await expect(page.locator("#chartTitle")).toHaveText("片区出行结构");
  await expect(page.locator("#datasetVersion")).toContainText("LT-2026.11-A");
});

test("键盘可切换章节，无动画模式会即时生效", async ({ page }) => {
  const first = page.getByRole("button", { name: /第 01 章/ });
  await first.focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(350);
  await expect(page.locator("#visualChapterTitle")).toHaveText("拥堵如何蔓延");

  await page.keyboard.press("Alt+3");
  await page.waitForTimeout(350);
  await expect(page.locator("#visualChapterTitle")).toHaveText("公交承担了什么");
  await expect(page.locator('[data-chapter-target="transit"]')).toHaveAttribute("aria-current", "step");

  const motion = page.locator("#motionToggle");
  await motion.click();
  await expect(motion).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveClass(/no-motion/);
  await expect(motion.locator(".button-label")).toHaveText("无动画");
});

test("筛选变化同步更新叙述、统计、地图和调试中间态", async ({ page }) => {
  const initial = await page.evaluate(() => window.reportApi.getSnapshot());
  expect(initial.objectCount).toBe(160);

  await page.locator("#districtFilter").selectOption("D1");
  await expect(page.locator("#currentFilter")).toContainText("中心城");
  await expect(page.locator("#chapter-flow [data-narrative='lede']")).toContainText("60 条观测");
  let snapshot = await page.evaluate(() => window.reportApi.getSnapshot());
  expect(snapshot.objectCount).toBe(60);
  await expect(page.locator("#debugState")).toContainText('"selected": 60');

  await page.locator("#directionFilter").selectOption("inbound");
  await page.locator("#periodFilter").selectOption("am");
  await expect(page.locator("#chapter-flow [data-narrative='lede']")).toContainText("12 条观测");
  snapshot = await page.evaluate(() => window.reportApi.getSnapshot());
  expect(snapshot.objectCount).toBe(12);
  await expect(page.locator("#exportScope")).toContainText("12 个对象");

  await page.locator("#resetButton").click();
  await page.locator("#datasetSelect").selectOption("audit");
  await expect(page.locator("#datasetVersion")).toContainText("LT-2026.11-B");
  await expect(page.locator("#filterStatus")).toContainText("清洗排除 8 行");
  snapshot = await page.evaluate(() => window.reportApi.getSnapshot());
  expect(snapshot.pipeline).toMatchObject({ raw: 162, missing: 3, duplicate: 2, outlier: 3, clean: 154 });
  await expect(page.locator("#debugAnomalies")).toContainText("空值");
  await expect(page.locator("#debugAnomalies")).toContainText("重复");
  await expect(page.locator("#debugAnomalies")).toContainText("异常");

  await page.locator("#scopeFilter").selectOption("audit");
  await expect(page.locator("#filterStatus")).toContainText("审计口径包含异常");
  snapshot = await page.evaluate(() => window.reportApi.getSnapshot());
  expect(snapshot.objectCount).toBe(159);
  await expect(page.locator("#chapter-flow [data-narrative='lede']")).toContainText("159 条观测");
});

test("速度图不可堆叠提示明确，返回章节后状态仍一致", async ({ page }) => {
  await page.locator('[data-chapter-target="speed"]').click();
  await page.waitForTimeout(350);
  const before = await page.evaluate(() => window.reportApi.getSnapshot());

  await page.locator("#stackButton").click();
  await expect(page.locator("#chartWarning")).toBeVisible();
  await expect(page.locator("#chartWarning")).toContainText("无法堆叠");
  await expect(page.locator("#stackButton")).toHaveAttribute("aria-pressed", "true");

  await page.locator('[data-chapter-target="transit"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-chapter-target="speed"]').click();
  await page.waitForTimeout(300);
  await expect(page.locator("#chartWarning")).toBeVisible();
  await expect(page.locator("#chartWarning")).toContainText("速度表示强度，不能相加");
  await expect(page.locator("#stackButton")).toHaveAttribute("aria-pressed", "true");

  const after = await page.evaluate(() => window.reportApi.getSnapshot());
  expect(after.objectCount).toBe(before.objectCount);
  expect(after.dataHash).toBe(before.dataHash);
  expect(after.stackAttempted).toBe(true);
});

test("PNG 导出的对象数、关键数值与页面快照一致", async ({ page }) => {
  await page.locator("#districtFilter").selectOption("D3");
  await page.locator("#periodFilter").selectOption("pm");
  await page.locator('[data-chapter-target="speed"]').click();
  await page.waitForTimeout(350);
  await page.locator("#motionToggle").click();
  const before = await page.evaluate(() => window.reportApi.getSnapshot());

  const exported = await page.evaluate(async () => {
    const result = await window.reportApi.exportCurrentChapter({ download: false });
    return {
      manifest: result.manifest,
      decodedManifest: window.reportApi.readManifest(result.dataUrl),
      dataUrlLength: result.dataUrl.length
    };
  });
  expect(exported.dataUrlLength).toBeGreaterThan(100_000);
  expect(exported.decodedManifest).toEqual(exported.manifest);
  expect(exported.manifest.chapterId).toBe("speed");
  expect(exported.manifest.objectCount).toBe(before.objectCount);
  expect(exported.manifest.keyValues).toEqual(before.keyValues);
  expect(exported.manifest.dataHash).toBe(before.dataHash);
  expect(exported.manifest.filterSummary).toBe(before.filterSummary);
  await expect(page.locator("#debugExport")).toContainText('"objectCount": 6');
  await expect(page.locator("#debugExport")).toContainText('"result": "一致"');
  await expect(page.locator("#debugExportHeading")).toContainText("一致");
});

test("保存工程后改动界面，再载入可恢复全部状态", async ({ page }) => {
  await page.locator("#datasetSelect").selectOption("audit");
  await page.locator("#districtFilter").selectOption("D4");
  await page.locator("#periodFilter").selectOption("pm");
  await page.locator("#directionFilter").selectOption("outbound");
  await page.locator("#motionToggle").click();
  await page.locator('[data-chapter-target="speed"]').click();
  await page.waitForTimeout(300);
  await page.locator("#stackButton").click();
  const before = await page.evaluate(() => window.reportApi.getSnapshot());
  const project = await page.evaluate(() => window.reportApi.saveProject({ download: false }));
  expect(project.dataset.observations.length).toBe(162);
  expect(project.settings.noMotion).toBe(true);
  expect(project.settings.stackAttempted).toBe(true);

  await page.locator("#resetButton").click();
  await page.locator("#datasetSelect").selectOption("base");
  await page.locator("#motionToggle").click();
  await page.locator('[data-chapter-target="transit"]').click();
  await page.waitForTimeout(200);

  const after = await page.evaluate((savedProject) => window.reportApi.loadProject(savedProject, { announce: false }), project);
  await page.waitForTimeout(300);
  expect(after.objectCount).toBe(before.objectCount);
  expect(after.dataHash).toBe(before.dataHash);
  expect(after.filters).toEqual(before.filters);
  expect(after.chapterId).toBe("speed");
  expect(after.noMotion).toBe(true);
  expect(after.stackAttempted).toBe(true);
  await expect(page.locator("#datasetVersion")).toContainText("工程快照");
  await expect(page.locator("#chartWarning")).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/no-motion/);
});
