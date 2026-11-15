import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts");

async function loadPlaywright() {
  const candidates = [
    "playwright",
    process.env.PLAYWRIGHT_MODULE,
    "/home/hj/userfeedback/uid295/node_modules/playwright/index.mjs"
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch {
      // Try the next known installation path.
    }
  }
  throw new Error("Playwright 未安装。请运行 npm install，或设置 PLAYWRIGHT_MODULE。");
}

async function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const bases = [
    join(process.env.HOME || "", ".cache/ms-playwright"),
    "/home/hj/.cache/ms-playwright"
  ];
  for (const base of bases) {
    try {
      const entries = await readdir(base, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
        if (entry.isDirectory() && entry.name.startsWith("chromium-")) {
          const path = join(base, entry.name, "chrome-linux64", "chrome");
          return path;
        }
      }
    } catch {
      // Continue with another cache location.
    }
  }
  return undefined;
}

async function startServer() {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`本地服务启动超时：${output}`)), 10000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`本地服务提前退出（${code}）：${output}`));
    });
  });
  return { child, url };
}

async function activate(page, mode, selector, keyboardKey = "Enter") {
  const locator = page.locator(selector).first();
  if (mode === "mouse") {
    await locator.click();
  } else {
    await locator.focus();
    await page.keyboard.press(keyboardKey);
  }
}

async function typeInto(page, mode, selector, text) {
  const locator = page.locator(selector).first();
  if (mode === "mouse") await locator.click();
  else await locator.focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text);
}

async function changeRange(page, mode, selector, targetRatio, arrowPresses) {
  const locator = page.locator(selector).first();
  const before = Number(await locator.inputValue());
  if (mode === "mouse") {
    const box = await locator.boundingBox();
    await page.mouse.click(box.x + box.width * targetRatio, box.y + box.height / 2);
  } else {
    await locator.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    for (let index = 0; index < arrowPresses; index += 1) {
      await page.keyboard.press("ArrowRight");
    }
  }
  const after = Number(await locator.inputValue());
  assert.notEqual(after, before, `${selector} 应通过 ${mode} 改变`);
  return after;
}

async function waitModule(page, moduleId, status = "ready") {
  await page.waitForFunction(
    ({ id, wanted }) => window.__FRAMECRAFT__?.getModule(id)?.status === wanted,
    { id: moduleId, wanted: status },
    { timeout: 8000 }
  );
}

async function assertFailure(page, moduleId, moduleName, stage) {
  const boundary = page.locator(`#boundary-${moduleId}`);
  await boundary.waitFor({ state: "visible" });
  assert.equal(await boundary.getAttribute("role"), "alert");
  const text = await boundary.innerText();
  assert.match(text, new RegExp(moduleName));
  assert.match(text, new RegExp(stage));
  assert.match(text, /可操作建议/);
  assert.match(text, /安全快照/);
  const presentation = await boundary.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      fontSize: Number.parseFloat(style.fontSize),
      visibility: style.visibility,
      opacity: Number(style.opacity),
      color: style.color,
      width: box.width,
      height: box.height
    };
  });
  assert.ok(presentation.width > 200 && presentation.height > 60, "失败提示必须可见且有尺寸");
  assert.equal(presentation.visibility, "visible");
  assert.equal(presentation.opacity, 1);
  assert.ok(presentation.fontSize >= 9, "失败提示字号应可读");
  assert.ok(presentation.color !== "rgba(0, 0, 0, 0)");
  return text;
}

async function assertAppAlive(page) {
  assert.equal(await page.locator("body").count(), 1);
  assert.ok((await page.locator("body").innerText()).length > 200, "页面不应白屏");
  assert.equal(await page.locator(".module-card").count(), 3);
  assert.ok(await page.locator("#preview-stage").isVisible());
  assert.ok(await page.locator("#timeline-track").isVisible());
  assert.equal(await page.locator("#sync-badge").textContent(), "三方一致 ✓");
}

async function setViewScroll(page, mode) {
  const timeline = page.locator("#timeline-scroller");
  const inspector = page.locator("#inspector-body");
  if (mode === "mouse") {
    await timeline.hover();
    await page.mouse.wheel(160, 0);
    await inspector.hover();
    await page.mouse.wheel(0, 140);
  } else {
    await timeline.focus();
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press("ArrowRight");
    }
    await inspector.focus();
    await page.keyboard.press("PageDown");
  }
  await page.waitForTimeout(450);
  const scroll = {
    timeline: await timeline.evaluate((element) => element.scrollLeft),
    inspector: await inspector.evaluate((element) => element.scrollTop)
  };
  assert.ok(scroll.timeline > 0, `${mode} 路径应滚动时间线`);
  assert.ok(scroll.inspector > 0, `${mode} 路径应滚动检查器`);
  return scroll;
}

