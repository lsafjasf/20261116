const { test, expect } = require('@playwright/test');
const {
  KEYS, sharedHarness, appState, setFieldByMouse, setFieldByKeyboard, waitForSavedHashMatch,
} = require('./helpers');
const { FIELD_DEFS } = require('../src/storage.cjs');

const def = (key) => FIELD_DEFS.find((d) => d.key === key);

test.describe('路径一：正常修改后重开保持原状（鼠标 + 键盘各一遍）', () => {
  const mouseEdits = [
    ['armorColor', '#2e8b57'],
    ['weapon', 'staff'],
    ['speed', 72],
  ];
  const keyboardEdits = [
    ['capeColor', '#123456'],
    ['helmet', 'heavy'],
    ['bounce', 25],
  ];

  for (const [mode, edits] of [['鼠标', mouseEdits], ['键盘', keyboardEdits]]) {
    test(`用${mode}完成修改并在新标签页重开后保持原状`, async () => {
      const { browser, context, page } = await sharedHarness();
      for (const [key, value] of edits) {
        if (mode === '鼠标') await setFieldByMouse(page, key, value);
        else await setFieldByKeyboard(page, key, value, def(key));
      }
      await waitForSavedHashMatch(page);
      const before = await appState(page);
      for (const [key, value] of edits) {
        expect(before.config[def(key).group][key]).toBe(value);
      }

      const page2 = await context.newPage();
      await page2.goto('/');
      const after = await page2.evaluate(() => window.characterApp.getState());
      expect(after.source).toBe('current');
      expect(after.config).toEqual(before.config);
      expect(after.currentHash).toBe(before.currentHash);
      expect(after.storedHash).toBe(before.storedHash);
      expect(after.saveBlocked).toBe(false);
      await context.close();
      await browser.close();
    });
  }

  test('导出的配置哈希稳定：同一配置重复导出与跨页面计算结果一致', async () => {
    const { browser, context, page } = await sharedHarness();
    await setFieldByMouse(page, 'swing', 64);
    await waitForSavedHashMatch(page);
    const hashes = await page.evaluate(async () => {
      const cfg = window.characterApp.getState().config;
      return [
        await window.characterApp.hashConfig(cfg),
        await window.characterApp.hashConfig(cfg),
      ];
    });
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    const page2 = await context.newPage();
    await page2.goto('/');
    const reloaded = await page2.evaluate(() => window.characterApp.getState());
    expect(reloaded.currentHash).toBe(hashes[0]);
    await context.close();
    await browser.close();
  });
});

test.describe('路径二：导入另一份配置，预览差异、确认覆盖并可回滚', () => {
  test('鼠标完成导入：差异行数正确，覆盖后哈希改变，回滚后恢复', async () => {
        const { browser, context, page } = await sharedHarness();
    const before = await appState(page);

    const incoming = structuredClone(before.config);
    incoming.colors.armorColor = '#ff8800';
    incoming.equipment.weapon = 'bow';
    incoming.animation.speed = 15;

    await page.getByRole('button', { name: '导入配置' }).click();
    await expect(page.locator('#importModal')).toBeVisible();
    await page.locator('#importText').click();
    await page.locator('#importText').fill(JSON.stringify(incoming));
    await expect(page.locator('.diff-changed')).toHaveCount(3);
    await expect(page.locator('.diff-row').first()).toContainText('装甲色');
    await expect(page.locator('#confirmImportBtn')).toBeEnabled();

    await page.locator('#confirmImportBtn').click();
    await expect(page.locator('#importModal')).toBeHidden();
    await waitForSavedHashMatch(page);
    const after = await appState(page);
    expect(after.config).toEqual(incoming);
    expect(after.currentHash).not.toBe(before.currentHash);
    expect(after.rollbackAvailable).toBe(true);

    await page.getByRole('button', { name: '回滚上次导入' }).click();
    await waitForSavedHashMatch(page);
    const rolled = await appState(page);
    expect(rolled.config).toEqual(before.config);
    expect(rolled.currentHash).toBe(before.currentHash);
    expect(rolled.rollbackAvailable).toBe(false);
    await context.close();
    await browser.close();
  });

  test('键盘完成同样的导入/回滚任务，含 Esc 关闭后草稿与滚动位置保留', async () => {
        const { browser, context, page } = await sharedHarness();
    const before = await appState(page);
    const incoming = structuredClone(before.config);
    incoming.equipment.shield = 'tower';

    await page.evaluate(() => window.scrollTo(0, 120));
    await page.locator('#previewScroll').evaluate((el) => { el.scrollTop = 40; });
    await page.waitForTimeout(150);

    await page.keyboard.press('Tab');
    let tabCount = 1;
    while (!(await page.locator('#importBtn').evaluate((el) => el === document.activeElement))) {
      await page.keyboard.press('Tab');
      tabCount += 1;
      if (tabCount > 40) throw new Error('Tab 无法到达导入按钮');
    }
    await page.keyboard.press('Enter');
    await expect(page.locator('#importModal')).toBeVisible();
    await page.keyboard.type(JSON.stringify(incoming));
    await expect(page.locator('.diff-changed')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('#importModal')).toBeHidden();

    await page.reload();
    await expect(page.locator('h1')).toBeVisible();
    const scrollY = await page.evaluate(() => window.scrollY);
    const preview = await page.locator('#previewScroll').evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
    expect(Math.abs(scrollY - 120)).toBeLessThanOrEqual(130);
    expect(preview.y).toBe(40);

    await page.locator('#importBtn').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#importModal')).toBeVisible();
    await expect(page.locator('#importText')).toHaveValue(JSON.stringify(incoming));
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await waitForSavedHashMatch(page);
    const after = await appState(page);
    expect(after.config.equipment.shield).toBe('tower');

    await page.locator('#rollbackBtn').focus();
    await page.keyboard.press('Enter');
    const rolled = await appState(page);
    expect(rolled.config).toEqual(before.config);
    await context.close();
    await browser.close();
  });

  test('非法导入 JSON 显示失败提示且不改变当前配置与存储', async () => {
        const { browser, context, page } = await sharedHarness();
    const before = await appState(page);
    await page.getByRole('button', { name: '导入配置' }).click();
    await page.locator('#importText').fill('{"schemaVersion":1,"colors":{"skinColor":"not-a-color"}}');
    await expect(page.locator('#importParseError')).toBeVisible();
    await expect(page.locator('#importParseError')).toContainText('skinColor');
    await expect(page.locator('#confirmImportBtn')).toBeDisabled();
    await page.keyboard.press('Escape');
    const after = await appState(page);
    expect(after.config).toEqual(before.config);
    expect(after.storedHash).toBe(before.storedHash);
    await context.close();
    await browser.close();
  });
});

