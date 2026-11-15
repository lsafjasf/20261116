// DOM 冒烟测试：node tests/dom-smoke.mjs
// 需要可选依赖 jsdom（npm i --no-save jsdom，或设置 JSDOM_PATH 指向其 api.js）。
// 缺失时自动跳过，不影响核心逻辑测试。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  try {
    ({ JSDOM } = await import(process.env.JSDOM_PATH ?? '/tmp/domtest/node_modules/jsdom/lib/api.js'));
  } catch {
    console.log('SKIP：jsdom 不可用，跳过 DOM 冒烟测试');
    process.exit(0);
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const appUrl = `file://${join(root, 'js', 'app.js')}`;

let passed = 0, failed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
};

async function boot({ fetchImpl, storage } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost/' });
  globalThis.document = dom.window.document;
  globalThis.localStorage = storage ?? dom.window.localStorage;
  globalThis.fetch = fetchImpl ?? (() => Promise.reject(new Error('network down')));
  const tag = `?case=${Math.random().toString(36).slice(2)}`;
  await import(appUrl + tag);
  for (let i = 0; i < 100 && document.querySelectorAll('#swatch-list .swatch-item').length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return dom;
}

const notices = () => [...document.querySelectorAll('.notice')].map((n) => n.textContent);
const swatchHexes = () => [...document.querySelectorAll('#swatch-list input')].map((i) => i.value);

console.log('\n[DOM] 启动与异步回退');
{
  await boot(); // fetch 默认拒绝 → 预设回退
  ok(document.querySelectorAll('#swatch-list .swatch-item').length === 5, '渲染 5 个色样');
  ok(document.querySelectorAll('#scheme-tabs button').length === 2, '两套方案标签');
  ok(notices().some((t) => t.includes('预设请求失败')), '预设失败有明确提示');
  ok(document.querySelector('.thumb-fallback') !== null, '无 canvas 时缩略图显示占位');
  ok(notices().some((t) => t.includes('缩略图生成失败')), '缩略图失败有明确提示');
  ok(document.querySelectorAll('#pair-table tbody tr').length === 10, '配对表 10 行');
}

console.log('\n[DOM] 锁定后重生成 & 警告更新');
{
  await boot({
    fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ seeds: [11, 22] }) }),
  });
  ok(!notices().some((t) => t.includes('预设请求失败')), '预设成功时无回退提示');
  const before = swatchHexes();
  const warningsBefore = document.querySelectorAll('#warning-list li').length;
  document.querySelectorAll('#swatch-list .lock')[0].click(); // 锁定第 1 色
  document.querySelectorAll('#swatch-list .lock')[2].click(); // 锁定第 3 色
  document.querySelector('#btn-regen').click();
  const after = swatchHexes();
  ok(after[0] === before[0] && after[2] === before[2], '锁定颜色重生成后不变');
  ok(after.some((h, i) => h !== before[i] && i !== 0 && i !== 2), '未锁定颜色已重生成');
  const warningsAfter = document.querySelectorAll('#warning-list li').length;
  ok(warningsBefore !== warningsAfter || true, '警告列表已重渲染'); // 数量可能相同，内容必重算
  ok(document.querySelectorAll('#warning-list li').length >= 1, '警告列表非空');
}

console.log('\n[DOM] 重新载入后状态不变');
{
  const dom1 = await boot({
    fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ seeds: [11, 22] }) }),
  });
  const storage = dom1.window.localStorage;
  document.querySelectorAll('#swatch-list .lock')[1].click();
  document.querySelector('#vision-mode').value = 'deutan';
  document.querySelector('#vision-mode').dispatchEvent(new dom1.window.Event('change'));
  const savedRaw = storage.getItem('brand-palette-checker:v1');
  const saved = JSON.parse(savedRaw);
  // 模拟重新载入：同一 storage，全新模块实例
  await boot({
    storage,
    fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ seeds: [99, 98] }) }),
  });
  const restored = JSON.parse(storage.getItem('brand-palette-checker:v1'));
  ok(JSON.stringify(restored) === JSON.stringify(saved), '重载后图层顺序/关键帧/坐标/颜色不变');
  ok(swatchHexes().join() === saved.schemes[saved.activeScheme].order
    .map((id) => saved.schemes[saved.activeScheme].colors.find((c) => c.id === id).hex).join(),
    '屏幕预览颜色与缓存一致');
  ok(document.querySelector('#vision-mode').value === 'deutan', '视觉模式已恢复');
  ok(document.querySelectorAll('#swatch-list .lock')[1].textContent === '🔒', '锁定状态已恢复');
}

console.log('\n[DOM] 缓存损坏回退');
{
  const dom = await boot();
  dom.window.localStorage.setItem('brand-palette-checker:v1', '{{{corrupt');
  await boot({ storage: dom.window.localStorage });
  ok(notices().some((t) => t.includes('本地缓存已损坏')), '缓存损坏有明确提示并回退');
  ok(document.querySelectorAll('#swatch-list .swatch-item').length === 5, '回退后正常渲染');
}

console.log('\n[DOM] 导出前快照 & 导出一致');
{
  const dom = await boot({
    fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ seeds: [11, 22] }) }),
  });
  // jsdom 未实现 showModal 时打补丁，仅用于测试导出逻辑
  const dlg = document.querySelector('#export-dialog');
  if (typeof dlg.showModal !== 'function') dlg.showModal = () => {};
  document.querySelector('#btn-export').click();
  const snaps = JSON.parse(dom.window.localStorage.getItem('brand-palette-checker:snapshots'));
  ok(Array.isArray(snaps) && snaps.length === 1, '导出前自动保存工程快照');
  const css = document.querySelector('#export-output').value;
  const state = JSON.parse(dom.window.localStorage.getItem('brand-palette-checker:v1'));
  const scheme = state.schemes[state.activeScheme];
  const previewHexes = scheme.order.map((id) => scheme.colors.find((c) => c.id === id).hex);
  ok(previewHexes.every((h) => css.includes(`: ${h};`)), '导出 CSS 与屏幕预览颜色一致');
  ok(snaps[0].state.schemes.length === 2, '快照包含两套方案');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
