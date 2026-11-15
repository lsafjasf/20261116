import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { wavDuration } from "../src/audio-core.js";

const port = Number(process.env.VERIFY_PORT || 4300 + (process.pid % 500));
const baseUrl = `http://127.0.0.1:${port}`;
const expectedOrder = ["highpass", "lowshelf", "lowpass", "gate", "softclip"];

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [
    join(homedir(), ".cache", "ms-playwright"),
    "/home/hj/.cache/ms-playwright"
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root).filter((name) => name.startsWith("chromium-")).sort().reverse();
    for (const version of versions) {
      for (const relative of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const candidate = join(root, version, relative);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

async function startServer() {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (output.includes("Signal Lab:")) return child;
    if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
    await delay(100);
  }
  child.kill("SIGTERM");
  throw new Error(`Server startup timeout: ${output}`);
}

async function getState(page) {
  return page.evaluate(() => window.__signalLab.getState());
}

async function waitReady(page, minimumGeneration = 1) {
  await page.waitForFunction((generation) => {
    const state = window.__signalLab?.getState();
    return state?.status === "ready" && state.generation >= generation && !state.renderInFlight;
  }, minimumGeneration, { timeout: 20000 });
}

async function main() {
  mkdirSync("artifacts", { recursive: true });
  const server = await startServer();
  const executablePath = findChromium();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  });
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1000 },
    acceptDownloads: true
  });
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.stack || error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await waitReady(page);
    const initial = await getState(page);
    assert.deepEqual(initial.nodeOrder, expectedOrder);
    assert.equal(initial.duration, 10);
    assert.equal(initial.sampleCount, 441000);
    assert.equal(initial.outputClippedSamples, 0);
    assert.ok(initial.outputPeak <= 0.944001);
    assert.deepEqual(initial.beatPoints, [1.8, 6.35]);

    await page.click("#playBtn");
    await page.waitForFunction(() => window.__signalLab.getState().activeNodes === 3, null, { timeout: 5000 });
    const playing = await getState(page);
    assert.equal(playing.contextState, "running");
    await page.click("#stopBtn");
    await page.waitForFunction(() => {
      const state = window.__signalLab.getState();
      return state.activeNodes === 0 && state.contextState === "closed";
    }, null, { timeout: 5000 });
    const stopped = await getState(page);

    const bypass = page.locator('[data-node="softclip"] .bypass-toggle');
    const beforeBypass = stopped.generation;
    await bypass.check();
    await waitReady(page, beforeBypass + 1);
    const bypassed = await getState(page);
    assert.equal(bypassed.params.nodes.softclip.bypass, true);
    assert.equal(bypassed.outputClippedSamples, 0);
    await bypass.uncheck();
    await waitReady(page, bypassed.generation + 1);

    await page.click("#saveSnapshotBtn");
    const snapshotState = await getState(page);
    await page.evaluate(() => {
      const input = document.querySelector("#masterGain");
      input.value = "-1";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() => {
      const state = window.__signalLab.getState();
      return state.status === "ready" && Math.abs(state.params.masterGainDb + 1) < 0.01;
    }, null, { timeout: 20000 });
    await page.click("#restoreSnapshotBtn");
    await page.waitForFunction(() => window.__signalLab.getState().lastSnapshotComparison !== null,
      null, { timeout: 20000 });
    const restored = await getState(page);
    assert.equal(restored.lastSnapshotComparison.passed, true);
    assert.equal(restored.lastSnapshotComparison.checksumMatches, true);
    assert.equal(restored.params.masterGainDb, snapshotState.params.masterGainDb);

    await page.click("#fixRecordBtn");
    await page.waitForFunction(() => window.__signalLab.getState().lastAudit !== null,
      null, { timeout: 30000 });
    const audited = await getState(page);
    assert.equal(audited.lastAudit.passed, true);
    assert.equal(audited.lastAudit.checksumMatches, true);
    assert.deepEqual(audited.lastAudit.order, expectedOrder);

    await page.click("#selfTestBtn");
    await page.waitForFunction(() => window.__signalLab.getState().lastLifecycle !== null,
      null, { timeout: 30000 });
    const lifecycleState = await getState(page);
    assert.equal(lifecycleState.lastLifecycle.length, 3);
    assert.equal(lifecycleState.lastLifecycle.every((result) => result.passed), true);
    assert.equal(lifecycleState.activeNodes, 0);
    assert.equal(lifecycleState.listenerCount, 14);

    const downloadPromise = page.waitForEvent("download");
    await page.click("#exportBtn");
    const download = await downloadPromise;
    const downloadPath = await download.path();
    const wav = readFileSync(downloadPath);
    copyFileSync(downloadPath, "artifacts/signal-lab.wav");
    let maxPcm = 0;
    for (let offset = 44; offset < wav.length; offset += 2) {
      maxPcm = Math.max(maxPcm, Math.abs(wav.readInt16LE(offset)));
    }
    const exported = await page.evaluate(() => window.__lastExport);
    assert.equal(wavDuration(wav), 10);
    assert.equal(exported.duration, 10);
    assert.equal(exported.checksum, lifecycleState.checksum);
    assert.equal(exported.samePcmAsAudition, true);
    assert.ok(maxPcm < 32767);

    await page.reload({ waitUntil: "networkidle" });
    await waitReady(page);
    await page.click("#restoreSnapshotBtn");
    await page.waitForFunction(() => window.__signalLab.getState().lastSnapshotComparison !== null,
      null, { timeout: 20000 });
    const reloaded = await getState(page);
    assert.equal(reloaded.lastSnapshotComparison.passed, true);
    assert.equal(reloaded.lastSnapshotComparison.checksumMatches, true);
    assert.equal(reloaded.checksum, exported.checksum);
    assert.equal(reloaded.activeNodes, 0);
    assert.equal(reloaded.contextState, "未创建");
    assert.deepEqual(browserErrors, []);

    await page.screenshot({ path: "artifacts/signal-lab.png", fullPage: true });
    const report = {
      verifiedAt: new Date().toISOString(),
      repair: {
        issue: "OfflineAudioContext 两阶段均未调用 AudioBufferSourceNode.start()，导致处理链输出全零",
        fix: "在滤波阶段与门限/软削波阶段启动源节点；最终安全级继续负责阻止削波。",
        nodeOrder: expectedOrder,
        safety: "非旁路安全天花板位于全部可旁路节点之后"
      },
      initial: {
        checksum: initial.checksum,
        duration: initial.duration,
        outputPeakDb: 20 * Math.log10(initial.outputPeak),
        outputClippedSamples: initial.outputClippedSamples,
        overCeilingSamples: initial.overCeilingSamples,
        correlation: initial.correlation,
        beatPoints: initial.beatPoints
      },
      playback: {
        playing,
        stopped
      },
      bypass: {
        outputPeak: bypassed.outputPeak,
        outputClippedSamples: bypassed.outputClippedSamples,
        overCeilingSamples: bypassed.overCeilingSamples
      },
      snapshotRestore: restored.lastSnapshotComparison,
      sameParameterReopen: audited.lastAudit,
      lifecycle: lifecycleState.lastLifecycle,
      export: {
        ...exported,
        artifact: "artifacts/signal-lab.wav",
        byteLength: wav.length,
        maxPcm,
        maxPcmNormalized: maxPcm / 32767,
        headerDuration: wavDuration(wav)
      },
      reloadRestore: reloaded.lastSnapshotComparison,
      final: {
        activeNodes: reloaded.activeNodes,
        contextState: reloaded.contextState,
        listenerCount: reloaded.listenerCount,
        status: reloaded.status
      }
    };
    writeFileSync("artifacts/verification.json", `${JSON.stringify(report, null, 2)}\n`);
    console.log("Verification passed");
    console.log(JSON.stringify({
      nodeOrder: report.repair.nodeOrder,
      repairIssue: report.repair.issue,
      checksum: initial.checksum,
      outputPeak: initial.outputPeak,
      outputClippedSamples: initial.outputClippedSamples,
      snapshotPass: report.snapshotRestore.passed,
      reopenPass: report.sameParameterReopen.passed,
      lifecycle: report.lifecycle.map(({ name, passed }) => ({ name, passed })),
      exportDuration: report.export.headerDuration,
      reloadPass: report.reloadRestore.passed
    }, null, 2));
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
