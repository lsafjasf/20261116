import { writeFileSync } from 'node:fs';
import { renderScenario, measurePeak } from '../src/offline-runner.js';

let passCount = 0;
let failCount = 0;

export function check(name, condition, detail = '') {
  if (condition) {
    passCount += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failCount += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return Boolean(condition);
}

export function summary() {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exitCode = 1;
  return { passCount, failCount };
}

export function section(title) {
  console.log(`\n=== ${title} ===`);
}

export function saveWav(path, buffer) {
  writeFileSync(path, Buffer.from(buffer));
}

export function saveJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

// Beat gaps on a fixed grid must all equal one quarter note exactly.
export function analyzeBeatGrid(engine) {
  const beats = engine.events.filter((e) => e.kind === 'beat');
  const gaps = [];
  for (let i = 1; i < beats.length; i++) gaps.push(beats[i].time - beats[i - 1].time);
  return { beats, gaps };
}

export { renderScenario, measurePeak };
