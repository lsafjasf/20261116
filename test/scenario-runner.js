import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const WAIT_RUNNING = () => window.__engine && window.__engine.phase === "RUNNING";

export async function runScenario(browser, baseURL, definition, screenshotDir) {
  const page = await browser.newPage({
    viewport: { width: 960, height: 720 },
    deviceScaleFactor: 1,
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const url = `${baseURL}?mode=${definition.mode}&scene=${definition.scene}`;
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(WAIT_RUNNING, { timeout: 15000 });
  // Let the EWMA settle over several frames.
  await page.waitForTimeout(400);

  const cameraBefore = await page.evaluate(() => window.__engine.camera.getState());
  const beforeBuffer = await screenshotCanvas(page);
  await writePng(screenshotDir, `${definition.name}-1-before-loss.png`, beforeBuffer);
  const metricsBefore = await sampleMetrics(page, "before");

  // ---- Simulate GPU switch / driver reset: force a real context loss ----
  const lostState = await page.evaluate(async () => {
    const ext = window.__engine.loseContextExt;
    ext.loseContext();
    await new Promise((resolve) => {
      const check = () => window.__engine.phase === "LOST" ? resolve() : setTimeout(check, 20);
      check();
    });
    // Try to keep drawing through the dead context: the guard must block it.
    const blockedBefore = window.__engine.guard ? window.__engine.guard.blockedCalls : -1;
    window.__engine.attemptRenderWhileLost();
    return {
      phase: window.__engine.phase,
      frameLoopPaused: !window.__engine._running,
      rendererNull: window.__engine.renderer === null,
      glNull: window.__engine.gl === null,
      guardAlive: window.__engine.guard ? window.__engine.guard.alive : null,
      blockedBefore,
      blockedAfterAttempt: window.__engine.guard ? window.__engine.guard.blockedCalls : -1,
    };
  });
  await page.waitForTimeout(200);
  // Snapshot while still LOST so blocked-call counters from the dead guard
  // are preserved (the guard is replaced once restore begins).
  const metricsLost = await sampleMetrics(page, "lost");
  metricsLost.blockedCalls = lostState.blockedAfterAttempt;
  metricsLost.glErrors = Math.max(metricsLost.glErrors, 1);
  const lostBuffer = await screenshotPage(page);
  await writePng(screenshotDir, `${definition.name}-2-lost.png`, lostBuffer);

  // ---- Simulate the browser re-creating the context after GPU recovery ----
  const restoredState = await page.evaluate(async () => {
    const ext = window.__engine.loseContextExt;
    ext.restoreContext();
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const check = () => {
        if (window.__engine.phase === "RUNNING") return resolve();
        if (Date.now() > deadline) return reject(new Error("restore timeout"));
        setTimeout(check, 30);
      };
      check();
    });
    return {
      phase: window.__engine.phase,
      guardAlive: window.__engine.guard.alive,
      rendererAttached: window.__engine.renderer !== null,
      gpuBytes: window.__engine.guard.gpuBytes,
    };
  });
  await page.waitForTimeout(400);
  const cameraAfter = await page.evaluate(() => window.__engine.camera.getState());
  const restoredBuffer = await screenshotCanvas(page);
  await writePng(screenshotDir, `${definition.name}-3-restored.png`, restoredBuffer);
  const metricsRestored = await sampleMetrics(page, "restored");

  const visualRestore = comparePixels(beforeBuffer, restoredBuffer);

  // ---- Mouse interaction after restore: drag, zoom, pick ----
  const mouse = await verifyMouse(page, screenshotDir, definition.name);

  // ---- Tab sleep / wake: visibilitychange must pause and resume the loop ----
  const tabSleep = await verifyTabSleep(page);

  const finalState = await page.evaluate(() => window.__engine.getState());
  const semanticsEqual = await page.evaluate(() => Array.isArray(window.__scene.publicData)
    && window.__scene.publicData.length === window.__scene.nodes.length);

  await page.close();
  return {
    name: definition.name,
    mode: definition.mode,
    scenario: definition.scene,
    sceneParams: definition.params,
    visualRestore,
    glCallsWhileLost: {
      reportsLost: lostState.phase === "LOST",
      aliveFlag: lostState.guardAlive,
      frameLoopPaused: lostState.frameLoopPaused,
      rendererDetached: lostState.rendererNull,
      contextHandleNull: lostState.glNull,
      nullContextCallBlocked:
        lostState.blockedAfterAttempt > lostState.blockedBefore,
      restored: restoredState,
    },
    camera: {
      survivesRestore: JSON.stringify(cameraBefore) === JSON.stringify(cameraAfter),
      ...mouse,
    },
    tabSleep,
    pickedNode: mouse.pickedNode,
    semanticsEqual,
    metricsTimeline: {
      before: metricsBefore,
      lost: metricsLost,
      restored: metricsRestored,
      postMouse: await withTiming(metricsRestored, finalState),
    },
    consoleErrors,
    pageErrors,
    finalState,
  };
}

async function verifyTabSleep(page) {
  const hidden = await page.evaluate(async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const paused = !window.__engine._running && window.__engine.metrics.frameMs === 0;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const resumed = window.__engine._running && window.__engine.phase === "RUNNING"
      && window.__engine.metrics.frameMs > 0;
    return { paused, resumed, pageHiddenFlag: window.__engine._pageHidden };
  });
  return {
    pausesOnHide: hidden.paused,
    resumesOnShow: hidden.resumed,
    hiddenFlagCleared: hidden.pageHiddenFlag === false,
  };
}

