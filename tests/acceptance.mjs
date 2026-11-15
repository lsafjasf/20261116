import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const port = Number(process.env.TEST_PORT) || 42931;
const baseUrl = `http://127.0.0.1:${port}`;

function findPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    join(root, "node_modules/playwright/index.mjs"),
    "/home/hj/userfeedback/uid620/node_modules/playwright/index.mjs"
  ].filter(Boolean);
  if (existsSync("/home/hj/userfeedback")) {
    for (const entry of readdirSync("/home/hj/userfeedback")) {
      candidates.push(`/home/hj/userfeedback/${entry}/node_modules/playwright/index.mjs`);
    }
  }
  return candidates.find((candidate) => existsSync(candidate));
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = "/home/hj/.cache/ms-playwright";
  if (!existsSync(cache)) return undefined;
  const versions = readdirSync(cache)
    .filter((name) => name.startsWith("chromium-"))
    .sort()
    .reverse();
  for (const version of versions) {
    const executable = join(cache, version, "chrome-linux64/chrome");
    if (existsSync(executable)) return executable;
  }
  return undefined;
}

const playwrightPath = findPlaywright();
if (!playwrightPath) {
  throw new Error("找不到 Playwright。请设置 PLAYWRIGHT_MODULE 指向 playwright/index.mjs。");
}
const { chromium } = await import(pathToFileURL(playwrightPath).href);

let server;
let browser;
const pageErrors = [];

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Keep waiting for the local server.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("本地验收服务器未启动");
}

async function start() {
  try {
    await fetch(baseUrl);
  } catch {
    server = spawn(process.execPath, ["server.mjs"], {
      cwd: root,
      env: { ...process.env, PORT: String(port) },
      stdio: "ignore"
    });
    await waitForServer();
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: findChromium()
  });
}

async function stop() {
  await browser?.close();
  server?.kill("SIGTERM");
}

async function openPage(contextOptions = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ...contextOptions
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon")) {
      pageErrors.push(message.text());
    }
  });
  await page.goto(baseUrl);
  await page.waitForFunction(() => window.canvasApp?.ready === true);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(220);
  return { context, page };
}

async function metrics(page) {
  return page.evaluate(() => window.canvasApp.metrics());
}

async function snapshot(page) {
  return page.evaluate(() => window.canvasApp.snapshot());
}

async function waitForSaved(page) {
  await page.waitForFunction(() => Boolean(window.canvasApp.metrics().lastSave.at));
  await page.waitForTimeout(180);
}

