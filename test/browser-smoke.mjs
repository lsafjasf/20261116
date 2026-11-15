import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer';

const root = join(import.meta.dirname, '..');
const MIME = { '.html': 'text/html', '.mjs': 'text/javascript',
  '.json': 'application/json', '.js': 'text/javascript' };

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'text/plain' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  headless: 'shell',
  executablePath: `${process.env.HOME}/.cache/puppeteer/chrome-headless-shell/157.0.8103.50/chrome-headless-shell-linux64/chrome-headless-shell`,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle0' });
await page.waitForSelector('#status');

const probe = () => page.evaluate(() => {
  const status = document.querySelector('#status').textContent;
  const dbg = window.__DEBUG__ ?? [];
  const last = dbg[dbg.length - 1]?.detail ?? {};
  return { status, lastEvent: last.reason, cursor: last.cursorHour,
    gapCount: last.gapCount, peakCount: last.peakCount, debugEvents: dbg.length };
});

const observations = [];

// 窗口 1：A / AM，拖动游标到 6（S1 温度缺测）
await page.select('#datasetSel', 'A');
await page.select('#windowSel', 'AM');
await page.evaluate(() => {
  const r = document.querySelector('#cursorRange');
  r.value = 6;
  r.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForFunction(() => window.__DEBUG__?.length > 2);
observations.push({ step: 'A/AM cursor=6', ...(await probe()) });
await page.screenshot({ path: 'artifacts/browser-A-AM.png' });

// 窗口 2：B / Q4，游标 21，隐藏 S3，再导出
await page.select('#datasetSel', 'B');
await page.select('#windowSel', 'Q4');
await page.evaluate(() => {
  const r = document.querySelector('#cursorRange');
  r.value = 21;
  r.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('input[data-station="S3"]');
await page.waitForFunction(() =>
  document.querySelector('#status').textContent.includes('Q4'));
observations.push({ step: 'B/Q4 cursor=21 hide S3', ...(await probe()) });

const exportInfo = await page.evaluate(async () => new Promise((resolve) => {
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (blob) => {
    blob.text().then((text) => resolve({ text }));
    return origCreate.call(URL, blob);
  };
  document.querySelector('#exportBtn').click();
}));
const report = JSON.parse(exportInfo.text);
observations.push({ step: 'export report',
  objectCount: report.integrity.objectCount, checksum: report.integrity.checksum,
  selectedStations: report.filters.selectedStations, slotCount: report.integrity.slotCount });

// 保存工程并重新载入
const projectInfo = await page.evaluate(() => new Promise((resolve) => {
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (blob) => {
    blob.text().then((text) => resolve({ text }));
    return origCreate.call(URL, blob);
  };
  document.querySelector('#saveBtn').click();
}));
const projectText = projectInfo.text;
observations.push({ step: 'save project',
  project: JSON.parse(projectText).state });

// 通过真实文件选择器载入刚保存的工程，核对状态恢复
const reloadPath = join(root, 'artifacts/reload-project.json');
await writeFile(reloadPath, projectText);
const fileInput = await page.$('#loadFile');
await fileInput.uploadFile(reloadPath);
await page.waitForFunction(() =>
  document.querySelector('#status').textContent.includes('Q4'));
observations.push({ step: 'reload project', ...(await probe()) });

await page.screenshot({ path: 'artifacts/browser-B-Q4.png' });

console.log(JSON.stringify({ observations, pageErrors: errors }, null, 2));
await browser.close();
server.close();
if (errors.length > 0) process.exit(1);
