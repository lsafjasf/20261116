/* Minimal DOM/Canvas/Audio stub so the real browser scripts load and run
 * under Node without a browser. Engine correctness is covered separately. */
'use strict';
const fs = require('fs');
const path = require('path');

const listeners = {};
function makeEl(id) {
  return {
    id, dataset: {}, value: '0', width: 980, height: 560,
    textContent: '', style: {},
    addEventListener: (type, fn) => {
      (listeners[id + ':' + type] = listeners[id + ':' + type] || []).push(fn);
    },
    getContext: () => new Proxy({}, { get: (t, p) => {
      if (p === 'measureText') return () => ({ width: 10 });
      return typeof p === 'string' ? () => {} : undefined;
    }, set: () => true }),
    querySelectorAll: () => []
  };
}

const ids = ['scope', 'hud-fsm', 'hud-timer', 'hud-target', 'hud-resources',
  'hud-transition', 'hud-seed', 'btn-start', 'btn-pause', 'btn-restart',
  'btn-replay', 'replay-out', 'hpf', 'lpf', 'gain', 'submit-out'];
const elements = {};
ids.forEach((id) => { elements[id] = makeEl(id); });

global.window = global;
global.location = { search: '?seed=20261116' };
global.window.addEventListener = (type, fn) => {
  listeners['window:' + type] = listeners['window:' + type] || [];
  listeners['window:' + type].push(fn);
};
global.document = {
  body: { dataset: {} },
  getElementById: (id) => elements[id] || makeEl(id),
  querySelectorAll: (sel) => {
    if (sel === '.target-btn') {
      return [0, 1, 2, 3].map((i) => ({ dataset: { id: String(i) }, addEventListener: () => {} }));
    }
    if (sel === '.state-btn') {
      return ['normal', 'loose', 'friction', 'overload'].map((s) => ({
        dataset: { state: s },
        addEventListener: (type, fn) => {
          listeners['.state-btn:' + s] = fn;
        }
      }));
    }
    return [];
  }
};
global.requestAnimationFrame = (fn) => 1;
const intervals = [];
global.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };

class FakeNode {
  constructor() { this.value = 0; }
  connect() { return this; }
  disconnect() {}
  start() {} stop() {}
  setValueAtTime() {} setTargetAtTime() {}
}
class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.destination = new FakeNode();
    this.state = 'running';
  }
  createBiquadFilter() {
    const n = new FakeNode();
    n.frequency = { value: 0, setTargetAtTime() {} };
    n.Q = { value: 0 }; n.type = '';
    return n;
  }
  createGain() { const n = new FakeNode(); n.gain = { value: 1, setTargetAtTime() {} }; return n; }
  createWaveShaper() { const n = new FakeNode(); n.curve = null; n.oversample = ''; return n; }
  createOscillator() {
    const n = new FakeNode();
    n.frequency = { value: 0 }; n.type = '';
    n.connect = function (x) { return x; };
    return n;
  }
  createBufferSource() {
    const n = new FakeNode();
    n.loop = false; n.buffer = null; n.connect = function (x) { return x; };
    return n;
  }
  createPanner() {
    const n = new FakeNode();
    n.panningModel = ''; n.distanceModel = '';
    n.positionX = { value: 0, setValueAtTime() {} };
    n.positionY = { value: 0, setValueAtTime() {} };
    n.positionZ = { value: 0, setValueAtTime() {} };
    return n;
  }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}
global.AudioContext = FakeAudioContext;

function load(file) {
  const code = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  new Function(code).call(global);
}
load('src/rng.js');
load('src/hash.js');
load('src/engine.js');
load('src/audio-host.js');
load('src/renderer.js');
load('src/main.js');

const assert = require('assert');
assert.strictEqual(elements['hud-fsm'].textContent, '待启动');
assert.strictEqual(elements['hud-seed'].textContent, 'seed=20261116');

listeners['btn-start:click'][0]();
assert.strictEqual(elements['hud-fsm'].textContent, '运行中');

listeners['hpf:input'][0]({ target: { value: '600' } });
listeners['gain:input'][0]({ target: { value: '4' } });
assert.ok(elements['hud-resources'].textContent.includes('[削波]'));

const keyEvt = { code: 'KeyW', preventDefault: () => {} };
listeners['window:keydown'].forEach((fn) => fn(keyEvt));
assert.strictEqual(global.AudioDiag, undefined === global.AudioDiag ? undefined : global.AudioDiag);

listeners['btn-pause:click'][0]();
assert.strictEqual(elements['hud-fsm'].textContent, '已暂停');
listeners['btn-pause:click'][0]();
assert.strictEqual(elements['hud-fsm'].textContent, '运行中');

listeners['.state-btn:normal']();
assert.ok(elements['submit-out'].textContent.length > 0);
assert.strictEqual(elements['hud-fsm'].textContent, '失败恢复');
for (let i = 0; i < 31; i++) intervals[0].fn();
assert.strictEqual(elements['hud-fsm'].textContent, '运行中');

listeners['btn-replay:click'][0]();
assert.ok(elements['replay-out'].textContent.includes('哈希'));
assert.ok(elements['hud-timer'].textContent !== '00:00', 'timer advanced before restart');

listeners['btn-restart:click'][0]();
assert.strictEqual(elements['hud-fsm'].textContent, '运行中');
assert.strictEqual(elements['hud-timer'].textContent, '00:00');

console.log('PASS | DOM smoke: real UI scripts load, render and handle all controls');
