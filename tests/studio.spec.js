import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

function parseWav(buffer) {
  expect(buffer.toString("ascii", 0, 4)).toBe("RIFF");
  expect(buffer.toString("ascii", 8, 12)).toBe("WAVE");
  let offset = 12;
  let format = null;
  let dataSize = 0;
  let dataOffset = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      format = {
        audioFormat: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        byteRate: buffer.readUInt32LE(offset + 16),
        blockAlign: buffer.readUInt16LE(offset + 20),
        bitsPerSample: buffer.readUInt16LE(offset + 22)
      };
    }
    if (chunkId === "data") {
      dataSize = chunkSize;
      dataOffset = offset + 8;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return {
    ...format,
    dataSize,
    dataOffset,
    duration: dataSize / format.byteRate,
    frames: dataSize / format.blockAlign
  };
}

function channelRms(buffer, wav) {
  const sums = new Array(wav.channels).fill(0);
  const frames = wav.dataSize / wav.blockAlign;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < wav.channels; channel += 1) {
      const sample = buffer.readInt16LE(wav.dataOffset + (frame * wav.channels + channel) * 2) / 32768;
      sums[channel] += sample * sample;
    }
  }
  return sums.map((sum) => Math.sqrt(sum / frames));
}

async function downloadFrom(page, selector) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(selector).click()
  ]);
  const path = await download.path();
  return {
    filename: download.suggestedFilename(),
    buffer: await readFile(path)
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.spatialStudio));
});

test("four sources, editable listener field, and runtime metrics are visible", async ({ page }) => {
  await expect(page).toHaveTitle(/空间音频导出器/);
  await expect(page.locator("h1")).toHaveText("四源空间音频导出器");
  await expect(page.locator(".source-card")).toHaveCount(4);
  await expect(page.locator("#stage")).toBeVisible();
  await expect(page.locator("#metricNodes")).toHaveText("0");
  await expect(page.locator("#runtimeStatus")).toHaveText("idle");
  await expect(page.locator("#formatChannels")).toHaveText("2 CH");

  const state = await page.evaluate(() => window.spatialStudio.getState());
  expect(state.sources).toHaveLength(4);
  expect(state.path.length).toBeGreaterThanOrEqual(2);
  expect(new Set(state.sources.map((source) => source.id)).size).toBe(4);
});

test("records a listener path by dragging on the stage", async ({ page }) => {
  const box = await page.locator("#stage").boundingBox();
  await page.locator("#recordButton").click();
  await page.mouse.move(box.x + box.width * 0.32, box.y + box.height * 0.44);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.58, { steps: 18 });
  await page.waitForTimeout(280);
  await page.mouse.up();
  await page.locator("#recordButton").click();

  const result = await page.evaluate(() => ({
    state: window.spatialStudio.getState(),
    diagnostics: window.spatialStudio.getDiagnostics()
  }));
  expect(result.state.path.length).toBeGreaterThan(8);
  const xs = result.state.path.map((point) => point.x);
  expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1);
  expect(result.diagnostics.activeNodes).toBe(0);
  expect(result.diagnostics.listeners).toBe(2);
  await expect(page.locator("#pathPointCount")).not.toHaveText("5 路径点");
});

test("exports real WAV files for both formats and a path JSON", async ({ page }) => {
  await page.locator('[data-format="binaural"]').click();
  const binaural = await downloadFrom(page, "#exportWavButton");
  const binauralWav = parseWav(binaural.buffer);
  expect(binaural.filename).toMatch(/binaural-4\.8s\.wav$/);
  expect(binauralWav.audioFormat).toBe(1);
  expect(binauralWav.channels).toBe(2);
  expect(binauralWav.sampleRate).toBe(48_000);
  expect(binauralWav.bitsPerSample).toBe(16);
  expect(binauralWav.duration).toBeCloseTo(4.8, 4);
  expect(binauralWav.frames).toBe(230_400);
  for (const rms of channelRms(binaural.buffer, binauralWav)) {
    expect(rms).toBeGreaterThan(1e-4);
  }

  await page.locator('[data-format="quad"]').click();
  const quad = await downloadFrom(page, "#exportWavButton");
  const quadWav = parseWav(quad.buffer);
  expect(quad.filename).toMatch(/quad-4\.8s\.wav$/);
  expect(quadWav.channels).toBe(4);
  expect(quadWav.sampleRate).toBe(48_000);
  expect(quadWav.duration).toBeCloseTo(4.8, 4);
  expect(quadWav.frames).toBe(230_400);
  expect(quadWav.dataSize).toBeGreaterThan(binauralWav.dataSize);
  for (const rms of channelRms(quad.buffer, quadWav)) {
    expect(rms).toBeGreaterThan(1e-5);
  }

  const jsonDownload = await downloadFrom(page, "#exportJsonButton");
  expect(jsonDownload.filename).toBe("spatial-path.json");
  const pathJson = JSON.parse(jsonDownload.buffer.toString("utf8"));
  expect(pathJson.schema).toBe("spatial-audio-path");
  expect(pathJson.sources).toHaveLength(4);
  expect(pathJson.channels).toBe(4);
  expect(pathJson.duration).toBe(4.8);
  expect(pathJson.listenerPath.length).toBeGreaterThanOrEqual(5);
  expect(pathJson.beatPoints.length).toBeGreaterThan(0);
  expect(pathJson.spatialProbes.length).toBeGreaterThan(0);

  const metadata = await page.evaluate(() => window.spatialStudio.getLastExports());
  expect(metadata.some((item) => item.format === "binaural" && item.channels === 2)).toBe(true);
  expect(metadata.some((item) => item.format === "quad" && item.channels === 4)).toBe(true);
});

