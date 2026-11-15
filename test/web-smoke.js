import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

class FakeContext {
  setTransform() {} clearRect() {} fillRect() {} beginPath() {} arc() {} fill() {}
  stroke() {} moveTo() {} lineTo() {} fillText() {} strokeRect() {}
}

class FakeElement {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.textContent = '';
    this.innerHTML = '';
    this.value = '1';
    this.width = 0;
    this.height = 0;
    this.listeners = {};
  }
  getContext() { return new FakeContext(); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 430 }; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, payload = {}) {
    (this.listeners[type] || []).forEach((fn) => fn({ target: this, ...payload }));
  }
  prepend(child) { this.children.unshift(child); }
  appendChild(child) { this.children.push(child); return child; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  removeChild(child) {
    this.children = this.children.filter((item) => item !== child);
  }
  querySelector() { return null; }
}

const ids = new Map();
function element(id, tag = 'div') {
  if (!ids.has(id)) ids.set(id, new FakeElement(tag));
  return ids.get(id);
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key)
};
globalThis.AudioContext = undefined;
globalThis.devicePixelRatio = 1;
globalThis.window = {
  AudioContext: undefined,
  devicePixelRatio: 1,
  addEventListener: () => {}
};
let rafCallback = null;
globalThis.requestAnimationFrame = (fn) => { rafCallback = fn; };
globalThis.performance = { now: () => Date.now() };

globalThis.document = {
  querySelector(selector) {
    const id = selector.replace('#', '');
    const tag = id.startsWith('canvas') ? 'canvas' : 'div';
    return element(id, tag);
  },
  createElement: (tag) => new FakeElement(tag)
};

const intervalIds = new Map();
let intervalSeq = 0;
globalThis.setInterval = (fn, ms) => {
  intervalSeq += 1;
  intervalIds.set(intervalSeq, fn);
  return intervalSeq;
};
globalThis.clearInterval = (id) => intervalIds.delete(id);
globalThis.setTimeout = (fn) => { fn(); return 0; };

const appUrl = new URL('../web/app.js', pathToFileURL(join(root, 'test/')));
await import(appUrl);
const { Pane } = await import(new URL('../web/renderer.js', pathToFileURL(join(root, 'test/'))));

const canvasLeft = element('canvas-left', 'canvas');
const canvasRight = element('canvas-right', 'canvas');
const feed = element('event-feed');

function click(canvas, x, y, shiftKey = false) {
  canvas.dispatch('click', { clientX: x, clientY: y, shiftKey });
}

function screenOf(pane, worldX, worldY) {
  return pane.project(worldX, worldY);
}

for (let i = 0; i < 5; i += 1) rafCallback(Date.now() + 16);

const leftPaneInstance = new Pane(canvasLeft, 'left');
leftPaneInstance.resize();
leftPaneInstance.scale = leftPaneInstance.baseScale;
const rightPaneInstance = new Pane(canvasRight, 'right');
rightPaneInstance.resize();
rightPaneInstance.scale = rightPaneInstance.baseScale;
const [leftX, leftY] = screenOf(leftPaneInstance, 520, 200);
click(canvasLeft, leftX, leftY);
const placeLine = feed.children[0];
if (!placeLine || !placeLine.textContent.includes('placeMarker')) throw new Error('左侧点击未产生标注事件');

element('undo-left').dispatch('click');
if (!feed.children[0].textContent.includes('undo')) throw new Error('撤销按钮无效');

const [markX, markY] = screenOf(leftPaneInstance, 1000, 160);
click(canvasLeft, markX, markY);
const [verifyX, verifyY] = screenOf(rightPaneInstance, 1000, 160);
click(canvasRight, verifyX, verifyY);
if (!feed.children.some((line) => line.textContent.includes('"approved":true'))) {
  throw new Error('右侧验证未成功');
}

const [wp1x, wp1y] = screenOf(rightPaneInstance, 300, 410);
const [wp2x, wp2y] = screenOf(rightPaneInstance, 960, 410);
click(canvasRight, wp1x, wp1y, true);
click(canvasRight, wp2x, wp2y, true);
element('finish-route').dispatch('click');

const saved = JSON.parse(storage.get('disaster-collab-session-v1'));
if (!saved.finalHash || saved.state.timeline.length < 5) throw new Error('本地快照不完整');
const { restoreSession } = await import(new URL('../src/core/timeline.js', pathToFileURL(join(root, 'test/'))));
const reloaded = restoreSession(storage.get('disaster-collab-session-v1'));
if (reloaded.hash !== saved.finalHash) throw new Error('重新载入后仪表/耐久/进度恢复校验失败');
if (reloaded.state.players.left.durability !== saved.state.players.left.durability) {
  throw new Error('重新载入后耐久不一致');
}

element('demo-success').dispatch('click');
const replayPanel = element('replay-panel');
if (replayPanel.hidden) throw new Error('回放面板未显示');
element('replay-step').dispatch('click');
element('replay-pause').dispatch('click');
element('replay-speed').value = '4';
element('replay-speed').dispatch('change');
element('replay-play').dispatch('click');
for (let i = 0; i < 40; i += 1) intervalIds.forEach((fn) => fn());
const finalText = element('replay-final').textContent;
if (!finalText.includes('一致=true')) throw new Error(`回放终态不一致：${finalText}`);

element('demo-conflict').dispatch('click');
const conflict = element('conflict-panel');
if (conflict.hidden || !conflict.innerHTML.includes('冲突 t=42.0s')) throw new Error('冲突演示缺失');

element('demo-failure').dispatch('click');
for (let i = 0; i < 40; i += 1) intervalIds.forEach((fn) => fn());
if (!element('replay-final').textContent.includes('一致=true')) throw new Error('失败局回放不一致');

console.log(readFileSync(new URL('../web/app.js', import.meta.url)) ? 'web/app.js loaded' : '');
console.log('WEB-SMOKE PASS：点击输入、undo、验证、路线、localStorage 恢复、回放倍速、冲突演示均工作');