test.describe('路径三：存储损坏恢复，最后可读快照不被覆盖', () => {
  test('current 被写坏时自动回退 lastGood，损坏内容被隔离且保存被封锁', async () => {
        const { browser, context, page } = await sharedHarness();
    await setFieldByMouse(page, 'armorColor', '#224488');
    await waitForSavedHashMatch(page);
    const good = await appState(page);
    const goodRaw = await page.evaluate((k) => localStorage.getItem(k), KEYS.lastGood);

    await page.evaluate((k) => localStorage.setItem(k, '{broken-json,,,,'), KEYS.current);
    const page2 = await context.newPage();
    await page2.goto('/');
    const recovered = await page2.evaluate(() => window.characterApp.getState());
    expect(recovered.source).toBe('lastGood');
    expect(recovered.saveBlocked).toBe(true);
    expect(recovered.config).toEqual(good.config);
    expect(recovered.currentHash).toBe(good.currentHash);

    const storage = await page2.evaluate((k) => ({
      lastGood: localStorage.getItem(k.lastGood),
      corrupted: localStorage.getItem(k.corrupted),
      current: localStorage.getItem(k.current),
    }), KEYS);
    expect(storage.lastGood).toBe(goodRaw);
    expect(storage.corrupted).toBe('{broken-json,,,,');
    expect(storage.current).toBe('{broken-json,,,,');
    await expect(page2.locator('#inlineError')).toContainText('损坏');
    await expect(page2.locator('#recoverBtn')).toBeEnabled();

    // 封锁期间继续编辑不能覆盖 lastGood。
    await setFieldByMouse(page2, 'speed', 5);
    await page2.waitForTimeout(700);
    const stillGood = await page2.evaluate((k) => localStorage.getItem(k), KEYS.lastGood);
    expect(stillGood).toBe(goodRaw);

    // 显式恢复后两个槽都被可读配置重建。
    await page2.locator('#recoverBtn').click();
    await waitForSavedHashMatch(page2);
    const rebuilt = await page2.evaluate(() => window.characterApp.getState());
    expect(rebuilt.saveBlocked).toBe(false);
    const rebuiltRaw = await page2.evaluate((k) => ({
      current: localStorage.getItem(k.current),
      lastGood: localStorage.getItem(k.lastGood),
    }), KEYS);
    expect(JSON.parse(rebuiltRaw.current).animation.speed).toBe(5);
    expect(rebuiltRaw.current).toBe(rebuiltRaw.lastGood);
    await context.close();
    await browser.close();
  });

  test('current 与 lastGood 同时损坏时使用默认配置，且损坏原文保留可查', async () => {
        const { browser, context, page } = await sharedHarness();
    await page.evaluate((k) => {
      localStorage.setItem(k.current, '###bad-current');
      localStorage.setItem(k.lastGood, '###bad-good');
    }, KEYS);
    await page.reload();
    const state = await appState(page);
    expect(state.source).toBe('default');
    expect(state.saveBlocked).toBe(true);
    const corruptedKept = await page.evaluate((k) => localStorage.getItem(k.corrupted), KEYS);
    expect(corruptedKept).toBe('###bad-current');
    await expect(page.locator('#inlineError')).toContainText('没有可读快照');
    await context.close();
    await browser.close();
  });
});
