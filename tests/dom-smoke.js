import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const html = readFileSync(resolve(root, 'web/index.html'), 'utf8');
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => console.error('jsdomError:', error?.stack || error));
const dom = new JSDOM(html, {
  url: 'http://localhost/web/index.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole,
});

global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Blob = dom.window.Blob;
global.URL = dom.window.URL;
global.URL.createObjectURL = () => 'blob:smoke-test';
global.URL.revokeObjectURL = () => {};
global.localStorage = dom.window.localStorage;
dom.window.HTMLAnchorElement.prototype.click = function click() {};

try {
  await import(pathToFileURL(resolve(root, 'web/app.js')).href);
} catch (error) {
  console.error(error);
  throw error;
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
await sleep(50);

const $ = (selector) => document.querySelector(selector);
const assert = (condition, message) => {
  if (!condition) throw new Error(`DOM 冒烟失败: ${message}`);
};

assert($('#timeline').querySelectorAll('.track-row').length === 6, '应渲染 6 条轨道');
assert($('#timeline').querySelectorAll('.clip').length === 15, '样例A 应渲染 15 个片段');
assert($('#timeline').querySelectorAll('.gap-marker').length >= 6, '每轨至少应有空洞标记');
assert($('#debug-panel').children.length >= 2, '调试面板应展示入库与标记两个中间状态');
assert($('#meta-version').textContent === 'v1', '初始数据版本应为 v1');

$('#filter-kind').value = 'audio';
$('#filter-kind').dispatchEvent(new dom.window.Event('change'));
const visibleCount = [...$('#timeline').querySelectorAll('.clip')].filter((node) => !node.classList.contains('hidden-by-filter')).length;
assert(visibleCount === 5, `音频筛选后应只见 5 个片段，实际 ${visibleCount}`);
assert($('#meta-filter').textContent.includes('audio'), '页眉当前筛选应同步更新');
$('#filter-kind').value = 'all';
$('#filter-kind').dispatchEvent(new dom.window.Event('change'));

const firstVideo = [...document.querySelectorAll('.clip')].find((node) => node.classList.contains('kind-video'));
firstVideo.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
$('#split-button').click();
assert($('#timeline').querySelectorAll('.clip').length === 16, '分割后应新增一个片段');
assert($('#meta-version').textContent === 'v4', '两次筛选(v3)+分割后应为 v4');

$('#illegal-button').click();
assert($('#toast').textContent.includes('已阻止'), '非法重叠应显示阻止提示');
assert($('#meta-version').textContent === 'v4', '非法重叠被阻止后版本应保持 v4');
assert([...$('#debug-panel').children].some((node) => node.classList.contains('bad')), '调试面板应记录被阻止的中间状态');

$('#playhead-input').value = '22';
$('#playhead-input').dispatchEvent(new dom.window.Event('change'));
assert($('#preview-video').textContent.includes('板书讲解'), '22s 画面应同步命中 v2');
assert($('#preview-audio').textContent.includes('教师领夹麦'), '22s 音频应同步命中');
assert($('#preview-subtitle').textContent.includes('page 12'), '22s 字幕应同步命中');

$('#save-button').click();
const saved = JSON.parse(localStorage.getItem('multimedia-timeline-project-v1'));
assert(saved.clips.length === 16, '保存工程应包含分割后的 16 个对象');
$('#reload-button').click();
assert($('#meta-version').textContent === 'v4', '重载后版本保持 v4');
assert($('#timeline').querySelectorAll('.clip').length === 16, '重载后片段数保持 16');

$('#scope-all').click();
$('#export-button').click();
assert($('#debug-panel').textContent.includes('导出报告'), '调试面板应记录导出中间状态');

$('#run-self-check').click();
await sleep(100);
const selfCheckText = $('#self-check-results').textContent;
const passCount = (selfCheckText.match(/PASS/g) || []).length;
assert(passCount === 11 && !selfCheckText.includes('FAIL'), `浏览器内嵌 11 项自检应全部通过，实际 PASS=${passCount}`);

console.log('DOM 冒烟测试通过：渲染、筛选、分割、非法重叠阻止、播放头同步、保存/重载、导出、内嵌自检全部正常');
