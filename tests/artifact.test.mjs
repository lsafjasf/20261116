import { test, expect } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";

test("生成演示截图与导出 WAV 工件", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => window.workbench);
  await page.evaluate(() => {
    const app = window.workbench;
    const mics = structuredClone(app.engine.layout.mics);
    mics[0].x = 0.42;
    mics[0].gain = 1.4;
    mics[2].angle = Math.PI;
    app.engine.updateLayout({ mics });
    app.afterLayoutChange();
  });
  await page.screenshot({ path: "artifacts/room-idle.png", fullPage: true });

  await page.click("#btnStart");
  await page.waitForSelector("#statusPill.recording");
  await page.waitForTimeout(900);
  await page.screenshot({ path: "artifacts/room-recording.png", fullPage: true });
  const stats = await page.evaluate(() => ({
    nodes: window.workbench.engine.activeNodes,
    listeners: window.workbench.engine.activeListeners,
    beats: window.workbench.engine.beats,
  }));
  await page.click("#btnStop");
  await page.waitForSelector("#statusPill.idle");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#btnExport"),
  ]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/session-demo.wav", Buffer.concat(chunks));

  expect(stats.nodes).toBeGreaterThan(10);
  expect(stats.listeners).toBe(1);
  expect(stats.beats.length).toBeGreaterThan(0);
});
