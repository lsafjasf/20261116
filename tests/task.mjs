// 同一项“简单图”任务的两种输入实现：纯键盘 vs 纯鼠标。
// 两者必须产生完全相同的工程状态（元素几何、选择、视图、撤销语义）。

export const TASK_SUMMARY = '矩形 + 椭圆 + 直线，选中第二个元素，放大到 1.2x，平移一次';

// 键盘路径：全程只用 key.press，不产生任何指针事件。
export async function drawWithKeyboard(page) {
  const canvas = page.locator('#canvas');
  await canvas.focus();

  // 矩形：R 选工具，移动光标，空格开始，移动，空格结束。
  await page.keyboard.press('r');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press(' ');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press(' ');

  // 椭圆
  await page.keyboard.press('e');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  // 直线
  await page.keyboard.press('l');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press(' ');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press(' ');

  // 选中第二个元素（椭圆）
  await page.keyboard.press('v');
  await page.keyboard.press(']');
  await page.keyboard.press(']');

  // 缩放与平移
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await page.keyboard.press('Alt+ArrowRight');
}

// 鼠标路径：同样的几何，通过 pointer 事件走相同 command。
export async function drawWithMouse(page) {
  const box = await page.locator('#canvas').boundingBox();
  function point(x, y) {
    return { x: box.x + x, y: box.y + y };
  }
  async function shape(tool, a, b) {
    await page.click(`[data-tool="${tool}"]`);
    const p1 = point(...a);
    const p2 = point(...b);
    await page.mouse.move(p1.x, p1.y);
    await page.mouse.down();
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(
        p1.x + ((p2.x - p1.x) * i) / steps,
        p1.y + ((p2.y - p1.y) * i) / steps,
      );
    }
    await page.mouse.up();
  }

  // 与键盘路径严格相同的文档坐标（初始光标 200,160，步长 10）。
  await shape('rect', [150, 120], [230, 170]);
  await shape('ellipse', [260, 200], [320, 240]);
  await shape('line', [280, 220], [380, 280]);

  // 点击选中椭圆（命中其包围盒）
  await page.click('[data-tool="select"]');
  await page.mouse.click(box.x + 300, box.y + 212);

  await page.click('#btn-zoom-in');
  await page.click('#btn-zoom-in');
  // 中键拖拽平移 10px：产生与 Alt+方向键相同的 pan 视图状态，全程纯鼠标。
  const panStart = point(300, 300);
  await page.mouse.move(panStart.x, panStart.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(panStart.x + 10, panStart.y);
  await page.mouse.up({ button: 'middle' });
}

export function comparableState(state) {
  return {
    tool: state.tool,
    elements: state.elements.map(({ id, ...rest }) => rest),
    selectedIndex: state.elements.findIndex((el) => el.id === state.selectedId),
    view: state.view,
  };
}
