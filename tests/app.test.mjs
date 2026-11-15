import assert from 'node:assert/strict';
import { installDom } from './dom-stub.mjs';

const dom = installDom();
const { SubAppMod } = await import('../src/app.js').then(() => ({ SubAppMod: true }));
// app.js self-bootstraps on DOMContentLoaded; emulate that event.
const { default: _ } = { default: null };

// Re-import after dom installed (module caches fine since globals are read at runtime).
await import('../src/app.js');
// Fire DOMContentLoaded listeners registered on document... app listens on window 'DOMContentLoaded'.
for (const fn of globalThis.window._l?.DOMContentLoaded || []) fn();

const app = globalThis.window.app;
assert.ok(app, 'SubApp should bootstrap');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ✓', name); };

test('starts in READY with full resources and zero timer', () => {
  assert.equal(dom.byId('phase')._text, 'READY');
  assert.equal(dom.byId('tick')._text, '0');
  assert.equal(app.sim.battery, 100);
});

test('manual keyboard input drives the simulation', () => {
  dom.press('ArrowUp');   // station B floods ballast
  dom.pump(30);
  dom.release('ArrowUp');
  assert.ok(app.sim.depth > 5, `should be diving, depth=${app.sim.depth}`);
  assert.equal(app.sim.inputLog.length, 30);
  dom.press('KeyQ'); dom.release('KeyQ');   // light cycles (applied next tick)
  dom.pump(2);
  assert.equal(app.sim.lightMode, 1);
});

test('pause freezes then resume continues', () => {
  const tickBefore = app.sim.tick;
  dom.act('pause').click();
  assert.equal(app.sim.phase, 'PAUSED');
  dom.pump(20);
  assert.equal(app.sim.tick, tickBefore);
  dom.act('pause').click();
  dom.pump(10);
  assert.ok(app.sim.tick > tickBefore);
});

test('autopilot safe mode completes mission through the real app loop', () => {
  dom.act('mode-safe').click();
  dom.pump(3000);
  assert.equal(app.sim.success, true);
  assert.equal(app.sim.collected, 3);
  assert.equal(app.sim.phase, 'SURFACED');
});

test('replay button reports matching hashes in the UI', () => {
  dom.act('replay').click();
  const html = dom.byId('replayResult')._html;
  assert.match(html, /重放 \d+ 帧/);
  assert.match(html, /完全一致/);
});

test('restart resets timer, resources, log and rng through the UI path', () => {
  dom.act('restart').click();
  const s = app.sim;
  assert.equal(s.tick, 0);
  assert.equal(s.timeMs, 0);
  assert.equal(s.battery, 100);
  assert.equal(s.o2, 100);
  assert.equal(s.hull, 100);
  assert.equal(s.depth, 0);
  assert.equal(s.inputLog.length, 0);
  assert.equal(dom.byId('timer')._text, '0.0s');
});

test('mistake mode produces RUNAWAY and recovery restores control', () => {
  dom.act('mode-mistake').click();
  let sawRunaway = false, n = 0;
  while (app.sim.phase !== 'FAILED' && n < 600) { dom.pump(1); sawRunaway = sawRunaway || app.sim.phase === 'RUNAWAY'; n++; }
  assert.equal(app.sim.phase, 'FAILED');
  assert.ok(sawRunaway);
  const failTick = app.sim.tick;
  dom.act('recover').click();
  assert.ok(app.sim.tick < failTick);
  assert.equal(app.sim.phase, 'DIVING');
  // continue under safe autopilot and finish
  dom.act('mode-safe').click();
  dom.pump(3000);
  assert.equal(app.sim.success, true);
});

test('extreme mode reaches a limit failure', () => {
  dom.act('mode-extreme').click();
  let n = 0;
  while (app.sim.phase !== 'FAILED' && n < 600) { dom.pump(1); n++; }
  assert.equal(app.sim.phase, 'FAILED');
  assert.ok(['CRUSH_DEPTH', 'HULL_BREACH'].includes(app.sim.failReason));
});

test('audio context advances without errors across all phases', () => {
  assert.ok(app.audio.ctx, 'Web Audio graph should be created');
  dom.act('restart').click();
  dom.act('mode-safe').click();
  dom.pump(400);
  assert.ok(app.audio.engineOsc);
});

console.log(`\n${passed} app tests passed`);
