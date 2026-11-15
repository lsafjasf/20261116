import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const root = new URL("..", import.meta.url).pathname;
const artifacts = join(root, "artifacts");
const port = 4400 + Math.floor(Math.random() * 1600);
const baseUrl = `http://127.0.0.1:${port}`;

async function findChrome() {
  const direct = process.env.CHROME_PATH;
  if (direct && await stat(direct).catch(() => null)) return direct;
  const fromPlaywright = chromium.executablePath();
  if (await stat(fromPlaywright).catch(() => null)) return fromPlaywright;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(process.env.HOME || "", ".cache/ms-playwright"),
    join("/home", process.env.USER || "hj", ".cache/ms-playwright"),
    "/root/.cache/ms-playwright",
  ].filter(Boolean);
  for (const cacheRoot of roots) {
    const versions = await readdir(cacheRoot).catch(() => []);
    for (const folder of versions.filter((name) => name.startsWith("chromium-")).sort().reverse()) {
      for (const candidate of [
        join(cacheRoot, folder, "chrome-linux64", "chrome"),
        join(cacheRoot, folder, "chrome-linux", "chrome"),
      ]) {
        if (await stat(candidate).catch(() => null)) return candidate;
      }
    }
  }
  throw new Error("未找到 Chromium；请设置 CHROME_PATH，或运行 npx playwright install chromium");
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("本地服务器启动超时");
}

await mkdir(artifacts, { recursive: true });
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverError = "";
server.stderr.on("data", (chunk) => { serverError += chunk.toString(); });