async function runAcceptanceTask(page, mode, report) {
  const step = (name, details = {}) => report.steps.push({ name, ...details });
  await page.goto(report.url, { waitUntil: "networkidle" });
  await page.evaluate(() => window.__FRAMECRAFT__.setStepDelay(10));
  await page.evaluate(() => document.fonts.ready);
  await assertAppAlive(page);

  await activate(page, mode, '.scene-item[data-clip-id="clip-image"]');
  assert.equal(await page.locator("#preview-stage").getAttribute("data-selected-id"), "clip-image");
  const brightness = await changeRange(page, mode, "#image-brightness", 0.76, 24);
  await typeInto(page, mode, "#image-note", `未提交备注-${mode}`);
  assert.equal(await page.locator("#sync-badge").textContent(), "三方一致 ✓");
  step("选择图像并编辑未提交草稿", { brightness });

  await activate(page, mode, "#fault-image");
  const imageFailure = await assertFailure(page, "image", "图像处理", "解码图像");
  await assertAppAlive(page);
  assert.equal(await page.locator("#audio-frequency").inputValue(), "220");
  assert.equal(await page.locator("#image-note").inputValue(), `未提交备注-${mode}`);
  assert.equal(await page.evaluate(() => window.__FRAMECRAFT__.getResourceCount()), 1);
  assert.equal(await page.evaluate(() => document.activeElement.id), "boundary-image");
  await page.screenshot({ path: join(artifacts, `failure-image-${mode}.png`), fullPage: true });
  step("图像模块在解码阶段失败且其他内容保留", { focus: "boundary-image" });

  await activate(page, mode, '[data-retry-module="image"]');
  await waitModule(page, "image");
  assert.equal(await page.evaluate(() => window.__FRAMECRAFT__.getResourceCount()), 1);
  assert.match(await page.locator("#resource-list").innerText(), /复用 1/);
  assert.equal(await page.evaluate(() => document.activeElement.id), "run-image");
  step("图像重试恢复且资源未重复", { resourceCount: 1 });

  await activate(page, mode, '.scene-item[data-clip-id="clip-audio"]');
  assert.equal(await page.evaluate(() => window.__FRAMECRAFT__.getState().selectedId), "clip-audio");
  const frequency = await changeRange(page, mode, "#audio-frequency", 0.3, 24);
  await activate(page, mode, "#fault-audio");
  await assertFailure(page, "audio", "音频合成", "合成音频");
  await assertAppAlive(page);
  assert.equal(await page.locator("#image-note").inputValue(), `未提交备注-${mode}`);
  assert.equal(await page.locator("#module-image-state").textContent(), "就绪");
  assert.equal(await page.evaluate(() => window.__FRAMECRAFT__.getResourceCount()), 2);
  step("音频模块失败且图像草稿保留", { frequency });

  await activate(page, mode, '[data-retry-module="audio"]');
  await waitModule(page, "audio");
  assert.equal(await page.evaluate(() => window.__FRAMECRAFT__.getResourceCount()), 2);
  step("音频重试恢复且资源未重复", { resourceCount: 2 });

  const scrollBeforeDialog = await setViewScroll(page, mode);
  await activate(page, mode, "#open-export");
  await page.locator("#export-dialog").waitFor({ state: "visible" });
  await typeInto(page, mode, "#dialog-export-name", "验收-共享导出名");
  if (mode === "mouse") await activate(page, "mouse", "#cancel-export");
  else await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
  assert.equal(await page.locator("#export-dialog").evaluate((element) => element.open), false);
  assert.equal(await page.locator("#export-name").inputValue(), "验收-共享导出名");
  assert.equal(await page.evaluate(() => document.activeElement.id), "open-export");
  assert.equal(await page.evaluate(() => window.__FRAMECRAFT__.getState().selectedId), "clip-audio");
  const scrollAfterDialog = {
    timeline: await page.locator("#timeline-scroller").evaluate((element) => element.scrollLeft),
    inspector: await page.locator("#inspector-body").evaluate((element) => element.scrollTop)
  };
  assert.equal(scrollAfterDialog.timeline, scrollBeforeDialog.timeline);
  assert.equal(scrollAfterDialog.inspector, scrollBeforeDialog.inspector);
  step("关闭导出弹窗后草稿、焦点、选中与滚动保留", { scroll: scrollAfterDialog });

  await activate(page, mode, "#undo-btn");
  assert.equal(await page.evaluate(() => window.__FRAMECRAFT__.getState().selectedId), "clip-audio");
  assert.equal(await page.locator("#image-note").inputValue(), `未提交备注-${mode}`);
  assert.equal(await page.locator("#export-name").inputValue(), "验收-共享导出名");
  assert.equal(await page.locator("#timeline-scroller").evaluate((element) => element.scrollLeft), scrollAfterDialog.timeline);
  await activate(page, mode, "#redo-btn");
  step("撤销/重做不丢未提交草稿、选中和滚动");

  await activate(page, mode, "#fault-export");
  await assertFailure(page, "export", "工程导出", "编码媒体");
  await assertAppAlive(page);
  assert.equal(await page.evaluate(() => window.__FRAMECRAFT__.getResourceCount()), 3);
  await activate(page, mode, '[data-retry-module="export"]');
  await waitModule(page, "export");
  assert.equal(await page.evaluate(() => window.__FRAMECRAFT__.getResourceCount()), 3);
  step("导出模块失败并恢复且资源未重复", { resourceCount: 3 });

  const scrollBeforeReload = {
    timeline: await page.locator("#timeline-scroller").evaluate((element) => element.scrollLeft),
    inspector: await page.locator("#inspector-body").evaluate((element) => element.scrollTop)
  };
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(180);
  assert.equal(await page.locator("#image-note").inputValue(), `未提交备注-${mode}`);
  assert.equal(await page.locator("#export-name").inputValue(), "验收-共享导出名");
  assert.equal(await page.evaluate(() => window.__FRAMECRAFT__.getState().selectedId), "clip-audio");
  const reloadedScroll = {
    timeline: await page.locator("#timeline-scroller").evaluate((element) => element.scrollLeft),
    inspector: await page.locator("#inspector-body").evaluate((element) => element.scrollTop)
  };
  assert.ok(Math.abs(reloadedScroll.timeline - scrollBeforeReload.timeline) <= 2);
  assert.ok(Math.abs(reloadedScroll.inspector - scrollBeforeReload.inspector) <= 2);
  await assertAppAlive(page);
  step("刷新后草稿、选中和滚动位置恢复", { scroll: reloadedScroll });

  await activate(page, mode, "#persistent-fault", "Space");
  assert.equal(await page.locator("#persistent-fault").isChecked(), true);
  await activate(page, mode, "#fault-export");
  await assertFailure(page, "export", "工程导出", "编码媒体");
  const attemptBeforeRetry = await page.evaluate(() => window.__FRAMECRAFT__.getModule("export").attempt);
  await activate(page, mode, '[data-retry-module="export"]');
  await page.waitForFunction(
    ({ attempt }) => {
      const module = window.__FRAMECRAFT__.getModule("export");
      return module.attempt > attempt && module.status === "error";
    },
    { attempt: attemptBeforeRetry },
    { timeout: 8000 }
  );
  const snapshotText = await page.locator("#boundary-export").innerText();
  assert.match(snapshotText, /安全快照/);
  assert.match(snapshotText, /资源/);
  assert.equal(await page.evaluate(() => window.__FRAMECRAFT__.getResourceCount()), 3);
  await page.screenshot({ path: join(artifacts, `retry-failed-snapshot-${mode}.png`), fullPage: true });
  step("恢复失败后保留可读快照", { snapshotReadable: true });

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(180);
  assert.ok(await page.locator("#boundary-export").isVisible());
  assert.match(await page.locator("#boundary-export").innerText(), /安全快照/);
  assert.equal(await page.evaluate(() => window.__FRAMECRAFT__.getResourceCount()), 3);
  await activate(page, mode, "#persistent-fault", "Space");
  assert.equal(await page.locator("#persistent-fault").isChecked(), false);
  await activate(page, mode, '[data-retry-module="export"]');
  await waitModule(page, "export");
  assert.equal(await page.locator("#boundary-export").count(), 0);
  step("刷新错误态后快照仍可读，关闭持续失败可恢复");

  await activate(page, mode, "#open-logs");
  await page.locator("#log-dialog").waitFor({ state: "visible" });
  const logText = await page.locator("#log-list").innerText();
  assert.match(logText, /图像处理/);
  assert.match(logText, /音频合成/);
  assert.match(logText, /工程导出/);
  assert.match(logText, /命中幂等键|复用资源/);
  assert.match(logText, /INJECTED_/);
  await page.screenshot({ path: join(artifacts, `logs-${mode}.png`), fullPage: true });
  if (mode === "mouse") await activate(page, "mouse", "#close-logs");
  else await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => document.activeElement.id), "open-logs");
  step("运行日志包含模块、阶段、故障和幂等复用", { logLines: logText.split("\n").length });

  const undoDisabled = await page.locator("#undo-btn").isDisabled();
  if (undoDisabled) await activate(page, mode, "#run-image");
  if (await page.locator("#redo-btn").isDisabled()) {
    await activate(page, mode, "#undo-btn");
  }
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(180);
  const focusSequence = [];
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    focusSequence.push(await page.evaluate(() => ({
      id: document.activeElement.id,
      label: (document.activeElement.getAttribute("aria-label") || document.activeElement.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28),
      focusVisible: document.activeElement.matches(":focus-visible")
    })));
  }
  assert.equal(focusSequence[0].label, "跳到编辑工作区");
  assert.equal(focusSequence[1].id, "project-title");
  assert.equal(focusSequence[2].id, "undo-btn");
  assert.equal(focusSequence[3].id, "redo-btn");
  assert.equal(focusSequence[4].id, "open-logs");
  assert.equal(focusSequence[5].id, "open-export");
  assert.ok(focusSequence.some((entry) => entry.focusVisible));
  step("键盘焦点顺序按顶栏、场景、模块、时间线推进", { focusSequence });

  const dialogTrigger = "open-export";
  await activate(page, mode, "#open-export");
  await page.locator("#export-dialog").waitFor({ state: "visible" });
  let stayedInDialog = true;
  for (let index = 0; index < 14; index += 1) {
    await page.keyboard.press("Tab");
    stayedInDialog &&= await page.evaluate(() => document.getElementById("export-dialog").contains(document.activeElement));
  }
  assert.equal(stayedInDialog, true, "模态弹窗必须约束焦点");
  if (mode === "mouse") await activate(page, "mouse", "#close-export");
  else await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => document.activeElement.id), dialogTrigger);
  assert.equal(await page.locator("#export-name").inputValue(), "验收-共享导出名");
  step("模态焦点被约束，关闭后返回触发控件且草稿保留");

  const finalState = await page.evaluate(() => ({
    sync: document.getElementById("sync-badge").textContent,
    health: document.getElementById("module-health").textContent,
    resources: window.__FRAMECRAFT__.getResourceCount(),
    logs: window.__FRAMECRAFT__.getLogs().length,
    draft: window.__FRAMECRAFT__.getState().drafts,
    selectedId: window.__FRAMECRAFT__.getState().selectedId,
    stored: window.__FRAMECRAFT__.getStorage()
  }));
  assert.equal(finalState.sync, "三方一致 ✓");
  assert.equal(finalState.resources, 3);
  assert.equal(finalState.stored.drafts.image.note, `未提交备注-${mode}`);
  assert.equal(finalState.stored.drafts.export.name, "验收-共享导出名");
  await page.screenshot({ path: join(artifacts, `acceptance-${mode}.png`), fullPage: true });
  step("最终输入、存储、渲染三方一致", {
    resourceCount: finalState.resources,
    logCount: finalState.logs
  });
  return finalState;
}

