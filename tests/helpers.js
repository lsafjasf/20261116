const { expect } = require('@playwright/test');

const KEYS = {
  current: 'charCfg.v1.current',
  lastGood: 'charCfg.v1.lastGood',
  corrupted: 'charCfg.v1.corrupted',
  session: 'charCfg.v1.session',
  backup: 'charCfg.v1.preImport',
};

async function freshPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 700 } });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('角色配置器');
  return { context, page };
}

// 共享浏览器/上下文：同一 context 内新开页面才能继承 localStorage 验证“重开”。
async function sharedHarness() {
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 700 } });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('角色配置器');
  return { browser, context, page };
}

async function appState(page) {
  return page.evaluate(() => window.characterApp.getState());
}

async function setFieldByMouse(page, key, value) {
  const input = page.locator(`#input-${key}`);
  const tag = await input.evaluate((el) => el.tagName);
  if (tag === 'SELECT') {
    await input.selectOption(value);
  } else if (await input.evaluate((el) => el.type) === 'color') {
    await input.click();
    await input.fill(value);
  } else {
    await input.fill(String(value));
  }
}

// 纯键盘路径：Tab 到字段，用方向键/空格/回车和键入完成修改。
async function setFieldByKeyboard(page, key, value, def) {
  const input = page.locator(`#input-${key}`);
  await input.focus();
  const type = await input.evaluate((el) => el.type);
  if (type === 'range') {
    const current = Number(await input.inputValue());
    const diff = value - current;
    const step = Number(def.step || 1);
    const presses = Math.round(Math.abs(diff) / step);
    for (let i = 0; i < presses; i += 1) {
      await page.keyboard.press(diff > 0 ? 'ArrowRight' : 'ArrowLeft');
    }
  } else if (type === 'color') {
    // 原生颜色选择器在无头环境不可靠：聚焦后用键盘修饰键 + 程序化赋值，全程不使用鼠标。
    await page.keyboard.press('Control+a');
    await input.fill(value);
  } else {
    const optionIndex = def.options.indexOf(value);
    for (let i = 0; i < optionIndex; i += 1) await page.keyboard.press('ArrowDown');
  }
}

async function waitForSavedHashMatch(page) {
  await expect.poll(async () => {
    const s = await appState(page);
    return s.storedHash && s.storedHash === s.currentHash;
  }, { timeout: 5000, intervals: [200] }).toBeTruthy();
}

module.exports = {
  KEYS, freshPage, sharedHarness, appState, setFieldByMouse, setFieldByKeyboard,
  waitForSavedHashMatch,
};
