import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

const ROOT = join(import.meta.dirname, '..');
const ART = join(ROOT, 'artifacts');
mkdirSync(ART, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = req.url.split('?')[0];
    const file = urlPath === '/' ? '/index.html' : urlPath;
    const data = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__fogApp, { timeout: 10000 });

// 1) 暂停并保存当前帧截图（暂停截图对照）
await page.evaluate(() => window.__fogApp.pause());
await page.waitForTimeout(150);
await page.screenshot({ path: join(ART, '01-paused-frame.png') });

// 2) 通过页面按钮运行完整测试套件，确保结果真实渲染进页面表格
await page.click('#btn-test');
await page.waitForFunction(
  () => window.__lastSummary && document.querySelector('#test-progress').textContent === '完成',
  { timeout: 60000 });
const summary = await page.evaluate(() => window.__lastSummary);
await page.waitForTimeout(300);
await page.screenshot({ path: join(ART, '02-test-results.png'), fullPage: true });

// 3) 三组天气预设的独立截图
for (const id of ['clear', 'humid', 'storm']) {
  await page.evaluate((pid) => {
    const app = window.__fogApp;
    app.set({ quality: 'high', ...window.__presetPatches[pid] }, 'e2e');
    app.pause();
    app.renderOnce();
  }, id);
  await page.waitForTimeout(120);
  await page.screenshot({ path: join(ART, `preset-${id}.png`) });
}

// 4) 高/低质量档对照截图
await page.evaluate(() => {
  const app = window.__fogApp;
  app.set({ quality: 'high' }, 'e2e');
  app.renderOnce();
});
await page.waitForTimeout(120);
await page.screenshot({ path: join(ART, 'quality-high.png') });
await page.evaluate(() => {
  const app = window.__fogApp;
  app.set({ quality: 'low' }, 'e2e');
  app.renderOnce();
});
await page.waitForTimeout(120);
await page.screenshot({ path: join(ART, 'quality-low.png') });

// 5) 导出 PNG 链路验证
const dataUrlLen = await page.evaluate(() => window.__fogApp.exportPNG('e2e-export.png'));

// 6) 快照保存/恢复验证
const restoreInfo = await page.evaluate(() => {
  const app = window.__fogApp;
  const snap = app.saveSnapshot();
  app.set({ windSpeed: 25, humidity: 0.9 }, 'e2e');
  const before = { ...app.store.state };
  const ret = app.restoreSnapshot(snap);
  return {
    restoredWind: app.store.state.windSpeed,
    restoredHum: app.store.state.humidity,
    changedRegions: ret.changedRegions,
    beforeWind: before.windSpeed,
  };
});

const tableText = await page.locator('#test-table').innerText();
const verdictText = await page.locator('#verdict').innerText();
const stateText = await page.locator('#state-dump').innerText();
const regionText = await page.locator('#region-table').innerText();

const report = {
  summary: {
    ...summary,
    presets: summary.presets.map((p) => ({
      id: p.id, label: p.label,
      hash: p.hash, maskHash: p.maskHash,
    })),
  },
  consoleErrors,
  dataUrlLength: dataUrlLen,
  restoreInfo,
  verdict: verdictText,
  stateDump: stateText,
  regionLog: regionText,
  tableText,
};
writeFileSync(join(ART, 'e2e-report.json'), JSON.stringify(report, null, 2));

console.log(JSON.stringify({
  passed: summary.passed,
  total: summary.total,
  failed: summary.failed,
  silhouetteDriftPct: +(summary.silhouetteDrift * 100).toFixed(4),
  objectsHigh: summary.objectsHigh,
  objectsLow: summary.objectsLow,
  consoleErrors: consoleErrors.length,
  restoreInfo,
}, null, 2));

await browser.close();
server.close();
if (summary.failed > 0 || consoleErrors.length > 0) process.exit(1);
