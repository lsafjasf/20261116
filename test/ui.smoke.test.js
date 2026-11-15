import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function makeEl(id) {
  return {
    id,
    width: 820,
    height: 560,
    value: id === 'seedInput' ? '42' : id === 'speedRange' ? '2' : '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    className: 'pill',
    listeners: {},
    getContext: () => makeCtx(),
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    click() {
      this.listeners.click?.();
    },
  };
}

function makeCtx() {
  const noop = () => {};
  return new Proxy({
    canvas: {},
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop: noop }),
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return typeof prop === 'string' ? noop : undefined;
    },
    set() {
      return true;
    },
  });
}

test('UI 冒烟：启动/暂停/极限停机/恢复/回放校验路径可用', async () => {
  const ids = [
    'loom', 'btnStart', 'btnPause', 'btnRepair', 'btnReset', 'btnMute', 'btnReplay',
    'btnExport', 'speedRange', 'speedLabel', 'patternSelect', 'seedInput',
    'goalPattern', 'goalLength', 'phasePill', 'faultText', 'resCloth', 'resPicks',
    'resWeft', 'resBobbins', 'resDefects', 'resTime', 'resSpeed', 'lastChange',
    'msgText', 'eventLog', 'hashText',
  ];
  const els = Object.fromEntries(ids.map((id) => [id, makeEl(id)]));
  const rafQueue = [];
  let now = 0;

  globalThis.document = {
    getElementById: (id) => els[id],
    createElement: () => ({ click() {}, set href(v) {}, set download(v) {} }),
    addEventListener: () => {},
  };
  globalThis.performance = { now: () => now };
  globalThis.requestAnimationFrame = (fn) => {
    rafQueue.push(fn);
    return rafQueue.length;
  };
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
  globalThis.Blob = class {
    constructor(parts) {
      this.text = parts.join('');
    }
  };
  globalThis.window = {
    AudioContext: class {
      constructor() {
        this.state = 'running';
        this.currentTime = 0;
        this.destination = {};
      }
      resume() {}
      createOscillator() {
        return {
          type: '',
          frequency: { value: 0, setTargetAtTime() {} },
          connect() {
            return { connect() {} };
          },
          start() {},
          stop() {},
        };
      }
      createGain() {
        return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} }, connect() { return { connect() {} }; } };
      }
    },
  };

  const appPath = join(here, '..', 'web', 'app.js');
  await import(pathToFileURL(appPath).href);

  function frames(seconds) {
    const count = Math.ceil(seconds * 60);
    for (let i = 0; i < count; i++) {
      now += 1000 / 60;
      const fn = rafQueue.shift();
      fn(now);
    }
  }

  els.btnStart.click();
  frames(1);
  assert.equal(els.phasePill.textContent, 'RUNNING');
  frames(2);
  assert.ok(Number(els.resPicks.textContent) > 0);
  els.btnPause.click();
  frames(1);
  assert.equal(els.phasePill.textContent, 'PAUSED');
  els.btnPause.click();
  frames(1);
  assert.equal(els.phasePill.textContent, 'RUNNING');

  els.speedRange.value = '3';
  els.speedRange.listeners.input();
  frames(25);
  assert.equal(els.phasePill.textContent, 'STOPPED');
  assert.ok(['ANOMALY', 'BREAK'].includes(els.faultText.textContent.split(' ')[0]));

  els.btnRepair.click();
  frames(1);
  assert.equal(els.phasePill.textContent, 'READY');

  els.btnReplay.click();
  assert.match(els.hashText.textContent, /回放一致/);

  els.btnReset.click();
  assert.equal(els.phasePill.textContent, 'READY');
  assert.equal(els.resPicks.textContent, '0');
  assert.equal(els.resTime.textContent, '0.0 s');
});
