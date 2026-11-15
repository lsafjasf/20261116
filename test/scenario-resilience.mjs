import { OfflineAudioContext } from 'web-audio-engine';
import { SoundtrackEngine } from '../src/engine.js';
import { check, section, saveWav, saveJson, renderScenario, measurePeak } from './lib.mjs';

// 1. Input interruption: immediate stop must leave zero audio tail.
section('interruption: instant stop leaves no tail');
{
  const stopAt = 4.0;
  const { engine, rendered, wav } = await renderScenario({
    durationSeconds: 8,
    params: { bpm: 100, fadeInSeconds: 0.5 },
    events: [
      { t: 0.5, type: 'intensity', value: 0.9 },
      { t: stopAt, type: 'stop', fadeSeconds: 0 },
    ],
  });
  const tailPeak = measurePeak(rendered, stopAt + 0.03, 8);
  const prePeak = measurePeak(rendered, 0.2, 3.9);
  check('audio present before stop', prePeak > 0.02, `pre peak ${prePeak.toFixed(4)}`);
  check('no tail after immediate stop', tailPeak < 1e-4, `tail peak ${tailPeak.toExponential(2)}`);
  check('engine marked stopped', engine.stopped === true);
  saveWav('artifacts/mix-interrupt-stop.wav', wav);
}

// 1b. Faded stop: tail must decay to silence within the fade window.
section('interruption: faded stop decays within fade window');
{
  const stopAt = 4.0;
  const fade = 0.3;
  const { engine, rendered } = await renderScenario({
    durationSeconds: 8,
    params: { bpm: 100 },
    events: [{ t: 0.5, type: 'intensity', value: 0.9 }, { t: stopAt, type: 'stop', fadeSeconds: fade }],
  });
  const afterWindow = measurePeak(rendered, stopAt + fade + 0.1, 8);
  check('silent after fade window', afterWindow < 1e-4, `peak ${afterWindow.toExponential(2)}`);
}

// 2. Node destruction: destroy() must close every node and clear listeners.
section('node destruction: no leaked nodes or listeners');
{
  const ctx = new OfflineAudioContext(2, 44100 * 4, 44100);
  let virtual = 0;
  const engine = new SoundtrackEngine(ctx, { bpm: 100 }, { clock: () => virtual, driver: fakeDriver() });
  const offA = engine.on('state', () => {});
  engine.on('beat', () => {});
  check('two listeners registered', engine.emitter.listenerCount() === 2);
  engine.start();
  virtual = 2;
  engine.tick(2);
  const createdMidRun = engine.createdNodes;
  check('voice nodes created while running', createdMidRun > 10, `${createdMidRun} created`);
  engine.stop(0);
  engine.destroy();
  check('all nodes disposed after destroy', engine.activeNodeCount === 0, `${engine.activeNodeCount} active`);
  check('registry empty', engine.registry.size === 0);
  check('listeners cleared', engine.emitter.listenerCount() === 0);
  check('destroy is idempotent', (engine.destroy(), true));
  check('start after destroy throws', (() => { try { engine.start(); return false; } catch { return true; } })());
  check('off() after clear is safe', (offA(), true));
  saveJson('artifacts/destruction-stats.json', { created: createdMidRun, disposed: engine.disposedNodes });
}

// 3. Repeated start: no duplicate timers, listeners, or nodes.
section('repeated start: single timer, stable listeners, no duplicate graph');
{
  const ctx = new OfflineAudioContext(2, 44100 * 4, 44100);
  let virtual = 0;
  const driver = fakeDriver();
  const engine = new SoundtrackEngine(ctx, { bpm: 100 }, { clock: () => virtual, driver });
  engine.on('beat', () => {});

  const timerCounts = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const first = cycle === 0 ? engine.start() : engine.restart();
    check(`cycle ${cycle}: start/restart accepted`, first === true);
    check(`cycle ${cycle}: exactly one interval timer`, driver.intervalIds.size === 1);
    timerCounts.push(driver.intervalIds.size);
    virtual += 1;
    engine.tick(virtual);
    engine.stop(0);
    check(`cycle ${cycle}: timer cleared on stop`, driver.intervalIds.size === 0);
    check(`cycle ${cycle}: only persistent graph nodes remain`, engine.registry.size === 10, `${engine.registry.size} nodes`);
    virtual += 0.2;
  }
  check('listener never duplicated', engine.emitter.listenerCount() === 1);
  check('graph nodes fixed at persistent set', engine.registry.size === 10, `registry ${engine.registry.size}`);
  engine.destroy();
  saveJson('artifacts/restart-stats.json', { timerCounts, stats: engine.getStats() });
}

function fakeDriver() {
  return {
    intervalIds: new Map(),
    timeoutIds: new Map(),
    nextId: 1,
    setInterval(fn) {
      const id = this.nextId++;
      this.intervalIds.set(id, fn);
      return id;
    },
    clearInterval(id) {
      this.intervalIds.delete(id);
    },
    setTimeout(fn) {
      const id = this.nextId++;
      this.timeoutIds.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      this.timeoutIds.delete(id);
    },
  };
}
