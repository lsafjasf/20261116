import { chromium } from 'playwright';
import path from 'node:path';

const browser = await chromium.launch({
  headless: true,
  executablePath: path.join(process.env.HOME, 'opt/chrome-deb/opt/google/chrome/google-chrome'),
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('console', (m) => console.log(`[${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const base = process.env.TEST_BASE_URL || `file://${path.join(ROOT, 'index.html')}`;
await page.goto(base.endsWith('/') ? base : `${base}/`);
await page.waitForTimeout(3000);
console.log('has game:', await page.evaluate(() => Boolean(window.__game)));
await browser.close();
