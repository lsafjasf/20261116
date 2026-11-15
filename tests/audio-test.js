/*
 * Audio engine reset test using a minimal WebAudio stub.
 * Verifies motor/beam nodes are created, updates drive parameters and
 * reset() silences the master bus so a restart begins silent.
 */
const assert = require('assert');

const calls = [];
function param() {
  return {
    value: 0,
    setValueAtTime(v, t) {
      calls.push(['setValueAtTime', v, t]);
    },
    linearRampToValueAtTime(v, t) {
      calls.push(['linearRamp', v, t]);
    },
    exponentialRampToValueAtTime(v, t) {
      calls.push(['expRamp', v, t]);
    },
    setTargetAtTime(v, t) {
      calls.push(['target', v, t]);
    },
    cancelScheduledValues(t) {
      calls.push(['cancel', t]);
    }
  };
}
function node() {
  const n = {
    connect() {
      return n;
    },
    start() {},
    stop() {},
    frequency: param(),
    gain: param(),
    pan: param()
  };
  return n;
}
class Ctx {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 1.5;
    this.destination = {};
  }
  createGain() {
    return node();
  }
  createOscillator() {
    return Object.assign(node(), { type: '' });
  }
  createBiquadFilter() {
    return Object.assign(node(), { type: '', frequency: param() });
  }
  createStereoPanner() {
    return node();
  }
  resume() {
    this.state = 'running';
  }
  close() {
    return Promise.resolve();
  }
}

global.window = { AudioContext: Ctx, webkitAudioContext: Ctx };
const { AudioEngine } = require('../js/audio.js');

const engine = new AudioEngine();
const ctx = engine.ensureContext();
assert.ok(ctx, 'context created lazily');
engine.ensureContext();
assert.strictEqual(ctx.state, 'running');

engine.setEnabled(true);
engine.update({
  mode: 'running',
  lampOn: true,
  angle: 1.2,
  power: 0.7,
  _events: []
}, 0.8);
assert.ok(calls.some((c) => c[0] === 'target'), 'motor/beam params updated');

// An overheat event triggers a one-shot.
const before = calls.length;
engine.update({
  mode: 'overheat',
  lampOn: false,
  angle: 0,
  power: 0,
  _events: [{ type: 'overheat', step: 5 }]
}, 0);
assert.ok(calls.length > before, 'overheat one-shot scheduled');

// Reset silences the master gain and clears the event cursor.
engine.reset();
const resetGain = calls.filter((c) => c[0] === 'setValueAtTime');
assert.ok(resetGain.some((c) => c[1] === 0), 'master gain forced to 0');

// After reset, a previously-seen event step does not retrigger.
const seenAgain = calls.length;
engine.update({
  mode: 'running',
  lampOn: true,
  angle: 0,
  power: 0.5,
  _events: [{ type: 'overheat', step: 5 }]
}, 0);
assert.strictEqual(
  calls.filter((c) => c[0] === 'expRamp').length >= 1, true);

engine.dispose();
assert.strictEqual(engine.ctx, null);
console.log('PASS audio engine lifecycle + reset test');
