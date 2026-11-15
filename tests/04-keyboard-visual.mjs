// 端到端演示：全程零指针事件，仅用键盘完成一幅图，产出截图与焦点顺序报告。
import { mkdir } from 'node:fs/promises';
import { assert, freshGoto, newPage, startServer } from './helpers.mjs';

let server;
let env;

async function main() {
  server = await startServer();
  env = await newPage();
  const { page } = env;
  await freshGoto(page);
  await page.evaluate(() => localStorage.clear());

  // 1) 焦点顺序：从地址区进入后连续 Tab，记录前 12 个焦点目标。
  await page.keyboard.press('Tab');
  const focusOrder = [];
  for (let i = 0; i < 12; i++) {
    focusOrder.push(await page.evaluate(() => {
      const el = document.activeElement;
      return el.id || `${el.tagName.toLowerCase()}:${el.dataset.tool || el.textContent.trim().slice(0, 8)}`;
    }));
    await page.keyboard.press('Tab');
  }

  // 2) 纯键盘绘图：矩形 + 椭圆 + 直线 + 删除 + 撤销恢复 + 导出。
  await page.keyboard.press('f');
  const canvasFocused = await page.evaluate(() => document.activeElement.id === 'canvas');
  assert(canvasFocused, 'F 聚焦画布');

  await page.keyboard.press('r');
  await page.keyboard.press(' ');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press(' ');

  await page.keyboard.press('e');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await page.keyboard.press('l');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press(' ');
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press(' ');

  await page.keyboard.press('v');
  await page.keyboard.press(']');
  await page.keyboard.press('Delete');
  let state = await page.evaluate(() => window.__app.getState());
  assert(state.elements.length === 2, '键盘 Delete 删除选中元素');
  await page.keyboard.press('Control+z');
  state = await page.evaluate(() => window.__app.getState());
  assert(state.elements.length === 3, 'Ctrl+Z 恢复被删元素');

  await page.keyboard.press('+');
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('Control+e');
  await page.waitForSelector('#export-dialog:not([hidden])');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#export-dialog', { state: 'hidden' });
  const focusReturned = await page.evaluate(() => document.activeElement.id === 'canvas');
  assert(focusReturned, '导出弹窗 Esc 后焦点归还画布');

  await mkdir('artifacts/screenshots', { recursive: true });
  await page.screenshot({ path: 'artifacts/screenshots/keyboard-drawing.png', fullPage: true });

  const finalState = await page.evaluate(() => {
    const s = window.__app.getState();
    return {
      elements: s.elements.map((e) => e.type),
      zoom: s.view.zoom,
      pan: [s.view.panX, s.view.panY],
      savedAt: s.savedAt,
    };
  });

  console.log('\n焦点顺序 (Tab):');
  focusOrder.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
  console.log('\n最终工程状态:', JSON.stringify(finalState, null, 2));
  console.log('截图: artifacts/screenshots/keyboard-drawing.png');

  if (env.errors.length) throw new Error(`控制台错误: ${env.errors.join(', ')}`);
  await env.close();
  server.kill();
  console.log('\n纯键盘端到端验证通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