test("listener path automation changes pan, distance gain, and reverb send", async ({ page }) => {
  const automation = await page.evaluate(() => {
    const state = window.spatialStudio.getState();
    const times = [0, 0.8, 1.6, 2.4, 3.2, 4.0, 4.8];
    const frames = times.map((time) => window.spatialStudio.sampleFrame(time));
    return state.sources.map((source, index) => {
      const values = frames.map((frame) => frame.sources[index]);
      return {
        id: source.id,
        minPan: Math.min(...values.map((value) => value.pan)),
        maxPan: Math.max(...values.map((value) => value.pan)),
        minGain: Math.min(...values.map((value) => value.gain)),
        maxGain: Math.max(...values.map((value) => value.gain)),
        minSend: Math.min(...values.map((value) => value.send)),
        maxSend: Math.max(...values.map((value) => value.send)),
        minDistance: Math.min(...values.map((value) => value.distance)),
        maxDistance: Math.max(...values.map((value) => value.distance))
      };
    });
  });
  for (const source of automation) {
    expect(source.maxPan - source.minPan).toBeGreaterThan(0.2);
    expect(source.maxGain - source.minGain).toBeGreaterThan(0.02);
    expect(source.maxSend - source.minSend).toBeGreaterThan(0.01);
    expect(source.maxDistance - source.minDistance).toBeGreaterThan(0.5);
  }
});

test("offline verification checks duration, channels, and repeatable replay for both formats", async ({ page }) => {
  await page.locator("#verifyButton").click();
  await expect(page.locator("#verifyButton")).toBeEnabled({ timeout: 30_000 });

  const results = await page.evaluate(() => window.spatialStudio.getLastExports());
  const checks = results.filter((item) => item.kind === "wav" && item.filename.startsWith("verify-"));
  expect(checks).toHaveLength(2);
  const binaural = checks.find((item) => item.format === "binaural");
  const quad = checks.find((item) => item.format === "quad");
  expect(binaural).toMatchObject({ channels: 2, duration: 4.8, durationMatch: true, channelsMatch: true, replayMatch: true, passed: true });
  expect(quad).toMatchObject({ channels: 4, duration: 4.8, durationMatch: true, channelsMatch: true, replayMatch: true, passed: true });
  expect(binaural.replayMaxDelta).toBeLessThanOrEqual(1);
  expect(quad.replayMaxDelta).toBeLessThanOrEqual(1);
  expect(binaural.renderEngine).toBe("OfflineAudioContext");
  await expect(page.locator("#exportLog")).toContainText("binaural 验证 通过");
  await expect(page.locator("#exportLog")).toContainText("quad 验证 通过");
});

