import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMELINE_SECONDS } from '../src/js/util.js';
import { createDefaultProject } from '../src/js/project.js';
import { PlaybackEngine } from '../src/js/engine.js';
import { MockHost } from '../src/js/mock-host.js';
import { synthesizeAll } from '../src/js/synth.js';

function harness() {
  const host = new MockHost();
  const engine = new PlaybackEngine(host, createDefaultProject(), synthesizeAll());
  return { host, engine };
}

test('start builds a fully connected graph and counts active nodes', async () => {
  const { host, engine } = await harness();
  await engine.start(0);
  assert.equal(engine.status, 'playing');
  const kinds = host.activeNodesByKind();
  assert.deepEqual(kinds, {
    master: 1,
    compressor: 1,
    source: 3,
    fadeGain: 3,
    clipGain: 3,
    panner: 3,
  });
  assert.equal(engine.activeNodeCount, 2 + 3 * 4);
  for (const node of host.nodes.keys()) {
    if (node.kind === 'source') {
      assert.equal(typeof node.stopTime, 'number');
      assert.equal(typeof node.onended, 'function');
    }
  }
  engine.destroy();
});

test('input interruption stops tail sound within the release ramp', async () => {
  const { host, engine } = await harness();
  await engine.start(0);
  host.advance(4.2);
  assert.ok(Math.abs(engine.playhead - 4.2) < 0.05);
  engine.stop();
  const master = [...host.nodes.keys()].find((node) => node.kind === 'master');
  const lastRamp = master.gain.events.at(-1);
  assert.equal(lastRamp.type, 'ramp');
  assert.ok(lastRamp.endTime - host.currentTime <= 0.021);
  assert.equal(lastRamp.value, 0);
  assert.equal(engine.status, 'idle');
  assert.equal(engine.playhead, 0);
  assert.equal(engine.activeNodeCount, 0);
  host.advance(0.5);
  assert.equal(engine.status, 'idle');
  assert.equal(engine.activeNodeCount, 0);
});

test('destroy releases every node and the single frame listener', async () => {
  const { host, engine } = await harness();
  await engine.start(0);
  host.advance(0.3);
  assert.equal(host.frameSubscriptions, 1);
  engine.destroy();
  assert.equal(engine.status, 'destroyed');
  assert.equal(engine.activeNodeCount, 0);
  assert.equal(host.frameUnsubscriptions, 1);
  assert.equal(host._frameCallbacks.size, 0);
  for (const node of host.nodes.keys()) {
    assert.equal(node.closed, true);
    assert.equal(node.connections.length, 0);
    assert.equal(node.onended, null);
  }
  await assert.rejects(() => engine.start(0), /destroyed/);
});

test('repeated start is idempotent with no duplicate listeners or nodes', async () => {
  const { host, engine } = await harness();
  const first = engine.start(0);
  const second = engine.start(2);
  assert.equal(await first, await second);
  assert.equal(host.frameSubscriptions, 1);
  assert.equal(engine.activeNodeCount, 2 + 3 * 4);
  host.advance(0.4);
  engine.destroy();
});

test('stop/start cycles do not accumulate nodes', async () => {
  const { host, engine } = await harness();
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await engine.start(cycle * 1.5);
    host.advance(0.2);
    engine.stop();
    assert.equal(engine.activeNodeCount, 0);
  }
  assert.equal(host.frameSubscriptions, 1);
  engine.destroy();
});

test('playhead follows the audio clock and auto-stops at the end', async () => {
  const { host, engine } = await harness();
  const seen = [];
  engine.onPlayhead((time) => seen.push(time));
  await engine.start(0);
  host.advance(TIMELINE_SECONDS + 0.1);
  assert.equal(engine.status, 'idle');
  assert.equal(engine.playhead, 0);
  assert.ok(seen.at(-2) >= TIMELINE_SECONDS - 0.05);
  assert.equal(engine.activeNodeCount, 0);
  engine.destroy();
});

test('status and playhead listeners are removed on destroy', async () => {
  const { host, engine } = await harness();
  let statusEvents = 0;
  let playheadEvents = 0;
  engine.onStatus(() => { statusEvents += 1; });
  engine.onPlayhead(() => { playheadEvents += 1; });
  await engine.start(0);
  host.advance(0.1);
  engine.destroy();
  const statusAfter = statusEvents;
  const playheadAfter = playheadEvents;
  host.advance(0.5);
  assert.equal(statusEvents, statusAfter);
  assert.equal(playheadEvents, playheadAfter);
});

test('no tail sound or new nodes appear after the release window', async () => {
  const { host, engine } = await harness();
  await engine.start(0);
  host.advance(2);
  const beforeStop = host.nodes.size;
  engine.stop();
  const sources = [...host.nodes.keys()].filter((node) => node.kind === 'source');
  assert.ok(sources.every((node) => typeof node.stopTime === 'number' && node.stopped));
  assert.ok(sources.every((node) => node.stopTime <= host.currentTime + 0.021));
  host.advance(2);
  assert.equal(host.nodes.size, beforeStop);
  assert.ok([...host.nodes.keys()].every((node) => node.closed));
  assert.equal(engine.activeNodeCount, 0);
  engine.destroy();
});
