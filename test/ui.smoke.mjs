// UI smoke test: minimal DOM stub, run ui.js for frames, verify no runtime errors
import assert from 'node:assert/strict';

function makeCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(t, k) {
      if (k === 'createLinearGradient') return () => grad;
      if (!(k in t)) t[k] = () => {};
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function makeEl(tag = 'div') {
  const el = {
    tag, children: [], dataset: {}, style: {},
    textContent: '', innerHTML: '', value: '0', disabled: false,
    scrollTop: 0, scrollHeight: 0, width: 960, height: 520,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, appendChild(c) { this.children.push(c); },
    getContext: () => makeCtx(),
    _q: {},
  };
  el.querySelector = function (sel) { return this._q[sel] ?? (this._q[sel] = makeEl()); };
  el.className = '';
  return el;
}

const gates = [0, 1, 2, 'spill'].map(k => {
  const el = makeEl();
  el.dataset.gate = String(k);
  el._q['input[type=range]'] = makeEl('input');
  el._q['.gv'] = makeEl();
  el._q['.repair'] = k === 'spill' ? null : makeEl('button');
  el.querySelector = function (sel) { return this._q[sel] ?? null; };
  return el;
});

const ids = {};
const get = id => ids[id] ?? (ids[id] = makeEl());
get('#speed').value = '3';
get('#scenario').value = 'gateFault';

let rafCb = null;
globalThis.document = {
  querySelector: sel => get(sel),
  querySelectorAll: sel => (sel === '.gate' ? gates : []),
  createElement: () => makeEl(),
};
globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; } };
globalThis.requestAnimationFrame = cb => { rafCb = cb; };
globalThis.window = globalThis;

await import('../js/ui.js');

function frames(n, ts0) {
  let ts = ts0;
  for (let i = 0; i < n; i++) {
    ts += 100;
    const cb = rafCb; rafCb = null;
    if (!cb) break;
    cb(ts);
  }
  return ts;
}

// gateFault scenario, high speed: covers fault injection at t=5400
get('#speed').value = '6';
let ts = frames(4000, 0);

// pause / step / resume
get('#btnPause').onclick();
get('#btnStep').onclick();
get('#btnResume').onclick();
ts = frames(50, ts);

// switch scenario + restart, run to failure, then failure replay
get('#scenario').value = 'extremeFlood';
get('#btnRestart').onclick();
ts = frames(4000, ts);
assert.ok(get('#log').children.length > 0, 'log should have entries');
if (!get('#btnReplayFail').disabled) get('#btnReplayFail').onclick();
ts = frames(200, ts);
console.log('UI smoke OK, log entries:', get('#log').children.length,
  'replay disabled =', get('#btnReplayFail').disabled);