let browser;
try {
  await waitForServer();
  const executablePath = await findChrome();
  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      "--use-angle=swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--disable-dev-shm-usage",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1120 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon")) pageErrors.push(message.text());
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => /PASS|FAIL/.test(document.querySelector("#test-status")?.textContent || ""), null, { timeout: 30000 });
  const firstStatus = (await page.locator("#test-status").textContent()).trim();
  assert.match(firstStatus, /^PASS/, `自动测试未通过: ${firstStatus}`);

  const suite = await page.evaluate(() => {
    const result = window.__PRISM_DEBUG__.getSuite();
    return {
      finalHash: result.finalHash,
      objectCount: result.objectCount,
      results: result.results.map((record) => ({
        id: record.id,
        status: record.status,
        beforeHash: record.beforeHash,
        afterHash: record.afterHash,
        fullHash: record.fullHash,
        hashMatch: record.hashMatch,
        objectsBefore: record.objectsBefore,
        objectsAfter: record.objectsAfter,
        dirtyTiles: record.dirtyTiles,
        totalTiles: record.totalTiles,
        changedPixels: record.changedPixels,
        changedRatio: record.changedRatio,
        note: record.note,
        views: record.views,
      })),
    };
  });
  assert.equal(suite.results.length, 3);
  assert.ok(suite.results.every((result) => result.status === "pass"));
  assert.ok(suite.results.every((result) => result.hashMatch));
  assert.ok(suite.results.every((result) => result.objectsBefore === result.objectsAfter));
  assert.equal(suite.results[0].objectsAfter, 8);
  assert.ok(suite.results[0].dirtyTiles < suite.results[0].totalTiles, "普通测试不应全量重绘");
  assert.equal(suite.results[1].views.length, 0);
  assert.ok(suite.results[0].views.every((view) => view.occluded), "两视图均应显示 L2 被玻璃遮挡");

  await page.locator("#glass-0").fill("20");
  await page.waitForFunction(() => document.querySelector("#tile-chip")?.textContent.startsWith("DIRTY"));
  const dirtyChip = (await page.locator("#tile-chip").textContent()).trim();
  assert.match(dirtyChip, /^DIRTY \d+\/96/);

  await page.locator("#restore-snapshot").click();
  await page.waitForFunction(() => document.querySelector("#tile-chip")?.textContent === "FULL PASS");
  await page.waitForTimeout(150);
  const restored = await page.evaluate(() => ({
    angle: window.__PRISM_DEBUG__.getState().lamps[1].angle,
    hash: window.__PRISM_DEBUG__.getRenderer().hash(),
  }));
  assert.equal(restored.angle, 150);
  assert.equal(restored.hash, suite.finalHash, "一键恢复后的画布哈希应与对照快照一致");

  await page.locator("#run-tests").click();
  await page.waitForFunction(() => document.querySelector("#test-status")?.textContent.includes("PASS · 3/3"), null, { timeout: 30000 });
  await page.waitForTimeout(2100);

  const finalSuite = await page.evaluate(() => {
    const result = window.__PRISM_DEBUG__.getSuite();
    const state = window.__PRISM_DEBUG__.getState();
    return {
      finalHash: result.finalHash,
      objectCount: result.objectCount,
      state,
      stateFingerprint: result.results[0].views.map((view) => view.behindOrder),
    };
  });

  const thumbs = await page.$$eval(".test-card .shot img", (images) => images.map((image) => image.src));
  assert.equal(thumbs.length, 6);
  const names = ["normal-before", "normal-after", "boundary-before", "boundary-after", "failure-before", "failure-after"];
  for (let i = 0; i < thumbs.length; i += 1) {
    const bytes = Buffer.from(thumbs[i].split(",")[1], "base64");
    await writeFile(join(artifacts, `${names[i]}.jpg`), bytes);
  }

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#save-params").click();
  const parameterDownload = await downloadPromise;
  await parameterDownload.saveAs(join(artifacts, "reference-parameters.json"));

  const shotPromise = page.waitForEvent("download");
  await page.locator("#download-shot").click();
  const screenshotDownload = await shotPromise;
  await screenshotDownload.saveAs(join(artifacts, "scene-download.png"));

  await page.locator("#scene").screenshot({ path: join(artifacts, "scene-two-view.png") });
  await page.locator("#two-view-evidence").screenshot({ path: join(artifacts, "view-evidence.png") });
  await page.waitForTimeout(1900);
  await page.screenshot({ path: join(artifacts, "final-page.png"), fullPage: true });

  const measurements = {
    generatedAt: new Date().toISOString(),
    viewport: "1440×1120 @1x",
    finalHash: finalSuite.finalHash,
    objectCount: finalSuite.objectCount,
    restoredAngle: restored.angle,
    restoredHash: restored.hash,
    incrementalUiChip: dirtyChip,
    testResults: suite.results,
    state: finalSuite.state,
    assertions: {
      threeScenariosPassed: true,
      hashesMatchedFullRender: true,
      objectCountStable: true,
      dirtyTilesBelowTotal: true,
      twoViewsOccludedByGlass: true,
      restoreHashMatched: true,
    },
  };
  await writeFile(join(artifacts, "measurements.json"), `${JSON.stringify(measurements, null, 2)}\n`);
  const savedParams = JSON.parse(await readFile(join(artifacts, "reference-parameters.json"), "utf8"));
  assert.equal(savedParams.stateFingerprint.length, 8);
  assert.equal(savedParams.algorithm.textures, 0);
  assert.equal(pageErrors.filter((message) => !message.includes("favicon")).length, 0, pageErrors.join("\n"));

  console.log("PRISM / 03 verification passed");
  for (const result of suite.results) {
    console.log(`${result.id.padEnd(9)} ${result.beforeHash} → ${result.afterHash} | objects ${result.objectsBefore}/${result.objectsAfter} | dirty ${result.dirtyTiles}/${result.totalTiles} | full ${result.hashMatch ? "MATCH" : "MISMATCH"}`);
  }
  console.log(`Restore: angle ${restored.angle}° · hash ${restored.hash} · UI incremental ${dirtyChip}`);
  console.log(`Artifacts: ${artifacts}`);
} catch (error) {
  if (serverError) console.error(serverError);
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
