// Drives the real UI through a full 20-switch run and captures the dashboard,
// proving the metrics/charts render with a live AudioContext in Chromium.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = process.env.CHROMIUM_PATH || undefined;

const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 1600 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto('http://127.0.0.1:4731/');
await page.selectOption('#mode-select', 'after');
await page.click('#start-btn');
await page.click('#loop-btn');
await page.waitForSelector('#report-output:has-text("标签")', { timeout: 30000 });
await page.waitForTimeout(400);
await page.screenshot({
  path: path.join(root, 'artifacts', 'dashboard-managed.png'),
  fullPage: true,
});

await page.click('#stop-btn');
await page.selectOption('#mode-select', 'before');
await page.click('#start-btn');
await page.click('#loop-btn');
await page.waitForTimeout(600);
await page.screenshot({
  path: path.join(root, 'artifacts', 'dashboard-naive.png'),
  fullPage: true,
});

console.log('screenshots written; page errors:', errors.length);
if (errors.length) {
  console.log(errors);
  process.exitCode = 1;
}
await browser.close();
