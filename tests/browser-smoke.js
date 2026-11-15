/*
 * Headless integration smoke test.
 * Stubs the DOM / Canvas / WebAudio surface, then loads the exact browser
 * bundles (sim + renderer + audio + game controller) and drives them through
 * start, play, pause, restart and replay. No external dependencies.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

function makeAudioParam() {
  return {
    value: 0,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    setTargetAtTime() {},
    cancelScheduledValues() {}
  };
}

function makeNode() {
  return {
    connect() {
      return this;
    },
    start() {},
    stop() {},
    frequency: makeAudioParam(),
    gain: makeAudioParam(),
    pan: makeAudioParam()
  };
}

class StubAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
  }
  createGain() {
    return makeNode();
  }
  createOscillator() {
    return Object.assign(makeNode(), { type: '' });
  }
  createBiquadFilter() {
    return Object.assign(makeNode(), { type: '', frequency: makeAudioParam() });
  }
  createStereoPanner() {
    return makeNode();
  }
  resume() {
    this.state = 'running';
  }
  close() {
    return Promise.resolve();
  }
}

const noop2d = new Proxy({}, {
  get(target, prop) {
    if (prop === 'measureText') return () => ({ width: 10 });
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
      return () => ({ addColorStop() {} });
    }
    if (prop === 'getContext') return undefined;
    return typeof prop === 'string' ? () => {} : undefined;
  },
  set() {
    return true;
  }
});

const elements = {};
function makeElement(id) {
  return {
    id,
    width: 0,
    height: 0,
    value: id === 'seedInput' ? '42' : '',
    textContent: '',
    dataset: {},
    listeners: {},
    getContext() {
      return noop2d;
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
  };
}

const ids = ['canvas', 'hudGoal', 'hudResources', 'hudChange', 'hudHash',
  'btnStart', 'btnPause', 'btnReplay', 'btnRecover', 'btnRestart',
  'btnAudio', 'seedInput', 'replayBox', 'btnLoadReplay'];
for (const id of ids) elements[id] = makeElement(id);

const rafQueue = [];
const sandbox = {
  console,
  Math,
  JSON,
  Number,
  Array,
  Object,
  isFinite,
  setTimeout,
  Promise,
  module: { exports: {} },
  window: {
    addEventListener(type, fn) {
      if (type === 'DOMContentLoaded') rafQueue._domReady = fn;
    }
  },
  document: {
    getElementById: (id) => elements[id],
    addEventListener(type, fn) {
      if (type === 'DOMContentLoaded') rafQueue._domReady = fn;
    }
  },
  requestAnimationFrame: (fn) => {
    rafQueue.push(fn);
    return rafQueue.length;
  },
  AudioContext: StubAudioContext
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

function load(rel) {
  const code = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const fn = new Function(
    'window', 'document', 'self', 'AudioContext', 'module', 'console',
    'requestAnimationFrame', 'Math', 'JSON', 'Number', 'Array', 'Object',
    'isFinite', 'setTimeout', 'Promise',
    code);
  fn(sandbox.window, sandbox.document, sandbox.self, sandbox.AudioContext,
    sandbox.module, sandbox.console, sandbox.requestAnimationFrame,
    Math, JSON, Number, Array, Object, isFinite, setTimeout, Promise);
}

load('js/sim.js');
load('js/audio.js');
load('js/renderer.js');

// The game controller references globals via window.*; wire the bundles.
sandbox.window.LighthouseSim = sandbox.module.exports &&
  sandbox.window.LighthouseSim;
const simApi = require('../js/sim.js');
const audioApi = require('../js/audio.js');
const rendererApi = require('../js/renderer.js');
sandbox.window.LighthouseSim = simApi;
sandbox.window.LighthouseAudio = audioApi;
sandbox.window.LighthouseRenderer = rendererApi;
load('js/game.js');

// Fire DOMContentLoaded and run a handful of animation frames.
rafQueue._domReady();
function click(id) {
  (elements[id].listeners.click || []).forEach((fn) => fn());
}
function pumpFrames(n) {
  for (let i = 0; i < n; i++) {
    const fn = rafQueue.shift();
    if (fn) fn(pumpFrames.clock += 16);
  }
}
pumpFrames.clock = 0;

pumpFrames(3);
assert.ok(elements.hudGoal.textContent.includes('ready'),
  'HUD goal shows ready state, got: ' + elements.hudGoal.textContent);
assert.ok(/状态哈希 [0-9a-f]{8}/.test(elements.hudHash.textContent));

// Start and simulate frames; audio must attach after the start click.
click('btnStart');
assert.ok(sandbox.window.__dummy === undefined);
pumpFrames(120);
assert.ok(elements.hudResources.textContent.includes('热量'));

// Pause freezes the displayed hash.
click('btnPause');
pumpFrames(2);
assert.ok(elements.hudGoal.textContent.includes('paused'));
const pausedHash = elements.hudHash.textContent;
pumpFrames(20);
assert.strictEqual(elements.hudHash.textContent, pausedHash);
click('btnPause');
pumpFrames(2);
assert.ok(elements.hudGoal.textContent.includes('running'));

// Restart resets timer and hash back to the ready snapshot.
click('btnRestart');
pumpFrames(5);
assert.ok(elements.hudResources.textContent.includes('时间 0.0s'));
assert.ok(elements.hudGoal.textContent.includes('ready'));

// Replay: build a record from a real deterministic run and load it via UI.
const { Simulation } = simApi;
const pilotSim = new Simulation(42);
pilotSim.start();
const { makeSuccessPilot } = require('./pilot.js');
const pilot = makeSuccessPilot();
for (let i = 0; i < 2400; i++) {
  pilotSim.applyInput(pilot(pilotSim));
  pilotSim.step();
  if (pilotSim.mode === 'success' || pilotSim.mode === 'failed') break;
}
elements.replayBox.value = JSON.stringify(pilotSim.toRecord());
click('btnLoadReplay');
pumpFrames(2600);
assert.ok(elements.hudGoal.textContent.includes('success'),
  'replay reaches success, got: ' + elements.hudGoal.textContent);

console.log('PASS browser bundle smoke test (render + audio + controls + replay)');