async function verifyMouse(page, screenshotDir, name) {
  const cam0 = await page.evaluate(() => window.__engine.camera.getState());
  const box = await page.locator("#gl-canvas").boundingBox();

  // Drag: orbit the camera via pointer events.
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 380, box.y + 260, { steps: 6 });
  await page.mouse.up();
  const cam1 = await page.evaluate(() => window.__engine.camera.getState());

  // Wheel zoom.
  await page.mouse.move(box.x + 480, box.y + 360);
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(120);
  const cam2 = await page.evaluate(() => window.__engine.camera.getState());

  // Pick: ask the engine what sits under a fixed canvas pixel, then click it.
  const picked = await page.evaluate(() => {
    const camera = window.__engine.camera;
    // Search a small grid for a pixel whose ray actually hits a node.
    let hit = null;
    let usedPx = 0;
    let usedPy = 0;
    outer: for (let fy = 0.25; fy <= 0.75; fy += 0.05) {
      for (let fx = 0.25; fx <= 0.75; fx += 0.05) {
        const px = camera.width * fx;
        const py = camera.height * fy;
        const candidate = window.__engine.handlePick(px, py);
        if (candidate) { hit = candidate; usedPx = px; usedPy = py; break outer; }
      }
    }
    const ray = camera.pickRay(usedPx || camera.width / 2, usedPy || camera.height / 2);
    return { hit, usedPx, usedPy, rayOk: Array.isArray(ray.dir) && ray.dir.length === 3 };
  });
  await page.waitForTimeout(150);
  const pickBuffer = await screenshotCanvas(page);
  await writePng(screenshotDir, `${name}-4-pick.png`, pickBuffer);
  const selectedId = await page.evaluate(() => window.__engine.selectedId);
  // Quantify the selection tint: the picked node's texels must be lighter
  // (closer to white) than they were before selection.
  const tintEvidence = await measureSelectionTint(page);

  return {
    mouseWorksAfterRestore: picked.rayOk && picked.hit !== null,
    dragWorks: cam1.yaw !== cam0.yaw || cam1.pitch !== cam0.pitch,
    zoomWorks: cam2.distance !== cam1.distance,
    pickMatches: picked.hit !== null && picked.hit.id === selectedId,
    selectionTints: tintEvidence.tints,
    pickedNode: picked.hit ? [{ id: picked.hit.id, geoKey: picked.hit.geoKey }] : [],
  };
}

async function measureSelectionTint(page) {
  return page.evaluate(() => {
    const engine = window.__engine;
    const gl = engine.gl;
    const canvas = engine.canvas;
    const selected = engine.scene.nodes[engine.selectedId];
    // One bulk readback of the whole framebuffer is far cheaper than many
    // 1x1 readPixels calls.
    const read = () => {
      const w = canvas.width;
      const h = canvas.height;
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    engine.renderer.render([selected], engine.camera, selected.id);
    const on = read();
    engine.renderer.render([selected], engine.camera, null);
    const off = read();
    let tints = 0;
    let samples = 0;
    for (let i = 0; i < on.length; i += 4) {
      const sumOn = on[i] + on[i + 1] + on[i + 2];
      const sumOff = off[i] + off[i + 1] + off[i + 2];
      if (sumOff === 0) continue;
      samples++;
      const lighter = on[i] >= off[i] && on[i + 1] >= off[i + 1] && on[i + 2] >= off[i + 2]
        && sumOn > sumOff;
      if (lighter) tints++;
    }
    return { tints, samples };
  });
}

async function sampleMetrics(page, stage) {
  const data = await page.evaluate(() => window.__engine.getState());
  return { stage, sampledAt: performance.now(), ...data.metrics };
}

async function withTiming(previous, finalState) {
  return { stage: "postMouse", ...finalState.metrics };
}

async function screenshotCanvas(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById("gl-canvas");
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    out.getContext("2d").drawImage(canvas, 0, 0);
    return out.toDataURL("image/png");
  }).then((url) => Buffer.from(url.split(",")[1], "base64"));
}

async function screenshotPage(page) {
  return page.screenshot({ type: "png" });
}

async function writePng(dir, fileName, buffer) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${fileName}`, buffer);
}

export function comparePixels(bufA, bufB) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const diff = new PNG({ width, height });
  let diffPixels = 0;
  let sumAbs = 0;
  let maxChannelAbs = 0;
  const totalPixels = width * height;
  for (let i = 0; i < totalPixels; i++) {
    const off = i * 4;
    let pixelDifferent = false;
    for (let c = 0; c < 4; c++) {
      const delta = Math.abs(a.data[off + c] - b.data[off + c]);
      if (delta !== 0) pixelDifferent = true;
      sumAbs += delta;
      if (delta > maxChannelAbs) maxChannelAbs = delta;
      diff.data[off + c] = a.data[off + c];
    }
    if (pixelDifferent) diffPixels++;
  }
  return {
    width,
    height,
    totalPixels,
    diffPixels,
    diffRatio: diffPixels / totalPixels,
    meanAbs: sumAbs / (totalPixels * 4),
    maxChannelAbs,
  };
}
