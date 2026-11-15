import { expect } from '@playwright/test';

export const STORAGE_KEY = 'focus-creator:v1';
export const LAST_GOOD_KEY = 'focus-creator:last-good';

export async function freshContext(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (err) => {
    throw new Error(`页面未捕获异常: ${err.message}`);
  });
  await page.goto('/');
  await expect(page.locator('#canvas')).toBeVisible();
  return { context, page };
}

export async function appState(page) {
  return page.evaluate(() => ({
    doc: globalThis.__app.doc,
    ui: globalThis.__app.ui,
    past: globalThis.__app.history.past.length,
    future: globalThis.__app.history.future.length,
  }));
}

export async function activeId(page) {
  return page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || 'none');
}

export async function statusDl(page, dlId) {
  return page.evaluate((id) => {
    const out = {};
    const dl = document.getElementById(id);
    const dts = dl.querySelectorAll('dt');
    const dds = dl.querySelectorAll('dd');
    dts.forEach((dt, i) => { out[dt.textContent] = dds[i].textContent; });
    return out;
  }, dlId);
}

export async function waitSaved(page) {
  await expect.poll(async () => {
    const s = await statusDl(page, 'st-storage');
    return s['存储状态'];
  }, { timeout: 5000 }).toBe('正常');
}
