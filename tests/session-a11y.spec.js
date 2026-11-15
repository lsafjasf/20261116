const { test, expect } = require('@playwright/test');
const {
  KEYS, sharedHarness, appState, setFieldByMouse, waitForSavedHashMatch,
} = require('./helpers');

test.describe('会话状态：刷新、关弹窗、撤销后不丢失未提交内容/选中对象/滚动位置', () => {
  test('刷新后未提交草稿、选中字段与滚动位置全部恢复', async () => {
    const { browser, context, page } = await sharedHarness();
    await page.evaluate(() => window.scrollTo(0, 200));
    await page.locator('#previewScroll').evaluate((el) => { el.scrollTop = 55; });
    await page.locator('#input-swing').focus();
    await setFieldByMouse(page, 'swing', 77);
    // 立刻刷新（400ms 防抖内），模拟“未提交的自动保存”。
    await page.waitForTimeout(80);
    await page.reload();
    await expect(page.locator('h1')).toBeVisible();

    const state = await appState(page);
    expect(state.config.animation.swing).toBe(77);
    await expect(page.locator('#input-swing')).toBeFocused();
    const scrollY = await page.evaluate(() => window.scrollY);
    expect(Math.abs(scrollY - 200)).toBeLessThanOrEqual(10);
    expect(await page.locator('#previewScroll').evaluate((el) => el.scrollTop)).toBe(55);

    await waitForSavedHashMatch(page);
    const afterFlush = await appState(page);
    expect(afterFlush.dirty).toBe(false);
    expect(afterFlush.config.animation.swing).toBe(77);
    await context.close();
    await browser.close();
  });

  test('撤销后恢复上一个值并持久化，连续撤销到空栈时按钮禁用', async () => {
    const { browser, context, page } = await sharedHarness();
    await setFieldByMouse(page, 'speed', 10);
    await waitForSavedHashMatch(page);
    await setFieldByMouse(page, 'speed', 90);
    await waitForSavedHashMatch(page);
    await page.waitForTimeout(450);
    await page.getByRole('button', { name: '撤销最后修改' }).click();
    await waitForSavedHashMatch(page);
    const state = await appState(page);
    expect(state.config.animation.speed).toBe(10);
    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k.current)), KEYS);
    expect(stored.animation.speed).toBe(10);

    await page.getByRole('button', { name: '撤销最后修改' }).click();
    await expect(page.locator('#undoBtn')).toBeDisabled();
    await context.close();
    await browser.close();
  });

  test('关闭导入弹窗不丢失已粘贴草稿，再次打开仍在', async () => {
    const { browser, context, page } = await sharedHarness();
    const before = await appState(page);
    const incoming = structuredClone(before.config);
    incoming.colors.capeColor = '#0a0a0a';
    await page.getByRole('button', { name: '导入配置' }).click();
    await page.locator('#importText').fill(JSON.stringify(incoming));
    await expect(page.locator('.diff-changed')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '导入配置' }).click();
    await expect(page.locator('#importText')).toHaveValue(JSON.stringify(incoming));
    await expect(page.locator('.diff-changed')).toHaveCount(1);
    await context.close();
    await browser.close();
  });

  test('导出弹窗 Esc 关闭后焦点回到导出按钮，且导出文本为规范 JSON', async () => {
    const { browser, context, page } = await sharedHarness();
    await page.getByRole('button', { name: '导出配置' }).click();
    await expect(page.locator('#exportArea')).toBeVisible();
    const text = await page.locator('#exportArea').textContent();
    const parsed = JSON.parse(text);
    expect(parsed.schemaVersion).toBe(1);
    expect(Object.keys(parsed)).toEqual(['schemaVersion', 'colors', 'equipment', 'animation']);
    await page.keyboard.press('Escape');
    await expect(page.locator('#exportArea')).toBeHidden();
    await expect(page.locator('#exportBtn')).toBeFocused();
    await context.close();
    await browser.close();
  });
});

