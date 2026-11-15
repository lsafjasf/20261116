import { test, expect } from "@playwright/test";
import { wavDurationSeconds } from "../src/wav.js";

async function boot(page) {
  await page.goto("/index.html");
  await page.waitForFunction(() => window.workbench instanceof window.RecordingWorkbench.App);
}

async function recordOne(page, waitMs) {
  await page.click("#btnStart");
  await page.waitForSelector("#statusPill.recording");
  await page.waitForTimeout(waitMs);
  await page.click("#btnStop");
  await page.waitForSelector("#statusPill.idle");
  return page.evaluate(() => ({
    duration: window.workbench.engine.recording.duration,
    channels: window.workbench.engine.recording.numberOfChannels,
    sampleRate: window.workbench.engine.recording.sampleRate,
    meta: window.workbench.engine.recordingMeta,
    pan: window.workbench.engine.layout.mics.map((m) =>
      Number(Math.max(-1, Math.min(1, (m.x - 0.5) * 2)).toFixed(4))
    ),
    gains: window.workbench.engine.layout.mics.map((m) => m.gain),
  }));
}

test("两次真实录音 + 清空缓冲 + 立体声 WAV 导出", async ({ page }) => {
  await boot(page);

  const take1 = await recordOne(page, 1300);
  expect(take1.channels).toBe(2);
  expect(take1.duration).toBeGreaterThan(1.0);
  expect(take1.meta.beats.length).toBeGreaterThan(0);

  // 有旧缓冲时开始按钮禁用，必须先清空。
  expect(await page.isDisabled("#btnStart")).toBe(true);
  await page.click("#btnClear");
  expect(await page.evaluate(() => window.workbench.engine.hasBuffer)).toBe(false);

  // 第二次录制前改变麦克风布置与增益。
  await page.evaluate(() => {
    const app = window.workbench;
    const mics = structuredClone(app.engine.layout.mics);
    mics[0].x = 0.55;
    mics[0].gain = 1.6;
    mics[2].x = 0.4;
    mics[2].gain = 0.4;
    app.engine.updateLayout({ mics });
    app.afterLayoutChange();
  });
  const take2 = await recordOne(page, 1700);
  expect(take2.duration).toBeGreaterThan(take1.duration);
  expect(take2.gains[0]).toBeCloseTo(1.6, 2);
  expect(take2.pan[0]).not.toEqual(take1.pan[0]);
  // 节拍点来自同一份程序生成素材，两次录音节拍时刻一致。
  expect(take2.meta.beats).toEqual(take1.meta.beats);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#btnExport"),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.wav$/);
  const path = await download.path();
  const bufferFrames = await page.evaluate(() => window.workbench.engine.recording.length);
  const fs = await import("node:fs");
  const wavBytes = fs.readFileSync(path);
  expect(wavBytes.subarray(0, 4).toString()).toBe("RIFF");
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  expect(view.getUint16(22, true)).toBe(2);
  const headerDuration =
    view.getUint32(40, true) / (view.getUint32(24, true) * 2 * 2);
  expect(headerDuration).toBeCloseTo(take2.duration, 1);
  expect(bufferFrames).toBeGreaterThan(0);
});

test("快照保存/恢复：节拍点、声像、增益与导出时长一致", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const app = window.workbench;
    const mics = structuredClone(app.engine.layout.mics);
    mics[1].x = 0.25;
    mics[1].gain = 1.35;
    app.engine.updateLayout({ mics, monitorGain: 0.62 });
    app.afterLayoutChange();
  });
  const before = await recordOne(page, 1200);
  await page.click("#btnSnapshot");

  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("field-recorder-snapshot-v1"))
  );
  expect(saved.layout.mics[1].x).toBeCloseTo(0.25, 4);
  expect(saved.layout.mics[1].gain).toBeCloseTo(1.35, 2);
  expect(saved.recordingMeta.duration).toBeCloseTo(before.duration, 1);
  expect(saved.beats).toEqual(before.meta.beats);

  // 清空并故意改乱参数，再从快照恢复。
  await page.click("#btnClear");
  await page.evaluate(() => {
    const app = window.workbench;
    const mics = structuredClone(app.engine.layout.mics);
    mics[1].x = 0.9;
    mics[1].gain = 2.2;
    app.engine.updateLayout({ mics, monitorGain: 0.2 });
    app.afterLayoutChange();
  });
  await page.click("#btnRestore");

  const restored = await page.evaluate(() => ({
    layout: window.workbench.engine.layout,
    beats: window.workbench.snapshot.beats,
    savedDuration: window.workbench.snapshot.recordingMeta.duration,
    pan: window.workbench.engine.layout.mics.map((m) =>
      Number(Math.max(-1, Math.min(1, (m.x - 0.5) * 2)).toFixed(4))
    ),
  }));
  expect(restored.layout.mics[1].x).toBeCloseTo(0.25, 4);
  expect(restored.layout.mics[1].gain).toBeCloseTo(1.35, 2);
  expect(restored.layout.monitorGain).toBeCloseTo(0.62, 2);
  expect(restored.pan).toEqual(before.pan);
  expect(restored.beats).toEqual(before.meta.beats);
  expect(restored.savedDuration).toBeCloseTo(before.duration, 1);

  // 恢复后重新录制，导出时长应与快照记录的同长度会话一致（同等待时长）。
  const again = await recordOne(page, 1200);
  expect(Math.abs(again.duration - before.duration)).toBeLessThan(0.35);
});
