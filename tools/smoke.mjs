import assert from 'node:assert/strict';
import { installDom } from './dom-shim.mjs';

const registry = installDom();
await import('../src/app.js');

// Start a live success simulation and advance ~2 simulated seconds of frames.
registry['btn-start'].click();
advanceTime(260);
flushFrames(12);

// Both players issue commands through the real UI controls.
registry['p1-gate'].value = 0.2;
registry['p1-gate'].dispatch({ type: 'input' });
registry['p2-pump'].value = 0.7;
registry['p2-pump'].dispatch({ type: 'input' });
document.dispatchKey('e');
document.dispatchKey('.');
advanceTime(260);
flushFrames(12);

// Save and reload through the actual storage path.
registry['btn-save'].click();
assert.match(registry['replay-status'].textContent, /已保存/);
registry['btn-load'].click();
assert.match(registry['replay-status'].textContent, /已恢复/);
assert.match(registry['replay-status'].textContent, /tick=\d+/);

// Toggle audio (shimmed Web Audio) and auto pilot.
await registry['btn-audio'].click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(registry['btn-audio'].textContent, '关闭音频');
registry['btn-auto'].click();

// Run enough frames (auto pilot) for the mission to end and be recorded.
for (let i = 0; i < 7600; i++) {
  flushFrames(1);
  if (registry['replay-status'].textContent.includes('录制完成')) break;
}
assert.match(registry['replay-status'].textContent, /录制完成/);

// Replay controls: play/pause, single step, speed and scrubber.
registry['rp-play'].click();
registry['rp-step'].click();
registry['rp-speed'].value = '4';
registry['rp-speed'].dispatch({ type: 'change' });
registry['rp-scrub'].value = 300;
registry['rp-scrub'].dispatch({ type: 'input' });
registry['rp-restart'].click();
assert.match(registry['replay-status'].textContent, /回放/);

// Exports must be wired without throwing in the shimmed environment.
registry['btn-csv'].click();
registry['btn-svg'].click();

console.log('browser app smoke test OK');
