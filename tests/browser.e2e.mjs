import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const port = 43_000 + (process.pid % 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const executableCandidates = [
  process.env.CHROMIUM_PATH,
  "/home/hj/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome",
  "/home/hj/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"
].filter(Boolean);

async function findChromium() {
  for (const candidate of executableCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known browser location.
    }
  }
  return undefined;
}

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server startup timeout")), 5_000);
    server.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    server.once("error", reject);
  });

  const executablePath = await findChromium();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.title(), "Phase Split · 双轨节拍");
  assert.equal(await page.evaluate(() => Boolean(window.__phaseSplit)), true);
  assert.equal(await page.locator("#objective").textContent(), "锁定六十秒时间线");
  assert.equal(await page.evaluate(() => document.fonts.check('16px "Phase CJK"')), true);
  await page.screenshot({ path: "artifacts/browser-ready.png", fullPage: true });

  await page.click("#calibrate-button");
  await page.waitForFunction(() => window.__phaseSplit.game.state === "CALIBRATION");
  assert.equal(await page.locator("#calibration-panel").isVisible(), true);
  assert.ok(await page.evaluate(() => window.__phaseSplit.audio.resources().calibrationClicks) > 0);
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("k");
    await page.waitForTimeout(140);
  }
  await page.waitForFunction(() => window.__phaseSplit.game.state === "READY");
  const calibratedOffset = await page.evaluate(() => window.__phaseSplit.game.calibrationOffset);
  assert.ok(calibratedOffset >= -180 && calibratedOffset <= 180);
  assert.equal(await page.evaluate(() => window.__phaseSplit.audio.resources().calibrationClicks), 0);
  await page.evaluate(() => window.__phaseSplit.game.setCalibrationOffset(0));

  await page.click("#start-button");
  await page.waitForFunction(() => ["COUNTDOWN", "PLAYING"].includes(window.__phaseSplit.game.state));
  const liveResources = await page.evaluate(() => window.__phaseSplit.resources());
  assert.equal(liveResources.audio.laneCount, 2);
  assert.equal(liveResources.audio.analyserCount, 2);
  assert.equal(liveResources.audio.spectrumBins, 96);
  assert.ok(liveResources.audio.sampleRate > 0);
  assert.equal(await page.locator("#stage").evaluate((canvas) => canvas.width > 0 && canvas.height > 0), true);

  const success = await page.evaluate(() => window.__phaseSplit.playPerfectRoute());
  assert.equal(success.state, "SUCCESS");
  assert.equal(success.score, 105_000);
  assert.match(success.finalHash, /^[0-9a-f]{16}$/);
  await page.waitForFunction(() => window.__phaseSplit.game.state === "SUCCESS");
  assert.equal(await page.locator("#clock").textContent(), "60.000");
  assert.match(await page.locator("#overlay-title").textContent(), /六十秒曲目完成/);
  assert.match(await page.locator("#run-meta").textContent(), new RegExp(success.finalHash));
  await page.screenshot({ path: "artifacts/browser-success.png", fullPage: true });

  const savedRecord = await page.evaluate(() => window.__phaseSplit.getLastRecord());
  assert.equal(savedRecord.finalHash, success.finalHash);
  assert.equal(savedRecord.inputs.length, success.inputs);
  const replay = await page.evaluate((record) => window.__phaseSplit.replayNow(record), savedRecord);
  assert.equal(replay.state, "SUCCESS");
  assert.equal(replay.match, true);
  assert.equal(replay.hash, success.finalHash);
  await page.waitForFunction(() => /哈希一致/.test(document.querySelector("#overlay-title").textContent));

  const mistake = await page.evaluate(() => window.__phaseSplit.playMistakeRoute());
  assert.equal(mistake.state, "SUCCESS");
  assert.equal(mistake.misses, 1);
  assert.equal(mistake.integrity, 100);
  assert.equal(mistake.blurLane === 0 || mistake.blurLane === 1, true);
  const mistakeRecord = await page.evaluate(() => window.__phaseSplit.getLastRecord());
  const mistakeReplay = await page.evaluate(
    (record) => window.__phaseSplit.replayNow(record),
    mistakeRecord
  );
  assert.equal(mistakeReplay.match, true);

  const failure = await page.evaluate(() => window.__phaseSplit.triggerFailure());
  assert.equal(failure.state, "FAILED");
  assert.equal(failure.integrity, 0);
  assert.equal(failure.misses, 9);
  await page.waitForFunction(() => window.__phaseSplit.game.state === "FAILED");
  await page.screenshot({ path: "artifacts/browser-failed.png", fullPage: true });

  await page.click("#recover-button");
  await page.waitForFunction(() => window.__phaseSplit.game.state === "READY");
  const recovered = await page.evaluate(() => ({
    snapshot: window.__phaseSplit.snapshot(),
    resources: window.__phaseSplit.resources()
  }));
  assert.equal(recovered.snapshot.songMs, 0);
  assert.equal(recovered.snapshot.integrity, 100);
  assert.equal(recovered.snapshot.inputCount, 0);
  assert.equal(recovered.resources.audio.activeVoices, 0);
  assert.equal(recovered.resources.visual.particles, 0);

  await page.click("#start-button");
  await page.waitForFunction(() => window.__phaseSplit.game.state === "PLAYING");
  await page.waitForTimeout(180);
  await page.click("#pause-button");
  await page.waitForFunction(() => window.__phaseSplit.game.state === "PAUSED");
  await page.waitForFunction(() => window.__phaseSplit.audio.context.state === "suspended");
  const pausedClock = await page.locator("#clock").textContent();
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#clock").textContent(), pausedClock);
  assert.equal(await page.locator("#overlay-title").textContent(), "时间线已冻结");
  await page.click("#start-button");
  await page.waitForFunction(() => window.__phaseSplit.game.state === "PLAYING");
  await page.waitForFunction(() => window.__phaseSplit.audio.context.state === "running");

  await page.evaluate(() => {
    const game = window.__phaseSplit.game;
    game.restart(game.seed);
    game.startCalibration();
    for (let index = 0; index < 5; index += 1) game.addCalibrationSample(99_999);
  });
  const calibration = await page.evaluate(() => ({
    offset: window.__phaseSplit.game.calibrationOffset,
    state: window.__phaseSplit.game.state,
    offsets: [
      window.__phaseSplit.game.setCalibrationOffset(-99_999),
      window.__phaseSplit.game.setCalibrationOffset(99_999)
    ]
  }));
  assert.equal(calibration.offset, 180);
  assert.equal(calibration.state, "READY");
  assert.deepEqual(calibration.offsets, [-180, 180]);

  const beforeReset = await page.evaluate(() => window.__phaseSplit.resources());
  const reset = await page.evaluate(() => window.__phaseSplit.resetProbe());
  assert.equal(reset.state, "READY");
  assert.equal(reset.songMs, 0);
  assert.equal(reset.score, 0);
  assert.equal(reset.integrity, 100);
  assert.equal(reset.combo, 0);
  assert.equal(reset.inputs, 0);
  assert.equal(reset.chartStable, true);
  assert.equal(reset.randomStable, true);
  assert.equal(reset.audio.activeVoices, 0);
  assert.equal(reset.visual.particles, 0);
  assert.ok(beforeReset.visual.notePool === reset.visual.notePool);

  await page.evaluate(() => window.__phaseSplit.game.setCalibrationOffset(0));
  const rerun = await page.evaluate(() => window.__phaseSplit.playPerfectRoute());
  assert.equal(rerun.finalHash, success.finalHash);
  const rerunReplay = await page.evaluate(() => {
    const record = window.__phaseSplit.getLastRecord();
    return window.__phaseSplit.replayNow(record);
  });
  assert.equal(rerunReplay.match, true);

  assert.deepEqual(errors, []);
  await page.screenshot({ path: "artifacts/browser-reset-success.png", fullPage: true });

  const report = {
    successHash: success.finalHash,
    successReplayMatch: replay.match,
    mistakeHash: mistake.finalHash,
    mistakeReplayMatch: mistakeReplay.match,
    recordedInputs: [savedRecord.inputs.length, mistakeRecord.inputs.length],
    failure: { state: failure.state, misses: failure.misses, integrity: failure.integrity },
    calibrationFlowOffset: calibratedOffset,
    pauseFrozen: true,
    calibrationOffsets: calibration.offsets,
    reset,
    rerunHash: rerun.finalHash,
    rerunHashMatchesSuccess: rerun.finalHash === success.finalHash,
    consoleErrors: errors
  };
  await writeFile("artifacts/browser-verification.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
} finally {
  server.kill("SIGTERM");
}
