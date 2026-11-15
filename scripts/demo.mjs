import { createEngine, snapshotHash } from '../src/core/engine.js';
import { createRecorder, replayRecording } from '../src/core/recorder.js';
import { CONFIG, PHASE, FAULT } from '../src/core/config.js';

function waitTerminal(engine) {
  let guard = 0;
  while (![PHASE.SUCCESS, PHASE.FAILED, PHASE.STOPPED].includes(engine.state.phase) && guard < 50000) {
    engine.step();
    guard += 1;
  }
}

const line = (title) => console.log(`\n== ${title} ==`);

line('1. 成功路线：三种图案各完成 10cm 无缺陷布面');
for (const patternId of ['plain', 'twill', 'satin']) {
  const engine = createEngine({ seed: 42, patternId });
  engine.start();
  waitTerminal(engine);
  console.log(`${patternId.padEnd(6)} phase=${engine.state.phase} cloth=${engine.state.clothCm}cm defects=${engine.state.defects} hash=${snapshotHash(engine).hash}`);
}

line('2. 操作失误：最低梭速 -> 漏纬自动停机 -> 修复后继续成功');
{
  const engine = createEngine({ seed: 7 });
  const rec = createRecorder(engine, 7, 'plain');
  engine.setSpeed(CONFIG.speedMin);
  engine.start();
  waitTerminal(engine);
  console.log(`停机 fault=${engine.state.fault} picks=${engine.state.picks} defects=${engine.state.defects}`);
  engine.repair();
  engine.setSpeed(CONFIG.speedStart);
  engine.start();
  waitTerminal(engine);
  console.log(`恢复后 phase=${engine.state.phase} cloth=${engine.state.clothCm}cm openDefects=${engine.state.openDefects}`);
  rec.record(0, 'SPEED', { value: CONFIG.speedMin });
  rec.record(0, 'START');
  rec.record(0, 'REPAIR');
  rec.record(0, 'SPEED', { value: CONFIG.speedStart });
  rec.record(0, 'START');
}

line('3. 参数极限：最高梭速寻找断线 seed');
for (let seed = 1; seed <= 40; seed++) {
  const engine = createEngine({ seed });
  engine.setSpeed(CONFIG.speedMax);
  engine.start();
  waitTerminal(engine);
  if (engine.state.fault === FAULT.BREAK) {
    console.log(`seed=${seed} fault=${engine.state.fault} thread=${engine.state.faultThread + 1} 张力=${engine.state.tensions[engine.state.faultThread].toFixed(1)}cN tick=${engine.state.tick}`);
    break;
  }
}

line('4. 复位检查');
{
  const engine = createEngine({ seed: 99, patternId: 'twill' });
  engine.setSpeed(2.8);
  engine.start();
  waitTerminal(engine);
  engine.reset();
  const s = engine.state;
  console.log(`tick=${s.tick} time=${s.runningTimeMs}ms picks=${s.picks} weft=${s.weft} rng=${s.rngState} phase=${s.phase}`);
}

line('5. 同 seed + 输入记录回放哈希一致性');
{
  const engine = createEngine({ seed: 123 });
  const rec = createRecorder(engine, 123, 'plain');
  rec.record(0, 'SPEED', { value: 2 });
  engine.setSpeed(2);
  rec.record(0, 'START');
  engine.start();
  waitTerminal(engine);
  const live = snapshotHash(engine).hash;
  const replayed = replayRecording(rec.exportJson()).snapshot.hash;
  console.log(`live=${live} replay=${replayed} equal=${live === replayed}`);
}
