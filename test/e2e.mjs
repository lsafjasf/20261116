import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const root = process.cwd();
const port = 4187;
const baseUrl = `http://127.0.0.1:${port}/`;

async function findChromium() {
  const cache = "/home/hj/.cache/ms-playwright";
  const entries = await readdir(cache, { withFileTypes: true });
  const versions = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const version of versions) {
    const path = join(cache, version, "chrome-linux64", "chrome");
    try {
      await readFile(path);
      return path;
    } catch {
      // Try the next cached browser.
    }
  }
  throw new Error("No cached Chromium executable found");
}

async function waitForServer(url, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Static server did not start");
}

async function saveDataUrl(dataUrl, filename) {
  const base64 = dataUrl.split(",")[1];
  await writeFile(filename, Buffer.from(base64, "base64"));
}

function compactScenario(result) {
  return {
    kind: result.kind,
    status: result.status,
    expectedMatch: result.expectedMatch,
    detected: result.detected,
    hashBeforeRecompute: result.hashBeforeRecompute,
    hashAfterRecompute: result.hashAfterRecompute,
    objectCountBefore: result.objectCountBefore,
    objectCountAfter: result.objectCountAfter,
    dirtySlots: result.dirtySlots,
    expectedDirtySlots: result.expectedDirtySlots,
    dirtyTexels: result.dirtyTexels,
    totalTexels: result.totalTexels,
    diffPixels: result.diffPixels,
    stableHashBefore: result.stableHashBefore,
    stableHashAfter: result.stableHashAfter,
    isolationViolations: result.isolationViolations,
    guardAlphaMax: result.guardAlphaMax,
    screenshotHashBefore: result.screenshotHashBefore,
    screenshotHashAfter: result.screenshotHashAfter,
    recomputeMs: result.recomputeMs,
  };
}

await mkdir(join(root, "artifacts"), { recursive: true });
await mkdir(join(root, "test-results"), { recursive: true });

const server = spawn(process.execPath, ["scripts/serve.mjs"], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});

