// 浏览器端冒烟测试: 用 DOM 桩件加载 render/main, 跑若干帧并模拟操作
'use strict';
const fs = require('fs');
const vm = require('vm');

function el() {
  return { innerHTML: '', textContent: '', value: '4', dataset: {},
           style: {}, scrollTop: 0, scrollHeight: 0,
           getContext: () => new Proxy({}, { get: () => () => {} }),
           addEventListener: () => {}, width: 420, height: 640 };
}
const elems = {};
const handlers = {};
const sandbox = {
  console, alert: () => {},
  document: {
    getElementById: id => (elems[id] = elems[id] || el()),
    addEventListener: (ev, fn) => { handlers[ev] = fn; }
  },
  requestAnimationFrame: () => {}, // 手动驱动
  self: null
};
sandbox.self = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

for (const f of ['js/sim.js', 'js/render.js', 'js/audio.js', 'js/main.js']) {
  vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: f });
}

// 模拟点击: 入队若干任务 + 重排
const click = handlers.click;
click({ target: { dataset: { enq: 'W9', kind: 'worker' } } });
click({ target: { dataset: { enq: 'W8', kind: 'worker' } } });
click({ target: { dataset: { enq: 'EA', kind: 'equipment' } } });
click({ target: { dataset: { up: '1' } } });

const S = sandbox.MineSim;
// main.js 内部 sim 不可达, 但面板应已渲染
if (!elems.queue.innerHTML.includes('W9')) throw new Error('队列未渲染');
if (!elems.status.innerHTML.includes('电量')) throw new Error('状态栏未渲染');
if (!elems.clock.textContent.includes('tick=')) throw new Error('时钟未渲染');
console.log('✔ 浏览器端冒烟测试通过 (DOM 桩件下渲染与交互正常)');
