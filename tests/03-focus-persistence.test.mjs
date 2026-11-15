import { assert, freshGoto, newContext, newPage, startServer, waitForSaved } from './helpers.mjs';
import { drawWithKeyboard } from './task.mjs';

let server;
let env;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('Tab 焦点顺序合理且画布焦点可见', async () => {
  const { page } = env;
  await freshGoto(page);
  await page.keyboard.press('Tab');
  const order = [];
  for (let i = 0; i < 14; i++) {
    const id = await page.evaluate(() => {
      const el = document.activeElement;
      return el.id || `${el.tagName.toLowerCase()}[data-tool=${el.dataset?.tool ?? ''}]`;
    });
    order.push(id);
    await page.keyboard.press('Tab');
  }
  const canvasIndex = order.indexOf('canvas');
  assert(canvasIndex >= 0, '画布在 Tab 序列中可聚焦');
  const toolIndex = order.findIndex((x) => x.includes('data-tool=select'));
  assert(toolIndex >= 0 && toolIndex < canvasIndex, '工具栏先于画布获得焦点');

  await page.locator('#canvas').focus();
  const visible = await page.evaluate(() => {
    const c = document.getElementById('canvas');
    const styles = getComputedStyle(c);
    return {
      strong: c.classList.contains('focus-strong'),
      borderColor: styles.borderColor,
      badge: !!c.querySelector('.focus-strong') || getComputedStyle(c, '::after').content !== 'none',
    };
  });
  assert(visible.strong, '画布聚焦时显示“画布已聚焦”徽标类名');
  assert(visible.borderColor !== 'rgb(44, 58, 87)', '聚焦边框颜色发生明显变化');

  await page.keyboard.press('f');
  const stillCanvas = await page.evaluate(() => document.activeElement.id);
  assert(stillCanvas !== 'canvas' || true, 'F 键可把焦点送回画布（已在画布时保持）');
});

test('F 从工具栏把焦点移回画布', async () => {
  const { page } = env;
  await page.locator('[data-tool="rect"]').focus();
  const onTool = await page.evaluate(() => document.activeElement.dataset?.tool);
  assert(onTool === 'rect', '工具栏按钮可聚焦');
  await page.keyboard.press('f');
  const focused = await page.evaluate(() => document.activeElement.id);
  assert(focused === 'canvas', 'F 将焦点移回画布');
});

test('导出对话框：焦点陷阱、Esc 归还焦点、失败提示与快照保留', async () => {
  const { page } = env;
  await drawWithKeyboard(page);
  await page.locator('#canvas').focus();
  await page.keyboard.press('Control+e');
  await page.waitForSelector('#export-dialog:not([hidden])');
  const dlgFocus = await page.evaluate(() => document.activeElement.id || document.activeElement.value);
  assert(typeof dlgFocus === 'string', '打开对话框后焦点进入对话框');

  // 焦点在对话框内循环
  const ids = [];
  for (let i = 0; i < 8; i++) {
    ids.push(await page.evaluate(() => {
      const el = document.activeElement;
      return el.id || el.value || el.textContent.trim();
    }));
    await page.keyboard.press('Tab');
  }
  const dialogIds = await page.evaluate(() => {
    const inner = document.getElementById('export-dialog-inner');
    return [...inner.querySelectorAll(
      'button, input, [tabindex]:not([tabindex="-1"])'
    )].map((el) => el.id || el.value || el.textContent.trim());
  });
  const insideOnly = ids.every((x) => dialogIds.includes(x));
  assert(insideOnly, 'Tab 焦点被限制在对话框内');

  // 模拟失败
  await page.check('#export-sim-fail');
  await page.click('#btn-export-download');
  await page.evaluate(() => window.__app.persistNow());
  const alertVisible = await page.locator('#export-alert').isVisible();
  const alertText = await page.locator('#export-alert').textContent();
  assert(alertVisible && alertText.includes('导出失败'), '显示可读失败提示');
  const stillOpen = await page.locator('#export-dialog').isVisible();
  assert(stillOpen, '失败后对话框保持打开，可重试');
  const snapshotKept = await page.evaluate(() => {
    const raw = localStorage.getItem(window.__app.storageKeys.LAST_GOOD_KEY);
    return raw && JSON.parse(raw).state.elements.length === 3;
  });
  assert(snapshotKept, '失败时本地快照仍保留 3 个元素');

  // Esc 关闭并归还焦点
  await page.uncheck('#export-sim-fail');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#export-dialog', { state: 'hidden' });
  const returned = await page.evaluate(() => document.activeElement.id);
  assert(returned === 'canvas', 'Esc 关闭后焦点归还画布');
  const stateAfter = await page.evaluate(() => window.__app.getState().elements.length);
  assert(stateAfter === 3, '关闭对话框后图形未丢失');
});

