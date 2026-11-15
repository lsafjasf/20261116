import { chromium } from 'playwright';
import path from 'node:path';

const browser = await chromium.launch({
  headless: true,
  executablePath: path.join(process.env.HOME, 'opt/chrome-deb/opt/google/chrome/google-chrome'),
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('console', (m) => console.log(`[${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:8000/');
await page.waitForFunction(() => window.__game);
const timerCheck = await page.evaluate(async () => {
  const stamps = [];
  const t0 = performance.now();
  await new Promise((resolve) => {
    const id = setInterval(() => {
      stamps.push(Number((performance.now() - t0).toFixed(1)));
      if (stamps.length >= 5) { clearInterval(id); resolve(); }
    }, 50);
  });
  return stamps;
});
console.log('interval stamps:', JSON.stringify(timerCheck));

const probe = await page.evaluate(async () => {
  const game = window.__game;
  game.updateParams({ beats: 12 });
  await game.start();
  game.attachMeter();
  const trace = [];
  const traceTimer = setInterval(() => {
    if (game.state !== 'running') return;
    trace.push({
      t: Number(game.songTime.toFixed(2)),
      ticks: game.audio.tickCount,
      voices: game.audio.playedVoices,
      nodes: game.audio.activeNodeCount,
    });
  }, 150);
  game._traceTimer = traceTimer;
  const readings = [];
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    readings.push(Number(game.readMeterRms().toFixed(5)));
  }
  clearInterval(traceTimer);
  const info = {
    readings,
    ctxState: game.audioState,
    sampleRate: game.audio.ctx.sampleRate,
    nodes: game.activeNodeCount,
    created: game.audio.createdTotal,
    schedulerActive: game.audio.schedulerTimer !== null,
    playedVoices: game.audio.playedVoices,
    tickCount: game.audio.tickCount,
    schedulerError: game.audio.lastSchedulerError || null,
    songTime: Number(game.songTime.toFixed(3)),
    firstNoteTime: game.chart.notes[0].time,
    startCtxTime: Number(game.startCtxTime.toFixed(3)),
    ctxNow: Number(game.audio.ctx.currentTime.toFixed(3)),
    baseLatency: game.audio.ctx.baseLatency,
    outputLatency: game.audio.ctx.outputLatency,
    trace,
  };
  const note0 = game.chart.notes[0];
  info.guard = {
    noteTime: note0.time,
    startCtxTime: game.startCtxTime,
    scheduledAt: game.startCtxTime + note0.time,
    ctxNowAtProbe: game.audio.ctx.currentTime,
    wouldPassGuard: (game.startCtxTime + note0.time) >= game.audio.ctx.currentTime - 0.05,
  };
  await game.stop();
  return info;
});
console.log(JSON.stringify(probe, null, 2));
await browser.close();
