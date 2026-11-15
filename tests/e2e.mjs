import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const artifacts = join(root, "artifacts");
const exportsDir = join(artifacts, "exports");
const checksDir = join(artifacts, "checks");
const snapshotsDir = join(artifacts, "snapshots");
const screenshotsDir = join(artifacts, "screenshots");

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    "/home/hj/userfeedback/uid621/node_modules/playwright/index.mjs",
    "/home/hj/userfeedback/uid220/node_modules/playwright/index.mjs",
    join(root, "node_modules/playwright/index.mjs")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  throw new Error("未找到 Playwright。请设置 PLAYWRIGHT_MODULE 指向 playwright/index.mjs");
}

async function findChromium() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cacheRoots = [
    join(process.env.HOME || "", ".cache/ms-playwright"),
    join(process.env.HOME || "", ".codex-relay-home-ddtmh136/.cache/ms-playwright"),
    "/home/hj/.cache/ms-playwright"
  ];
  for (const cacheRoot of cacheRoots) {
    if (!existsSync(cacheRoot)) continue;
    const entries = await readdir(cacheRoot);
    for (const entry of entries.sort().reverse()) {
      const executable = join(cacheRoot, entry, "chrome-linux64/chrome");
      if (entry.startsWith("chromium-") && existsSync(executable)) return executable;
    }
  }
  return undefined;
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server process is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`本地服务器未启动：${url}`);
}

