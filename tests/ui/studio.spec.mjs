import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function waitForStudio(page) {
  await page.goto("/");
  await page.waitForFunction(() => window.__atlasReady === true);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".chart-card")).toHaveCount(3);
}

async function selectFrame(page, frameIndex) {
  const cards = page.locator(".chart-card");
  for (let index = 0; index < 3; index += 1) {
    await cards.nth(index).locator(".frames button").nth(frameIndex).click();
  }
}

function parseSvgTexts(svg) {
  const result = [];
  const pattern = /<text\b[^>]*data-role="([^"]+)"[^>]*>([^<]*)<\/text>/g;
  for (const match of svg.matchAll(pattern)) {
    const tag = match[0].slice(0, match[0].indexOf(">"));
    const x = tag.match(/\bx="([^"]+)"/)?.[1] ?? null;
    const y = tag.match(/\by="([^"]+)"/)?.[1] ?? null;
    result.push({ role: match[1], text: match[2], x, y });
  }
  return result;
}

test("all three parameter groups and keyframes render without text collisions", async ({ page }) => {
  await waitForStudio(page);
  for (const scenario of ["default", "boundary", "abnormal"]) {
    await page.locator(`[data-scenario="${scenario}"]`).click();
    await expect(page.locator(`[data-scenario="${scenario}"]`)).toHaveAttribute("aria-pressed", "true");
    for (let frame = 0; frame < 3; frame += 1) {
      await selectFrame(page, frame);
      const report = await page.evaluate(() =>
        [...document.querySelectorAll(".chart-svg-wrap svg")].map((svg) => {
          const labels = [...svg.querySelectorAll("[data-label-box]")].map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              role: element.dataset.labelBox,
              text: element.textContent,
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            };
          });
          const collisions = [];
          for (let left = 0; left < labels.length; left += 1) {
            for (let right = left + 1; right < labels.length; right += 1) {
              const a = labels[left];
              const b = labels[right];
              if (!(
                a.x + a.width <= b.x ||
                b.x + b.width <= a.x ||
                a.y + a.height <= b.y ||
                b.y + b.height <= a.y
              )) {
                collisions.push([a.role, a.text, b.role, b.text]);
              }
            }
          }
          return {
            chartId: svg.dataset.chartId,
            layoutHash: svg.dataset.layoutHash,
            count: labels.length,
            collisions
          };
        })
      );
      expect(report).toHaveLength(3);
      for (const chart of report) {
        expect(chart.count).toBeGreaterThan(8);
        expect(chart.layoutHash).toMatch(/^[0-9a-f]{8}$/);
        expect(chart.collisions).toEqual([]);
      }
    }
  }
  await expect(page.locator(".verify-row.pass")).toHaveCount(3);
});

test("SVG and PNG exports keep the preview geometry and save a prior snapshot", async ({ page }) => {
  await waitForStudio(page);
  await expect(page.locator("#snapshot-count")).toHaveText("0");
  const screen = await page.evaluate(() => {
    const svg = document.querySelector(".chart-svg-wrap svg");
    return {
      hash: svg.dataset.layoutHash,
      texts: [...svg.querySelectorAll("text[data-role]")].map((element) => ({
        role: element.dataset.role,
        text: element.textContent,
        x: element.getAttribute("x"),
        y: element.getAttribute("y")
      }))
    };
  });

  const svgDownloadPromise = page.waitForEvent("download");
  await page.locator('[data-card-id="edge-flow"] [data-format="SVG"]').click();
  const svgDownload = await svgDownloadPromise;
  const svgPath = await svgDownload.path();
  const exportedSvg = await readFile(svgPath, "utf8");
  expect(exportedSvg).toContain(`data-layout-hash="${screen.hash}"`);
  expect(exportedSvg).toContain("data:font/woff2;base64,");
  expect(parseSvgTexts(exportedSvg)).toEqual(screen.texts);
  await expect(page.locator("#snapshot-count")).toHaveText("1");
  const snapshot = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas-chart-studio:snapshots:v1"))[0]
  );
  expect(snapshot.reason).toBe("before-export");
  expect(snapshot.charts[0].layoutHash).toBe(screen.hash);
  expect(snapshot.layerOrder).toEqual([
    "background", "grid", "axes", "area", "line", "scatter", "annotations", "header", "legend"
  ]);
  expect(snapshot.charts[0].colors.cache).toBe("#2367d1");

  const pngDownloadPromise = page.waitForEvent("download");
  await page.locator('[data-card-id="edge-flow"] [data-format="PNG"]').click();
  const pngDownload = await pngDownloadPromise;
  const pngPath = await pngDownload.path();
  const png = await readFile(pngPath);
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(1840);
  expect(png.readUInt32BE(20)).toBe(920);
  await expect(page.locator("#snapshot-count")).toHaveText("2");
});

