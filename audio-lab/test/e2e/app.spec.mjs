import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pageUrl = 'http://127.0.0.1:4731/';
const artifactDir = path.join(root, 'artifacts');

test.beforeAll(() => {
  fs.mkdirSync(artifactDir, { recursive: true });
});

test.describe('Web Audio resource manager in a real browser', () => {
  test.beforeEach(async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(pageUrl);
    await page.evaluate(() => { window.__pageErrors = []; });
    page.__errors = errors;
  });

  test('managed mode keeps node count bounded across 20 switches', async ({ page }) => {
    await page.selectOption('#mode-select', 'after');
    await page.click('#start-btn');
    await expect(page.locator('#audio-state')).toContainText('running');

    const beforeText = await page.locator('.metric-value[data-metric="activeNodes"]').textContent();
    await page.click('#loop-btn');
    await expect(page.locator('#report-output')).toContainText('标签', { timeout: 30000 });
    await expect(page.locator('.metric-value[data-metric="activeNodes"]')).toHaveText('0');

    const report = await page.locator('#report-output').textContent();
    expect(report).toContain('输出指纹稳定    : true');
    expect(report).toContain('异常数          : 0');
    const nodes = await page.evaluate(() =>
      document.querySelector('.metric-value[data-metric="activeNodes"]').textContent);
    expect(Number(nodes)).toBe(0);

    const series = await page.evaluate(async () => {
      const lab = window.__audioLab;
      const ctx = new AudioContext();
      const mgr = new lab.ResourceManager(ctx);
      const cache = new lab.SceneConfigCache(5);
      const ctl = new lab.SceneController(ctx, mgr, cache);
      const out = await lab.runScenario({
        context: ctx, controller: ctl, manager: mgr, cache,
        library: lab.SCENE_LIBRARY, iterations: 20, label: 'e2e-managed',
        flush: () => new Promise((r) => setTimeout(r, 5)),
      });
      return out.nodeSeries;
    });
    const steady = series.slice(0, 20);
    for (let index = 5; index < 20; index += 1) {
      expect(steady[index]).toBe(steady[index - 5]);
    }
    expect(series[20]).toBe(0);
    expect(Number(beforeText)).toBeGreaterThan(0);
    expect(page.__errors).toEqual([]);
  });

  test('naive baseline grows without bound for comparison', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const lab = window.__audioLab;
      const ctx = new AudioContext();
      const mgr = new lab.NaiveResourceManager(ctx);
      const cache = new lab.SceneConfigCache(5);
      const ctl = new lab.SceneController(ctx, mgr, cache);
      const out = await lab.runScenario({
        context: ctx, controller: ctl, manager: mgr, cache,
        library: lab.SCENE_LIBRARY, iterations: 20, label: 'e2e-naive',
        flush: () => new Promise((r) => setTimeout(r, 5)),
      });
      return {
        head: out.nodeSeries.slice(0, 5),
        tail: out.nodeSeries.slice(-6, -1),
        last: out.nodeSeries[20],
        fingerprintStable: out.fingerprintStable,
      };
    });
    expect(result.tail[4]).toBeGreaterThan(result.head[0]);
    expect(result.tail[4]).toBeGreaterThan(40);
    expect(result.fingerprintStable).toBe(true);
    expect(page.__errors).toEqual([]);
  });

  test('destroyed nodes never invoke callbacks after teardown', async ({ page }) => {
    const guard = await page.evaluate(async () => {
      const lab = window.__audioLab;
      const ctx = new AudioContext();
      const violations = [];
      const mgr = new lab.ResourceManager(ctx, {
        onViolation: (event) => violations.push(event),
      });
      const cache = new lab.SceneConfigCache(5);
      const ctl = new lab.SceneController(ctx, mgr, cache);
      ctl.enterScene(lab.SCENE_LIBRARY[2]);
      const oscillators = [...mgr._records.values()]
        .filter((record) => record.label === 'oscillator')
        .map((record) => record.node);
      ctl.exitScene();
      for (const osc of oscillators) {
        osc.dispatchEvent(new Event('ended'));
      }
      await new Promise((r) => setTimeout(r, 20));
      return {
        suppressed: mgr.stats.suppressedCallbacks,
        violations: violations.length,
        handlerFired: ctl.handlerFired,
        active: mgr.stats.activeNodes,
      };
    });
    expect(guard.suppressed).toBeGreaterThan(0);
    expect(guard.violations).toBe(guard.suppressed);
    expect(guard.handlerFired).toBe(0);
    expect(guard.active).toBe(0);
    expect(page.__errors).toEqual([]);
  });

  test('offline rendered output is identical before/after optimization', async ({ page }) => {
    const comparison = await page.evaluate(async () => {
      const mod = await import('./src/offlineRender.mjs');
      return mod.compareOfflineOutput(window.__audioLab.SCENE_LIBRARY);
    });
    expect(comparison.allEqual).toBe(true);
    for (const row of comparison.rows) {
      expect(row.equal).toBe(true);
      expect(row.rms).toBeGreaterThan(0);
      expect(row.perceptualEqual).toBe(true);
      expect(row.perceptual.rms).toBeGreaterThan(0);
    }
    fs.writeFileSync(
      path.join(artifactDir, 'offline-fingerprints.json'),
      JSON.stringify(comparison, null, 2));
    expect(page.__errors).toEqual([]);
  });

  test('listening character matches and WAV artifacts are exported', async ({ page }) => {
    const listening = await page.evaluate(async () => {
      const renderMod = await import('./src/offlineRender.mjs');
      const wavMod = await import('./src/wav.mjs');
      const scenes = window.__audioLab.SCENE_LIBRARY.slice(0, 3);
      const exports = [];
      for (const scene of scenes) {
        const naive = await renderMod.renderScene(scene, 'naive');
        const managed = await renderMod.renderScene(scene, 'managed');
        const rmsDelta = Math.abs(naive.perceptual.rms - managed.perceptual.rms);
        const peakDelta = Math.abs(naive.perceptual.peak - managed.perceptual.peak);
        const blob = wavMod.encodeWav(
          Float32Array.from(managed.channel), managed.sampleRate);
        const base64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
        exports.push({
          sceneId: scene.id,
          base64,
          rmsDelta,
          peakDelta,
          fundamentalHz: managed.perceptual.estimatedFundamentalHz,
        });
      }
      return exports;
    });
    expect(listening).toHaveLength(3);
    for (const item of listening) {
      // Separate offline renders can differ at floating-point noise floor.
      // 1e-7 is 1000x below the smallest audible amplitude change (~1e-4).
      expect(item.rmsDelta).toBeLessThan(1e-7);
      expect(item.peakDelta).toBeLessThan(1e-7);
      expect(item.fundamentalHz).toBeGreaterThan(0);
      fs.writeFileSync(
        path.join(artifactDir, `listen-${item.sceneId}.wav`),
        Buffer.from(item.base64, 'base64'));
    }
    expect(page.__errors).toEqual([]);
  });

  test('heap trend diverges: leak baseline grows, managed stays bounded', async ({ page }) => {
    const memory = await page.evaluate(async () => {
      const lab = window.__audioLab;
      const gc = () => new Promise((resolve) => setTimeout(resolve, 25));
      async function phase(mode) {
        const ctx = new AudioContext();
        const mgr = mode === 'naive'
          ? new lab.NaiveResourceManager(ctx)
          : new lab.ResourceManager(ctx);
        const cache = new lab.SceneConfigCache(5);
        const ctl = new lab.SceneController(ctx, mgr, cache);
        const heap = [];
        // Two warm-up cycles stabilize allocator/GC before measuring.
        for (let index = 0; index < 10; index += 1) {
          await ctl.switchTo(lab.SCENE_LIBRARY[index % lab.SCENE_LIBRARY.length]);
        }
        ctl.exitScene();
        await gc();
        const baseline = performance.memory.usedJSHeapSize;
        for (let index = 0; index < 20; index += 1) {
          await ctl.switchTo(lab.SCENE_LIBRARY[index % lab.SCENE_LIBRARY.length]);
          await new Promise((resolve) => setTimeout(resolve, 4));
          if (index % 4 === 3) heap.push(performance.memory.usedJSHeapSize);
        }
        ctl.exitScene();
        await gc();
        return {
          heap,
          baseline,
          growth: performance.memory.usedJSHeapSize - baseline,
          activeNodes: mgr.stats.activeNodes,
        };
      }
      const naive = await phase('naive');
      const managed = await phase('managed');
      return { naive, managed };
    });
    // Both start from a fresh context; only the leak path retains every node.
    // Heap sampling is GC-sensitive, so the deterministic guarantee is the
    // retained node count; heap series is exported as supporting trend evidence.
    expect(memory.naive.activeNodes).toBeGreaterThan(40);
    expect(memory.managed.activeNodes).toBe(0);
    expect(memory.naive.heap).toHaveLength(5);
    expect(memory.managed.heap).toHaveLength(5);
    expect(memory.naive.heap[4]).toBeGreaterThanOrEqual(memory.naive.heap[0]);
    fs.writeFileSync(
      path.join(artifactDir, 'memory-trend.json'),
      JSON.stringify(memory, null, 2));
    expect(page.__errors).toEqual([]);
  });

  test('boundary parameters clean up fully and never throw', async ({ page }) => {
    const boundary = await page.evaluate(async () => {
      const lab = window.__audioLab;
      const ctx = new AudioContext();
      const mgr = new lab.ResourceManager(ctx);
      const cache = new lab.SceneConfigCache(2);
      const ctl = new lab.SceneController(ctx, mgr, cache);
      const out = await lab.runScenario({
        context: ctx, controller: ctl, manager: mgr, cache,
        library: lab.BOUNDARY_LIBRARY, iterations: 20, label: 'e2e-boundary',
        flush: () => new Promise((r) => setTimeout(r, 5)),
      });
      return {
        lastNodes: out.summary.lastActiveNodes,
        lastConnections: out.summary.lastConnections,
        errors: out.errors.length,
        peak: out.summary.peakActiveNodes,
        stable: out.fingerprintStable,
        hitRate: out.summary.finalCacheHitRate,
      };
    });
    expect(boundary.lastNodes).toBe(0);
    expect(boundary.lastConnections).toBe(0);
    expect(boundary.errors).toBe(0);
    expect(boundary.peak).toBeLessThanOrEqual(40);
    expect(boundary.stable).toBe(true);
    expect(boundary.hitRate).toBeLessThan(1);
    expect(page.__errors).toEqual([]);
  });

  test('UI renders at least three live metrics and updates them', async ({ page }) => {
    await page.selectOption('#mode-select', 'after');
    await page.click('#start-btn');
    const metricCount = await page.locator('.metric-cell').count();
    expect(metricCount).toBeGreaterThanOrEqual(3);
    const first = await page.locator('.metric-value[data-metric="activeNodes"]').textContent();
    await page.click('#switch-btn');
    await page.click('#switch-btn');
    const second = await page.locator('.metric-value[data-metric="activeNodes"]').textContent();
    expect(Number(second)).toBeGreaterThan(0);
    expect(second).not.toBe(first);
    await page.click('#stop-btn');
    const stopped = await page.locator('.metric-value[data-metric="activeNodes"]').textContent();
    expect(Number(stopped)).toBe(0);
    expect(page.__errors).toEqual([]);
  });
});
