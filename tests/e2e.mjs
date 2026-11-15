import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { globSync } from "node:fs";

const root = process.cwd();
const artifactDir = join(root, "artifacts", "acceptance");
const require = createRequire(import.meta.url);

function findPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    "playwright",
    ...globSync("/home/hj/.codex-relay-home-*/.npm/_npx/*/node_modules/playwright", { absolute: true }),
    ...globSync("/home/hj/userfeedback/*/node_modules/playwright", { absolute: true })
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const loaded = require(candidate);
      if (loaded.chromium) return loaded;
    } catch {
      // Try the next installation.
    }
  }
  throw new Error("Playwright not found. Set PLAYWRIGHT_MODULE to its package directory.");
}

function findChrome(playwright) {
  const candidates = [
    process.env.CHROME_PATH,
    playwright.chromium.executablePath(),
    "/tmp/mix04-browser/chrome-linux64/chrome",
    ...globSync("/home/hj/.cache/ms-playwright/chromium-*/chrome-linux64/chrome", { absolute: true })
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(100);
  }
  throw new Error(`Server did not start at ${url}`);
}

function startServer(port) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return {
    child,
    stderr: () => stderr
  };
}

function sha(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function diffObjects(before, after, path = "", output = []) {
  if (Object.is(before, after)) return output;
  if (
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) !== Array.isArray(after)
  ) {
    output.push({ path: path || "$", before, after });
    return output;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    diffObjects(before[key], after[key], path ? `${path}.${key}` : key, output);
  }
  return output;
}

async function snapshot(page) {
  return page.evaluate(() => {
    const autosave = JSON.parse(localStorage.getItem("frame.autosave.v1"));
    const exportSettings = JSON.parse(localStorage.getItem("frame.export-settings.v1"));
    const selected = document.querySelector('.clip[aria-pressed="true"]')?.dataset.clipId || null;
    const tracks = autosave.snapshot.project.tracks;
    const audioTrack = tracks.find((track) => track.type === "audio");
    return {
      project: autosave.snapshot.project,
      ui: autosave.snapshot.ui,
      exportSettings,
      visible: {
        name: document.querySelector("#clip-name").value,
        scale: document.querySelector("#clip-scale").value,
        selected,
        scrollLeft: Math.round(document.querySelector("#timeline-scroll").scrollLeft),
        playhead: Number(document.querySelector("#playhead-range").value),
        draft: document.querySelector("#draft-state").textContent,
        sync: document.querySelector("#sync-badge").textContent,
        recoveryOpen: document.querySelector("#recovery-dialog").open
      },
      integrity: {
        trackIds: tracks.map((track) => track.id),
        keyframes: tracks.flatMap((track) =>
          track.clips.map((clip) => ({
            clip: clip.id,
            frames: clip.keyframes.map(({ id, time, property, value }) => ({ id, time, property, value }))
          }))
        ),
        sound: audioTrack?.sound || null
      }
    };
  });
}

async function capturePreviews(page, prefix) {
  const fullBefore = await page.screenshot({ fullPage: true });
  const previewBefore = await page.locator("#preview").screenshot();
  writeFileSync(join(artifactDir, `${prefix}-full-before.png`), fullBefore);
  writeFileSync(join(artifactDir, `${prefix}-preview-before.png`), previewBefore);
  return {
    fullHash: sha(fullBefore),
    previewHash: sha(previewBefore)
  };
}

async function capturePostviews(page, prefix) {
  await page.waitForTimeout(500);
  const fullAfter = await page.screenshot({ fullPage: true });
  const previewAfter = await page.locator("#preview").screenshot();
  writeFileSync(join(artifactDir, `${prefix}-full-after.png`), fullAfter);
  writeFileSync(join(artifactDir, `${prefix}-preview-after.png`), previewAfter);
  return {
    fullHash: sha(fullAfter),
    previewHash: sha(previewAfter)
  };
}

