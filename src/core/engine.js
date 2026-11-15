import { mulberry32 } from './rng.js';
import { getPattern } from './patterns.js';
import { CONFIG, PHASE, FAULT } from './config.js';

export function createEngine(options = {}) {
  const seed = (options.seed ?? 1) >>> 0;
  const patternId = options.patternId ?? 'plain';
  const pattern = getPattern(patternId);
  const rng = mulberry32(seed);

  const state = {
    seed,
    patternId,
    phase: PHASE.READY,
    fault: FAULT.NONE,
    faultThread: -1,
    message: '就绪：按启动开始投梭',
    lastTransition: { phase: PHASE.READY, atMs: 0, tick: 0, reason: 'INIT' },
    tick: 0,
    runningTimeMs: 0,
    speed: CONFIG.speedStart,
    speedTarget: CONFIG.speedStart,
    picks: 0,
    clothCm: 0,
    weft: CONFIG.initialWeft,
    bobbins: CONFIG.initialBobbins,
    defects: 0,
    repaired: 0,
    openDefects: 0,
    rows: [],
    shuttle: { active: false, progress: 0, dir: 1 },
    tensions: new Array(pattern.warpCount).fill(CONFIG.tensionBase),
    rngState: seed,
    events: [],
  };

  function pushEvent(type, detail = '') {
    state.events.push({ tick: state.tick, type, detail });
    if (state.events.length > 30) state.events.shift();
  }

  function transition(phase, reason) {
    state.phase = phase;
    state.lastTransition = {
      phase,
      atMs: Math.round(state.runningTimeMs),
      tick: state.tick,
      reason,
    };
    pushEvent('STATE', `${phase}:${reason}`);
  }

  function setSpeed(value) {
    const clamped = Math.min(CONFIG.speedMax, Math.max(CONFIG.speedMin, Number(value) || CONFIG.speedStart));
    state.speedTarget = clamped;
    pushEvent('INPUT', `SPEED:${clamped.toFixed(2)}`);
  }

  function start() {
    if (state.phase === PHASE.READY) {
      transition(PHASE.RUNNING, 'START');
      state.message = '运行中';
    }
  }

  function pause() {
    if (state.phase === PHASE.RUNNING) {
      transition(PHASE.PAUSED, 'PAUSE');
      state.message = '已暂停';
    }
  }

  function resume() {
    if (state.phase === PHASE.PAUSED) {
      transition(PHASE.RUNNING, 'RESUME');
      state.message = '运行中';
    }
  }

  function reset() {
    state.phase = PHASE.READY;
    state.fault = FAULT.NONE;
    state.faultThread = -1;
    state.message = '就绪：按启动开始投梭';
    state.lastTransition = { phase: PHASE.READY, atMs: 0, tick: 0, reason: 'INIT' };
    state.tick = 0;
    state.runningTimeMs = 0;
    state.speed = CONFIG.speedStart;
    state.speedTarget = CONFIG.speedStart;
    state.picks = 0;
    state.clothCm = 0;
    state.weft = CONFIG.initialWeft;
    state.bobbins = CONFIG.initialBobbins;
    state.defects = 0;
    state.repaired = 0;
    state.openDefects = 0;
    state.rows = [];
    state.shuttle = { active: false, progress: 0, dir: 1 };
    state.tensions = new Array(pattern.warpCount).fill(CONFIG.tensionBase);
    state.events = [];
    rng.state = seed;
    state.rngState = seed;
    pushEvent('STATE', 'READY:RESET');
  }

  function tick(engine) {
    const { state } = engine;
    state.tick += 1;
    state.rngState = rng.state;
    if (state.phase !== PHASE.RUNNING) return;

    state.runningTimeMs = Math.round(state.tick * CONFIG.tickDt * 1000);
    state.speed += (state.speedTarget - state.speed) * 0.08;
    updateTensions(engine);
    updateShuttle(engine);
  }

  function updateTensions(engine) {
    const { state } = engine;
    const stress = Math.max(0, (state.speed - CONFIG.safeSpeedHigh) /
      (CONFIG.speedMax - CONFIG.safeSpeedHigh));
    for (let i = 0; i < state.tensions.length; i++) {
      const shed = pattern.shedUp(i, state.picks) ? CONFIG.tensionShedDelta : 0;
      const noise = (rng.next() * 2 - 1) * CONFIG.tensionNoise;
      state.tensions[i] = CONFIG.tensionBase + shed + stress * 10 + noise;
    }
    if (stress > 0) {
      const roll = rng.next();
      const pAnomaly = stress * CONFIG.pAnomalyAtMax;
      if (roll < pAnomaly) {
        const index = Math.floor(rng.next() * state.tensions.length);
        state.tensions[index] += CONFIG.tensionAnomaly - CONFIG.tensionNormal;
        if (rng.next() < stress * 0.3) {
          state.tensions[index] += CONFIG.tensionBreak - CONFIG.tensionAnomaly + 4;
          stopFor(engine, FAULT.BREAK, index, `第 ${index + 1} 根经纱断线`);
          return;
        }
        stopFor(engine, FAULT.ANOMALY, index, `第 ${index + 1} 根经纱张力异常`);
        return;
      }
    }
    const over = state.tensions.findIndex((t) => t >= CONFIG.tensionBreak);
    if (over >= 0) stopFor(engine, FAULT.BREAK, over, `第 ${over + 1} 根经纱断线`);
  }

  function stopFor(engine, fault, thread, message) {
    const { state } = engine;
    state.fault = fault;
    state.faultThread = thread;
    state.message = message;
    transition(PHASE.STOPPED, fault);
  }

  function updateShuttle(engine) {
    const { state } = engine;
    if (!state.shuttle.active) {
      state.shuttle = { active: true, progress: 0, dir: state.picks % 2 === 0 ? 1 : -1 };
    }
    const cycle = CONFIG.shuttleCycleTicksAtSpeed1 * CONFIG.speedStart / state.speed;
    state.shuttle.progress += 1 / cycle;
    if (state.shuttle.progress >= 1) {
      state.shuttle.active = false;
      state.shuttle.progress = 0;
      completePick(engine);
    }
  }

  function completePick(engine) {
    const { state } = engine;
    if (state.weft <= 0) {
      stopFor(engine, FAULT.NO_WEFT, -1, '纬纱用尽，需更换梭芯');
      return;
    }
    state.weft -= CONFIG.weftPerPick;

    const slow = Math.max(0, (CONFIG.safeSpeedLow - state.speed) /
      (CONFIG.safeSpeedLow - CONFIG.speedMin));
    const miss = rng.next() < slow * CONFIG.pSlowMissAtMin;

    state.picks += 1;
    if (miss) {
      state.rows.push({ pick: state.picks, ok: false, pattern: state.patternId });
      state.defects += 1;
      state.openDefects += 1;
      stopFor(engine, FAULT.MISS_PICK, -1, '梭速过慢导致漏纬');
      return;
    }
    state.rows.push({ pick: state.picks, ok: true, pattern: state.patternId });
    state.clothCm = Math.round(state.rows.length * pattern.rowWidthCm * 1000) / 1000;
    if (state.clothCm >= CONFIG.targetLengthCm) finishRoll(engine);
  }

  function finishRoll(engine) {
    const { state } = engine;
    if (state.openDefects === 0) {
      state.message = '完成十厘米无缺陷布面';
      transition(PHASE.SUCCESS, 'TARGET_REACHED');
    } else {
      state.message = '布面存在缺陷，未达标';
      transition(PHASE.FAILED, 'DEFECT_LEFT');
    }
  }

  function repair(engine) {
    const { state } = engine;
    if (state.phase !== PHASE.STOPPED) return;
    const fault = state.fault;
    if (fault === FAULT.NO_WEFT) {
      if (state.bobbins <= 0) {
        state.message = '没有备用梭芯';
        return;
      }
      state.bobbins -= 1;
      state.weft += CONFIG.bobbinWeft;
    } else if (fault === FAULT.MISS_PICK) {
      const bad = state.rows.pop();
      if (bad) {
        state.openDefects -= 1;
        state.picks -= 1;
      }
    } else if (fault === FAULT.ANOMALY || fault === FAULT.BREAK) {
      if (state.faultThread >= 0) {
        state.tensions[state.faultThread] = CONFIG.tensionRecovered;
      }
      state.openDefects += 1;
      state.repaired += 1;
    }
    state.fault = FAULT.NONE;
    state.faultThread = -1;
    state.message = `已恢复（${fault}），可继续投梭`;
    pushEvent('REPAIR', String(fault));
    transition(PHASE.READY, 'REPAIRED');
  }

  const engine = {
    CONFIG,
    pattern,
    state,
    setSpeed,
    start,
    pause,
    resume,
    reset,
    repair: () => repair(engine),
    step: (n = 1) => {
      for (let i = 0; i < n; i++) tick(engine);
    },
    snapshotHash: () => snapshotHash(engine),
  };
  return engine;
}

export function snapshotHash(engine) {
  const s = engine.state;
  const canonical = {
    seed: s.seed,
    patternId: s.patternId,
    phase: s.phase,
    fault: s.fault,
    faultThread: s.faultThread,
    message: s.message,
    lastTransition: s.lastTransition,
    tick: s.tick,
    runningTimeMs: s.runningTimeMs,
    speed: Number(s.speed.toFixed(4)),
    speedTarget: Number(s.speedTarget.toFixed(4)),
    picks: s.picks,
    clothCm: s.clothCm,
    weft: s.weft,
    bobbins: s.bobbins,
    defects: s.defects,
    repaired: s.repaired,
    openDefects: s.openDefects,
    rows: s.rows,
    shuttle: s.shuttle,
    tensions: s.tensions.map((t) => Number(t.toFixed(4))),
    rngState: s.rngState,
    events: s.events,
  };
  return { json: JSON.stringify(canonical), hash: fnv1a(JSON.stringify(canonical)) };
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
