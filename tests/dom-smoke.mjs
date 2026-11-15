// 页面级冒烟测试（jsdom）：验证状态变化后所有视图同步、封路重规划与导出
import { JSDOM } from '/tmp/domtest/node_modules/jsdom/lib/api.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: `file://${root}/index.html`,
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

// jsdom 不实现 canvas 渲染与下载，提供最小桩
window.HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy({}, { get: (t, p) => {
    if (p === 'measureText') return () => ({ width: 10 });
    return typeof t[p] !== 'undefined' ? t[p] : () => {};
  }, set: () => true });
};
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,STUB';
const downloads = [];
let alertMsg = '';
window.alert = (m) => { alertMsg = m; };

const errors = [];
window.addEventListener('error', (e) => errors.push(e.message));

globalThis.window = window;
globalThis.document = window.document;
globalThis.Blob = window.Blob;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
window.URL.createObjectURL = (b) => { downloads.push(b); return 'blob:stub'; };
window.URL.revokeObjectURL = () => {};
globalThis.URL = window.URL;

// jsdom 不执行 module 脚本，直接在注入 DOM 全局后动态导入 app.js
await import(path.join(root, 'src/app.js'));
await new Promise((r) => setTimeout(r, 20));

const $ = (id) => window.document.getElementById(id);
const assert = (name, cond) => {
  if (!cond) { errors.push(name); console.log('  ✗ ' + name); }
  else console.log('  ✓ ' + name);
};

console.log('== 页面初始化 ==');
assert('统计卡片已渲染', $('stats').children.length === 12);
assert('决策日志有内容', $('decision-log').children.length > 0);
assert('调试面板显示中间状态', $('debug-panel').textContent.includes('tick'));
assert('清洗记录展示问题', $('issues-panel').children.length > 10);
assert('道路下拉已填充', $('edge-select').options.length > 5);
assert('顶部显示数据版本', $('meta-version').textContent.includes('v'));

console.log('== 切换样例 B 并封路 ==');
$('sample-select').value = 'B';
$('sample-select').dispatchEvent(new window.Event('change'));
assert('样例 B 元信息更新', $('meta-sample').textContent.includes('sample-b'));
$('edge-select').value = 'AB';
$('edge-select').dispatchEvent(new window.Event('change'));
$('close-from').value = '4';
$('close-to').value = '12';
$('apply-closure').click();
assert('封路后统计出现重规划', $('stats').textContent.includes('重规划'));
assert('调试面板可显示封闭边 AB', (() => {
  $('tick-range').value = '6';
  $('tick-range').dispatchEvent(new window.Event('input'));
  return $('debug-panel').textContent.includes('AB');
})());
assert('版本号在封路后递增', Number($('meta-version').textContent.match(/v(\d+)/)[1]) >= 3);

console.log('== 车辆决策记录联动 ==');
$('vehicle-select').value = 'K1';
$('vehicle-select').dispatchEvent(new window.Event('change'));
const logText = $('decision-log').textContent;
assert('K1 记录含封路重规划', logText.includes('reroute-closure'));
assert('K1 记录含改道路径 AX', logText.includes('AX'));

console.log('== 筛选联动 ==');
$('filter-state').value = 'arrived';
$('filter-state').dispatchEvent(new window.Event('change'));
assert('顶部筛选同步显示', $('meta-filter').textContent.includes('arrived'));

console.log('== CSV 导出与一致性 ==');
$('export-csv').click();
assert('产生 3 个下载 Blob', downloads.length === 3);
assert('导出校验显示一致', $('export-verify').textContent.includes('导出前后完全一致'));
assert('顶部导出口径更新', $('meta-export').textContent.includes('导出口径：v'));

console.log('== PNG 导出 ==');
$('export-png').click();
assert('PNG 导出不报错', alertMsg === '');

console.log('== 工程保存/重载 ==');
$('save-project').click();
assert('重载按钮启用', $('reload-project').disabled === false);
$('remove-closure').click();
const beforeReload = $('stats').textContent;
$('reload-project').click();
assert('重载后恢复封路（重规划统计回归）', $('stats').textContent !== beforeReload);

console.log('== 内置验证按钮 ==');
await $('run-verify').click();
await new Promise((r) => setTimeout(r, 50));
assert('验证输出包含结论', $('verify-output').textContent.includes('验证结论'));
assert('验证零失败', $('verify-output').textContent.includes('/ 0 失败'));

if (errors.length) {
  console.error('\n页面冒烟测试失败：', errors);
  process.exit(1);
}
console.log('\n页面冒烟测试全部通过');
