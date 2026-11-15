const { chromium } = require('/tmp/node_modules/playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'bridge');
const MIME = { '.html': 'text/html', '.js': 'application/javascript',
  '.json': 'application/json' };

const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') {
    res.writeHead(204); return res.end();
  }
  const file = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
});

(async () => {
  await new Promise(r => server.listen(8791, r));
  const exe = require('os').homedir() +
    '/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';
  const browser = await chromium.launch({ executablePath: exe,
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (m.type() === 'error' && !m.text().includes('favicon.ico')) errors.push(m.text());
  });
  page.on('requestfailed', r => errors.push('REQFAIL ' + r.url()));
  page.on('response', r => {
    if (r.status() >= 400) errors.push('HTTP' + r.status() + ' ' + r.url());
  });
  await page.goto('http://127.0.0.1:8791/');
  await page.waitForTimeout(800);

  const clock1 = await page.textContent('#clock');
  await page.click('#btnPause');
  const pausedClock = await page.textContent('#clock');
  await page.waitForTimeout(400);
  const stillPaused = await page.textContent('#clock');
  if (pausedClock !== stillPaused) throw new Error('暂停后时钟仍在前进');
  await page.click('#btnStep');
  const stepped = await page.textContent('#clock');
  if (parseFloat(stepped) - parseFloat(pausedClock) < 0.05) {
    throw new Error('单步没有推进固定步长');
  }
  await page.click('#btnResume');

  await page.selectOption('#scenario', 'overlimit');
  await page.click('#btnLoad');
  await page.waitForFunction(() =>
    document.getElementById('clock').textContent === '4.0', null, { timeout: 8000 });
  await page.waitForTimeout(300);
  const rejectCount = await page.$$eval('#log .tag.reject', els => els.length);
  if (rejectCount < 3) throw new Error('越限命令拒绝数量不足: ' + rejectCount);

  await page.selectOption('#scenario', 'wrongReinforce');
  await page.click('#btnLoad');
  await page.waitForFunction(() =>
    document.getElementById('statusPill').textContent.includes('失稳失败'),
    null, { timeout: 20000 });
  const failClock = await page.textContent('#clock');
  await page.click('#btnReplay');
  await page.waitForTimeout(500);
  const replayClock = await page.textContent('#clock');
  await page.waitForFunction(() =>
    document.getElementById('statusPill').textContent.includes('失稳失败'),
    null, { timeout: 12000 });

  const pixel = await page.evaluate(() => {
    const c = document.getElementById('scene');
    const g = c.getContext('2d');
    const d = g.getImageData(c.width / 2, c.height / 2, 1, 1).data;
    return Array.from(d);
  });
  if (errors.length) throw new Error('页面错误: ' + errors.join(' | '));
  const result = { runningClock: clock1, pausedClock, steppedClock: stepped,
    overlimitRejects: rejectCount,
    failClock, replayClockAfter500ms: replayClock, canvasCenterPixel: pixel };
  fs.writeFileSync(path.join(__dirname, '..', 'artifacts', 'browser-smoke.json'),
    JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  server.close();
})().catch(e => { console.error(e); process.exit(1); });
