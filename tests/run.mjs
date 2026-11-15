import fs from 'node:fs';
import path from 'node:path';
import { newPage, playFullGame, startAutoplay, ROOT } from './helpers.js';

const report = { startedAt: new Date().toISOString(), suites: [] };
function suite(name) {
  const entry = { name, checks: [] };
  report.suites.push(entry);
  return entry;
}
function check(entry, name, ok, detail = '') {
  entry.checks.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}\n`);
}

let browser;
let context;
let page;
try {
  ({ browser, context, page } = await newPage());

  // ---- Suite 1: full game, judgment counts --------------------------------
  const s1 = suite('full-game');
  const result = await playFullGame(page, { difficulty: 'normal', beats: 24 });
  check(s1, 'game reaches finished state',
    (await page.evaluate(() => window.__game.state)) === 'finished');
  check(s1, 'all notes judged', result.total > 0,
    `${result.total} notes`);
  check(s1, 'judgment tiers present',
    typeof result.counts.perfect === 'number' &&
    typeof result.counts.good === 'number' &&
    typeof result.counts.miss === 'number',
    JSON.stringify(result.counts));
  check(s1, 'tier counts sum to total',
    result.counts.perfect + result.counts.good + result.counts.miss === result.total);

  // ---- Suite 2: calibration offset moves hit timing -----------------------
  const s2 = suite('calibration');
  // Fixed-time player: always presses exactly at each note's target time,
  // ignoring the calibrated offset. The reported delta must therefore move
  // by exactly the offset amount, proving calibration changes hit timing.
  const runAtOffset = (offsetMs) => page.evaluate(async (offsetMs) => {
    const game = window.__game;
    game.updateParams({ beats: 16, offsetMs, difficulty: 'easy' });
    await game.start();
    // Exact-clock scheduling: each key press happens at startCtxTime + note.time
    // regardless of calibration, so the offset shows up purely in the delta.
    for (const note of game.chart.notes) {
      const targetCtx = game.startCtxTime + note.time;
      const delayMs = Math.max(0, (targetCtx - game.audio.ctx.currentTime) * 1000);
      setTimeout(() => game.simulateLane(note.lane, targetCtx), delayMs);
    }
    return null;
  }, offsetMs);

  await runAtOffset(0);
  await page.waitForFunction(() => window.__game.state === 'finished', null, { timeout: 60000 });
  const zeroEvents = await page.evaluate(() => window.__game.hitEvents
    .filter((e) => e.tier !== 'miss').map((e) => e.deltaSec));
  const meanZero = avg(zeroEvents);
  await runAtOffset(120);
  await page.waitForFunction(() => window.__game.state === 'finished', null, { timeout: 60000 });
  const shiftedEvents = await page.evaluate(() => window.__game.hitEvents
    .filter((e) => e.tier !== 'miss').map((e) => e.deltaSec));
  const meanShifted = avg(shiftedEvents);
  check(s2, 'zero-offset hits centered near 0', Math.abs(meanZero) < 0.03,
    `mean delta ${meanZero.toFixed(4)}s`);
  check(s2, 'offset +120ms shifts hit delta by ~120ms',
    Math.abs((meanShifted - meanZero) - 0.12) < 0.04,
    `delta means ${meanZero.toFixed(4)} -> ${meanShifted.toFixed(4)}`);

  // Difficulty window narrowing: hard window smaller than easy.
  const windows = await page.evaluate(() => {
    const d = window.__DIFFICULTIES;
    return { easy: d.easy.windows.perfect, hard: d.hard.windows.perfect };
  });
  check(s2, 'hard judgment window narrower than easy',
    windows.hard < windows.easy, `easy ${windows.easy}s vs hard ${windows.hard}s`);

  // ---- Suite 3: pause/restart no drift; resource cleanup ------------------
  const s3 = suite('resource-management');
  const drift = await page.evaluate(async () => {
    const game = window.__game;
    game.updateParams({ beats: 24, offsetMs: 0 });
    await game.start();
    await new Promise((r) => setTimeout(r, 1500));
    const before = game.songTime;
    await game.pause();
    await new Promise((r) => setTimeout(r, 1200));
    await game.resume();
    await new Promise((r) => setTimeout(r, 300));
    const after = game.songTime;
    return {
      before, after, jump: after - before,
      audioStateAfterResume: game.audioState,
      pausedDuration: game.pausedDuration,
    };
  });
  check(s3, 'song time does not jump across pause/resume',
    drift.jump >= 0 && drift.jump < 0.6,
    `song time moved ${drift.jump.toFixed(3)}s over the cycle`);
  check(s3, 'audio context running after resume',
    drift.audioStateAfterResume === 'running', drift.audioStateAfterResume);

  // Let the run finish, then verify full teardown.
  await page.waitForFunction(() => window.__game.state === 'finished', null, { timeout: 60000 });
  await page.waitForFunction(() => window.__game.audio === null, null, { timeout: 10000 });
  await page.waitForTimeout(500); // let onended/safety-net cleanups settle
  const afterFinish = await page.evaluate(() => ({
    nodes: window.__game.activeNodeCount,
    listeners: window.__game.listenerCount,
    state: window.__game.state,
  }));
  check(s3, 'no audio nodes remain after finish teardown',
    afterFinish.nodes === 0, `${afterFinish.nodes} nodes`);
  check(s3, 'no key listeners remain after finish teardown',
    afterFinish.listeners === 0, `${afterFinish.listeners} listeners`);

  // Explicit stop: input interruption mid-song.
  const stopInfo = await page.evaluate(async () => {
    const game = window.__game;
    await game.start();
    await new Promise((r) => setTimeout(r, 800));
    await game.stop();
    return {
      state: game.state,
      nodes: game.activeNodeCount,
      listeners: game.listenerCount,
      audio: game.audio,
      raf: game.rafId,
    };
  });
  check(s3, 'stop leaves zero nodes', stopInfo.nodes === 0, `${stopInfo.nodes}`);
  check(s3, 'stop removes listeners', stopInfo.listeners === 0, `${stopInfo.listeners}`);
  check(s3, 'stop cancels rAF and audio engine',
    stopInfo.raf === 0 && stopInfo.audio === null);

  // Input interruption while voices are ringing: prove the tail is silenced.
  const tail = await page.evaluate(async () => {
    const game = window.__game;
    await game.start();
    game.attachMeter();
    await new Promise((r) => setTimeout(r, 2600)); // first drum is at song t=1s
    const rmsWhilePlaying = game.readMeterRms();
    const rmsSamples = [];
    for (let i = 0; i < 5; i += 1) {
      rmsSamples.push(Number(game.readMeterRms().toFixed(5)));
      await new Promise((r) => setTimeout(r, 120));
    }
    await game.stop();
    return {
      rmsWhilePlaying,
      rmsSamples,
      graphAfterStop: game.audio,
      nodesAfterStop: game.activeNodeCount,
      meterAfterStop: game.readMeterRms(),
    };
  });
  check(s3, 'master bus carries signal while playing',
    Math.max(...tail.rmsSamples) > 0.0005,
    `rms samples ${JSON.stringify(tail.rmsSamples)}`);
  check(s3, 'stop destroys graph so no tail can ring',
    tail.graphAfterStop === null && tail.nodesAfterStop === 0,
    `nodes ${tail.nodesAfterStop}`);
  check(s3, 'meter returns null after teardown', tail.meterAfterStop === null);

  // Restart three times in a row: listeners must stay at exactly one, and
  // every old engine must be fully destroyed before the next one starts.
  const triple = await page.evaluate(async () => {
    const game = window.__game;
    const samples = [];
    for (let i = 0; i < 3; i += 1) {
      await game.restart();
      samples.push({
        listeners: game.listenerCount,
        nodes: game.activeNodeCount,
        state: game.state,
        engineCreatedTotal: game.audio.createdTotal,
      });
      await new Promise((r) => setTimeout(r, 300));
    }
    await game.stop();
    return {
      samples,
      afterStop: { listeners: game.listenerCount, nodes: game.activeNodeCount },
    };
  });
  check(s3, 'three restarts keep one listener each time',
    triple.samples.every((s) => s.listeners === 1),
    JSON.stringify(triple.samples.map((s) => s.listeners)));
  check(s3, 'each restarted engine starts from a small node set',
    triple.samples.every((s) => s.nodes <= 4),
    JSON.stringify(triple.samples.map((s) => s.nodes)));
  check(s3, 'clean after triple restart + stop',
    triple.afterStop.listeners === 0 && triple.afterStop.nodes === 0,
    JSON.stringify(triple.afterStop));

  // Duplicate start guard + restart listener/node accounting.
  const dup = await page.evaluate(async () => {
    const game = window.__game;
    await game.start();
    const listenersAfterFirst = game.listenerCount;
    const nodesAfterFirst = game.activeNodeCount;
    const second = await game.start(); // must be ignored
    const listenersAfterDuplicate = game.listenerCount;
    const createdBefore = game.audio.createdTotal;
    await game.restart();
    return {
      second,
      listenersAfterFirst,
      listenersAfterDuplicate,
      nodesAfterFirst,
      listenersAfterRestart: game.listenerCount,
      freshEngine: game.audio.createdTotal < createdBefore || game.audio.createdTotal <= 6,
    };
  });
  check(s3, 'duplicate start() is rejected', dup.second === false);
  check(s3, 'duplicate start adds no listeners',
    dup.listenersAfterFirst === dup.listenersAfterDuplicate,
    `${dup.listenersAfterFirst} == ${dup.listenersAfterDuplicate}`);
  check(s3, 'restart keeps exactly one listener', dup.listenersAfterRestart === 1);
  check(s3, 'restart builds a fresh engine', dup.freshEngine === true);
  await page.evaluate(() => window.__game.stop());
  await page.waitForFunction(() => window.__game.audio === null);
  const finalClean = await page.evaluate(() => ({
    nodes: window.__game.activeNodeCount,
    listeners: window.__game.listenerCount,
  }));
  check(s3, 'final teardown clean',
    finalClean.nodes === 0 && finalClean.listeners === 0,
    JSON.stringify(finalClean));

  // ---- Suite 4: snapshot save/restore + WAV export ------------------------
  const s4 = suite('snapshot-export');
  const snap = await page.evaluate(async () => {
    const game = window.__game;
    game.updateParams({ beats: 24, difficulty: 'hard', offsetMs: 45, masterGain: 0.66 });
    await game.start();
    await new Promise((r) => setTimeout(r, 600));
    const saved = game.saveSnapshot();
    const stored = JSON.parse(localStorage.getItem(window.__STORAGE_KEY));
    await game.stop();
    return { saved, stored };
  });
  check(s4, 'snapshot persisted to localStorage',
    snap.stored && snap.stored.version === 1 && snap.stored.params.offsetMs === 45);

  const restored = await page.evaluate(() => {
    const game = window.__game;
    const snapshot = JSON.parse(localStorage.getItem(window.__STORAGE_KEY));
    const rebuilt = new game.constructor(document.getElementById('game'), snapshot.params);
    rebuilt.restoreSnapshot(snapshot);
    const now = rebuilt.takeSnapshot();
    return {
      beatsEqual: JSON.stringify(snapshot.beatPoints) === JSON.stringify(now.beatPoints),
      pansEqual: JSON.stringify(snapshot.pans) === JSON.stringify(now.pans),
      gainsEqual: snapshot.gains.master === now.gains.master &&
        snapshot.gains.drum === now.gains.drum &&
        snapshot.gains.hit === now.gains.hit,
      durationEqual: snapshot.chartDuration === now.chartDuration,
      paramsEqual: snapshot.params.offsetMs === now.params.offsetMs &&
        snapshot.params.difficulty === now.params.difficulty,
      beatSample: now.beatPoints.slice(0, 4),
      pans: now.pans,
      gains: now.gains,
      duration: now.chartDuration,
    };
  });
  check(s4, 'restored beat points identical', restored.beatsEqual,
    JSON.stringify(restored.beatSample));
  check(s4, 'restored pans identical', restored.pansEqual, JSON.stringify(restored.pans));
  check(s4, 'restored gains identical', restored.gainsEqual, JSON.stringify(restored.gains));
  check(s4, 'restored chart duration identical', restored.durationEqual,
    `${restored.duration}s`);

  const exportInfo = await page.evaluate(async () => {
    const { AudioEngine } = await import('./src/audio.js');
    const { generateChart } = await import('./src/chart.js');
    const params = { ...window.__game.params, beats: 24 };
    const chart = generateChart(params);
    const { wav, buffer } = await AudioEngine.renderOffline(params, chart);
    const expected = chart.duration + 0.5;
    return {
      duration: buffer.duration,
      expected,
      bytes: wav.size,
      header: new Uint8Array(await wav.arrayBuffer()).slice(0, 4),
    };
  });
  check(s4, 'WAV export has RIFF header',
    Buffer.from(exportInfo.header).toString() === 'RIFF');
  check(s4, 'WAV duration matches chart length',
    Math.abs(exportInfo.duration - exportInfo.expected) < 0.05,
    `${exportInfo.duration.toFixed(3)}s vs expected ${exportInfo.expected.toFixed(3)}s`);
  fs.writeFileSync(path.join(ROOT, 'artifacts', 'rhythm-export.wav'),
    Buffer.from(await (await page.evaluate(async () => {
      const { AudioEngine } = await import('./src/audio.js');
      const { generateChart } = await import('./src/chart.js');
      const params = { ...window.__game.params, beats: 24 };
      const { wav } = await AudioEngine.renderOffline(params, generateChart(params));
      return Array.from(new Uint8Array(await wav.arrayBuffer()));
    }))));

  // Save the in-page snapshot JSON as an artifact too.
  fs.writeFileSync(path.join(ROOT, 'artifacts', 'snapshot.json'),
    JSON.stringify(snap.stored, null, 2));

  // ---- Console/page errors ------------------------------------------------
  const hadErrors = report.suites.some((s) => s.checks.some((c) => !c.ok));
  report.ok = !hadErrors;
} catch (err) {
  report.ok = false;
  report.fatal = err.stack || String(err);
  process.stdout.write(`FATAL: ${report.fatal}\n`);
} finally {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(ROOT, 'artifacts', 'test-report.json'),
    JSON.stringify(report, null, 2));
  await context?.close();
  await browser?.close();
}

function avg(values) {
  if (!values.length) return NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

if (!report.ok) process.exitCode = 1;
