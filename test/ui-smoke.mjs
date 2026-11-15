// 前端冒烟测试：用最小 DOM 桩加载 main.js，验证实时推进、存档恢复、回放模式
// 运行：node test/ui-smoke.mjs
import { readFileSync } from 'node:fs';

const listeners = { window: {} };
const elements = new Map();
function makeEl(id) {
  const el = {
    id, style: {}, textContent: '', children: [],
    firstElementChild: null,
    addEventListener(type, fn) { (el._h ??= {})[type] = fn; },
    getContext: () => new Proxy({}, { get: () => () => {} }),
  };
  el.firstElementChild = { style: {} };
  return el;
}
const store = new Map();
let rafCb = null;

globalThis.window = {
  addEventListener(type, fn) { listeners.window[type] = fn; },
  AudioContext: undefined, webkitAudioContext: undefined,
};
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  },
};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.performance = { now: () => simTime };
globalThis.requestAnimationFrame = (cb) => { rafCb = cb; };
let simTime = 0;

await import('../src/main.js');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.error(`  FAIL ${name} ${detail}`); }
};

function runFrames(n) {
  for (let i = 0; i < n; i++) {
    simTime += 1000 / 60;
    const cb = rafCb;
    rafCb = null;
    cb(simTime);
  }
}

console.log('== UI 冒烟：实时推进 + 输入 ==');
runFrames(10);
check('画布与仪表元素就绪', elements.has('cv') && elements.has('tensionVal'));
listeners.window.keydown({ code: 'KeyS', preventDefault() {} });
runFrames(120);
listeners.window.keyup({ code: 'KeyS' });
runFrames(60);
const tensionText = elements.get('tensionVal').textContent;
check('张力仪表有读数', /kN/.test(tensionText), tensionText);
check('进度点显示为未连接', elements.get('dots').textContent.includes('○'));

console.log('== UI 冒烟：过早松钩失败 + 存档 ==');
listeners.window.keydown({ code: 'KeyE', preventDefault() {} });
runFrames(30);
check('状态栏显示失败原因',
  /松钩过早/.test(elements.get('status').textContent),
  elements.get('status').textContent);
check('本地存档已写入', store.has('bridge-install-save-v1'));
const savedDurability = JSON.parse(store.get('bridge-install-save-v1'));
check('存档含事件与 tick', savedDurability.tick > 0 && Array.isArray(savedDurability.events));

console.log('== UI 冒烟：回放模式（暂停/单步/倍速） ==');
elements.get('btnReplay')._h.click();
runFrames(30);
check('回放信息栏出现', /回放 tick/.test(elements.get('replayInfo').textContent));
elements.get('btnPlayPause')._h.click(); // 暂停
const before = elements.get('replayInfo').textContent;
runFrames(30);
check('暂停后画面静止', elements.get('replayInfo').textContent === before);
elements.get('btnStep')._h.click();
runFrames(1);
check('单步可推进', elements.get('replayInfo').textContent !== before);
elements.get('btnSpeed')._h.click();
check('倍速切换', /0\.5x|1x|2x|4x/.test(elements.get('btnSpeed').textContent));
runFrames(6000); // 快进到回放结束
check('回放到达终局（failed）', /failed/.test(elements.get('replayInfo').textContent),
  elements.get('replayInfo').textContent);
elements.get('btnExitReplay')._h.click();

console.log('== UI 冒烟：重置清空存档 ==');
elements.get('btnReset')._h.click();
check('重置后存档清除', !store.has('bridge-install-save-v1'));

console.log(failures === 0 ? '\nUI 冒烟测试通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
