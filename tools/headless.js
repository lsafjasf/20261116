import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as C from '../src/config.js';
import { Simulation, hashObject } from '../src/simulation.js';
import { Recording, Replayer } from '../src/recorder.js';
import { saveGame, loadGame, clearSave, MemoryStore } from '../src/storage.js';
import { toCSV, toSVG } from '../src/export.js';
import { analyzeOrderSensitivity, summarizeRecording } from '../src/analysis.js';
import { runScenario, SCENARIOS } from '../src/controllers.js';

globalThis.localStorage = new MemoryStore();

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'artifacts');
mkdirSync(outDir, { recursive: true });

const report = { generatedAt: new Date().toISOString(), runs: [], replay: [], restore: [], order: [] };

for (const [name, [gateStyle, pumpStyle]] of Object.entries(SCENARIOS)) {
  const sim = new Simulation(C.DEFAULT_SEED);
  const { result } = runScenario(name, gateStyle, pumpStyle, sim);
  const recording = Recording.capture(sim, name);

  writeFileSync(join(outDir, `${name}.timeline.json`), recording.serialize());
  writeFileSync(join(outDir, `${name}.pressure.csv`), toCSV(recording));
  writeFileSync(join(outDir, `${name}.pressure.svg`), toSVG(recording));

  // Save/load round trip at the moment of completion.
  clearSave();
  const payload = saveGame(sim, name);
  const loaded = loadGame();
  const restoredHash = hashObject(loaded.sim.snapshot());
  const restoreOK =
    restoredHash === payload.snapshotHash &&
    loaded.sim.tick === sim.tick &&
    loaded.sim.pump.durability === sim.pump.durability &&
    Math.abs(loaded.sim.channelLevel - sim.channelLevel) < 1e-12 &&
    JSON.stringify(loaded.sim.ended) === JSON.stringify(sim.ended);

  // Replay determinism under three different control patterns.
  const patterns = replayPatterns(recording);

  report.runs.push({
    scenario: name,
    result,
    summary: summarizeRecording(recording),
    artifacts: [
      `artifacts/${name}.timeline.json`,
      `artifacts/${name}.pressure.csv`,
      `artifacts/${name}.pressure.svg`
    ]
  });
  report.replay.push({ scenario: name, patterns });
  report.restore.push({
    scenario: name,
    restoreOK,
    tick: loaded.sim.tick,
    durability: loaded.sim.pump.durability,
    channelLevel: loaded.sim.channelLevel,
    progressPercent: payload.progress.percent
  });
  report.order.push({ scenario: name, ...analyzeOrderSensitivity(recording) });
}

writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
printReport(report);

function replayPatterns(recording) {
  const expected = recording.finalHash;
  const patterns = [];

  // 1. Continuous replay.
  const a = new Replayer(Recording.parse(JSON.stringify(recording)));
  a.runToEnd();
  patterns.push(check('continuous', a, expected));

  // 2. Pause + single-step every 300 ticks (speed never changes state).
  const b = new Replayer(Recording.parse(JSON.stringify(recording)));
  b.playing = false;
  while (!b.sim.ended) {
    for (let i = 0; i < 300 && !b.sim.ended; i++) b.step();
    b.playing = !b.playing;
    b.speed = b.speed === 1 ? 4 : 1;
  }
  patterns.push(check('pause-step-speed', b, expected));

  // 3. Checkpoint seek to the end.
  const c = new Replayer(Recording.parse(JSON.stringify(recording)));
  c.seekFromCheckpoint(recording.finalSnapshot.tick);
  patterns.push(check('checkpoint-seek', c, expected));

  // 4. Mid-sim seek followed by a normal run to the end.
  const mid = Math.floor(recording.finalSnapshot.tick / 2);
  const d = new Replayer(Recording.parse(JSON.stringify(recording)));
  d.seekFromCheckpoint(mid);
  d.runToEnd();
  patterns.push(check('seek-half-then-run', d, expected));

  return patterns;
}

function check(label, replayer, expected) {
  const actual = hashObject(replayer.sim.snapshot());
  return {
    label,
    expected,
    actual,
    match: actual === expected,
    ending: replayer.sim.ended
  };
}

function printReport(data) {
  console.log('=== River gate/pump co-op: headless dispatch report ===\n');
  for (const run of data.runs) {
    const s = run.summary;
    console.log(
      `[${run.scenario}] ${run.result.result} (${run.result.reason}) ` +
        `ticks=${s.ticks} inputs=${s.inputCount} conflicts=${s.conflictCount} ` +
        `collisions=${s.collisionCount} overheats=${s.overheatCount} ` +
        `peakPressure=${s.peakPressure.pressure}kPa street=${s.finalStreetDepth}m ` +
        `durability=${s.finalDurability}% hash=${s.finalHash}`
    );
  }
  console.log('\nReplay determinism (pause/step/speed must not change final state):');
  for (const r of data.replay) {
    for (const p of r.patterns) {
      console.log(`  ${r.scenario} ${p.label}: ${p.match ? 'OK' : 'MISMATCH'} ${p.actual}`);
    }
  }
  console.log('\nSave/reload restoration:');
  for (const r of data.restore) {
    console.log(
      `  ${r.scenario}: ${r.restoreOK ? 'OK' : 'FAIL'} tick=${r.tick} ` +
        `durability=${r.durability}% channel=${r.channelLevel}m progress=${r.progressPercent}%`
    );
  }
  console.log('\nOrder sensitivity (swapping player arrival order):');
  for (const r of data.order) {
    console.log(
      `  ${r.scenario}: conflicts=${r.conflicts.length} diverges=${r.reorderDiverges} ` +
        `hash(P1-first)=${r.finalHashIfP1Wins} hash(P2-first)=${r.finalHashIfP2Wins}`
    );
    for (const cf of r.conflicts) {
      console.log(
        `    -> t=${cf.simTime}s tick=${cf.tick} ${cf.object} @${cf.position} ` +
          `players=${cf.players.join('/')} values=[${cf.values.join(',')}] sensitive=${cf.orderSensitive}`
      );
    }
  }
}
