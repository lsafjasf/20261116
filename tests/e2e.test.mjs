import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const port = 5799;
let server;
let browser;

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://localhost:${port}`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not start");
}

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(250);
  return { context, page, errors };
}

before(async () => {
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore"
  });
  await waitForServer();
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  server?.kill();
});

test("two players produce simultaneous left and right input on the same timeline", { timeout: 15000 }, async () => {
  const { context, page, errors } = await newPage();
  await page.getByTestId("audio-button").click();
  assert.equal(await page.evaluate(() => __flightApp.getAudioEnabled()), true);

  await page.keyboard.down("w");
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(1200);
  await page.keyboard.up("w");
  await page.keyboard.up("ArrowUp");
  await page.waitForTimeout(250);

  const result = await page.evaluate(() => {
    const state = __flightApp.getState();
    const timeline = __flightApp.getTimeline();
    return {
      left: state.controls.left.throttle,
      right: state.controls.right.hydraulic,
      rpm: state.engine.rpm,
      pressure: state.hydraulic.pressure,
      sources: [...new Set(timeline.inputs.map((event) => event.source))].sort()
    };
  });
  assert.ok(result.left > 0);
  assert.ok(result.right > 50);
  assert.ok(result.rpm > 0);
  assert.ok(result.pressure > 0);
  assert.deepEqual(result.sources, ["left", "right"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("single-player debug mode drives both cockpits from one keyboard", { timeout: 12000 }, async () => {
  const { context, page, errors } = await newPage();
  await page.getByTestId("mode-button").click();
  assert.match(await page.getByTestId("mode-button").innerText(), /单人调试/);
  assert.equal(await page.locator("#debug-badge").isVisible(), true);

  await page.keyboard.down("w");
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(1000);
  await page.keyboard.up("w");
  await page.keyboard.up("ArrowRight");
  await page.waitForTimeout(200);

  const state = await page.evaluate(() => __flightApp.getState());
  assert.equal(state.mode, "debug");
  assert.ok(state.controls.left.throttle > 0);
  assert.ok(state.controls.right.hydraulic > 50);
  assert.deepEqual(errors, []);
  await context.close();
});

test("mistaken ground gear retraction fails and reload restores both instruments", { timeout: 20000 }, async () => {
  const { context, page, errors } = await newPage();
  await page.keyboard.down("w");
  await page.waitForTimeout(3200);
  await page.keyboard.up("w");
  await page.getByTestId("gear-toggle").click();
  await page.waitForFunction(() => __flightApp.getState().stage === "FAILED", null, { timeout: 6000 });
  await page.waitForTimeout(300);

  const before = await page.evaluate(() => {
    const state = __flightApp.getState();
    const timeline = __flightApp.getTimeline();
    const frame = timeline.frames.at(-1);
    return {
      stage: state.stage,
      progress: state.progress,
      leftDamage: state.engine.damage,
      rightDamage: state.hydraulic.damage,
      hull: state.shared.hull,
      rpm: state.engine.rpm,
      pressure: state.hydraulic.pressure,
      gear: state.hydraulic.gearPosition,
      frame,
      collisions: timeline.collisions
    };
  });
  const beforeUi = {
    stage: await page.getByTestId("mission-stage").innerText(),
    leftDurability: await page.getByTestId("left-durability").innerText(),
    rightDurability: await page.getByTestId("right-durability").innerText(),
    progress: await page.getByTestId("progress").innerText(),
    rpm: await page.getByTestId("left-rpm").innerText(),
    pressure: await page.getByTestId("right-pressure").innerText()
  };
  assert.equal(before.stage, "FAILED");
  assert.equal(before.collisions.length, 1);
  assert.equal(before.collisions[0].reason, "GEAR_RETRACTED_ON_GROUND");
  assert.ok(before.frame.right.damage > 0);
  assert.ok(before.hull < 100);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const state = __flightApp.getState();
    return {
      stage: state.stage,
      progress: state.progress,
      leftDamage: state.engine.damage,
      rightDamage: state.hydraulic.damage,
      hull: state.shared.hull,
      rpm: state.engine.rpm,
      pressure: state.hydraulic.pressure,
      gear: state.hydraulic.gearPosition
    };
  });
  const afterUi = {
    stage: await page.getByTestId("mission-stage").innerText(),
    leftDurability: await page.getByTestId("left-durability").innerText(),
    rightDurability: await page.getByTestId("right-durability").innerText(),
    progress: await page.getByTestId("progress").innerText(),
    rpm: await page.getByTestId("left-rpm").innerText(),
    pressure: await page.getByTestId("right-pressure").innerText()
  };
  const beforeComparable = {
    stage: before.stage,
    progress: before.progress,
    leftDamage: before.leftDamage,
    rightDamage: before.rightDamage,
    hull: before.hull,
    rpm: before.rpm,
    pressure: before.pressure,
    gear: before.gear
  };
  assert.deepEqual(after, beforeComparable, "serialized state must round-trip exactly");
  assert.deepEqual(afterUi, beforeUi, "both cockpit instruments must match after reload");
  assert.equal(await page.locator("#result-title").innerText(), "任务失败");
  const canvasColors = await page.locator("#flight-canvas").evaluate((canvas) => {
    const context = canvas.getContext("2d");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    const stride = Math.max(4, Math.floor(pixels.length / 1600) * 4);
    for (let index = 0; index < pixels.length; index += stride) {
      colors.add(`${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`);
    }
    return colors.size;
  });
  assert.ok(canvasColors > 12, "canvas must repaint after reload/resize");
  assert.deepEqual(errors, []);
  await context.close();
});

test("complete success replay keeps final state immutable and shows order conflict coordinates", { timeout: 45000 }, async () => {
  const { context, page, errors } = await newPage();
  await page.getByTestId("load-success-demo").click();
  assert.match(await page.getByTestId("conflict-card").innerText(), /T\+2\.10s/);
  assert.match(await page.getByTestId("conflict-card").innerText(), /左发动机/);
  assert.match(await page.getByTestId("conflict-card").innerText(), /液压\/起落架/);

  await page.locator("[data-seek-tick]").click();
  assert.equal(await page.locator("#conflict-overlay").isVisible(), true);
  assert.match(await page.locator("#conflict-overlay").innerText(), /T\+2\.10s/);
  assert.match(await page.locator("#conflict-overlay").innerText(), /6\.50/);

  const hashBefore = await page.getByTestId("replay-hash").innerText();
  const finalBefore = await page.evaluate(() => __flightApp.getReplayFinal());
  await page.locator('[data-speed="0.5"]').click();
  await page.getByTestId("replay-step").click();
  await page.getByTestId("replay-step").click();
  await page.locator('[data-speed="2"]').click();
  await page.locator("#replay-scrub").evaluate((element) => {
    element.value = "0";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator('[data-speed="4"]').click();
  const hashAfterStep = await page.getByTestId("replay-hash").innerText();
  assert.equal(hashAfterStep, hashBefore);

  await page.getByTestId("replay-play").click();
  await page.waitForFunction(
    () => __flightApp.getReplayFrame()?.stage === "SUCCESS",
    null,
    { timeout: 35000 }
  );
  await page.waitForTimeout(300);

  const finalAfter = await page.evaluate(() => __flightApp.getReplayFinal());
  assert.deepEqual(finalAfter, finalBefore);
  assert.equal(await page.getByTestId("replay-hash").innerText(), hashBefore);
  assert.match(await page.locator("#replay-integrity-label").innerText(), /READ-ONLY/);
  assert.equal(await page.getByTestId("mission-stage").innerText(), "任务成功");
  assert.equal(await page.getByTestId("progress").innerText(), "100%");
  assert.equal(await page.locator("#result-title").innerText(), "回放完成 · 安全降落");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "artifacts/e2e-success-replay.png", fullPage: true });
  await context.close();
});