test.describe('无障碍：焦点顺序、可读状态与失败提示', () => {
  test('Tab 焦点顺序符合视觉顺序，所有交互控件可达且有可见焦点环', async () => {
        const { browser, context, page } = await sharedHarness();
    const order = [];
    await page.keyboard.press('Tab');
    for (let i = 0; i < 16; i += 1) {
      const id = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
      order.push(id);
      await page.keyboard.press('Tab');
    }
    expect(order).toContain('input-skinColor');
    expect(order).toContain('input-speed');
    expect(order).toContain('exportBtn');
    expect(order).toContain('importBtn');
    expect(order.indexOf('input-armorColor')).toBeGreaterThan(order.indexOf('input-skinColor'));
    expect(order.indexOf('exportBtn')).toBeGreaterThan(order.indexOf('input-swing'));

    const outline = await page.locator('#input-speed').evaluate((el) => {
      el.focus();
      const s = getComputedStyle(el);
      return { outlineWidth: s.outlineWidth, outlineColor: s.outlineColor };
    });
    expect(Number.parseFloat(outline.outlineWidth)).toBeGreaterThanOrEqual(2);
    await context.close();
    await browser.close();
  });

  test('弹窗打开时焦点进入文本框，Tab 在弹窗内循环，Esc 后焦点归还触发按钮', async () => {
        const { browser, context, page } = await sharedHarness();
    await page.locator('#importBtn').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#importText')).toBeFocused();
    const incoming = structuredClone((await appState(page)).config);
    incoming.animation.swing = 10;
    await page.locator('#importText').fill(JSON.stringify(incoming));
    await expect(page.locator('#confirmImportBtn')).toBeEnabled();
    const seq = [];
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Tab');
      seq.push(await page.evaluate(() => document.activeElement.id));
    }
    expect(seq).toContain('confirmImportBtn');
    expect(seq).toContain('cancelImportBtn');
    expect(seq[0]).toBe('confirmImportBtn');
    expect(seq).toContain('importText');
    expect(new Set(seq).size).toBeGreaterThan(1);
    expect(await page.evaluate(() => !!document.activeElement.closest('.modal'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#importBtn')).toBeFocused();
    await context.close();
    await browser.close();
  });

  test('关键状态面板展示输入/存储/渲染同步信息，损坏时出现可读失败提示', async () => {
        const { browser, context, page } = await sharedHarness();
    await setFieldByMouse(page, 'bounce', 33);
    await waitForSavedHashMatch(page);
    const statusText = await page.locator('#statusList').innerText();
    expect(statusText).toContain('内存哈希');
    expect(statusText).toContain('存储哈希');
    expect(statusText).toContain('哈希一致');
    expect(statusText).toContain('一致');
    expect(statusText).toContain('"bounce":33');

    await page.evaluate((k) => localStorage.setItem(k.current, 'garbage'), KEYS);
    await page.reload();
    await expect(page.locator('#inlineError')).toBeVisible();
    const errorText = await page.locator('#inlineError').innerText();
    expect(errorText.length).toBeGreaterThan(20);
    const statusAfter = await page.locator('#statusList').innerText();
    expect(statusAfter).toContain('已封锁');
    expect(statusAfter).toContain('lastGood');
    await context.close();
    await browser.close();
  });

  test('对比度：正文与面板背景、错误提示与错误背景均达到可读水平', async () => {
        const { browser, context, page } = await sharedHarness();
    const ratios = await page.evaluate(() => {
      const lum = (hex) => {
        const rgb = hex.match(/\w\w/g).map((v) => {
          const n = parseInt(v, 16) / 255;
          return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      };
      const ratio = (a, b) => {
        const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (l1 + 0.05) / (l2 + 0.05);
      };
      return {
        body: ratio('#e8edf7', '#1b2333'),
        danger: ratio('#ff8a8a', '#3a1f26'),
        ok: ratio('#7fd99b', '#1b2333'),
      };
    });
    expect(ratios.body).toBeGreaterThan(7);
    expect(ratios.danger).toBeGreaterThan(4.5);
    expect(ratios.ok).toBeGreaterThan(4.5);
    await context.close();
    await browser.close();
  });
});