function dataToBuffer(dataUrl) {
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

async function writeDataUrl(path, dataUrl) {
  await writeFile(path, dataToBuffer(dataUrl));
}

async function waitForRender(page) {
  await page.waitForFunction(() => {
    const state = window.SeamLab?.getState();
    return state && state.metrics && !state.renderMode.includes("正在");
  }, null, { timeout: 15000 });
  await page.waitForTimeout(120);
}

async function captureMaterial(page, kind) {
  await waitForRender(page);
  const png512 = await page.evaluate(() => window.SeamLab.renderDataUrl(512));
  const png1024 = await page.evaluate(() => window.SeamLab.renderDataUrl(1024, { withMetrics: true }));
  await writeDataUrl(join(exportsDir, `${kind}-512.png`), png512);
  await writeDataUrl(join(exportsDir, `${kind}-1024.png`), png1024.dataUrl);
  const tile = await page.evaluate(() => window.SeamLab.tileDataUrl(1024));
  await writeDataUrl(join(checksDir, `${kind}-tile-2x2.png`), tile);
  const comparison = await page.evaluate(() => window.SeamLab.comparison());
  await writeDataUrl(join(checksDir, `${kind}-resample-report.png`), comparison.report);
  await writeDataUrl(join(checksDir, `${kind}-direct-512.png`), comparison.direct);
  await writeDataUrl(join(checksDir, `${kind}-downscaled-1024-to-512.png`), comparison.downscaled);
  const snapshot512 = await page.evaluate(() => window.SeamLab.prepareSnapshot("512 导出前工程快照", 512));
  const snapshot1024 = await page.evaluate(() => window.SeamLab.prepareSnapshot("1024 导出前工程快照", 1024));
  await writeFile(join(snapshotsDir, `${kind}-pre-export-512.json`), JSON.stringify(snapshot512, null, 2));
  await writeFile(join(snapshotsDir, `${kind}-pre-export-1024.json`), JSON.stringify(snapshot1024, null, 2));
  assert.equal(png1024.metrics.passes, true, `${kind} 1024 接缝检测未通过`);
  assert.equal(comparison.metrics.passes, true, `${kind} 重采样对比未通过`);
  return { png1024: png1024.metrics, comparison: comparison.metrics, snapshotDigest: snapshot1024.digest };
}

async function main() {
  const { chromium } = await loadPlaywright();
  await Promise.all([exportsDir, checksDir, snapshotsDir, screenshotsDir]
    .map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all([exportsDir, checksDir, snapshotsDir, screenshotsDir].map((dir) => mkdir(dir, { recursive: true })));
  const port = 4500 + (process.pid % 300);
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore"
  });
  const url = `http://127.0.0.1:${port}`;
  let browser;
  try {
    await waitForServer(url);
    browser = await chromium.launch({ headless: true, executablePath: await findChromium() });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      acceptDownloads: true,
      deviceScaleFactor: 1
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.SeamLab), null, { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await waitForRender(page);
    assert.equal(await page.title(), "SeamLab — 程序化纹理工作台");

    const stone = await captureMaterial(page, "stone");
    await page.screenshot({ path: join(screenshotsDir, "editor-stone.png") });
    await page.click("#presetFabric");
    await waitForRender(page);
    const fabric = await captureMaterial(page, "fabric");
    await page.screenshot({ path: join(screenshotsDir, "editor-fabric.png") });

    await page.click("#presetStone");
    await waitForRender(page);
    const shell = await page.locator("#canvasShell").boundingBox();
    const geometry = await page.evaluate(() => {
      const shellElement = document.querySelector("#canvasShell");
      const width = shellElement.clientWidth;
      const height = shellElement.clientHeight;
      return { cx: width / 2, cy: height / 2, tile: Math.min(width, height) * 0.72 };
    });
    const seamX = shell.x + geometry.cx + geometry.tile / 2;
    const brushY = shell.y + geometry.cy - 28;
    await page.mouse.move(seamX - 8, brushY);
    await page.mouse.down();
    await page.mouse.move(seamX + 24, brushY + 18, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const pointerStroke = await page.evaluate(() => {
      const layer = window.SeamLab.getScene().layers.find((item) => item.type === "brush");
      const stroke = layer.strokes.at(-1);
      return { count: layer.strokes.length, maxX: Math.max(...stroke.points.map((point) => point.x)) };
    });
    assert.ok(pointerStroke.count >= 1, "真实指针绘制未产生笔触");
    assert.ok(pointerStroke.maxX > 1, "真实指针绘制未跨过 U 边界");
    const brushResult = await page.evaluate(() => {
      const layer = window.SeamLab.getScene().layers.find((item) => item.type === "brush");
      window.SeamLab.addBoundaryStroke();
      const updated = window.SeamLab.getScene().layers.find((item) => item.type === "brush");
      const stroke = updated.strokes.at(-1);
      return {
        before: layer.strokes.length,
        after: updated.strokes.length,
        minX: Math.min(...stroke.points.map((point) => point.x)),
        maxX: Math.max(...stroke.points.map((point) => point.x)),
        minY: Math.min(...stroke.points.map((point) => point.y)),
        maxY: Math.max(...stroke.points.map((point) => point.y))
      };
    });
    assert.equal(brushResult.after, brushResult.before + 1);
    assert.ok(brushResult.maxX > 1 && brushResult.minX < 0, "笔刷未跨过 U 边界");
    assert.ok(brushResult.maxY > 1 && brushResult.minY >= 0, "笔刷未跨过 V 边界");
    await waitForRender(page);
    const brushTile = await page.evaluate(() => window.SeamLab.tileDataUrl(1024));
    await writeDataUrl(join(checksDir, "stone-brush-cross-boundary-tile.png"), brushTile);

    await page.click("#tileToggle");
    await page.click("#rotateRight");
    await page.click("#rotateRight");
    await page.locator("#zoomRange").fill("140");
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(screenshotsDir, "tile-rotated-zoom.png") });
    const transformedMetrics = await page.evaluate(() => window.SeamLab.renderDataUrl(1024, { withMetrics: true }).metrics);
    assert.equal(transformedMetrics.passes, true, "缩放/旋转后的导出接缝检测未通过");

    const beforeReload = await page.evaluate(() => {
      const scene = window.SeamLab.getScene();
      const brush = scene.layers.find((layer) => layer.type === "brush");
      const material = scene.layers.find((layer) => layer.type === "material");
      const ordered = [brush, material].filter(Boolean);
      for (const layer of scene.layers) if (!ordered.includes(layer)) ordered.push(layer);
      scene.layers = ordered;
      scene.selectedLayerId = material.id;
      scene.currentTime = 72;
      scene.cursor = { u: 0.321, v: 0.789 };
      scene.brush.color = "#7d9fb1";
      scene.view.rotation = -30;
      scene.view.zoom = 1.4;
      material.palette.base = "#958d7f";
      const keyframe = scene.keyframes.find((frame) => frame.time === 50);
      keyframe.weather = 0.44;
      const digest = window.SeamLab.setScene(scene, { history: false, save: true });
      return { digest, scene, keyframeSnapshot: JSON.stringify(scene.keyframes) };
    });
    await waitForRender(page);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.evaluate(() => window.SeamLab.reloadCheck())
    ]);
    await page.waitForFunction(() => Boolean(window.SeamLab), null, { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await waitForRender(page);
    const afterReload = await page.evaluate(() => ({
      digest: window.SeamLab.getDigest(),
      layerOrder: window.SeamLab.getScene().layers.map((layer) => layer.id),
      keyframes: JSON.stringify(window.SeamLab.getScene().keyframes),
      cursor: window.SeamLab.getScene().cursor,
      brushColor: window.SeamLab.getScene().brush.color,
      baseColor: window.SeamLab.getScene().layers.find((layer) => layer.type === "material").palette.base,
      view: window.SeamLab.getScene().view,
      reloadMessage: document.querySelector("#toastStack").textContent
    }));
    assert.equal(afterReload.digest, beforeReload.digest, "重新载入后工程摘要发生变化");
    assert.deepEqual(afterReload.layerOrder, beforeReload.scene.layers.map((layer) => layer.id));
    assert.equal(afterReload.keyframes, beforeReload.keyframeSnapshot);
    assert.deepEqual(afterReload.cursor, beforeReload.scene.cursor);
    assert.equal(afterReload.brushColor, "#7d9fb1");
    assert.equal(afterReload.baseColor, "#958d7f");
    assert.equal(afterReload.view.zoom, 1.4);
    assert.equal(afterReload.view.rotation, -30);
    assert.match(afterReload.reloadMessage, /重载校验通过/);
    await page.screenshot({ path: join(screenshotsDir, "reloaded-project.png") });

    const previewMatchesExport = await page.evaluate(
      () => window.SeamLab.previewDataUrl() === window.SeamLab.renderDataUrl(1024)
    );
    assert.equal(previewMatchesExport, true, "屏幕预览与 1024 导出不是同一像素结果");

    await page.click("#failureCache");
    await page.waitForFunction(() => document.querySelector("#diagnosticStatus").textContent.includes("重建"), null, { timeout: 5000 });
    await page.click("#failureThumb");
    await page.waitForTimeout(300);
    const thumbnails = await page.locator("#layerList canvas").count();
    const thumbnailDiagnostic = await page.locator("#diagnosticStatus").textContent();
    assert.ok(thumbnails >= 2, "缩略图失效后未回退到主纹理缩略图");
    assert.match(thumbnailDiagnostic, /缩略图缓存失效/);
    await page.click("#failureAsync");
    await page.waitForFunction(() => document.querySelector("#renderMode").textContent.includes("回退"), null, { timeout: 5000 });
    await page.screenshot({ path: join(screenshotsDir, "async-failure-fallback.png") });
    const fallbackState = await page.evaluate(() => ({
      renderMode: document.querySelector("#renderMode").textContent,
      diagnostic: document.querySelector("#diagnosticStatus").textContent,
      metrics: window.SeamLab.getState().metrics
    }));
    assert.match(fallbackState.renderMode, /回退/);
    assert.match(fallbackState.diagnostic, /回退/);
    assert.equal(fallbackState.metrics.passes, true);

    const parameterTests = await page.evaluate(() => window.SeamLab.runParameterTests());
    assert.equal(parameterTests.passed, true, "三组参数测试未全部通过");
    await writeFile(join(artifacts, "parameter-tests.json"), JSON.stringify(parameterTests, null, 2));
    const snapshots = await page.evaluate(() => window.SeamLab.snapshots());
    assert.ok(snapshots.length >= 4, "导出前工程快照数量不足");
    await writeFile(join(snapshotsDir, "index.json"), JSON.stringify(snapshots, null, 2));

    await page.evaluate(() => {
      const scene = window.SeamLab.getScene();
      const material = scene.layers.find((layer) => layer.type === "material");
      const brush = scene.layers.find((layer) => layer.type === "brush");
      const rest = scene.layers.filter((layer) => layer !== material && layer !== brush);
      if (material) scene.layers = [material, ...rest];
      if (brush) scene.layers.push(brush);
      scene.view.tiling = false;
      scene.view.zoom = 1;
      scene.view.rotation = 0;
      scene.view.panX = 0;
      scene.view.panY = 0;
      scene.selectedLayerId = material?.id || scene.layers[0].id;
      window.SeamLab.setScene(scene, { history: false, save: true });
    });
    await waitForRender(page);
    await page.evaluate(() => {
      document.querySelector(".right-rail").scrollTop = 0;
      document.querySelector(".left-rail").scrollTop = 0;
      document.querySelectorAll(".toast").forEach((toast) => toast.remove());
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(screenshotsDir, "editor-final.png") });

    const manifest = {
      generatedAt: new Date().toISOString(),
      viewport: "1440x960",
      materials: { stone, fabric },
      checks: {
        fourEdgeSeam: stone.png1024.passes && fabric.png1024.passes,
        resampleConsistency: stone.comparison.passes && fabric.comparison.passes,
        pointerBrushAcrossSeam: pointerStroke,
        crossBoundaryBrush: brushResult,
        zoomRotateExportSeams: transformedMetrics.passes,
        previewMatchesExport,
        reload: {
          digest: afterReload.digest,
          layers: afterReload.layerOrder,
          keyframes: JSON.parse(afterReload.keyframes).length,
          cursor: afterReload.cursor,
          colors: { brush: afterReload.brushColor, base: afterReload.baseColor }
        },
        failureFallback: fallbackState,
        parameterTests: parameterTests.passed,
        snapshots: snapshots.length
      },
      pageErrors
    };
    await writeFile(join(artifacts, "acceptance-manifest.json"), JSON.stringify(manifest, null, 2));
    assert.deepEqual(pageErrors, [], `浏览器出现错误：${pageErrors.join(" | ")}`);
    console.log(JSON.stringify({
      passed: true,
      stoneSeam: stone.png1024,
      stoneResample: stone.comparison,
      fabricSeam: fabric.png1024,
      fabricResample: fabric.comparison,
      brush: brushResult,
      snapshots: snapshots.length,
      artifacts
    }, null, 2));
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
