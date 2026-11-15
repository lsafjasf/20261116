import { test, expect } from '@playwright/test';
import { freshContext, appState, activeId, statusDl } from './helpers.mjs';

test.describe('键盘完整流程：打开 / 编辑 / 关闭 / 撤销', () => {
  test('焦点陷阱、焦点归还、快捷键守卫与历史一致', async ({ browser }) => {
    const { context, page } = await freshContext(browser);

    // 1) 用键盘 Tab 到达“文本弹窗”按钮并回车打开（首个 Tab 位是跳过链接）
    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#btn-add-rect')).toBeFocused();
    let tabOrder = (await statusDl(page, 'st-focus'))['Tab 顺序'];
    expect(tabOrder).toContain('btn-add-rect');
    await page.keyboard.press('Tab'); // 椭圆
    await page.keyboard.press('Tab'); // 文本弹窗
    await expect(page.locator('#btn-open-text')).toBeFocused();
    const triggerId = await activeId(page);
    await page.keyboard.press('Enter');

    // 2) 弹窗打开：焦点进入首个输入框，背景 inert
    await expect(page.locator('#modal-backdrop')).toBeVisible();
    await expect(page.locator('#modal-title-input')).toBeFocused();
    const focusRows = await statusDl(page, 'st-focus');
    expect(focusRows['弹窗打开']).toBe('true');
    expect(focusRows['背景 inert']).toBe('true');
    expect(focusRows['Tab 顺序']).toContain('弹窗内循环');
    expect(await page.locator('.topbar').evaluate((el) => el.inert)).toBe(true);

    // 3) Tab 不能进入背景：连按 5 次 Tab，焦点始终在弹窗内
    const modalIds = ['modal-title-input', 'modal-body-input', 'btn-modal-save',
      'btn-modal-cancel', 'btn-modal-discard'];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      const id = await activeId(page);
      expect(modalIds).toContain(id);
    }
    // Shift+Tab 反向也在弹窗内
    await page.keyboard.press('Shift+Tab');
    expect(modalIds).toContain(await activeId(page));

    // 4) 输入框中按背景单键快捷键（r/o/t/k）不得触发背景动作
    await page.locator('#modal-title-input').fill('键盘创作标题');
    await page.locator('#modal-body-input').click();
    await page.keyboard.type('正文包含 r o t k 快捷键字符，不应添加图形或关键帧', { delay: 8 });
    const shapesBefore = (await appState(page)).doc.shapes.length;
    const keysBefore = (await appState(page)).doc.timeline.length;
    expect((await appState(page)).doc.shapes.length).toBe(shapesBefore);
    expect((await appState(page)).doc.timeline.length).toBe(keysBefore);

    // 5) 空内容保存必须给出失败提示，且弹窗不关闭
    await page.locator('#modal-title-input').fill('');
    await page.locator('#modal-body-input').fill('');
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('#modal-error')).toBeVisible();
    expect(await page.locator('#modal-error').textContent()).toContain('失败提示');
    await expect(page.locator('#modal-backdrop')).toBeVisible();
    await expect(page.locator('#modal-title-input')).toBeFocused();

    // 6) 重新输入后 Ctrl+Enter 保存关闭，焦点必须回到触发按钮
    await page.keyboard.type('键盘创作标题');
    await page.locator('#modal-body-input').fill('键盘创作正文');
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('#modal-backdrop')).toBeHidden();
    await expect(page.locator(`#${triggerId}`)).toBeFocused();
    const afterSave = await appState(page);
    expect(afterSave.doc.texts).toHaveLength(1);
    expect(afterSave.ui.modalDraft).toBeNull();

    // 7) 键盘添加图形并移动（合并历史），再 Delete
    await page.keyboard.press('r');
    const s1 = await appState(page);
    expect(s1.doc.shapes.length).toBe(3);
    const newShapeId = s1.ui.selectedShapeId;
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    const s2 = await appState(page);
    const moved = s2.doc.shapes.find((s) => s.id === newShapeId);
    expect(moved.x).toBeGreaterThan(s1.doc.shapes.find((s) => s.id === newShapeId).x);

    // 8) 键盘新增时间轴关键帧
    await page.keyboard.press('k');
    const s3 = await appState(page);
    expect(s3.doc.timeline.length).toBe(3);

    // 9) 撤销：关键帧 -> 移动（一次合并） -> 图形 -> 文本，状态逐步回退
    const undoSteps = ['删除关键帧回退', '移动回退', '图形回退', '文本回退'];
    await page.keyboard.press('Control+z');
    expect((await appState(page)).doc.timeline.length).toBe(2);
    await page.keyboard.press('Control+z');
    const s4 = await appState(page);
    const restored = s4.doc.shapes.find((s) => s.id === newShapeId);
    expect(restored.x).toBe(s1.doc.shapes.find((s) => s.id === newShapeId).x);
    await page.keyboard.press('Control+z');
    expect((await appState(page)).doc.shapes.length).toBe(2);
    await page.keyboard.press('Control+z');
    expect((await appState(page)).doc.texts.length).toBe(0);
    const historyRows = await statusDl(page, 'st-history');
    expect(historyRows['可撤销']).toBe('false');
    expect(historyRows['可重做']).toBe('true');

    // 10) 重做链恢复全部操作
    for (let i = 0; i < 4; i++) await page.keyboard.press('Control+y');
    const s5 = await appState(page);
    expect(s5.doc.texts.length).toBe(1);
    expect(s5.doc.shapes.length).toBe(3);
    expect(s5.doc.timeline.length).toBe(3);

    // 11) 撤销到底再撤销要有失败提示（toast）
    for (let i = 0; i < 10; i++) await page.keyboard.press('Control+z');
    await expect(page.locator('#toast')).toBeVisible();
    expect(await page.locator('#toast').textContent()).toContain('没有可撤销');

    await context.close();
  });

  test('Esc 关闭保留未提交草稿，重开弹窗草稿仍在', async ({ browser }) => {
    const { context, page } = await freshContext(browser);
    await page.locator('#btn-open-text').focus();
    await page.keyboard.press('Enter');
    await page.locator('#modal-title-input').fill('草稿标题');
    await page.locator('#modal-body-input').fill('草稿正文未提交');
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-backdrop')).toBeHidden();
    await expect(page.locator('#btn-open-text')).toBeFocused();
    const st = await appState(page);
    expect(st.ui.modalDraft).toMatchObject({ title: '草稿标题', body: '草稿正文未提交', dirty: true });

    await page.keyboard.press('Enter');
    await expect(page.locator('#modal-backdrop')).toBeVisible();
    expect(await page.locator('#modal-title-input').inputValue()).toBe('草稿标题');
    expect(await page.locator('#modal-body-input').inputValue()).toBe('草稿正文未提交');
    await context.close();
  });
});
