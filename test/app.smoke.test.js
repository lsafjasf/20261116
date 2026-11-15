import { test } from 'node:test';
import assert from 'node:assert/strict';

class StubElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this._width = 980;
    this._height = 100;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.className = '';
    this.classList = { toggle() {}, add() {}, remove() {} };
  }

  get clientWidth() { return this._width; }
  get clientHeight() { return this._height; }

  append(...nodes) { this.children.push(...nodes); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }
  setPointerCapture() {}
  click() { this.dispatch('click'); }
  getContext() {
    return new Proxy({}, {
      get(target, property) {
        if (property === 'setTransform' || property === 'clearRect' || property === 'fillRect'
          || property === 'fillText' || property === 'beginPath' || property === 'moveTo'
          || property === 'lineTo' || property === 'stroke' || property === 'arc'
          || property === 'strokeRect' || property === 'fill') {
          return () => {};
        }
        return target[property] ?? (target[property] = '');
      },
      set(target, property, value) {
        target[property] = value;
        return true;
      },
    });
  }
}

function installDom() {
  const registry = new Map();
  const make = (id) => {
    if (!registry.has(id)) registry.set(id, new StubElement('input'));
    return registry.get(id);
  };
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
  };
  globalThis.devicePixelRatio = 1;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.document = {
    querySelector: (selector) => make(selector),
    createElement: (tag) => new StubElement(tag),
  };
  globalThis.addEventListener = () => {};
  globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
  globalThis.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };
  return registry;
}

test('app boots against DOM stubs and wires save/restore/export', async () => {
  const registry = installDom();
  const app = await import('../src/js/app.js');
  assert.ok(app);
  const tracks = registry.get('#tracks');
  assert.equal(tracks.children.length, 3);
  const save = registry.get('#saveBtn');
  const restore = registry.get('#restoreBtn');
  const exportButton = registry.get('#exportBtn');
  save.dispatch('click');
  assert.equal(globalThis.localStorage.getItem('soundscape.project') !== null, true);
  restore.dispatch('click');
  assert.match(registry.get('#ioMessage').textContent, /快照恢复一致/);
  exportButton.dispatch('click');
  assert.match(registry.get('#ioMessage').textContent, /已导出/);
  assert.match(registry.get('#engineState').textContent, /未创建/);
});