test("interruption, node destruction, and repeated start release voices and listeners", async ({ page }) => {
  const firstStart = await page.evaluate(() => window.spatialStudio.play());
  expect(firstStart.status).toBe("running");
  const starts = await page.evaluate(() =>
    Promise.all([
      window.spatialStudio.play(),
      window.spatialStudio.play()
    ])
  );
  expect(starts.at(-1).status).toBe("running");

  let diagnostics = await page.evaluate(() => window.spatialStudio.getDiagnostics());
  expect(diagnostics.status).toBe("running");
  expect(diagnostics.activeContexts).toBe(1);
  expect(diagnostics.activeNodes).toBeGreaterThan(0);
  expect(diagnostics.scheduledSources).toBe(4);
  expect(diagnostics.listeners).toBe(3);
  expect(diagnostics.timerActive).toBe(true);
  expect(diagnostics.lastStopTailRms).toBeLessThan(5e-4);

  await page.evaluate(() => window.spatialStudio.stop("测试停止", "stopped"));
  diagnostics = await page.evaluate(() => window.spatialStudio.getDiagnostics());
  expect(diagnostics.status).toBe("stopped");
  expect(diagnostics.activeNodes).toBe(0);
  expect(diagnostics.activeContexts).toBe(0);
  expect(diagnostics.contextState).toBe("closed");
  expect(diagnostics.listeners).toBe(2);
  expect(diagnostics.timerActive).toBe(false);
  expect(diagnostics.lastStopTailRms).toBeLessThan(5e-4);
  await expect(page.locator("#metricNodes")).toHaveText("0");

  await page.evaluate(() => window.spatialStudio.play());
  await page.waitForTimeout(180);
  await page.evaluate(() => window.spatialStudio.interrupt("自动化输入中断"));
  diagnostics = await page.evaluate(() => window.spatialStudio.getDiagnostics());
  expect(diagnostics.status).toBe("interrupted");
  expect(diagnostics.activeNodes).toBe(0);
  expect(diagnostics.activeContexts).toBe(0);
  expect(diagnostics.listeners).toBe(2);
  expect(diagnostics.timerActive).toBe(false);
  expect(diagnostics.lastStopTailRms).toBeLessThan(5e-4);

  await page.evaluate(() => window.spatialStudio.play());
  await page.waitForTimeout(120);
  diagnostics = await page.evaluate(() => window.spatialStudio.destroy());
  expect(diagnostics.status).toBe("destroyed");
  expect(diagnostics.activeNodes).toBe(0);
  expect(diagnostics.activeContexts).toBe(0);
  expect(diagnostics.listeners).toBe(0);
  expect(diagnostics.subscribers).toBe(0);
  expect(diagnostics.timerActive).toBe(false);
  expect(diagnostics.lastStopTailRms).toBeLessThan(5e-4);

  diagnostics = await page.evaluate(() => window.spatialStudio.play());
  expect(diagnostics.status).toBe("running");
  expect(diagnostics.activeNodes).toBeGreaterThan(0);
  expect(diagnostics.listeners).toBe(3);
  await page.evaluate(() => window.spatialStudio.stop());
  diagnostics = await page.evaluate(() => window.spatialStudio.getDiagnostics());
  expect(diagnostics.activeNodes).toBe(0);
  expect(diagnostics.listeners).toBe(2);
});

test("snapshot restore preserves beats, pan/gain, and rendered duration", async ({ page }) => {
  const snapshot = await page.evaluate(() => {
    window.spatialStudio.configure({
      duration: 5.2,
      bpm: 132,
      format: "quad",
      path: [
        { time: 0, x: -3, y: 1, z: 0 },
        { time: 1.7, x: 0, y: -1.4, z: 0 },
        { time: 5.2, x: 2.8, y: 1.5, z: 0 }
      ],
      sources: [
        { id: "source-1", x: -2.2, y: 2.7, z: 0, gain: 0.74 },
        { id: "source-2", x: 2.5, y: 2.1, z: 0, gain: 0.61 },
        { id: "source-3", x: -2.4, y: -2.3, z: 0, gain: 0.49 },
        { id: "source-4", x: 2.9, y: -1.8, z: 0, gain: 0.56 }
      ]
    });
    return window.spatialStudio.saveSnapshot();
  });
  const before = await page.evaluate(() => window.spatialStudio.getState());
  expect(snapshot.state).toEqual(before);
  expect(snapshot.beatPoints.length).toBeGreaterThan(10);
  expect(snapshot.spatialProbes).toHaveLength(7);

  await page.evaluate(() => {
    window.spatialStudio.configure({
      duration: 2.1,
      bpm: 72,
      format: "binaural",
      sources: [
        { id: "source-1", x: 4.5, y: -3.2, z: 0, gain: 0.1 },
        { id: "source-2", x: -4.1, y: 3.1, z: 0, gain: 0.2 },
        { id: "source-3", x: 0, y: 0, z: 0, gain: 0.2 },
        { id: "source-4", x: 1, y: 1, z: 0, gain: 0.2 }
      ],
      path: [
        { time: 0, x: 3, y: 3, z: 0 },
        { time: 2.1, x: -3, y: -3, z: 0 }
      ]
    });
  });
  await page.locator("#restoreSnapshotButton").click();

  const restored = await page.evaluate(() => ({
    state: window.spatialStudio.getState(),
    beats: window.spatialStudio.getBeatPoints(),
    probes: window.spatialStudio.getSpatialProbes()
  }));
  expect(restored.state).toEqual(before);
  expect(restored.beats).toEqual(snapshot.beatPoints);
  expect(restored.probes).toEqual(snapshot.spatialProbes);

  const check = await page.evaluate(() => window.spatialStudio.runSnapshotSelfCheck());
  expect(check).toMatchObject({
    passed: true,
    beatsMatch: true,
    spatialMatch: true,
    durationEqual: true,
    exportDurationEqual: true,
    expectedDuration: 5.2,
    exportDuration: 5.2
  });
  await expect(page.locator("#snapshotResult")).toContainText("自检通过");
  await expect(page.locator("#snapshotBadge")).toHaveText("已保存");
});
