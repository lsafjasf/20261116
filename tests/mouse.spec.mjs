import { test, expect } from '@playwright/test';
import { freshContext, appState } from './helpers.mjs';

test.describe('鼠标完整流程：与键盘相同的任务', () => {
  test('点击打开、编辑、关闭、撤销，状态与键盘流一致', async ({ browser }) => {
    const { context, page } = await freshContext(browser);

    // 1) 鼠标点击触发按钮打开弹窗
    await page.locator('#btn-open-text').click();
    await expect(page.locator('#modal-backdrop')).toBeVisible();
    await expect(page.locator('#modal-title-input')).toBeFocused();

    // 2) 输入并通过鼠标点“取消”，验证草稿保留与焦点归还
    await page.locator('#modal-title-input').fill('鼠标创作标题');
    await page.locator('#modal-body-input').fill('鼠标创作正文');
    await page.locator('#btn-modal-cancel').click();
    await expect(page.locator('#modal-backdrop')).toBeHidden();
    await expect(page.locator('#btn-open-text')).toBeFocused();
    expect((await appState(page)).ui.modalDraft?.dirty).toBe(true);

    // 3) 鼠标重新打开并保存
    await page.locator('#btn-open-text').click();
    await page.locator('#btn-modal-save').click();
    await expect(page.locator('#modal-backdrop')).toBeHidden();
    await expect(page.locator('#btn-open-text')).toBeFocused();
    const s0 = await appState(page);
    expect(s0.doc.texts[0]).toMatchObject({ title: '鼠标创作标题', body: '鼠标创作正文' });

    // 4) 鼠标添加两个图形，点选第二个
    await page.locator('#btn-add-rect').click();
    await page.locator('#btn-add-ellipse').click();
    const s1 = await appState(page);
    expect(s1.doc.shapes.length).toBe(4);
    const shapes = page.locator('#canvas .shape');
    await shapes.nth(3).click();
    const selected = (await appState(page)).ui.selectedShapeId;
    expect(selected).toBe(s1.doc.shapes[3].id);
    await expect(page.locator('#canvas .shape.selected')).toHaveCount(1);

    // 5) 鼠标拖动选中图形（拖拽历史可一次撤销）
    const beforeDrag = (await appState(page)).doc.shapes.find((s) => s.id === selected);
    const box = await page.locator('#canvas .shape.selected').boundingBox();
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + 60, { steps: 6 });
    await page.mouse.up();
    const afterDrag = (await appState(page)).doc.shapes.find((s) => s.id === selected);
    expect(afterDrag.x - beforeDrag.x).toBe(70);
    expect(afterDrag.y - beforeDrag.y).toBe(40);
    expect((await appState(page)).ui.selectedShapeId).toBe(selected);

    // 6) 鼠标新增关键帧并在时间轴点选
    await page.locator('#btn-add-key').click();
    expect((await appState(page)).doc.timeline.length).toBe(3);
    const keyItems = page.locator('#timeline li');
    await keyItems.first().click();
    const firstKeyId = (await appState(page)).doc.timeline
      .slice().sort((a, b) => a.t - b.t)[0].id;
    expect((await appState(page)).ui.selectedKeyId).toBe(firstKeyId);

    // 7) 鼠标点工具栏撤销/重做按钮，逐步核对
    const counts = async () => {
      const s = await appState(page);
      return [s.doc.texts.length, s.doc.shapes.length, s.doc.timeline.length];
    };
    await page.locator('#btn-undo').click(); // 撤销关键帧
    expect(await counts()).toEqual([1, 4, 2]);
    await page.locator('#btn-undo').click(); // 撤销拖拽（图形数不变）
    const draggedBack = (await appState(page)).doc.shapes.find((s) => s.id === selected);
    expect(draggedBack.x).toBe(beforeDrag.x);
    expect(draggedBack.y).toBe(beforeDrag.y);
    await page.locator('#btn-undo').click(); // 撤销椭圆
    expect(await counts()).toEqual([1, 3, 2]);
    await page.locator('#btn-undo').click(); // 撤销矩形
    expect(await counts()).toEqual([1, 2, 2]);
    await page.locator('#btn-undo').click(); // 撤销文本
    expect(await counts()).toEqual([0, 2, 2]);
    await expect(page.locator('#btn-undo')).toBeDisabled();
    // 选中对象在撤销后保持有效（调和逻辑）
    const sUndo = await appState(page);
    const validShape = sUndo.doc.shapes.some((x) => x.id === sUndo.ui.selectedShapeId);
    expect(validShape || sUndo.ui.selectedShapeId === null).toBe(true);

    for (let i = 0; i < 5; i++) await page.locator('#btn-redo').click();
    expect(await counts()).toEqual([1, 4, 3]);
    await expect(page.locator('#btn-redo')).toBeDisabled();

    await context.close();
  });

  test('鼠标点遮罩关闭弹窗并归还焦点；丢弃草稿清空', async ({ browser }) => {
    const { context, page } = await freshContext(browser);
    await page.locator('#btn-open-text').click();
    await page.locator('#modal-title-input').fill('遮罩草稿');
    await page.locator('#modal-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#modal-backdrop')).toBeHidden();
    await expect(page.locator('#btn-open-text')).toBeFocused();
    expect((await appState(page)).ui.modalDraft?.title).toBe('遮罩草稿');

    await page.locator('#btn-open-text').click();
    await page.locator('#btn-modal-discard').click();
    await expect(page.locator('#modal-backdrop')).toBeHidden();
    expect((await appState(page)).ui.modalDraft).toBeNull();
    await expect(page.locator('#btn-open-text')).toBeFocused();
    await context.close();
  });
});
