import { test, expect } from '@playwright/test';
import { freshContext, appState, statusDl, STORAGE_KEY, LAST_GOOD_KEY, waitSaved } from './helpers.mjs';

test.describe('刷新保持、滚动位置与失败恢复', () => {
  test('刷新后文档、选中对象、滚动位置、草稿均保持', async ({ browser }) => {
    const { context, page } = await freshContext(browser);
    await page.locator('#btn-add-rect').click();
    const before = await appState(page);
    const pickedShape = before.doc.shapes.at(-1).id;
    await page.evaluate((id) => globalThis.__app.render(), pickedShape);
    await page.locator(`#layer-list li[data-id="${pickedShape}"]`).click();

    // 制造滚动位置
    await page.locator('#canvas-scroll').evaluate((el) => { el.scrollLeft = 240; el.scrollTop = 180; });
    await page.locator('#sidebar-scroll').evaluate((el) => { el.scrollTop = 120; });
    await page.waitForTimeout(450); // 等待防抖保存

    // 制造未提交草稿
    await page.locator('#btn-open-text').click();
    await page.locator('#modal-title-input').fill('刷新前草稿');
    await page.locator('#modal-body-input').fill('刷新后必须还在');
    await page.waitForTimeout(450);
    await page.keyboard.press('Escape');
    await page.evaluate(() => globalThis.__app.flushSave()); // 显式落盘，不依赖关闭时序

    await page.reload();
    await expect(page.locator('#canvas')).toBeVisible();
    await page.waitForTimeout(500); // 等待分帧滚动恢复完成
    const after = await appState(page);
    expect(after.doc.shapes.map((s) => s.id)).toEqual(before.doc.shapes.map((s) => s.id));
    expect(after.ui.selectedShapeId).toBe(pickedShape);
    expect(after.ui.modalDraft).toMatchObject({ title: '刷新前草稿', body: '刷新后必须还在' });
    const scroll = await page.evaluate(() => ({
      c: document.getElementById('canvas-scroll').scrollTop,
      cl: document.getElementById('canvas-scroll').scrollLeft,
      s: document.getElementById('sidebar-scroll').scrollTop,
    }));
    expect(scroll).toMatchObject({ c: 180, cl: 240, s: 120 });

    // 看板中存储状态正常且字节数 > 0
    const storageRows = await statusDl(page, 'st-storage');
    expect(storageRows['存储状态']).toContain('正常');
    expect(Number(storageRows['快照字节'])).toBeGreaterThan(0);
    await context.close();
  });

  test('主快照损坏时显示可读快照横幅并保留损坏原文', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    // 先正常使用一次，生成 last-good 完好快照
    const setup = await context.newPage();
    await setup.goto('/');
    await setup.locator('#btn-add-ellipse').click();
    await setup.waitForTimeout(450);
    const lastGood = await setup.evaluate((k) => JSON.parse(localStorage.getItem(k)), LAST_GOOD_KEY);
    expect(lastGood.doc.shapes.length).toBe(3);
    await setup.close();

    // 新会话加载前写入损坏主快照，模拟外部破坏（本会话代码无机会覆盖它）
    await context.addInitScript((k) => localStorage.setItem(k, '{broken json!!!'), STORAGE_KEY);
    const page = await context.newPage();
    await page.goto('/');
    const banner = page.locator('.recovery-banner');
    await expect(banner).toBeVisible();
    expect(await banner.textContent()).toContain('已保留可读快照');
    expect(await page.locator('#corrupt-raw').textContent()).toContain('broken json');
    // last-good 被恢复，文档仍可读
    const st = await appState(page);
    expect(st.doc.shapes.length).toBe(3);
    const storageRows = await statusDl(page, 'st-storage');
    expect(storageRows['存储状态']).toBe('异常');
    expect(storageRows['最近错误']).toContain('恢复失败');
    // 可读快照可下载
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#btn-download-snapshot').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('readable-snapshot.json');
    await context.close();
  });

  test('写入失败注入：提示失败但内存状态不丢，恢复写入后成功', async ({ browser }) => {
    const { context, page } = await freshContext(browser);
    await page.locator('#btn-write-fail').click();
    await page.locator('#btn-add-rect').click();
    await page.waitForTimeout(450);
    await expect(page.locator('#toast')).toBeVisible();
    expect(await page.locator('#toast').textContent()).toContain('模拟写入失败');
    const storageRows = await statusDl(page, 'st-storage');
    expect(storageRows['存储状态']).toBe('异常');
    // 内存状态仍在
    expect((await appState(page)).doc.shapes.length).toBe(3);

    await page.locator('#btn-write-fail').click();
    await page.waitForTimeout(450);
    const fixed = await statusDl(page, 'st-storage');
    expect(fixed['存储状态']).toBe('正常');
    await context.close();
  });

  test('看板同步：输入、存储、渲染字段随操作实时更新', async ({ browser }) => {
    const { context, page } = await freshContext(browser);
    const edit0 = await statusDl(page, 'st-edit');
    expect(edit0['图形数']).toBe('2');
    await page.locator('#btn-add-rect').click();
    const edit1 = await statusDl(page, 'st-edit');
    expect(edit1['图形数']).toBe('3');
    const render1 = await statusDl(page, 'st-render');
    expect(render1['SVG 子节点']).toBe('3');
    const focus = await statusDl(page, 'st-focus');
    expect(['rect', 'ellipse']).toContain(focus['activeElement']);
    expect(focus['当前焦点可编辑']).toBe('false');
    await context.close();
  });
});