test("reload preserves layer order, keyframes, coordinates and colors", async ({ page }) => {
  await waitForStudio(page);
  await page.locator('[data-scenario="boundary"]').click();
  await selectFrame(page, 1);
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => {
    const state = window.__atlas.getState();
    return {
      scenarioId: state.scenarioId,
      layerOrder: state.layerOrder,
      charts: state.charts.map((chart) => ({
        id: chart.id,
        selectedFrame: chart.selectedFrame,
        keyframes: chart.frames.map((frame) => frame.id),
        colors: chart.frames.map((frame) => frame.series.map((series) => series.color))
      })),
      renders: window.__atlas.getRenders()
    };
  });
  await page.reload();
  await page.waitForFunction(() => window.__atlasReady === true);
  await page.evaluate(() => document.fonts.ready);
  const after = await page.evaluate(() => {
    const state = window.__atlas.getState();
    return {
      scenarioId: state.scenarioId,
      layerOrder: state.layerOrder,
      charts: state.charts.map((chart) => ({
        id: chart.id,
        selectedFrame: chart.selectedFrame,
        keyframes: chart.frames.map((frame) => frame.id),
        colors: chart.frames.map((frame) => frame.series.map((series) => series.color))
      })),
      renders: window.__atlas.getRenders()
    };
  });
  expect(after).toEqual(before);
  await expect(page.locator(".chart-card").nth(0)).toHaveAttribute(
    "data-layout-hash",
    before.renders[0].layoutHash
  );
});

test("a before-export snapshot restores the exact keyframe geometry", async ({ page }) => {
  await waitForStudio(page);
  await selectFrame(page, 1);
  const downloadPromise = page.waitForEvent("download");
  await page.locator('[data-card-id="edge-flow"] [data-format="SVG"]').click();
  await downloadPromise;
  const saved = await page.evaluate(() => {
    const snapshots = JSON.parse(localStorage.getItem("atlas-chart-studio:snapshots:v1"));
    return {
      id: snapshots[0].id,
      state: snapshots[0].state,
      chart: snapshots[0].charts[0]
    };
  });
  await selectFrame(page, 2);
  await expect(page.locator('[data-card-id="edge-flow"] .frames button').nth(2))
    .toHaveAttribute("aria-pressed", "true");
  await page.locator(`[data-snapshot-id="${saved.id}"] button`).click();
  await page.waitForTimeout(120);
  const restored = await page.evaluate(() => window.__atlas.getState());
  expect(restored.charts[0].selectedFrame).toBe(saved.state.charts[0].selectedFrame);
  expect(restored.layerOrder).toEqual(saved.state.layerOrder);
  expect(await page.evaluate(() => window.__atlas.getRenders()[0].layoutHash))
    .toBe(saved.chart.layoutHash);
  await expect(page.locator('[data-card-id="edge-flow"] .frames button').nth(1))
    .toHaveAttribute("aria-pressed", "true");
});

test("thumbnail, async and cache failures fall back with explicit notices", async ({ page }) => {
  await waitForStudio(page);
  await page.locator("#fail-thumbnail").check();
  await expect(page.locator(".thumb.is-fallback")).toHaveCount(3);
  await expect(page.locator(".notice").filter({ hasText: "缩略图生成失败" })).toBeVisible();
  await expect(page.locator(".chart-svg-wrap svg")).toHaveCount(3);

  await page.locator("#fail-async").check();
  await page.locator("#refresh-scenario").click();
  await expect(page.locator(".notice").filter({ hasText: "异步请求失败" })).toBeVisible();
  await expect(page.locator(".chart-svg-wrap svg")).toHaveCount(3);

  await page.locator('[data-scenario="boundary"]').click();
  await expect(page.locator(".chart-card")).toHaveCount(3);
  await Promise.all([
    page.waitForEvent("load"),
    page.locator("#fail-cache").click()
  ]);
  await page.waitForFunction(() => window.__atlasReady === true);
  await expect(page.locator(".notice").filter({ hasText: "缓存不可用" })).toBeVisible();
  await expect(page.locator(".chart-card")).toHaveCount(3);
  await expect(page.locator(".chart-svg-wrap svg")).toHaveCount(3);
  expect(await page.evaluate(() => window.__atlas.getState().scenarioId)).toBe("default");
});