async function newPage(browser, label, errors) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${label}: console: ${message.text()}`);
  });
  return { context, page };
}

function report(name, payload) {
  const path = join(artifactDir, `${name}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  console.log(`✓ ${name}`);
  return path;
}

rmSync(artifactDir, { recursive: true, force: true });
mkdirSync(artifactDir, { recursive: true });

const playwright = findPlaywright();
const port = 4400 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}/`;
const server = startServer(port);
let browser;
const errors = [];
const reportData = {};

try {
  await waitForServer(base);
  const chromePath = findChrome(playwright);
  browser = await playwright.chromium.launch({
    headless: true,
    executablePath: chromePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  {
    const { context, page } = await newPage(browser, "focus-order", errors);
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForTimeout(350);
    const signatures = [];
    for (let index = 0; index < 16; index += 1) {
      await page.keyboard.press("Tab");
      signatures.push(
        await page.evaluate(() => {
          const element = document.activeElement;
          const media = element.closest?.(".media-item");
          if (element.id) return element.id;
          if (media) return `media:${media.dataset.clipId}`;
          if (element.getAttribute("aria-label")) return `label:${element.getAttribute("aria-label")}`;
          return (element.innerText || element.tagName).trim().split("\n")[0];
        })
      );
    }
    const expected = [
      "interrupt-button",
      "export-button",
      "label:添加媒体",
      "全部 6",
      "视频",
      "音频",
      "media:clip-skyline",
      "media:clip-night",
      "media:clip-interview",
      "media:clip-vo",
      "media:clip-music",
      "fullscreen-button",
      "play-button",
      "playhead-range",
      "marker-button",
      "clip-name"
    ];
    assert.deepEqual(signatures, expected);
    assert.equal(await page.evaluate(() => document.activeElement.matches(":focus-visible")), true);
    assert.equal(await page.evaluate(() => document.fonts.check('12px "FRAME Noto"')), true);
    assert.equal(await page.locator("#sync-badge").textContent(), "3/3");
    assert.equal(await page.locator("#toast-region").getAttribute("aria-live"), "polite");
    await page.screenshot({ path: join(artifactDir, "focus-order.png"), fullPage: true });
    reportData.focusOrder = { signatures, fontLoaded: true, sync: "3/3" };
    report("focus-order", reportData.focusOrder);
    await context.close();
  }

  {
    const { context, page } = await newPage(browser, "mouse-refresh", errors);
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);

    await page.locator('.media-item[data-clip-id="clip-skyline"]').click();
    await page.locator("#clip-name").click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("城市天际线 · 待审");
    await page.locator("#clip-scale").click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("126");

    const range = await page.locator("#playhead-range").boundingBox();
    await page.mouse.click(range.x + range.width * (12.34 / 32), range.y + range.height / 2);
    const timeline = await page.locator("#timeline-scroll").boundingBox();
    await page.mouse.move(timeline.x + timeline.width * 0.45, timeline.y + timeline.height / 2);
    await page.mouse.wheel(180, 0);
    await page.waitForTimeout(250);

    await page.locator("#export-button").click();
    await page.locator("#export-fps").selectOption("30");
    await page.locator("#export-bitrate").fill("60");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.waitForTimeout(650);

    const before = await snapshot(page);
    assert.equal(before.visible.name, "城市天际线 · 待审");
    assert.equal(before.visible.scale, "126");
    assert.equal(before.visible.selected, "clip-skyline");
    assert.ok(before.visible.scrollLeft > 0);
    assert.equal(before.exportSettings.fps, "30");
    assert.equal(before.exportSettings.bitrate, 60);
    assert.equal(before.visible.draft.includes("未提交草稿"), true);
    const beforeImages = await capturePreviews(page, "mouse-refresh");

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const after = await snapshot(page);
    assert.equal(after.visible.recoveryOpen, false);
    assert.deepEqual(diffObjects(before.project, after.project), []);
    assert.deepEqual(diffObjects(before.ui, after.ui), []);
    assert.deepEqual(diffObjects(before.visible, after.visible), []);
    assert.deepEqual(diffObjects(before.integrity, after.integrity), []);
    assert.equal(after.exportSettings.fps, "30");
    assert.equal(after.exportSettings.bitrate, 60);
    const afterImages = await capturePostviews(page, "mouse-refresh");
    assert.equal(afterImages.previewHash, beforeImages.previewHash, "刷新前后预览截图应完全一致");
    reportData.mouseRefresh = {
      objectDiff: 0,
      snapshotUiDiff: 0,
      previewScreenshotEqual: true,
      beforePreviewHash: beforeImages.previewHash,
      afterPreviewHash: afterImages.previewHash,
      before,
      after
    };
    report("mouse-refresh", reportData.mouseRefresh);
    await context.close();
  }

  {
    const { context, page } = await newPage(browser, "keyboard-recovery", errors);
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);

    for (let index = 0; index < 7; index += 1) await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    for (let index = 0; index < 9; index += 1) await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "clip-name");
    await page.keyboard.press("Control+A");
    await page.keyboard.type("城市天际线 · 待审");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Control+A");
    await page.keyboard.type("126");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");

    await page.keyboard.press("t");
    await page.keyboard.press("Home");
    for (let index = 0; index < 12; index += 1) await page.keyboard.press("Shift+ArrowRight");
    for (let index = 0; index < 8; index += 1) await page.keyboard.press("ArrowRight");
    for (let index = 0; index < 3; index += 1) await page.keyboard.press("Control+ArrowRight");
    await page.waitForTimeout(450);

    await page.keyboard.press("Control+e");
    await page.waitForTimeout(140);
    for (let index = 0; index < 4; index += 1) await page.keyboard.press("Tab");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Control+A");
    await page.keyboard.type("60");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);

    const before = await snapshot(page);
    assert.equal(before.visible.name, "城市天际线 · 待审");
    assert.equal(before.visible.scale, "126");
    assert.equal(before.visible.selected, "clip-skyline");
    assert.ok(before.visible.scrollLeft > 0);
    assert.equal(before.exportSettings.fps, "30");
    assert.equal(before.exportSettings.bitrate, 60);
    const beforeImages = await capturePreviews(page, "keyboard-recovery");

    await page.keyboard.press("Control+Shift+X");
    await page.waitForSelector("#recovery-dialog[open]", { timeout: 5000 });
    await page.waitForTimeout(250);
    const promptText = await page.locator("#recovery-summary").innerText();
    assert.match(promptText, /4 \/ 5/);
    assert.match(promptText, /关键帧\n7/);
    assert.match(promptText, /声音参数\n-4.5 dB · pan 12/);
    assert.equal(await page.evaluate(() => document.activeElement.id), "accept-recovery");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "decline-recovery");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "accept-recovery");
    await page.screenshot({ path: join(artifactDir, "keyboard-recovery-prompt.png"), fullPage: true });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector("#recovery-dialog").open, { timeout: 5000 });
    await page.waitForTimeout(750);

    const after = await snapshot(page);
    assert.deepEqual(diffObjects(before.project, after.project), []);
    assert.deepEqual(diffObjects(before.ui, after.ui), []);
    assert.deepEqual(diffObjects(before.visible, after.visible), []);
    assert.deepEqual(before.integrity, after.integrity);
    assert.deepEqual(after.integrity.sound, {
      volumeDb: -4.5,
      pan: 12,
      eq: { low: 1.2, mid: -0.8, high: 1.8 },
      compressor: true,
      noiseReduction: 42
    });
    assert.equal(after.integrity.keyframes.reduce((sum, item) => sum + item.frames.length, 0), 7);
    const afterImages = await capturePostviews(page, "keyboard-recovery");
    assert.equal(afterImages.previewHash, beforeImages.previewHash, "强制中断恢复前后预览截图应完全一致");
    reportData.keyboardRecovery = {
      objectDiff: 0,
      snapshotUiDiff: 0,
      previewScreenshotEqual: true,
      beforePreviewHash: beforeImages.previewHash,
      afterPreviewHash: afterImages.previewHash,
      promptSummary: promptText,
      before,
      after
    };
    report("keyboard-recovery", reportData.keyboardRecovery);
    await context.close();
  }

  {
    const { context, page } = await newPage(browser, "undo-preservation", errors);
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);

    await page.locator('.media-item[data-clip-id="clip-night"]').click();
    await page.locator("#clip-name").fill("已提交版本");
    await page.locator("#clip-scale").fill("130");
    await page.locator("#apply-button").click();
    await page.waitForTimeout(350);
    await page.locator("#clip-name").fill("撤销后仍保留的草稿");

    const timeline = await page.locator("#timeline-scroll").boundingBox();
    await page.mouse.move(timeline.x + timeline.width * 0.5, timeline.y + timeline.height / 2);
    await page.mouse.wheel(180, 0);
    await page.waitForTimeout(300);
    const beforeUndo = await page.evaluate(() => ({
      committed: JSON.parse(localStorage.getItem("frame.autosave.v1")).snapshot.project.tracks[1].clips[0].name,
      field: document.querySelector("#clip-name").value,
      selected: document.querySelector('.clip[aria-pressed="true"]')?.dataset.clipId,
      scrollLeft: Math.round(document.querySelector("#timeline-scroll").scrollLeft),
      draft: document.querySelector("#draft-state").textContent
    }));
    assert.equal(await page.locator("#undo-button").isDisabled(), false);

    await page.locator("#undo-button").click();
    await page.waitForTimeout(450);
    const afterUndo = await page.evaluate(() => ({
      committed: JSON.parse(localStorage.getItem("frame.autosave.v1")).snapshot.project.tracks[1].clips[0].name,
      field: document.querySelector("#clip-name").value,
      selected: document.querySelector('.clip[aria-pressed="true"]')?.dataset.clipId,
      scrollLeft: Math.round(document.querySelector("#timeline-scroll").scrollLeft),
      draft: document.querySelector("#draft-state").textContent,
      toast: [...document.querySelectorAll(".toast")].map((toast) => toast.textContent)
    }));
    assert.equal(beforeUndo.committed, "已提交版本");
    assert.equal(afterUndo.committed, "霓虹雨夜");
    assert.equal(afterUndo.field, "撤销后仍保留的草稿");
    assert.equal(afterUndo.selected, beforeUndo.selected);
    assert.equal(afterUndo.scrollLeft, beforeUndo.scrollLeft);
    assert.equal(afterUndo.draft, beforeUndo.draft);
    assert.match(afterUndo.toast.join(" "), /未提交草稿、选中对象与滚动位置均已保留/);
    await page.screenshot({ path: join(artifactDir, "undo-preservation.png"), fullPage: true });
    report("undo-preservation", { beforeUndo, afterUndo });
    await context.close();
  }

  {
    const { context, page } = await newPage(browser, "decline-recovery", errors);
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);

    await page.locator('.media-item[data-clip-id="clip-night"]').click();
    await page.locator("#clip-name").fill("拒绝后不应出现的名字");
    await page.locator("#clip-scale").fill("144");
    await page.locator("#playhead-range").fill("21.5");
    await page.locator("#playhead-range").dispatchEvent("input");
    const timeline = await page.locator("#timeline-scroll").boundingBox();
    await page.mouse.move(timeline.x + timeline.width * 0.6, timeline.y + timeline.height / 2);
    await page.mouse.wheel(220, 0);
    await page.waitForTimeout(500);
    const stale = await snapshot(page);
    assert.equal(stale.visible.name, "拒绝后不应出现的名字");

    await page.keyboard.press("Control+Shift+X");
    await page.waitForSelector("#recovery-dialog[open]", { timeout: 5000 });
    await page.locator("#decline-recovery").click();
    await page.waitForTimeout(700);
    const after = await snapshot(page);
    assert.equal(after.visible.recoveryOpen, false);
    assert.notEqual(after.visible.name, "拒绝后不应出现的名字");
    assert.equal(after.visible.name, "城市天际线");
    assert.equal(after.visible.selected, "clip-skyline");
    assert.equal(after.visible.playhead, 8.42);
    assert.equal(after.visible.scrollLeft, 0);
    assert.equal(
      await page.evaluate(
        (needle) => JSON.parse(localStorage.getItem("frame.autosave.archived.v1")).original.includes(needle),
        "拒绝后不应出现的名字"
      ),
      true
    );
    assert.equal(
      await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem("frame.autosave.v1"))).includes("拒绝后不应出现的名字")),
      false
    );
    await page.screenshot({ path: join(artifactDir, "decline-result.png"), fullPage: true });
    report("decline-recovery", { stale, after });
    await context.close();
  }

  {
    const { context, page } = await newPage(browser, "failure-snapshot", errors);
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    await page.locator('.media-item[data-clip-id="clip-night"]').click();
    await page.locator("#clip-name").fill("失败演练草稿");
    const timeline = await page.locator("#timeline-scroll").boundingBox();
    await page.mouse.move(timeline.x + timeline.width * 0.5, timeline.y + timeline.height / 2);
    await page.mouse.wheel(100, 0);
    await page.waitForTimeout(350);
    const before = await snapshot(page);

    await page.locator("#recovery-failure-demo").click();
    await page.waitForTimeout(250);
    const failure = await page.evaluate(() => ({
      open: document.querySelector("#failure-dialog").open,
      title: document.querySelector("#failure-title").textContent,
      reason: document.querySelector("#failure-reason").textContent,
      rawLength: document.querySelector("#failure-raw").textContent.length,
      rawContainsCorruption: document.querySelector("#failure-raw").textContent.includes("corrupted-demo-value"),
      active: document.activeElement.id,
      saved: Boolean(localStorage.getItem("frame.autosave.failed.v1")),
      currentTracks: JSON.parse(localStorage.getItem("frame.autosave.v1")).snapshot.project.tracks.length
    }));
    assert.equal(failure.open, true);
    assert.match(failure.title, /无法自动恢复/);
    assert.match(failure.reason, /原始快照未删除/);
    assert.ok(failure.rawLength > 500);
    assert.equal(failure.rawContainsCorruption, true);
    assert.equal(failure.active, "failure-raw");
    assert.equal(failure.saved, true);
    assert.equal(failure.currentTracks, 4);
    await page.screenshot({ path: join(artifactDir, "failure-dialog.png"), fullPage: true });

    await page.locator("#dismiss-failure").click();
    await page.waitForTimeout(550);
    const after = await snapshot(page);
    assert.equal(after.visible.recoveryOpen, false);
    assert.equal(after.visible.name, before.visible.name);
    assert.equal(after.visible.selected, before.visible.selected);
    assert.equal(after.visible.scrollLeft, before.visible.scrollLeft);
    assert.deepEqual(diffObjects(before.project, after.project), []);
    report("failure-snapshot", { before, failure, after });
    await context.close();
  }

  assert.deepEqual(errors, [], `Browser errors: ${errors.join("\n")}`);
  report("summary", {
    passed: true,
    viewport: "1440x1000",
    port,
    screenshots: [
      "focus-order.png",
      "mouse-refresh-full-before.png",
      "mouse-refresh-full-after.png",
      "keyboard-recovery-full-before.png",
      "keyboard-recovery-full-after.png",
      "keyboard-recovery-prompt.png",
      "undo-preservation.png",
      "decline-result.png",
      "failure-dialog.png"
    ],
    objectDiff: 0,
    screenshotPreviewHashEqual: true
  });
} finally {
  if (browser) await browser.close();
  server.child.kill("SIGTERM");
  await sleep(150);
  if (server.stderr()) process.stderr.write(server.stderr());
}
