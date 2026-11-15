import { assert, freshGoto, newContext, newPage, startServer } from './helpers.mjs';
import { comparableState, drawWithKeyboard, drawWithMouse } from './task.mjs';

let server;
let env;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function freshPage() {
  const ctx = await newContext(env.browser);
  env.tracked.push(ctx);
  await freshGoto(ctx.page);
  return ctx.page;
}

async function runIsolated(draw) {
  const { page, browser, errors } = await newContext(env.browser);
  env.tracked.push({ page, errors });
  await freshGoto(page);
  assert(await page.evaluate(() => window.__app.getState().elements.length) === 0, '干净起始状态');
  await draw(page);
  await page.evaluate(() => window.__app.persistNow());
  const state = await page.evaluate(() => window.__app.getState());
  const svg = await page.locator('#stage g').innerHTML();
  const stored = JSON.parse(await page.evaluate(
    (key) => localStorage.getItem(key),
    await page.evaluate(() => window.__app.storageKeys.STORAGE_KEY),
  ));
  await page.close();
  return { state, svg, stored };
}

test('鼠标与键盘完成同一任务产生等价工程状态', async () => {
  const kb = await runIsolated(drawWithKeyboard);
  const ms = await runIsolated(drawWithMouse);

  assert(kb.state.elements.length === 3 && ms.state.elements.length === 3,
    `两条路径都画出 3 个元素（键盘 ${kb.state.elements.length} / 鼠标 ${ms.state.elements.length}）`);
  assert(
    JSON.stringify(comparableState(kb.state)) === JSON.stringify(comparableState(ms.state)),
    '工具/元素几何/选中索引/视图完全一致',
  );
  assert(kb.svg === ms.svg, 'SVG 渲染输出逐字符一致');
  assert(
    JSON.stringify(comparableState(kb.stored.state)) === JSON.stringify(comparableState(ms.stored.state)),
    'localStorage 持久化内容一致',
  );
});

test('鼠标路径同样可撤销且与键盘路径同构', async () => {
  const page = await freshPage();
  await drawWithMouse(page);
  let count = await page.evaluate(() => window.__app.getState().elements.length);
  assert(count === 3, `鼠标画出 3 个元素（实际 ${count}）`);
  while ((await page.evaluate(() => window.__app.getState().elements.length)) === 3) {
    await page.click('#btn-undo');
  }
  count = await page.evaluate(() => window.__app.getState().elements.length);
  assert(count === 2, '工具栏撤销按钮可撤销鼠标绘制');
  while ((await page.evaluate(() => window.__app.getState().elements.length)) < 3) {
    await page.click('#btn-redo');
  }
  count = await page.evaluate(() => window.__app.getState().elements.length);
  assert(count === 3, '工具栏重做按钮恢复元素');
});

test('鼠标右键取消草稿，已提交元素保留', async () => {
  const page = await freshPage();
  await drawWithMouse(page);
  const box = await page.locator('#canvas').boundingBox();
  await page.click('[data-tool="rect"]');
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 150);
  let draft = await page.evaluate(() => window.__app.getState().draft);
  assert(draft !== null, '鼠标拖拽产生草稿');
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'right' });
  await page.mouse.up();
  draft = await page.evaluate(() => window.__app.getState().draft);
  const count = await page.evaluate(() => window.__app.getState().elements.length);
  assert(draft === null, '右键取消草稿');
  assert(count === 3, '已提交的 3 个元素保留');
});

async function main() {
  server = await startServer();
  env = await newPage();
  env.tracked = [];
  let failed = 0;
  for (const t of tests) {
    console.log(`\n${t.name}`);
    try { await t.fn(); } catch (err) {
      failed += 1;
      console.error(String(err.stack || err));
    }
  }
  const allErrors = [...env.errors, ...env.tracked.flatMap((t) => t.errors)];
  if (allErrors.length) {
    failed += 1;
    console.error(`\n浏览器控制台错误:\n${allErrors.join('\n')}`);
  }
  await env.close();
  server.kill();
  console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main();
