const { test, expect } = require("@playwright/test");
const path = require("path");

async function ready(page) {
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
}

test("两套样例、避障、删除撤销重载和导出一致性", async ({ page }) => {
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("/");
  await ready(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await ready(page);

  const sampleA = await page.evaluate(() => window.TopoForge.getState());
  expect(sampleA.backupRouteCount).toBe(2);
  expect(sampleA.visibleNodes).toBe(11);
  expect(sampleA.visibleLinks).toBe(14);

  const nodeBox = await page.locator('[data-node-id="RT-AGG-B"]').boundingBox();
  await page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(nodeBox.x + nodeBox.width / 2 - 260, nodeBox.y + nodeBox.height / 2 - 40, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.TopoForge.getState().detourCount)).toBeGreaterThan(0);
  const detouredPlan = await page.evaluate(() =>
    window.TopoForge.getDebugSnapshot().pathPlans.find((plan) => plan.id === "L-GW-CORE-A")
  );
  expect(detouredPlan.detoured).toBe(true);
  expect(detouredPlan.pathText).toContain("L");

  await page.evaluate(() => window.TopoForge.loadSample("sample-a"));
  await page.locator('[data-node-id="TERM-HMI-02"]').click();
  await page.keyboard.press("Delete");
  const deleted = await page.evaluate(() => window.TopoForge.getState());
  expect(deleted.visibleNodes).toBe(10);
  expect(deleted.visibleLinks).toBe(13);
  await expect(page.locator("#debug-events")).toContainText("TERM-HMI-02");
  await page.keyboard.press("Control+z");
  const undone = await page.evaluate(() => window.TopoForge.getState());
  expect(undone.fingerprint).toBe(sampleA.fingerprint);
  await page.reload();
  await ready(page);
  const reloaded = await page.evaluate(() => window.TopoForge.getState());
  expect(reloaded.visibleNodes).toBe(11);
  expect(reloaded.visibleLinks).toBe(14);
  expect(reloaded.fingerprint).toBe(sampleA.fingerprint);

  await page.locator(".type-chip[data-type='terminal']").click();
  const filtered = await page.evaluate(() => window.TopoForge.getState());
  expect(filtered.visibleNodes).toBe(8);
  expect(filtered.filter).toContain("隐藏 终端");
  await page.locator("#resetFilterBtn").click();

  await page.locator("#projectFileInput").setInputFiles(path.join(__dirname, "..", "samples", "topoforge-core-project.json"));
  await expect.poll(() => page.evaluate(() => window.TopoForge.getState().project)).toContain("核心园区");
  const imported = await page.evaluate(() => window.TopoForge.getState());
  expect(imported.visibleNodes).toBe(11);
  expect(imported.visibleLinks).toBe(14);
  expect(imported.fingerprint).toBe(sampleA.fingerprint);

  await page.locator("#sampleSelect").selectOption("sample-b");
  await page.waitForTimeout(100);
  const sampleB = await page.evaluate(() => ({
    state: window.TopoForge.getState(),
    quality: window.TopoForge.getProject().quality
  }));
  expect(sampleB.quality.duplicateNodes).toBe(1);
  expect(sampleB.quality.duplicateLinks).toBe(1);
  expect(sampleB.quality.nullFields).toBe(5);
  expect(sampleB.quality.anomalies).toBe(5);
  expect(sampleB.state.backupRouteCount).toBe(2);

  const verification = await page.evaluate(() => window.TopoForge.runVerification());
  expect(verification.passed).toBe(true);
  expect(verification.steps).toHaveLength(7);
  expect(verification.workflow.deletedIncidentLinks).toBeGreaterThan(1);
  expect(verification.exportAudit.countsMatch).toBe(true);
  expect(verification.exportAudit.valuesMatch).toBe(true);
  await expect(page.locator("#debug-verify")).toContainText("全部检查通过");

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportMenuBtn").click();
  await page.locator('[data-export="json"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/topology-v\d+\.json$/);
  const downloadPath = await download.path();
  const fs = require("fs");
  const exported = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
  expect(exported.nodes).toHaveLength(sampleB.state.visibleNodes);
  expect(exported.links).toHaveLength(sampleB.state.visibleLinks);
  expect(exported.stats.totalLatencyMs).toBeGreaterThan(0);
  expect(exported.dataVersion).toBe(sampleB.state.dataVersion);

  const svgDownloadPromise = page.waitForEvent("download");
  await page.locator("#exportMenuBtn").click();
  await page.locator('[data-export="svg"]').click();
  const svgDownload = await svgDownloadPromise;
  expect(svgDownload.suggestedFilename()).toMatch(/topology-v\d+\.svg$/);
  const svgPath = await svgDownload.path();
  const svgText = fs.readFileSync(svgPath, "utf8");
  expect((svgText.match(/data-node-id=/g) || [])).toHaveLength(sampleB.state.visibleNodes);
  expect((svgText.match(/data-link-id=/g) || [])).toHaveLength(sampleB.state.visibleLinks);
  expect(svgText).toContain("TopoExportSC");
  expect(consoleErrors).toEqual([]);
});
