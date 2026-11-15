import assert from 'node:assert/strict';
import * as C from '../src/constants.js';
import { createSim, step } from '../src/engine.js';

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ✓', name); };

test('both stations act within the same tick', () => {
  const s = createSim(99);
  const both = [0, 0, 0, 0, 0, 0, 1, 0];
  both[C.INPUT.THRUST] = 1;       // station A: forward
  both[C.INPUT.LIGHT] = 2;        // station A: floodlight
  both[C.INPUT.FLOOD] = 1;        // station B: flood ballast
  step(s, both);
  assert.equal(s.lightMode, 2);
  assert.ok(s.ballast > C.BALLAST_NEUTRAL, 'station B flood must apply in same tick');
  assert.ok(s.vx > 0, 'station A thrust must apply in same tick');
  assert.equal(s.inputLog[0].i[C.INPUT.THRUST], 1);
  assert.equal(s.inputLog[0].i[C.INPUT.FLOOD], 1);
});

test('floodlight reduces effective thrust vs standard light', () => {
  const mk = (light) => {
    const s = createSim(99);
    const inp = [1, light, 0, 0, 0, 0, 1, 0];
    for (let t = 0; t < 20; t++) step(s, inp);
    return s;
  };
  const flood = mk(2);
  const standard = mk(1);
  assert.ok(flood.thrustScale < standard.thrustScale,
    `flood ${flood.thrustScale} should be weaker than standard ${standard.thrustScale}`);
  assert.ok(Math.abs(flood.x) < Math.abs(standard.x), 'floodlight sub travels less far');
});

test('rapid vertical movement swings cabin temperature faster than hovering', () => {
  const dive = createSim(5);
  const hover = createSim(5);
  for (let t = 0; t < 40; t++) step(dive, [0, 1, 1, 0, 0, 0, 1, 0]); // flooding = sinking
  for (let t = 0; t < 40; t++) step(hover, [0, 1, 0, 0, 1, 0, 1, 0]); // neutral
  const swingDive = Math.abs(dive.temp - 20);
  const swingHover = Math.abs(hover.temp - 20);
  assert.ok(swingDive > swingHover, `dive swing ${swingDive} > hover ${swingHover}`);
  assert.ok(dive.depth > hover.depth);
});

test('emergency blow opens valve and drains ballast quickly', () => {
  const s = createSim(5);
  for (let t = 0; t < 20; t++) step(s, [0, 0, 1, 0, 0, 0, 1, 0]); // flood first
  const flooded = s.ballast;
  for (let t = 0; t < 6; t++) step(s, [0, 0, 0, 0, 0, 1, 1, 0]); // blow
  assert.ok(s.ballast < flooded * 0.4);
  assert.equal(s.valveBlow, true);
});

console.log(`\n${passed} crew tests passed`);
