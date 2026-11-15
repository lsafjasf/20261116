import { chromium } from 'playwright';
import path from 'node:path';
import { ROOT } from './helpers.js';

const browser = await chromium.launch({
  headless: true,
  executablePath: path.join(process.env.HOME, 'opt/chrome-deb/opt/google/chrome/google-chrome'),
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:8000/');
await page.waitForFunction(() => window.__game);
await page.evaluate(async () => {
  const game = window.__game;
  game.updateParams({ beats: 32 });
  await game.start();
  await new Promise((r) => setTimeout(r, 2500));
});
await page.screenshot({ path: path.join(ROOT, 'artifacts', 'gameplay.png') });
const hud = await page.locator('#hud').textContent();
await page.evaluate(() => window.__game.stop());
console.log('HUD during play:', hud);
await browser.close();
