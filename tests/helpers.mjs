import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

export const PORT = Number(process.env.TEST_PORT) || (8200 + Math.floor(Math.random() * 800));
export const BASE = `http://127.0.0.1:${PORT}`;

export function startServer() {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 5000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('serving')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
}

export async function newPage() {
  const browser = await chromium.launch();
  return newContext(browser);
}

export async function newContext(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));
  return {
    browser,
    context,
    page,
    errors,
    async close() { await browser.close(); },
  };
}

export function assert(condition, message) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    throw new Error(`断言失败: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}

export async function freshGoto(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(200);
}

export async function waitForSaved(page, expectedCount, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const raw = await page.evaluate(() => localStorage.getItem(window.__app.storageKeys.STORAGE_KEY));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.state.elements.length === expectedCount) return parsed;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`等待 localStorage 落盘 ${expectedCount} 个元素超时`);
}

export async function resetStorage(page) {
  await page.evaluate(() => window.__app?.persistNow?.());
  await page.waitForTimeout(300); // 越过 250ms 防抖窗口，避免旧写入在清空后复活
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('kbd-drawing:'))
      .forEach((k) => localStorage.removeItem(k));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#stage');
  await page.waitForTimeout(100);
}