async function main() {
  await mkdir(artifacts, { recursive: true });
  const { chromium } = await loadPlaywright();
  const executablePath = await findChromium();
  const { child, url } = await startServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const report = {
    startedAt: new Date().toISOString(),
    url,
    modes: {},
    failures: []
  };

  try {
    for (const mode of ["mouse", "keyboard"]) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 800 },
        acceptDownloads: true
      });
      const page = await context.newPage();
      const consoleErrors = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => {
        consoleErrors.push(`PAGEERROR ${error.message}`);
      });
      const modeReport = { mode, steps: [] };
      report.modes[mode] = modeReport;
      try {
        const finalState = await runAcceptanceTask(page, mode, { ...report, url, steps: modeReport.steps });
        assert.deepEqual(consoleErrors, [], `${mode} 路径不应出现控制台错误`);
        modeReport.finalState = finalState;
        modeReport.status = "passed";
        console.log(`✓ ${mode} 路径通过：${modeReport.steps.length} 个检查点，3 个唯一资源`);
      } catch (error) {
        modeReport.status = "failed";
        modeReport.error = String(error.stack || error);
        report.failures.push(`${mode}: ${error.message}`);
        await page.screenshot({ path: join(artifacts, `acceptance-${mode}-failed.png`), fullPage: true });
        console.error(`✗ ${mode} 路径失败：${error.message}`);
      } finally {
        modeReport.consoleErrors = consoleErrors;
        await context.close();
      }
    }
  } finally {
    await browser.close();
    child.kill("SIGTERM");
  }

  report.finishedAt = new Date().toISOString();
  report.status = report.failures.length === 0 ? "passed" : "failed";
  await writeFile(join(artifacts, "acceptance-report.json"), JSON.stringify(report, null, 2));
  if (report.failures.length) {
    throw new Error(`验收失败：\n${report.failures.join("\n")}`);
  }
  console.log("鼠标与键盘两条路径均通过；验收报告：artifacts/acceptance-report.json");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