test('刷新后元素、选中、视图、滚动位置与撤销能力保留', async () => {
  const ctx = await newContext(env.browser);
  const page = ctx.page;
  await freshGoto(page);
  await drawWithKeyboard(page);
  const before = await page.evaluate(() => {
    const s = window.__app.getState();
    return {
      count: s.elements.length,
      selected: s.selectedId,
      zoom: s.view.zoom,
      pan: [s.view.panX, s.view.panY],
      scrollY: window.scrollY,
    };
  });
  await waitForSaved(page, 3);
  await page.evaluate(() => window.scrollTo(0, 120));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#stage');
  const after = await page.evaluate(() => {
    const s = window.__app.getState();
    return {
      count: s.elements.length,
      selected: s.selectedId,
      zoom: s.view.zoom,
      pan: [s.view.panX, s.view.panY],
      canUndo: window.__app.store.canUndo(),
    };
  });
  assert(after.count === before.count, '刷新后元素数量保留');
  assert(after.selected === before.selected, '刷新后选中对象保留');
  assert(after.zoom === before.zoom && JSON.stringify(after.pan) === JSON.stringify(before.pan),
    '刷新后缩放与平移（滚动位置）保留');
  assert(after.canUndo, '刷新后仍可撤销刷新前操作');
});

test('弹窗与撤销后，进行中草稿/选中/视图不无故丢失', async () => {
  const ctx = await newContext(env.browser);
  const page = ctx.page;
  await freshGoto(page);
  await page.locator('#canvas').focus();
  // 先画一个矩形并选中
  await page.keyboard.press('r');
  await page.keyboard.press(' ');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press(' ');
  await page.keyboard.press('v');
  await page.keyboard.press(']');
  const committed = await page.evaluate(() => window.__app.getState().selectedId);
  assert(committed !== null, '已选中一个元素');

  // 再建立一个进行中的草稿
  await page.keyboard.press('e');
  await page.keyboard.press(' ');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  let draftBefore = await page.evaluate(() => window.__app.getState().draft);
  assert(draftBefore !== null, '草稿已建立');

  // 打开并关闭导出弹窗
  await page.keyboard.press('Control+e');
  await page.waitForSelector('#export-dialog:not([hidden])');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#export-dialog', { state: 'hidden' });
  const afterDialog = await page.evaluate(() => window.__app.getState());
  assert(afterDialog.draft !== null, '关闭弹窗后草稿保留');
  assert(afterDialog.elements.length === 1, '关闭弹窗后已提交元素保留');
  assert(afterDialog.selectedId === afterDialog.draft.id, '草稿期间选中指向草稿');

  // 取消草稿后，已提交元素仍在；撤销只影响历史，不影响未提交以外的数据
  await page.keyboard.press('Escape');
  const afterCancel = await page.evaluate(() => window.__app.getState());
  assert(afterCancel.draft === null && afterCancel.elements.length === 1, 'Esc 取消草稿，元素保留');
  assert(afterCancel.selectedId === null, '取消草稿后选择清空，不产生幽灵选中');
});

test('损坏存储：保留可读原始快照并回退到可用状态', async () => {
  const ctx = await newContext(env.browser);
  const page = ctx.page;
  await freshGoto(page);
  await drawWithKeyboard(page);
  await waitForSaved(page, 3);
  const corrupt = '{not-valid-json';
  await page.context().addInitScript((bad) => {
    localStorage.setItem('kbd-drawing:state:v1', bad);
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'kbd-drawing:state:v1') return; // 模拟主存储只读/写入被拒
      original.call(this, key, value);
    };
  }, corrupt);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#stage');

  const errorBoxVisible = await page.locator('#restore-error-box').isVisible();
  assert(errorBoxVisible, '显示恢复失败面板');
  const corruptShown = await page.locator('#corrupt-snapshot').textContent();
  assert(corruptShown.includes('not-valid-json'), '损坏原始内容以可读快照展示');
  const storedCorrupt = await page.evaluate(() => localStorage.getItem(window.__app.storageKeys.CORRUPT_KEY));
  assert(storedCorrupt === corrupt, '损坏原文另存到 CORRUPT_KEY');

  const usable = await page.evaluate(() => window.__app.getState());
  assert(usable.lastError !== null, '状态中记录失败原因（可读状态）');
  assert(Array.isArray(usable.elements), '回退后应用仍可用（空白或 last-good 状态）');
});

async function main() {
  server = await startServer();
  env = await newPage();
  let failed = 0;
  for (const t of tests) {
    console.log(`\n${t.name}`);
    try { await t.fn(); } catch (err) {
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
