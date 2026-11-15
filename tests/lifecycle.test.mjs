import { test, expect } from "@playwright/test";

async function boot(page) {
  await page.goto("/index.html");
  await page.waitForFunction(() => window.workbench instanceof window.RecordingWorkbench.App);
  return page.evaluate(() => window.workbench);
}

test("节点销毁与重复启动：停止后无残留节点/监听器，重复 start 被拒绝", async ({ page }) => {
  await boot(page);

  await page.click("#btnStart");
  await page.waitForSelector("#statusPill.recording");
  const running = await page.evaluate(() => ({
    nodes: window.workbench.engine.activeNodes,
    listeners: window.workbench.engine.activeListeners,
    state: window.workbench.engine.ctx.state,
  }));
  expect(running.nodes).toBeGreaterThan(10);
  expect(running.listeners).toBe(1);
  expect(running.state).toBe("running");

  const doubleStart = await page.evaluate(async () => {
    try {
      await window.workbench.engine.start();
      return "no-error";
    } catch (err) {
      return err.message;
    }
  });
  expect(doubleStart).toContain("禁止重复启动");

  await page.click("#btnStop");
  await page.waitForSelector("#statusPill.idle");
  await page.waitForFunction(() => window.workbench.engine.activeNodes === 0);
  const after = await page.evaluate(() => ({
    nodes: window.workbench.engine.activeNodes,
    listeners: window.workbench.engine.activeListeners,
    ctx: window.workbench.engine.ctx,
    startCount: window.workbench.engine.startCount,
  }));
  expect(after.nodes).toBe(0);
  expect(after.listeners).toBe(0);
  expect(after.ctx).toBeNull();
  expect(after.startCount).toBe(1);

  // 旧缓冲未清空时拒绝重新录制。
  const blocked = await page.evaluate(() => window.document.getElementById("btnStart").disabled);
  expect(blocked).toBe(true);
});

test("运行中输入中断：节点被销毁且统计数下降", async ({ page }) => {
  await boot(page);
  await page.click("#btnStart");
  await page.waitForSelector("#statusPill.recording");
  const before = await page.evaluate(() => window.workbench.engine.activeNodes);
  await page.evaluate(() => window.workbench.engine.interruptInput("voice"));
  await page.waitForFunction(
    (baseline) => window.workbench.engine.activeNodes <= baseline - 2,
    before
  );
  const after = await page.evaluate(() => ({
    nodes: window.workbench.engine.activeNodes,
    hasVoice: window.workbench.engine._sourceChains.has("voice"),
  }));
  expect(after.hasVoice).toBe(false);
  expect(after.nodes).toBeLessThan(before);
  await page.click("#btnStop");
  await page.waitForFunction(() => window.workbench.engine.activeNodes === 0);
});

test("录音中布局锁定：调整位置被拒绝，旧轨道不改变", async ({ page }) => {
  await boot(page);
  await page.click("#btnStart");
  await page.waitForSelector("#statusPill.recording");
  const message = await page.evaluate(() => {
    try {
      window.workbench.engine.updateLayout({ monitorGain: 0.1 });
      return "no-error";
    } catch (err) {
      return err.message;
    }
  });
  expect(message).toContain("锁定");
  await page.click("#btnStop");
  await page.waitForSelector("#statusPill.idle");
});

test("实时停止无尾音：淡出末端之后录制缓冲严格为零", async ({ page }) => {
  await boot(page);
  await page.click("#btnStart");
  await page.waitForSelector("#statusPill.recording");
  await page.waitForTimeout(1000);
  await page.click("#btnStop");
  await page.waitForSelector("#statusPill.idle");
  const tail = await page.evaluate(() => {
    const buf = window.workbench.engine.recording;
    const left = buf.getChannelData(0);
    const right = buf.getChannelData(1);
    // 硬切断点之后必须严格为零（无混响/节点残留尾音）。
    let max = 0;
    const boundary = Math.floor(left.length - 2048);
    for (let i = boundary; i < left.length; i++) {
      max = Math.max(max, Math.abs(left[i]), Math.abs(right[i]));
    }
    return { max, nodes: window.workbench.engine.activeNodes };
  });
  expect(tail.max).toBe(0);
  expect(tail.nodes).toBe(0);
});
