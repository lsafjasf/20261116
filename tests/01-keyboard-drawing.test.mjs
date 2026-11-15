import { assert, BASE, freshGoto, newPage, startServer, waitForSaved } from './helpers.mjs';
import { comparableState, drawWithKeyboard, TASK_SUMMARY } from './task.mjs';

let server;
let env;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('纯键盘完成一幅简单图并核对关键状态', async () => {
  const { page } = env;
  await page.goto('about:blank');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(200);

  assert(await page.locator('#canvas').getAttribute('tabindex') === '0', '画布可获得焦点 (tabindex=0)');
  await drawWithKeyboard(page);

  const state = await page.evaluate(() => window.__app.getState());
  assert(state.elements.length === 3, `画出 3 个元素（实际 ${state.elements.length}）`);
  assert(state.elements[0].type === 'rect', '第 1 个是矩形');
  assert(state.elements[1].type === 'ellipse', '第 2 个是椭圆');
  assert(state.elements[2].type === 'line', '第 3 个是直线');
  assert(state.selectedId === state.elements[1].id, '椭圆处于选中状态');
  assert(Math.abs(state.view.zoom - 1.2) < 1e-9, `缩放为 1.2（实际 ${state.view.zoom}）`);
  assert(state.view.panX === 10 && state.view.panY === 0, '平移量为 (10,0)');

  const panel = await page.locator('#status-list dd[data-key="elements"]').textContent();
  assert(panel === '3', '状态面板显示元素数量 3');
  const svgShapes = await page.locator('#stage g > *').count();
  assert(svgShapes === 3, `SVG 渲染出 3 个节点（实际 ${svgShapes}）`);

  const stored = await waitForSaved(page, 3);
  assert(stored.state.elements.length === 3, 'localStorage 已持久化 3 个元素');
  assert(JSON.stringify(comparableState(stored.state).elements)
    === JSON.stringify(comparableState(state).elements), '存储几何与内存状态一致');

  console.log(`  任务: ${TASK_SUMMARY}`);
});

test('键盘撤销/重做恢复元素且不丢选择与视图', async () => {
  const { page } = env;
  await page.keyboard.press('Control+z');
  let state = await page.evaluate(() => window.__app.getState());
  assert(state.selectedId === state.elements[0].id, '第一次 Ctrl+Z 先还原选择操作');
  while ((await page.evaluate(() => window.__app.getState().elements.length)) === 3) {
    await page.keyboard.press('Control+z');
  }
  state = await page.evaluate(() => window.__app.getState());
  assert(state.elements.length === 2, '继续 Ctrl+Z 撤销掉直线');
  while ((await page.evaluate(() => window.__app.getState().elements.length)) < 3) {
    await page.keyboard.press('Control+y');
  }
  state = await page.evaluate(() => window.__app.getState());
  assert(state.elements.length === 3, 'Ctrl+Y 逐步重做恢复直线');
  while (state.selectedId !== state.elements[1].id) {
    await page.keyboard.press('Control+y');
    state = await page.evaluate(() => window.__app.getState());
  }
  assert(state.selectedId === state.elements[1].id, '重做后选中对象恢复');
  assert(Math.abs(state.view.zoom - 1.2) < 1e-9, '视图缩放未丢失');

  await page.keyboard.press('Delete');
  state = await page.evaluate(() => window.__app.getState());
  assert(state.elements.length === 2 && state.selectedId === null, 'Delete 删除选中并清空选择');
  await page.keyboard.press('Control+z');
  state = await page.evaluate(() => window.__app.getState());
  assert(state.elements.length === 3 && state.selectedId === state.elements[1].id, '撤销恢复元素与选中');
});

test('Esc 取消进行中草稿，已提交内容不受影响', async () => {
  const { page } = env;
  await page.keyboard.press('r');
  await page.keyboard.press(' ');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  let state = await page.evaluate(() => window.__app.getState());
  assert(state.draft !== null, '草稿已建立');
  await page.keyboard.press('Escape');
  state = await page.evaluate(() => window.__app.getState());
  assert(state.draft === null && state.elements.length === 3, 'Esc 取消草稿且 3 个已提交元素保留');
});

async function main() {
  server = await startServer();
  env = await newPage();
  let failed = 0;
  for (const t of tests) {
    console.log(`\n${t.name}`);
    try {
      await t.fn();
    } catch (err) {
      failed += 1;
      console.error(String(err.stack || err));
    }
  }
  if (env.errors.length) {
    failed += 1;
    console.error(`\n浏览器控制台错误:\n${env.errors.join('\n')}`);
  }
  await env.close();
  server.kill();
  console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main();