function near(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ±${tolerance}, received ${actual}`
  );
}

async function dispatchTouch(cdp, type, points) {
  await cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((point, index) => ({
      x: point.x,
      y: point.y,
      id: index + 1,
      radiusX: 4,
      radiusY: 4,
      force: 1
    }))
  });
}

const results = [];
async function test(name, callback) {
  try {
    await callback();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.error(`✗ ${name}`);
    throw error;
  }
}

await start();

try {
  await test("鼠标：多选删除、撤销、拖动平移、滚轮缩放与滚动互斥", async () => {
    const { context, page } = await openPage();
    const initial = await metrics(page);
    assert.equal(initial.objectCount, 8);

    await page.locator('[data-object-id="note-close"]').click();
    await page.keyboard.down("Shift");
    await page.locator('[data-object-id="poster-focus"]').click();
    await page.keyboard.up("Shift");
    let state = await snapshot(page);
    assert.deepEqual(state.selectedIds.sort(), ["note-close", "poster-focus"]);
    assert.equal(state.multiSelect, true);

    await page.locator("#deleteButton").click();
    assert.equal((await metrics(page)).objectCount, 6);
    await page.locator("#undoButton").click();
    state = await snapshot(page);
    assert.equal(state.objects.length, 8);
    assert.deepEqual(state.selectedIds.sort(), ["note-close", "poster-focus"]);
    assert.match(await page.locator("#inputStatus").textContent(), /撤销/);
    assert.match(await page.locator("#snapshotText").textContent(), /"selection"/);

    const rect = (await metrics(page)).canvasRect;
    const scrollBeforeWheel = await page.evaluate(() => scrollY);
    const viewportBeforeWheel = (await metrics(page)).viewport;
    await page.mouse.move(rect.x + rect.width / 2, rect.y + 28);
    await page.mouse.wheel(0, 96);
    await page.waitForTimeout(120);
    const afterWheel = await metrics(page);
    assert.equal(await page.evaluate(() => scrollY), scrollBeforeWheel);
    assert.notEqual(afterWheel.viewport.y, viewportBeforeWheel.y);

    const scaleBefore = afterWheel.viewport.scale;
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -110);
    await page.keyboard.up("Control");
    await page.waitForTimeout(130);
    assert.ok((await metrics(page)).viewport.scale > scaleBefore);

    const scrollBeforeDrag = await page.evaluate(() => scrollY);
    const viewportBeforeDrag = (await metrics(page)).viewport;
    await page.mouse.move(rect.x + 60, rect.y + rect.height - 42);
    await page.mouse.down();
    await page.mouse.move(rect.x + 150, rect.y + rect.height - 92, { steps: 7 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const afterDrag = await metrics(page);
    assert.notEqual(afterDrag.viewport.x, viewportBeforeDrag.x);
    assert.notEqual(afterDrag.viewport.y, viewportBeforeDrag.y);
    assert.equal(await page.evaluate(() => scrollY), scrollBeforeDrag);
    assert.equal(afterDrag.strokeCount, 0);
    assert.equal((await metrics(page)).acceptance.pan, true);
    assert.equal((await metrics(page)).acceptance.zoom, true);
    assert.equal((await metrics(page)).acceptance.delete, true);

    await page.mouse.move(rect.x + 60, rect.y + rect.height + 50);
    await page.mouse.wheel(0, 260);
    await page.waitForTimeout(180);
    assert.ok((await page.evaluate(() => scrollY)) > scrollBeforeDrag);

    await page.waitForTimeout(420);
    await page.screenshot({ path: join(root, "artifacts/acceptance-desktop.png"), fullPage: false });
    await context.close();
  });

  await test("键盘：焦点顺序、方向键平移、缩放、多选、删除与撤销", async () => {
    const { context, page } = await openPage();
    const focusTrail = [];
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press("Tab");
      focusTrail.push(await page.evaluate(() => {
        const active = document.activeElement;
        return active?.dataset?.tool || active?.dataset?.objectId ||
          active?.id || active?.className || active?.tagName;
      }));
    }
    assert.match(String(focusTrail[0]), /skip-link/);
    assert.match(String(focusTrail[1]), /brand/);
    assert.equal(focusTrail[2], "helpButton");
    assert.equal(focusTrail[3], "select");
    assert.equal(focusTrail[4], "pen");
    assert.equal(focusTrail[5], "multiSelectButton");

    await page.locator("#canvasViewport").focus();
    const beforePan = (await metrics(page)).viewport;
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowUp");
    const afterPan = (await metrics(page)).viewport;
    assert.ok(afterPan.x < beforePan.x);
    assert.ok(afterPan.y > beforePan.y);
    const scaleBefore = afterPan.scale;
    await page.keyboard.press("+");
    assert.ok((await metrics(page)).viewport.scale > scaleBefore);

    await page.keyboard.press("Tab");
    const firstFocused = await page.evaluate(() => document.activeElement?.dataset?.objectId);
    assert.equal(firstFocused, "note-close");
    await page.keyboard.press("Enter");
    await page.keyboard.press("m");
    await page.keyboard.press("Tab");
    const secondFocused = await page.evaluate(() => document.activeElement?.dataset?.objectId);
    assert.equal(secondFocused, "poster-focus");
    await page.keyboard.press("Enter");
    assert.deepEqual((await snapshot(page)).selectedIds.sort(), ["note-close", "poster-focus"]);

    await page.evaluate(() => window.scrollTo({ top: 190, behavior: "instant" }));
    await page.waitForTimeout(160);
    const scrollBeforeDelete = await page.evaluate(() => scrollY);
    await page.keyboard.press("Delete");
    assert.equal((await metrics(page)).objectCount, 6);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(80);
    const restored = await snapshot(page);
    assert.equal(restored.objects.length, 8);
    assert.deepEqual(restored.selectedIds.sort(), ["note-close", "poster-focus"]);
    assert.equal(await page.evaluate(() => scrollY), scrollBeforeDelete);
    assert.match(await page.locator("#inputStatus").textContent(), /撤销/);
    assert.match(await page.locator("#renderStatus").textContent(), /2 选中/);

    await page.waitForTimeout(420);
    await page.screenshot({ path: join(root, "artifacts/acceptance-keyboard.png"), fullPage: false });
    await context.close();
  });

  await test("触屏：平移、缩放、长按多选、旋转坐标与触摸删除", async () => {
    const { context, page } = await openPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 1
    });
    const cdp = await context.newCDPSession(page);
    let current = await metrics(page);
    const startRect = current.canvasRect;
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), startRect.y - 82);
    await page.waitForTimeout(180);
    current = await metrics(page);
    const rect = current.canvasRect;
    const scrollBeforeGestures = await page.evaluate(() => scrollY);

    const noteBox = await page.locator('[data-object-id="note-close"]').boundingBox();
    await dispatchTouch(cdp, "touchStart", [{
      x: noteBox.x + noteBox.width / 2,
      y: noteBox.y + noteBox.height / 2
    }]);
    await page.waitForTimeout(650);
    await dispatchTouch(cdp, "touchEnd", []);
    let state = await snapshot(page);
    assert.deepEqual(state.selectedIds, ["note-close"]);
    assert.equal(state.multiSelect, true);
    assert.equal((await metrics(page)).acceptance.multiSelect, true);

    const stickerBox = await page.locator('[data-object-id="sticker-world"]').boundingBox();
    await dispatchTouch(cdp, "touchStart", [{
      x: stickerBox.x + stickerBox.width / 2,
      y: stickerBox.y + stickerBox.height / 2
    }]);
    await page.waitForTimeout(70);
    await dispatchTouch(cdp, "touchEnd", []);
    state = await snapshot(page);
    assert.deepEqual(state.selectedIds.sort(), ["note-close", "sticker-world"]);

    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const scaleBeforePinch = state.viewport.scale;
    await dispatchTouch(cdp, "touchStart", [
      { x: center.x - 44, y: center.y },
      { x: center.x + 44, y: center.y }
    ]);
    for (let index = 1; index <= 6; index += 1) {
      await dispatchTouch(cdp, "touchMove", [
        { x: center.x - 44 - index * 11, y: center.y },
        { x: center.x + 44 + index * 11, y: center.y }
      ]);
    }
    const beforeRelease = await page.evaluate(() => {
      const element = document.querySelector('[data-object-id="sticker-world"]');
      const bounds = element.getBoundingClientRect();
      return {
        metrics: window.canvasApp.metrics(),
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      };
    });
    await dispatchTouch(cdp, "touchEnd", []);
    await page.waitForTimeout(80);
    const afterRelease = await page.evaluate(() => {
      const element = document.querySelector('[data-object-id="sticker-world"]');
      const bounds = element.getBoundingClientRect();
      return {
        metrics: window.canvasApp.metrics(),
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      };
    });
    assert.ok(afterRelease.metrics.viewport.scale > scaleBeforePinch);
    near(afterRelease.metrics.viewport.x, beforeRelease.metrics.viewport.x, 0.05, "缩放结束 x 不跳位");
    near(afterRelease.metrics.viewport.y, beforeRelease.metrics.viewport.y, 0.05, "缩放结束 y 不跳位");
    near(afterRelease.bounds.x, beforeRelease.bounds.x, 0.1, "选中对象 x 不跳位");
    near(afterRelease.bounds.y, beforeRelease.bounds.y, 0.1, "选中对象 y 不跳位");
    assert.deepEqual(afterRelease.metrics.selectedIds.sort(), ["note-close", "sticker-world"]);
    assert.equal(afterRelease.metrics.strokeCount, 0);
    assert.equal(await page.evaluate(() => scrollY), scrollBeforeGestures);

    const viewportBeforePan = afterRelease.metrics.viewport;
    await dispatchTouch(cdp, "touchStart", [{
      x: rect.x + 26,
      y: rect.y + rect.height - 34
    }]);
    for (let index = 1; index <= 5; index += 1) {
      await dispatchTouch(cdp, "touchMove", [{
        x: rect.x + 26 + index * 12,
        y: rect.y + rect.height - 34 - index * 4
      }]);
    }
    await dispatchTouch(cdp, "touchEnd", []);
    await page.waitForTimeout(80);
    const afterTouchPan = await metrics(page);
    assert.notEqual(afterTouchPan.viewport.x, viewportBeforePan.x);
    assert.equal(await page.evaluate(() => scrollY), scrollBeforeGestures);
    assert.equal(afterTouchPan.strokeCount, 0);
    assert.equal(afterTouchPan.acceptance.pan, true);
    assert.equal(afterTouchPan.acceptance.zoom, true);

    const beforeRotate = await page.evaluate(() => {
      const values = window.canvasApp.metrics();
      const centerWorld = window.canvasApp.screenToWorld(
        values.canvasRect.x + values.canvasRect.width / 2,
        values.canvasRect.y + values.canvasRect.height / 2
      );
      return {
        centerWorld,
        selectedIds: [...values.selectedIds],
        orientation: values.orientation
      };
    });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(480);
    const afterRotate = await page.evaluate(() => {
      const values = window.canvasApp.metrics();
      const centerWorld = window.canvasApp.screenToWorld(
        values.canvasRect.x + values.canvasRect.width / 2,
        values.canvasRect.y + values.canvasRect.height / 2
      );
      const object = window.canvasApp.snapshot().objects.find((item) => item.id === "note-close");
      const element = document.querySelector('[data-object-id="note-close"]').getBoundingClientRect();
      const expected = window.canvasApp.worldToScreen(object.x, object.y);
      return {
        centerWorld,
        selectedIds: [...values.selectedIds],
        orientation: values.orientation,
        acceptance: values.acceptance,
        mapping: {
          element: { x: element.x, y: element.y, width: element.width },
          expected,
          expectedWidth: object.width * values.viewport.scale
        }
      };
    });
    assert.equal(beforeRotate.orientation, "portrait");
    assert.equal(afterRotate.orientation, "landscape");
    near(afterRotate.centerWorld.x, beforeRotate.centerWorld.x, 0.2, "旋转中心世界 x");
    near(afterRotate.centerWorld.y, beforeRotate.centerWorld.y, 0.2, "旋转中心世界 y");
    assert.deepEqual(afterRotate.selectedIds, beforeRotate.selectedIds);
    assert.equal(afterRotate.acceptance.rotate, true);
    near(afterRotate.mapping.element.x, afterRotate.mapping.expected.x, 0.2, "旋转后对象屏幕 x");
    near(afterRotate.mapping.element.y, afterRotate.mapping.expected.y, 0.2, "旋转后对象屏幕 y");
    near(afterRotate.mapping.element.width, afterRotate.mapping.expectedWidth, 0.2, "旋转后对象宽度");

    const tapTarget = await page.evaluate(() => {
      const viewport = window.canvasApp.metrics().canvasRect;
      const selected = new Set(window.canvasApp.metrics().selectedIds);
      const object = window.canvasApp.snapshot().objects.find((item) => {
        if (selected.has(item.id)) return false;
        const point = window.canvasApp.worldToScreen(item.x + item.width / 2, item.y + item.height / 2);
        return point.x > viewport.x + 20 && point.x < viewport.right - 20 &&
          point.y > viewport.y + 20 && point.y < viewport.bottom - 20;
      });
      if (!object) return null;
      const point = window.canvasApp.worldToScreen(object.x + object.width / 2, object.y + object.height / 2);
      return { id: object.id, ...point };
    });
    assert.ok(tapTarget, "旋转后应至少有一个未选对象可触摸");
    await dispatchTouch(cdp, "touchStart", [{ x: tapTarget.x, y: tapTarget.y }]);
    await page.waitForTimeout(70);
    await dispatchTouch(cdp, "touchEnd", []);
    assert.ok((await snapshot(page)).selectedIds.includes(tapTarget.id));
    assert.deepEqual(
      (await snapshot(page)).selectedIds.sort(),
      [...beforeRotate.selectedIds, tapTarget.id].sort()
    );

    await page.locator("#deleteButton").evaluate((element) => {
      element.scrollIntoView({ block: "center", behavior: "instant" });
    });
    await page.waitForTimeout(100);
    const deleteBox = await page.locator("#deleteButton").boundingBox();
    const countBeforeDelete = (await metrics(page)).objectCount;
    const selectionBeforeDelete = (await snapshot(page)).selectedIds.length;
    await page.touchscreen.tap(deleteBox.x + deleteBox.width / 2, deleteBox.y + deleteBox.height / 2);
    await page.waitForTimeout(140);
    assert.equal((await metrics(page)).objectCount, countBeforeDelete - selectionBeforeDelete);
    assert.equal((await metrics(page)).acceptance.delete, true);
    assert.equal((await snapshot(page)).selectedIds.length, 0);

    await page.locator("#fitButton").click();
    await page.waitForTimeout(320);
    await page.evaluate(() => {
      const card = document.querySelector(".canvas-card");
      window.scrollTo({
        top: Math.max(0, card.getBoundingClientRect().top + scrollY - 58),
        behavior: "instant"
      });
    });
    await page.waitForTimeout(220);
    await page.screenshot({
      path: join(root, "artifacts/acceptance-mobile-landscape.png"),
      fullPage: false
    });
    await context.close();
  });

  await test("持久化：刷新、关闭弹窗和撤销保留草稿、选择与滚动位置", async () => {
    const { context, page } = await openPage();
    await page.locator('[data-object-id="note-close"]').click();
    const selectedBefore = (await snapshot(page)).selectedIds;
    await page.evaluate(() => window.scrollTo({ top: 255, behavior: "instant" }));
    await page.waitForTimeout(220);
    const scrollBeforeDialog = await page.evaluate(() => scrollY);

    await page.evaluate(() => document.getElementById("addNoteButton").click());
    await page.waitForTimeout(90);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "noteTitle");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "closeNoteButton");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "noteTitle");
    await page.keyboard.type("未提交：旋转后坐标");
    await page.keyboard.press("Tab");
    await page.keyboard.type("关闭弹窗和刷新都不能丢掉这段草稿。");

    await page.keyboard.press("Escape");
    await page.waitForTimeout(180);
    assert.equal(await page.locator("#noteDialog").getAttribute("open"), null);
    const afterClose = await snapshot(page);
    assert.equal(afterClose.draft.title, "未提交：旋转后坐标");
    assert.match(afterClose.draft.body, /不能丢掉/);
    assert.deepEqual(afterClose.selectedIds, selectedBefore);
    near(await page.evaluate(() => scrollY), scrollBeforeDialog, 1, "关闭弹窗后的滚动位置");
    assert.match(await page.locator("#snapshotText").textContent(), /未提交：旋转后坐标/);
    assert.equal(await page.locator("#draftIndicator").isVisible(), true);
    assert.match(await page.locator("#draftIndicator").textContent(), /未提交：旋转后坐标/);

    await page.keyboard.press("Delete");
    assert.equal((await metrics(page)).objectCount, 7);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(100);
    const afterUndo = await snapshot(page);
    assert.equal(afterUndo.objects.length, 8);
    assert.deepEqual(afterUndo.selectedIds, selectedBefore);
    assert.equal(afterUndo.draft.title, "未提交：旋转后坐标");
    near(await page.evaluate(() => scrollY), scrollBeforeDialog, 1, "撤销后的滚动位置");
    assert.match(await page.locator("#inputStatus").textContent(), /撤销/);
    assert.match(await page.locator("#selectionList").textContent(), /先靠近/);

    const viewportBeforeRefresh = afterUndo.viewport;
    await page.evaluate(() => document.querySelector('[data-tool="pen"]').click());
    const drawingRect = (await metrics(page)).canvasRect;
    await page.mouse.move(drawingRect.x + drawingRect.width * 0.52, drawingRect.y + drawingRect.height * 0.58);
    await page.mouse.down();
    await page.mouse.move(drawingRect.x + drawingRect.width * 0.58, drawingRect.y + drawingRect.height * 0.63, { steps: 5 });
    await page.waitForTimeout(60);
    await waitForSaved(page);
    await page.reload();
    await page.mouse.up();
    await page.waitForFunction(() => window.canvasApp?.ready === true);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(320);
    const restored = await snapshot(page);
    assert.deepEqual(restored.selectedIds, selectedBefore);
    assert.equal(restored.draft.title, "未提交：旋转后坐标");
    assert.match(restored.draft.body, /关闭弹窗和刷新/);
    assert.equal(restored.strokes.length, 1);
    near(restored.viewport.x, viewportBeforeRefresh.x, 0.5, "刷新后视口 x");
    near(restored.viewport.y, viewportBeforeRefresh.y, 0.5, "刷新后视口 y");
    near(await page.evaluate(() => scrollY), scrollBeforeDialog, 2, "刷新后滚动位置");
    assert.match(await page.locator("#snapshotText").textContent(), /未提交：旋转后坐标/);

    await page.evaluate(() => document.getElementById("addNoteButton").click());
    await page.waitForTimeout(80);
    assert.equal(await page.locator("#noteTitle").inputValue(), "未提交：旋转后坐标");
    assert.match(await page.locator("#noteBody").inputValue(), /关闭弹窗和刷新/);
    assert.match(await page.locator("#draftStatus").textContent(), /草稿/);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    assert.deepEqual((await snapshot(page)).selectedIds, selectedBefore);
    near(await page.evaluate(() => scrollY), scrollBeforeDialog, 2, "再次关闭弹窗后的滚动位置");

    await page.screenshot({ path: join(root, "artifacts/acceptance-persistence.png"), fullPage: false });
    await context.close();
  });

  await test("失败提示：便签校验、主备快照损坏与存储写入失败都保留可读快照", async () => {
    const first = await openPage();
    let { page } = first;
    await waitForSaved(page);

    await page.evaluate(() => document.getElementById("addNoteButton").click());
    await page.waitForTimeout(70);
    await page.locator('#noteForm button[type="submit"]').click();
    assert.equal(await page.locator("#noteDialog").getAttribute("open"), "");
    assert.equal(await page.locator("#noteTitle").getAttribute("aria-invalid"), "true");
    assert.match(await page.locator("#draftStatus").textContent(), /失败/);
    assert.match(await page.locator("#toastRegion").textContent(), /草稿已保留/);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);

    await page.evaluate(() => localStorage.setItem("__corrupt_mode__", "primary"));
    await first.context.addInitScript(() => {
      const mode = localStorage.getItem("__corrupt_mode__");
      const primary = "gesture-canvas:snapshot:v1";
      const backup = "gesture-canvas:backup:v1";
      if (mode === "primary") {
        localStorage.setItem(primary, '{"version":1,"objects":"READABLE_PRIMARY"');
        localStorage.removeItem("__corrupt_mode__");
        localStorage.setItem("__corrupt_backup_ready__", "1");
      }
      if (mode === "both") {
        localStorage.setItem(primary, '{"version":1,"objects":"READABLE_BOTH_PRIMARY"');
        localStorage.setItem(backup, '{"version":1,"objects":"READABLE_BOTH_BACKUP"');
        localStorage.removeItem("__corrupt_mode__");
      }
    });
    await page.reload();
    await page.waitForFunction(() => window.canvasApp?.ready === true);
    await page.waitForTimeout(280);
    assert.equal(await page.locator("#recoveryBanner").isVisible(), true);
    assert.match(await page.locator("#recoveryMessage").textContent(), /备份/);
    assert.match(await page.locator("#snapshotText").textContent(), /READABLE_PRIMARY/);
    assert.equal((await metrics(page)).objectCount, 8);
    assert.match(await page.locator("#storageStatus").textContent(), /备份|恢复/);

    await page.evaluate(() => localStorage.setItem("__corrupt_mode__", "both"));
    await page.reload();
    await page.waitForFunction(() => window.canvasApp?.ready === true);
    await page.waitForTimeout(320);
    assert.equal(await page.locator("#recoveryBanner").isVisible(), true);
    assert.match(await page.locator("#recoveryMessage").textContent(), /安全空白状态|无法|失败|恢复/);
    const rawSnapshot = await page.locator("#snapshotText").textContent();
    assert.match(rawSnapshot, /READABLE_BOTH_PRIMARY/);
    assert.match(rawSnapshot, /READABLE_BOTH_BACKUP/);
    assert.match(rawSnapshot, /未能自动恢复的原始快照/);
    await first.context.close();

    const second = await openPage();
    page = second.page;
    await waitForSaved(page);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key, value) {
        if (String(key).startsWith("gesture-canvas:")) {
          throw new DOMException("Quota exceeded in acceptance test", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
    });
    await page.locator('[data-object-id="note-close"]').click();
    await page.waitForTimeout(420);
    assert.equal(await page.locator("#recoveryBanner").isVisible(), true);
    assert.match(await page.locator("#recoveryMessage").textContent(), /写入失败|可读快照/);
    assert.match(await page.locator("#storageStatus").textContent(), /失败/);
    assert.match(await page.locator("#snapshotText").textContent(), /note-close/);
    assert.match(await page.locator("#toastRegion").textContent(), /保存失败/);
    assert.ok((await snapshot(page)).selectedIds.includes("note-close"));

    await page.screenshot({ path: join(root, "artifacts/acceptance-recovery.png"), fullPage: false });
    await second.context.close();
  });
} finally {
  await stop();
}

const failures = results.filter((result) => !result.ok);
console.log(`\n${results.length - failures.length}/${results.length} 组验收通过`);
if (failures.length) {
  console.error(failures.map((result) => `- ${result.name}: ${result.error.message}`).join("\n"));
  process.exitCode = 1;
}
if (pageErrors.length) {
  console.error(`页面运行错误：\n${[...new Set(pageErrors)].join("\n")}`);
  process.exitCode = 1;
}