const pageErrors = [];
let browser;
try {
  await waitForServer(baseUrl);
  browser = await chromium.launch({
    headless: true,
    executablePath: await findChromium(),
    args: ["--no-sandbox", "--font-render-hinting=none"],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__atlasReady === true, null, { timeout: 30000 });

  const initial = await page.evaluate(() => ({
    objects: window.__atlasApp.state.scene.length,
    hash: window.__atlasApp.state.measurements.hash,
    guard: window.__atlasApp.state.measurements.guardViolations,
    scenarios: Object.fromEntries(Object.entries(window.__atlasApp.state.scenarios).map(([key, value]) => [key, value.status])),
    reload: {
      passed: window.__atlasApp.state.reloaded.validation.passed,
      restored: window.__atlasApp.state.reloaded.validation.restoredCount,
      objects: window.__atlasApp.state.reloaded.validation.objectCount,
    },
    liveCheck: window.__atlasApp.state.liveCheck,
  }));
  assert.deepEqual(initial.scenarios, { normal: "pass", boundary: "pass", failure: "pass" });
  assert.equal(initial.guard, 0);
  assert.equal(initial.reload.passed, true);
  assert.equal(initial.reload.restored, initial.reload.objects);
  assert.equal(initial.objects, initial.reload.objects);
  assert.equal(initial.liveCheck.equal, true);

  const scenarioData = await page.evaluate(() => window.__atlasApp.state.scenarios);
  for (const kind of ["normal", "boundary", "failure"]) {
    const result = scenarioData[kind];
    assert.equal(result.status, "pass", `${kind} scenario should meet expected behavior`);
    await saveDataUrl(result.beforeShot, join(root, `artifacts/scenario-${kind}-incremental.png`));
    await saveDataUrl(result.fullShot, join(root, `artifacts/scenario-${kind}-full.png`));
    await saveDataUrl(result.diffShot, join(root, `artifacts/scenario-${kind}-diff.png`));
  }
  assert.equal(scenarioData.normal.hashBeforeRecompute, scenarioData.normal.hashAfterRecompute);
  assert.equal(scenarioData.boundary.hashBeforeRecompute, scenarioData.boundary.hashAfterRecompute);
  assert.notEqual(scenarioData.failure.hashBeforeRecompute, scenarioData.failure.hashAfterRecompute);
  assert.equal(scenarioData.boundary.guardAlphaMax, 0);

  const beforeMove = await page.evaluate(() => {
    const app = window.__atlasApp;
    const state = app.state;
    window.__sceneRef = state.scene;
    const used = new Set(state.scene.map((entry) => entry.slot));
    const selected = state.scene.find((entry) => entry.id === state.selectedId);
    let target = 0;
    while (used.has(target)) target += 1;
    return {
      selectedSlot: selected.slot,
      target,
      objects: state.scene.length,
      hash: state.measurements.hash,
      textureRebuilds: state.textureRebuilds,
      sceneRebuilds: state.sceneRebuilds,
    };
  });
  await page.selectOption("#slotSelect", String(beforeMove.target));
  await page.waitForTimeout(250);
  const afterMove = await page.evaluate(() => {
    const state = window.__atlasApp.state;
    return {
      mode: state.lastUpdate.mode,
      dirtyTiles: state.lastUpdate.dirtyTiles,
      dirtyPixels: state.lastUpdate.dirtyPixels,
      objects: state.scene.length,
      hash: state.measurements.hash,
      textureRebuilds: state.textureRebuilds,
      sceneRebuilds: state.sceneRebuilds,
      sameArray: window.__sceneRef === state.scene,
      selectedSlot: state.scene.find((entry) => entry.id === state.selectedId).slot,
    };
  });
  assert.equal(afterMove.mode, "INCREMENTAL");
  assert.equal(afterMove.dirtyTiles, 2);
  assert.equal(afterMove.dirtyPixels, 2 * 128 * 128);
  assert.equal(afterMove.objects, beforeMove.objects);
  assert.equal(afterMove.textureRebuilds, beforeMove.textureRebuilds);
  assert.equal(afterMove.sceneRebuilds, beforeMove.sceneRebuilds);
  assert.equal(afterMove.sameArray, true);
  assert.equal(afterMove.selectedSlot, beforeMove.target);
  assert.notEqual(afterMove.hash, beforeMove.hash);

  const beforeRotation = await page.evaluate(() => ({
    textureRebuilds: window.__atlasApp.state.textureRebuilds,
    sceneRebuilds: window.__atlasApp.state.sceneRebuilds,
  }));
  await page.locator("#rotationRange").evaluate((input) => {
    input.value = "17";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(200);
  const afterRotation = await page.evaluate(() => {
    const state = window.__atlasApp.state;
    return {
      mode: state.lastUpdate.mode,
      dirtyTiles: state.lastUpdate.dirtyTiles,
      dirtyPixels: state.lastUpdate.dirtyPixels,
      sameArray: window.__sceneRef === state.scene,
      textureRebuilds: state.textureRebuilds,
      sceneRebuilds: state.sceneRebuilds,
    };
  });
  assert.equal(afterRotation.mode, "INCREMENTAL");
  assert.equal(afterRotation.dirtyTiles, 1);
  assert.equal(afterRotation.dirtyPixels, 128 * 128);
  assert.equal(afterRotation.sameArray, true);
  assert.equal(afterRotation.textureRebuilds, beforeRotation.textureRebuilds);
  assert.equal(afterRotation.sceneRebuilds, beforeRotation.sceneRebuilds);
  await page.screenshot({ path: join(root, "artifacts/incremental-page.png"), fullPage: true });

  await page.click("#restoreButton");
  await page.waitForFunction(() => window.__atlasApp.state.liveCheck?.equal === true, null, { timeout: 10000 });
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  await page.click("#exportReloadButton");
  await page.waitForTimeout(1200);
  assert.ok(downloads.length >= 2, `expected PNG + JSON downloads, received ${downloads.length}`);
  const pngDownload = downloads.find((download) => download.suggestedFilename().endsWith(".png"));
  const jsonDownload = downloads.find((download) => download.suggestedFilename().endsWith(".json"));
  assert.ok(pngDownload, "atlas PNG download missing");
  assert.ok(jsonDownload, "index JSON download missing");
  const atlasPath = join(root, "artifacts/shadow-atlas.png");
  const indexPath = join(root, "artifacts/shadow-atlas-index.json");
  await pngDownload.saveAs(atlasPath);
  await jsonDownload.saveAs(indexPath);
  await page.waitForFunction(() => window.__atlasApp.state.reloaded?.validation?.passed === true, null, { timeout: 10000 });
  await page.screenshot({ path: join(root, "artifacts/final-page.png"), fullPage: true });

  const exported = await page.evaluate(() => {
    const app = window.__atlasApp;
    return {
      stateSummary: app.buildStateSummary(),
      index: app.getIndex(),
      reload: app.state.reloaded.validation,
    };
  });
  await writeFile(join(root, "artifacts/algorithm-state.json"), JSON.stringify(exported.stateSummary, null, 2));

  const downloadedIndex = JSON.parse(await readFile(indexPath, "utf8"));
  assert.equal(downloadedIndex.format, "shadow-atlas/v1");
  assert.equal(downloadedIndex.shapeCount, 14);
  assert.equal(downloadedIndex.texture.hash, exported.reload.expectedTextureHash);
  assert.equal(exported.reload.passed, true);
  assert.equal(exported.reload.restoredCount, 14);

  const reloadPage = await context.newPage();
  reloadPage.on("pageerror", (error) => pageErrors.push(error.message));
  await reloadPage.goto(baseUrl, { waitUntil: "networkidle" });
  await reloadPage.waitForFunction(() => window.__atlasReady === true, null, { timeout: 30000 });
  await reloadPage.setInputFiles("#bundleIndexFile", indexPath);
  await reloadPage.setInputFiles("#bundleAtlasFile", atlasPath);
  await reloadPage.waitForFunction(() => window.__atlasApp.state.lastUpdate.mode === "RELOAD", null, { timeout: 15000 });

  const reloadResult = await reloadPage.evaluate(() => {
    const app = window.__atlasApp;
    const validation = app.state.reloaded.validation;
    return {
      passed: validation.passed,
      textureHash: validation.textureHash,
      expectedTextureHash: validation.expectedTextureHash,
      objectCount: validation.objectCount,
      restoredCount: validation.restoredCount,
      guardViolations: validation.guardViolations,
      items: validation.items.map((item) => ({
        id: item.id,
        name: item.name,
        slot: item.slot,
        status: item.status,
        guardAlphaMax: item.guardAlphaMax,
        alphaPixels: item.alphaPixels,
        problems: item.problems,
      })),
      magnifierSource: app.state.magnifierSource,
    };
  });
  assert.equal(reloadResult.passed, true);
  assert.equal(reloadResult.textureHash, downloadedIndex.texture.hash);
  assert.equal(reloadResult.objectCount, 14);
  assert.equal(reloadResult.restoredCount, 14);
  assert.equal(reloadResult.guardViolations, 0);
  assert.equal(reloadResult.magnifierSource, "reloaded");

  const reloadItemCount = await reloadPage.locator(".reload-item").count();
  assert.equal(reloadItemCount, 14);
  for (let index = 0; index < reloadItemCount; index += 1) {
    await reloadPage.locator(".reload-item").nth(index).click();
    const selected = await reloadPage.evaluate((itemIndex) => {
      const state = window.__atlasApp.state;
      const item = state.reloaded.validation.items[itemIndex];
      return {
        selectedId: state.selectedId,
        expectedId: item.id,
        source: state.magnifierSource,
        guardText: document.getElementById("magnifierGuard").textContent,
      };
    }, index);
    assert.equal(selected.selectedId, selected.expectedId);
    assert.equal(selected.source, "reloaded");
    assert.equal(selected.guardText, "0");
  }
  await reloadPage.screenshot({ path: join(root, "artifacts/reloaded-page.png"), fullPage: true });
  await reloadPage.locator("#magnifierCanvas").screenshot({ path: join(root, "artifacts/reloaded-magnifier.png") });
  assert.deepEqual(pageErrors, []);

  const report = {
    status: "pass",
    generatedAt: new Date().toISOString(),
    initial,
    incrementalMove: {
      before: beforeMove,
      after: afterMove,
      textureRebuildsUnchanged: afterMove.textureRebuilds === beforeMove.textureRebuilds,
      sceneArrayPreserved: afterMove.sameArray,
    },
    incrementalParameter: {
      before: beforeRotation,
      after: afterRotation,
      sceneArrayPreserved: afterRotation.sameArray,
    },
    scenarios: Object.fromEntries(Object.entries(scenarioData).map(([kind, result]) => [kind, compactScenario(result)])),
    export: {
      atlas: "artifacts/shadow-atlas.png",
      index: "artifacts/shadow-atlas-index.json",
      stateSummary: "artifacts/algorithm-state.json",
      textureHash: downloadedIndex.texture.hash,
      objectCount: downloadedIndex.shapeCount,
    },
    reload: {
      passed: reloadResult.passed,
      textureHash: reloadResult.textureHash,
      objects: reloadResult.objectCount,
      restored: reloadResult.restoredCount,
      guardViolations: reloadResult.guardViolations,
      items: reloadResult.items,
    },
    screenshots: [
      "artifacts/final-page.png",
      "artifacts/incremental-page.png",
      "artifacts/reloaded-page.png",
      "artifacts/reloaded-magnifier.png",
      "artifacts/scenario-normal-incremental.png",
      "artifacts/scenario-normal-full.png",
      "artifacts/scenario-boundary-incremental.png",
      "artifacts/scenario-boundary-full.png",
      "artifacts/scenario-failure-incremental.png",
      "artifacts/scenario-failure-full.png",
    ],
    conclusion:
      "最终实时纹理与独立全量重算哈希一致；PNG/JSON 回载 14/14 项通过，隔离环 alpha 为 0。",
  };
  const reportText = JSON.stringify(report, null, 2);
  await writeFile(join(root, "test-results/validation-report.json"), reportText);
  await writeFile(join(root, "artifacts/validation-report.json"), reportText);
  console.log(JSON.stringify({
    status: report.status,
    textureHash: report.export.textureHash,
    scenarios: Object.fromEntries(Object.entries(report.scenarios).map(([kind, result]) => [kind, result.status])),
    reload: `${report.reload.restored}/${report.reload.objects}`,
  }, null, 2));
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
