import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
const CHROME = path.join(
  process.env.HOME, 'opt/chrome-deb/opt/google/chrome/google-chrome',
);

export async function newPage() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.addInitScript((fn) => {
    window.__startAutoplay = eval(`(${fn})`);
  }, startAutoplay.toString());
  page.on('pageerror', (err) => {
    process.stdout.write(`PAGEERROR: ${err.message}\n`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') process.stdout.write(`CONSOLE: ${msg.text()}\n`);
  });
  const base = process.env.TEST_BASE_URL || `file://${path.join(ROOT, 'index.html')}`;
  await page.goto(base.endsWith('/') ? base : `${base}/`);
  await page.waitForFunction(() => window.__game !== undefined);
  return { browser, context, page };
}

// Run one chart to completion with automated hits. Returns final result.
export async function playFullGame(page, { offsetMs = 0, difficulty = 'normal', beats = 24 } = {}) {
  await page.evaluate(async ({ offsetMs, difficulty, beats }) => {
    const game = window.__game;
    game.updateParams({ difficulty, beats, offsetMs });
    await game.start();
    window.__startAutoplay(game);
  }, { offsetMs, difficulty, beats });

  await page.waitForFunction(() => window.__game.state === 'finished', null, { timeout: 60000 });
  await page.evaluate(() => clearInterval(window.__game._autoplayTimer));
  return page.evaluate(() => window.__game.result());
}

// Polling autoplay: arm only notes within the next window so lead-in and
// timing offsets never produce negative setTimeout delays.
export function startAutoplay(game, jitterMs = 0) {
  const timer = setInterval(() => {
    if (game.state !== 'running') return;
    const now = game.songTime;
    for (const note of game.chart.notes) {
      if (note.judged || note._armed) continue;
      const waitSec = note.time - now - game.offsetSec;
      if (waitSec <= 0.25) {
        note._armed = true;
        const jitter = jitterMs ? (Math.random() - 0.5) * jitterMs : 0;
        setTimeout(() => game.simulateLane(note.lane), Math.max(0, waitSec * 1000 + jitter));
      }
    }
  }, 40);
  game._autoplayTimer = timer;
  return timer;
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERT FAILED: ${message}`);
  }
}
