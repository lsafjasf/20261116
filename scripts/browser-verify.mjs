import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const port = 4927;
const origin = `http://127.0.0.1:${port}`;
const executablePath = process.env.CHROME_BIN || "/tmp/chrome-linux64/chrome";
const outDir = new URL("../artifacts/", import.meta.url);
await mkdir(outDir, { recursive: true });

const server = spawn(process.execPath, ["scripts/serve.mjs"], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local verification server did not start");
}

const browserErrors = [];
const report = {
  browser: "Google Chrome for Testing 140.0.7339.82",
  mode: "solo",
  checks: {},
};

try {
  await waitForServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(String(error)));

  await page.goto(`${origin}/?seed=e2e-success-01&mode=solo`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__LATCH3__));
  await page.evaluate(() => {
    window.__LATCH3__.restart();
    window.__LATCH3__.pause();
  });
  await page.waitForTimeout(100);

  assert.equal(await page.title(), "LATCH//3 · 三轴轨道对接");
  assert.equal(await page.locator("#mode-name").textContent(), "单人调试");
  assert.match(await page.locator("#mode-hint").textContent(), /A\/D 方位/);
  assert.equal(await page.locator("#seed-display").textContent(), "e2e-success-01");
  assert.equal(await page.evaluate(() => window.__LATCH3__.getRuntime().mode), "solo");

  const baseline = await page.evaluate(() => {
    const api = window.__LATCH3__;
    return {
      state: api.getState(),
      hash: api.getHash(),
      runtime: api.getRuntime(),
      visual: api.getVisualState(),
    };
  });
  assert.equal(baseline.state.tick, 0);
  assert.equal(baseline.state.resources.propellant, 100);
  assert.equal(baseline.state.resources.power, 100);
  assert.equal(baseline.runtime.audio.distanceBand, "FAR");

  const audioState = await page.evaluate(() => window.__LATCH3__.ensureAudio());
  assert.equal(audioState, "running");

  await page.selectOption("#mode-select", "crew");
  assert.equal(await page.locator("#mode-name").textContent(), "三人协作");
  assert.match(await page.locator("#mode-hint").textContent(), /P1 A\/D/);
  await page.selectOption("#mode-select", "solo");
  assert.equal(await page.locator("#mode-name").textContent(), "单人调试");
  report.checks.modeSwitch = true;

  await page.evaluate(() => {
    window.__LATCH3__.restart();
  });
  await page.keyboard.down("d");
  await page.waitForTimeout(360);
  await page.keyboard.up("d");
  await page.waitForTimeout(100);
  const keyboardState = await page.evaluate(() => window.__LATCH3__.getState());
  assert.ok(keyboardState.x > 0, "单人模式 D 键应产生正向方位机动");
  assert.ok(keyboardState.tick > 0);
  report.checks.soloKeyboardInput = {
    x: keyboardState.x,
    tick: keyboardState.tick,
  };

  const movingTick = await page.evaluate(() => window.__LATCH3__.getRuntime().tick);
  await page.click("#pause-button");
  await page.waitForTimeout(300);
  const pausedTick = await page.evaluate(() => window.__LATCH3__.getRuntime().tick);
  assert.ok(pausedTick >= movingTick);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__LATCH3__.getRuntime().tick), pausedTick);
  assert.equal(await page.locator("#overlay").isVisible(), true);
  await page.click("#overlay-primary");
  await page.waitForTimeout(250);
  assert.ok((await page.evaluate(() => window.__LATCH3__.getRuntime().tick)) > pausedTick);
  report.checks.pauseFreeze = true;

  await page.evaluate(() => {
    const api = window.__LATCH3__;
    api.restart();
    api.pause();
    api.setCommands({ yaw: 1, pitch: -1, throttle: 1 });
    api.step(150);
  });
  await page.waitForTimeout(100);
  const dirty = await page.evaluate(() => ({
    state: window.__LATCH3__.getState(),
    visual: window.__LATCH3__.getVisualState(),
  }));
  assert.equal(dirty.state.tick, 150);
  assert.ok(dirty.state.resources.propellant < 100);
  assert.notEqual(dirty.visual.module.x, baseline.visual.module.x);

  await page.evaluate(() => {
    window.__LATCH3__.restart();
    window.__LATCH3__.pause();
  });
  await page.waitForTimeout(100);
  const reset = await page.evaluate(() => {
    const api = window.__LATCH3__;
    return {
      state: api.getState(),
      hash: api.getHash(),
      runtime: api.getRuntime(),
      visual: api.getVisualState(),
    };
  });
  assert.equal(reset.state.tick, 0);
  assert.equal(reset.state.elapsed, 0);
  assert.equal(reset.state.resources.propellant, 100);
  assert.deepEqual(reset.runtime.random, baseline.runtime.random);
  assert.deepEqual(reset.visual, baseline.visual);
  assert.equal(reset.runtime.audio.distanceBand, "FAR");
  assert.equal(reset.hash, baseline.hash);
  report.checks.restartReset = {
    timerReset: true,
    resourcesReset: true,
    randomReset: true,
    visualReset: true,
    audioDistanceReset: true,
    stateHash: reset.hash,
  };

  const nearMission = await page.evaluate(() => {
    const api = window.__LATCH3__;
    api.restart();
    api.pause();
    const result = api.advanceAutopilot(2000);
    return { state: result.state, runtime: api.getRuntime(), visual: api.getVisualState() };
  });
  assert.equal(nearMission.state.phase, "hold");
  assert.ok(nearMission.state.d < 2);
  assert.equal(nearMission.runtime.audio.distanceBand, "LOCK");
  await page.evaluate(() => window.__LATCH3__.resume());
  await page.waitForTimeout(50);
  await page.screenshot({
    path: new URL("browser-approach-hold.png", outDir).pathname,
    fullPage: true,
  });
  await page.evaluate(() => window.__LATCH3__.pause());
  report.checks.distanceAudio = {
    far: baseline.runtime.audio.distanceBand,
    near: nearMission.runtime.audio.distanceBand,
    range: nearMission.state.d,
  };

  const success = await page.evaluate(() => {
    const api = window.__LATCH3__;
    api.restart();
    api.pause();
    return api.advanceAutopilot(7000);
  });
  assert.equal(success.state.phase, "complete");
  assert.equal(success.state.latchCount, 2);
  await page.waitForTimeout(120);
  assert.match(await page.locator("#overlay-title").textContent(), /两次锁定/);
  await page.screenshot({ path: new URL("browser-success.png", outDir).pathname, fullPage: true });

  const replay = await page.evaluate(() => {
    const api = window.__LATCH3__;
    const record = api.makeRecord();
    const validation = api.validateRecord(record);
    api.startRecordReplay(record);
    const replayedHash = api.advanceReplayToEnd();
    return {
      recordHash: record.finalHash,
      validationHash: validation.hash,
      validationMatch: validation.match,
      replayedHash,
      replayEvents: record.inputLog.length,
      replayFinished: api.getRuntime().replayFinished,
    };
  });
  assert.equal(replay.validationMatch, true);
  assert.equal(replay.replayedHash, replay.recordHash);
  assert.equal(replay.validationHash, replay.recordHash);
  assert.equal(replay.replayFinished, true);
  await page.waitForTimeout(120);
  assert.match(await page.locator("#overlay-title").textContent(), /回放结束/);
  report.checks.success = {
    phase: success.state.phase,
    elapsed: success.state.elapsed,
    latchCount: success.state.latchCount,
    finalHash: success.hash,
    ...replay,
  };
  await page.evaluate(() => window.__LATCH3__.exitReplay());

  const failure = await page.evaluate(() => {
    const api = window.__LATCH3__;
    api.restart();
    api.pause();
    api.setCommands({ yaw: 0, pitch: 0, throttle: 1 });
    api.step(1000);
    return api.getState();
  });
  assert.equal(failure.phase, "failed");
  assert.match(failure.failure, /速度超过结构极限|过冲/);
  await page.waitForTimeout(120);
  assert.match(await page.locator("#overlay-title").textContent(), /对接中止/);
  assert.equal(await page.locator("#recover-button").isDisabled(), false);
  await page.screenshot({ path: new URL("browser-failure.png", outDir).pathname, fullPage: true });

  await page.click("#overlay-primary");
  await page.waitForTimeout(120);
  const recovered = await page.evaluate(() => ({
    state: window.__LATCH3__.getState(),
    runtime: window.__LATCH3__.getRuntime(),
  }));
  assert.equal(recovered.state.phase, "approach");
  assert.equal(recovered.state.tick, 0);
  assert.equal(recovered.state.resources.propellant, 100);
  assert.deepEqual(recovered.runtime.random, baseline.runtime.random);
  report.checks.failureRecovery = {
    failureReason: failure.failure,
    recoveredTick: recovered.state.tick,
    recoveredResources: recovered.state.resources,
  };

  const limit = await page.evaluate(() => {
    const api = window.__LATCH3__;
    api.restart();
    api.pause();
    api.setCommands({ yaw: 999, pitch: -999, throttle: 999 });
    const commands = api.getState().commands;
    api.step(1000);
    return { commands, state: api.getState() };
  });
  assert.deepEqual(limit.commands, { yaw: 1, pitch: -1, throttle: 1 });
  assert.equal(limit.state.phase, "failed");
  report.checks.parameterLimit = {
    clampedCommands: limit.commands,
    failureReason: limit.state.failure,
    failureTick: limit.state.tick,
  };

  await page.setInputFiles(
    "#import-file",
    new URL("../artifacts/replay-success.json", import.meta.url).pathname,
  );
  await page.waitForFunction(
    () => document.querySelector("#overlay-title")?.textContent === "确定性校验一致",
  );
  assert.match(await page.locator("#overlay-copy").textContent(), /重放哈希 94c9483ce62b4106/);
  await page.click("#overlay-secondary");
  const importedReplayHash = await page.evaluate(() => window.__LATCH3__.advanceReplayToEnd());
  assert.equal(importedReplayHash, "94c9483ce62b4106");
  report.checks.importValidation = {
    file: "artifacts/replay-success.json",
    hash: importedReplayHash,
    match: true,
  };

  report.errors = browserErrors;
  assert.deepEqual(browserErrors, []);
  report.checks.browserErrors = 0;
  await browser.close();

  await writeFile(new URL("browser-verification.json", outDir), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.kill("SIGTERM");
}
