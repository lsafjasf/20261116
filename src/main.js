// UI wiring: controls, status HUD, calibration, snapshots and WAV export.

import { Game } from './game.js';
import { AudioEngine } from './audio.js';
import { DIFFICULTIES, STORAGE_KEY } from './config.js';

const $ = (id) => document.getElementById(id);

const canvas = $('game');
canvas.width = 720;
canvas.height = 720;

function readParams() {
  return {
    bpm: Number($('bpm').value),
    beats: Number($('beats').value),
    difficulty: $('difficulty').value,
    approachTime: Number($('approach').value),
    offsetMs: Number($('offset').value),
    masterGain: Number($('masterGain').value),
    drumGain: Number($('drumGain').value),
    hitGain: Number($('hitGain').value),
    swing: 0,
  };
}

let game = new Game(canvas, readParams());
window.__game = game; // debug/test surface

const offsetLabel = $('offsetValue');
$('offset').addEventListener('input', (e) => {
  const value = Number(e.target.value);
  offsetLabel.textContent = `${value} ms`;
  game.setOffsetMs(value);
});

['bpm', 'beats', 'difficulty', 'approach', 'masterGain', 'drumGain', 'hitGain']
  .forEach((id) => $(id).addEventListener('change', () => game.updateParams(readParams())));

$('btnStart').addEventListener('click', async () => {
  game.updateParams(readParams());
  const started = await game.start();
  log(started ? 'started' : 'start ignored (already running)');
});
$('btnPause').addEventListener('click', async () => {
  const paused = await game.pause();
  log(paused ? 'paused (audio context suspended)' : 'pause ignored');
});
$('btnResume').addEventListener('click', async () => {
  const resumed = await game.resume();
  log(resumed ? 'resumed (no time shift)' : 'resume ignored');
});
$('btnRestart').addEventListener('click', async () => {
  await game.restart();
  log('restarted with fresh audio engine');
});
$('btnStop').addEventListener('click', async () => {
  await game.stop();
  log('stopped and destroyed');
});

game._onFinish = (result) => {
  $('result').textContent =
    `Perfect ${result.counts.perfect} / Good ${result.counts.good} / Miss ${result.counts.miss}` +
    ` (max combo ${result.maxCombo}, ${result.total} notes)`;
  log('finished');
};

function log(message) {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  $('log').prepend(line);
}

// ---- Snapshot save / restore -------------------------------------------
$('btnSnapshot').addEventListener('click', () => {
  const snapshot = game.saveSnapshot();
  log(`snapshot saved (${snapshot.chartNoteCount} notes)`);
});

$('btnRestore').addEventListener('click', () => {
  const snapshot = Game.loadSnapshot();
  if (!snapshot) {
    log('no snapshot found');
    return;
  }
  const restored = new Game(canvas, snapshot.params);
  restored.restoreSnapshot(snapshot);
  const regenerated = restored.takeSnapshot();
  window.__restored = regenerated;
  const beatMatch = JSON.stringify(snapshot.beatPoints) === JSON.stringify(regenerated.beatPoints);
  const panMatch = JSON.stringify(snapshot.pans) === JSON.stringify(regenerated.pans);
  const gainMatch = snapshot.gains.master === regenerated.gains.master &&
    snapshot.gains.drum === regenerated.gains.drum &&
    snapshot.gains.hit === regenerated.gains.hit;
  $('restoreReport').textContent =
    `beats match: ${beatMatch} | pans match: ${panMatch} | gains match: ${gainMatch} | ` +
    `duration ${snapshot.chartDuration}s -> ${regenerated.chartDuration}s`;
  log('snapshot restored and compared');
});

// ---- Offline WAV export -------------------------------------------------
$('btnExport').addEventListener('click', async () => {
  const params = readParams();
  const { generateChart } = await import('./chart.js');
  const activeChart = game.chart || generateChart(params);
  const { wav, buffer } = await AudioEngine.renderOffline(params, activeChart);
  const url = URL.createObjectURL(wav);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `rhythm-${params.difficulty}-${params.bpm}bpm.wav`;
  anchor.click();
  URL.revokeObjectURL(url);
  log(`exported WAV ${buffer.duration.toFixed(2)}s, ${wav.size} bytes`);
  window.__lastExport = { durationSec: buffer.duration, bytes: wav.size, sampleRate: buffer.sampleRate };
});

// ---- Live status HUD: distinguish scheduler / resource / playback issues
setInterval(() => {
  const hud = $('hud');
  const schedTimer = game.audio && game.audio.schedulerTimer !== null ? 'on' : 'off';
  hud.textContent =
    `state=${game.state} | audio=${game.audioState} | nodes=${game.activeNodeCount} ` +
    `| created=${game.audio ? game.audio.createdTotal : 0} | scheduler=${schedTimer} ` +
    `| listeners=${game.listenerCount} | t=${game.songTime.toFixed(2)}s`;
}, 200);

window.__DIFFICULTIES = DIFFICULTIES;
window.__STORAGE_KEY = STORAGE_KEY;
