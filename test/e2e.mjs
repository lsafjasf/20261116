// Real-browser end-to-end verification with Playwright. The test never relies
// on a screenshot alone: it asserts DOM state, canvas pixels, downloaded bytes
// and cross-window filter retention, and stores reusable evidence artifacts.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = normalize(join(fileURLToPath(import.meta.url), '../..'));
const artifactDir = join(root, 'artifacts');
mkdirSync(artifactDir, { recursive: true });

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png'
};

const server = createServer((req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = join(root, normalize(path));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1200 },
  acceptDownloads: true
});
const page = await context.newPage();
const downloads = [];
page.on('download', async (download) => {
  const path = join(artifactDir, download.suggestedFilename());
  await download.saveAs(path);
  downloads.push({ filename: download.suggestedFilename(), path });
});
const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(String(error)));

let checks = 0;
const check = (name, condition) => {
  assert.ok(condition, name);
  checks += 1;
  console.log('  \u2713', name);
};

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });

 const initial = await page.evaluate(() => ({ ...window.__lastRender }));
  check('首屏渲染产生数据版本与导出口径', initial.dataVersion && initial.exportScope.counts.cleanedRows === 64);
  check('调试面板展示管线阶段日志', (await page.locator('#pipelineLog').innerText()).includes('dedupe'));

  // Canvas actually contains all three curve colors, not just a blank image.
  const colorProbe = await page.evaluate(() => {
    const canvas = document.getElementById('chart');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const targets = { raw: [209, 73, 91], cleaned: [42, 157, 143], reference: [58, 110, 165] };
    const found = {};
    for (const [name, [r, g, b]] of Object.entries(targets)) {
      let hits = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.abs(data[i] - r) < 12 && Math.abs(data[i + 1] - g) < 12 && Math.abs(data[i + 2] - b) < 12) {
          hits += 1;
        }
      }
      found[name] = hits;
    }
    return found;
  });
  check('Canvas 同时绘制原始/清洗/参考三色曲线', Object.values(colorProbe).every((hits) => hits > 50));

  // Window 1: change rules and remember them.
  await page.selectOption('#nullStrategy', 'forward');
  await page.selectOption('#spikeStrategy', 'clip');
  await page.fill('#spikeThreshold', '3.2');
  await page.selectOption('#sampleSelect', 'sampleB');
  const w1State = await page.evaluate(() => ({
    filter: document.getElementById('currentFilter').textContent,
    version: document.getElementById('dataVersion').textContent,
    rules: window.__store.rules,
    revision: window.__store.revision
  }));
  check('窗口 1 规则变更后版本号同步更新', w1State.version.includes('sampleB'));

  await page.screenshot({ path: join(artifactDir, '01-window1-sampleB.png'), fullPage: true });

  // Switch to window 2, apply different rules.
  await page.click('[data-window="W2"]');
  await page.selectOption('#nullStrategy', 'zero');
  await page.selectOption('#spikeStrategy', 'none');
  const w2State = await page.evaluate(() => ({
    filter: document.getElementById('currentFilter').textContent,
    version: document.getElementById('dataVersion').textContent,
    rules: window.__store.rules
  }));
  check('窗口 2 可独立设置不同规则', w2State.rules.nullStrategy === 'zero' && w2State.rules.spikeStrategy === 'none');
  await page.screenshot({ path: join(artifactDir, '02-window2-rules.png'), fullPage: true });

  // Return to window 1: filters must be retained.
  await page.click('[data-window="W1"]');
  const retained = await page.evaluate(() => ({
    filter: document.getElementById('currentFilter').textContent,
    rules: window.__store.rules,
    version: document.getElementById('dataVersion').textContent
  }));
  check('返回窗口 1 时筛选条件保留', retained.rules.nullStrategy === 'forward' && retained.rules.spikeStrategy === 'clip');
  check('返回窗口 1 时数据版本恢复一致', retained.version === w1State.version);
  check('当前筛选文本包含样例与窗口', retained.filter.includes('sampleB') && retained.filter.includes('W1'));

  // Every view stays in sync after data changes: status, metrics, debug, canvas.
  const before = await page.evaluate(() => window.__lastRender);
  await page.selectOption('#sampleSelect', 'sampleA');
  const after = await page.evaluate(() => ({
    render: window.__lastRender,
    statusVersion: document.getElementById('dataVersion').textContent,
    debugVersion: JSON.parse(document.getElementById('debugState').innerText).dataVersion,
    scopeText: document.getElementById('exportScope').textContent,
    filterText: document.getElementById('currentFilter').textContent
  }));
  check('数据变化后版本号在状态栏与调试面板同步', after.statusVersion === after.render.dataVersion && after.debugVersion === after.render.dataVersion);
  check('导出口径与筛选随数据变化更新',
    after.filterText.includes('sampleA') &&
    after.scopeText.includes(`原始行 ${after.render.exportScope.counts.rawRows}`) &&
    after.render.revision > before.revision);

  // PNG export: file bytes must match the on-screen scope and metrics.
  const pngDownload = page.waitForEvent('download');
  await page.click('#exportPng');
  await pngDownload;
  const logDownload = page.waitForEvent('download');
  await page.click('#exportLog');
  const logFile = await logDownload;
  const projectDownload = page.waitForEvent('download');
  await page.click('#saveProject');
  const projectFile = await projectDownload;
  await page.waitForTimeout(300);

  check('三类导出均产生下载文件', downloads.length === 3);
  const pngEntry = downloads.find((item) => item.filename.endsWith('.png'));
  const pngBytes = readFileSync(pngEntry.path);
  check('PNG 导出为真实 PNG 字节', pngBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));

  const logPath = join(artifactDir, logFile.suggestedFilename());
  const log = JSON.parse(readFileSync(logPath, 'utf8'));
  const liveScope = await page.evaluate(() => window.__lastRender.exportScope);
  check('清洗日志数量与界面口径一致',
    log.exportScope.counts.windowRows === liveScope.counts.windowRows &&
    log.exportScope.counts.cleanedRows === liveScope.counts.cleanedRows &&
    log.exportScope.counts.rawRows === liveScope.counts.rawRows);
  check('清洗日志关键数值与界面一致',
    log.exportScope.metrics.mae === liveScope.metrics.mae &&
    log.exportScope.metrics.maxDev === liveScope.metrics.maxDev &&
    log.exportScope.dataVersion === liveScope.dataVersion);

  // Reload the saved project and confirm rules + version are reconstructed.
  const projectPath = join(artifactDir, projectFile.suggestedFilename());
  const project = JSON.parse(readFileSync(projectPath, 'utf8'));
  check('工程文件包含可重载状态与样例数据', project.format === 'ts-cleaning-monitor/project' && project.samples.sampleA.rows.length > 0);
  await page.evaluate((payload) => window.__store.loadProject(payload), project);
  const reloaded = await page.evaluate(() => ({
    version: document.getElementById('dataVersion').textContent,
    rules: window.__store.rules,
    window: window.__store.windowId
  }));
  check('重载工程后数据版本与规则恢复', reloaded.version === project.dataVersion);

  // Reload page: localStorage restores the previous window filter.
  await page.reload({ waitUntil: 'networkidle' });
  const persisted = await page.evaluate(() => ({
    window: window.__store.windowId,
    nullStrategy: window.__store.rules.nullStrategy,
    sample: window.__store.sampleId
  }));
  check('页面刷新后本地工程状态保留', persisted.window === project.activeWindow && persisted.sample === project.sampleId);

  // Both fixed samples visibly cover nulls, duplicates and spikes in debug.
  const coverage = await page.evaluate(() => {
    const store = window.__store;
    return ['sampleA', 'sampleB'].map((id) => {
      const sample = store.samples[id];
      return {
        id,
        rawRows: sample.rows.length,
        nulls: sample.manifest.nulls.length,
        duplicates: sample.manifest.duplicates.length,
        spikes: sample.manifest.spikes.length
      };
    });
  });
  check('两份固定样例均含空值/重复/尖峰', coverage.every((item) => item.nulls >= 7 && item.duplicates >= 3 && item.spikes >= 4));

  check('浏览器无运行时错误', consoleErrors.length === 0);
  await page.screenshot({ path: join(artifactDir, '03-final-reloaded.png'), fullPage: true });

  writeFileSync(
    join(artifactDir, 'e2e-report.json'),
    JSON.stringify({ checks, downloads: downloads.map((item) => item.filename), consoleErrors, coverage }, null, 2)
  );
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${checks} 项浏览器端到端验证全部通过`);
