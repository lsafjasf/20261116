export const FIXED_MS = 16;
export const ACTION_WINDOW_MS = 8000;
export const SYNC_MS = 1200;
export const ORDER_TOLERANCE_MS = 220;
export const SUCCESS_PAUSE_MS = 1500;

export const TARGET_ASSEMBLIES = 3;
export const TOTAL_KITS = 4;
export const REQUIRED_SPARE = 1;

export const OFFSET_SAFE = 18;
export const PRESSURE_MIN = 42;
export const PRESSURE_MAX = 74;
export const PRESSURE_CRUSH = 92;
export const OFFSET_COLLISION = 70;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value) => Math.round(value * 1000) / 1000;

export function objectPositions(state) {
  const drift = (state.offset - OFFSET_SAFE) * 0.92;
  return {
    base: { x: 590 + drift * 0.18, y: 434, object: '固定底座' },
    gasket: { x: 590 + drift * 0.78, y: 368, object: '密封垫圈' },
    module: { x: 590 + drift, y: 295 + state.pressure * 0.18, object: '上部模块' }
  };
}

function fnv1a(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function initialTimeline() {
  return {
    events: [],
    collisions: [],
    conflicts: [],
    results: [],
    final: null
  };
}

function initialState(seed) {
  return {
    seed,
    tick: 0,
    phase: 'idle',
    attempt: 0,
    completed: 0,
    inventory: TOTAL_KITS,
    durability: 100,
    offset: 44,
    pressure: 34,
    leftHeld: false,
    rightHeld: false,
    syncMs: 0,
    cycleStartTick: 0,
    cycleLeftPressTick: null,
    cycleFirstRightTick: null,
    successHoldTick: null,
    phaseTick: 0,
    statusText: '等待装载',
    lastConstraint: '',
    timeline: initialTimeline()
  };
}

export class AssemblyEngine {
  constructor(options = {}) {
    const seed = options.seed ?? 0x7a11ce;
    this.state = initialState(seed);
    if (options.autoStart !== false) this.startRun();
  }

  startRun() {
    const seed = this.state.seed;
    this.state = initialState(seed);
    this.startCycle();
    return this.snapshot();
  }

  startCycle() {
    const state = this.state;
    state.phase = 'active';
    state.attempt = state.completed + 1;
    state.offset = 44 + (state.attempt % 3) * 1.5;
    state.pressure = 34;
    state.leftHeld = false;
    state.rightHeld = false;
    state.syncMs = 0;
    state.cycleStartTick = state.tick;
    state.cycleLeftPressTick = null;
    state.cycleFirstRightTick = null;
    state.successHoldTick = null;
    state.phaseTick = state.tick;
    state.statusText = `第 ${state.attempt} 组 · 等待同步`;
    state.lastConstraint = '左侧先夹紧，右侧脉冲加压';
    state.timeline.events.push(this.event('cycle-start', null, {
      attempt: state.attempt,
      object: '装配工位'
    }));
    return this.snapshot();
  }

  event(kind, side, extra = {}) {
    const state = this.state;
    const positions = objectPositions(state);
    return {
      id: `${state.tick}-${state.timeline.events.length}-${kind}`,
      kind,
      side,
      tick: state.tick,
      t: state.tick * FIXED_MS,
      offset: round(state.offset),
      pressure: round(state.pressure),
      object: extra.object ?? (side === 'left' ? positions.base.object : positions.module.object),
      position: extra.position ?? (side === 'left' ? positions.base : positions.module),
      ...extra
    };
  }

  hasConflict(key) {
    return this.state.timeline.conflicts.some((item) => item.key === key);
  }

  addConflict(key, side, message, object = '上部模块') {
    if (this.hasConflict(key)) return;
    const state = this.state;
    const positions = objectPositions(state);
    const position = object === '固定底座' ? positions.base : positions.module;
    state.timeline.conflicts.push({
      ...this.event('order-conflict', side, {
        object,
        position: { x: round(position.x), y: round(position.y), object }
      }),
      key,
      message
    });
  }

  press(side) {
    const state = this.state;
    if (state.phase !== 'active') return this.snapshot();
    if (side !== 'left' && side !== 'right') return this.snapshot();
    if (state[`${side}Held`]) return this.snapshot();

    state[`${side}Held`] = true;
    if (side === 'left') {
      if (state.cycleLeftPressTick === null) state.cycleLeftPressTick = state.tick;
      if (
        state.cycleFirstRightTick !== null &&
        state.tick - state.cycleFirstRightTick > ORDER_TOLERANCE_MS / FIXED_MS
      ) {
        this.addConflict(
          `right-first-${state.attempt}`,
          'right',
          '动作顺序冲突：右侧先于左侧启动，模块已开始偏移',
          '上部模块'
        );
      }
    } else {
      if (state.cycleFirstRightTick === null) state.cycleFirstRightTick = state.tick;
    }

    state.timeline.events.push(this.event('press', side, {
      object: side === 'left' ? '固定底座' : '上部模块'
    }));
    state.lastConstraint = side === 'left'
      ? '固定底座受力，等待右侧进入安全压力'
      : '右侧开始加压，左侧需持续夹紧';
    return this.snapshot();
  }

  release(side) {
    const state = this.state;
    if (state.phase !== 'active') return this.snapshot();
    if (side !== 'left' && side !== 'right') return this.snapshot();
    if (!state[`${side}Held`]) return this.snapshot();

    state[`${side}Held`] = false;
    if (
      side === 'left' &&
      state.rightHeld &&
      state.pressure >= PRESSURE_MIN
    ) {
      this.addConflict(
        `early-release-${state.attempt}`,
        'left',
        '动作顺序冲突：右侧仍在加压时左侧提前松手',
        '固定底座'
      );
    }
    state.timeline.events.push(this.event('release', side, {
      object: side === 'left' ? '固定底座' : '上部模块'
    }));
    state.lastConstraint = side === 'left'
      ? '夹持释放：底座正在漂移'
      : '压力正在泄放';
    return this.snapshot();
  }

  addResult(kind, extra = {}) {
    const state = this.state;
    state.timeline.results.push({
      ...this.event(kind, null, extra),
      completed: state.completed,
      inventory: state.inventory,
      durability: state.durability
    });
  }

  addCollision(type, object, message) {
    const state = this.state;
    const positions = objectPositions(state);
    const position = object === '密封垫圈' ? positions.gasket : positions.module;
    state.timeline.collisions.push({
      ...this.event('collision', type === 'crush' ? 'right' : 'left', {
        object,
        position: { x: round(position.x), y: round(position.y), object }
      }),
      type,
      message
    });
  }

  finishFailure(type, object, message, wear) {
    const state = this.state;
    state.phase = 'failed';
    state.phaseTick = state.tick;
    state.inventory = Math.max(0, state.inventory - 1);
    state.durability = Math.max(0, state.durability - wear);
    state.leftHeld = false;
    state.rightHeld = false;
    state.statusText = type === 'crush' ? '垫圈压溃 · 装配失败' : '窗口关闭 · 装配失败';
    state.lastConstraint = message;
    this.addCollision(type, object, message);
    this.addResult('assembly-failed', { type, object, wear });
    this.finalize('failed');
  }

  finishSuccess() {
    const state = this.state;
    state.completed += 1;
    state.inventory = Math.max(0, state.inventory - 1);
    state.durability = Math.max(0, state.durability - 2);
    state.phase = 'success';
    state.phaseTick = state.tick;
    state.leftHeld = false;
    state.rightHeld = false;
    state.statusText = `第 ${state.completed} 组同步锁定`;
    state.lastConstraint = '夹持、压力与碰撞检查全部通过';
    this.addResult('assembly-clear', {
      object: '上部模块',
      syncMs: round(state.syncMs),
      offset: round(state.offset),
      pressure: round(state.pressure)
    });
  }

  finalize(status) {
    const state = this.state;
    state.timeline.final = {
      status,
      tick: state.tick,
      t: state.tick * FIXED_MS,
      completed: state.completed,
      inventory: state.inventory,
      durability: state.durability,
      fingerprint: this.fingerprint()
    };
  }

  tick() {
    const state = this.state;
    state.tick += 1;

    if (state.phase === 'success') {
      if (state.tick - state.phaseTick >= Math.ceil(SUCCESS_PAUSE_MS / FIXED_MS)) {
        if (state.completed >= TARGET_ASSEMBLIES) {
          state.phase = 'complete';
          state.phaseTick = state.tick;
          state.statusText = state.inventory >= REQUIRED_SPARE
            ? '任务完成 · 备件已保留'
            : '任务完成 · 但备件不足';
          state.lastConstraint = '三组装配完成，工位已锁定';
          this.finalize('complete');
        } else {
          this.startCycle();
        }
      }
      return state;
    }

    if (state.phase !== 'active') return state;

    const elapsed = state.tick - state.cycleStartTick;
    const toleranceTicks = Math.ceil(ORDER_TOLERANCE_MS / FIXED_MS);
    if (
      state.cycleFirstRightTick !== null &&
      !state.leftHeld &&
      elapsed > toleranceTicks &&
      (state.cycleLeftPressTick === null ||
        state.cycleLeftPressTick > state.cycleFirstRightTick + toleranceTicks)
    ) {
      this.addConflict(
        `right-first-${state.attempt}`,
        'right',
        '动作顺序冲突：右侧先于左侧启动，模块已开始偏移',
        '上部模块'
      );
    }

    const jitter = Math.sin((state.tick + state.seed) * 0.173) * 0.018;
    const offsetVelocity = state.leftHeld ? -0.58 : 0.29;
    const pressureVelocity = state.rightHeld ? 0.54 : -0.43;
    state.offset = clamp(state.offset + offsetVelocity + jitter, 0, 100);
    state.pressure = clamp(state.pressure + pressureVelocity, 0, 100);

    if (state.pressure > PRESSURE_CRUSH) {
      this.finishFailure(
        'crush',
        '密封垫圈',
        '压力超过 92%，垫圈压溃',
        35
      );
      return state;
    }

    if (state.offset >= OFFSET_COLLISION && state.pressure >= PRESSURE_MIN) {
      this.finishFailure(
        'lateral',
        '上部模块',
        '底座偏移达到碰撞阈值，模块错位',
        22
      );
      return state;
    }

    const inSyncZone =
      state.leftHeld &&
      state.offset <= OFFSET_SAFE &&
      state.pressure >= PRESSURE_MIN &&
      state.pressure <= PRESSURE_MAX;

    if (inSyncZone) {
      if (state.successHoldTick === null) state.successHoldTick = state.tick;
      state.syncMs += FIXED_MS;
      state.lastConstraint = '同步保持中：夹持稳定，压力处于安全带';
    } else {
      state.successHoldTick = null;
      state.syncMs = Math.max(0, state.syncMs - FIXED_MS * 1.8);
      if (state.offset > OFFSET_SAFE) {
        state.lastConstraint = '底座偏移超限：左侧需要持续夹紧';
      } else if (state.pressure < PRESSURE_MIN) {
        state.lastConstraint = '压力不足：右侧需要脉冲加压';
      } else if (state.pressure > PRESSURE_MAX) {
        state.lastConstraint = '压力接近上限：松开右侧泄压';
      } else {
        state.lastConstraint = '两侧尚未同时进入安全区';
      }
    }

    if (state.syncMs >= SYNC_MS) {
      this.finishSuccess();
      return state;
    }

    if (elapsed >= ACTION_WINDOW_MS / FIXED_MS) {
      this.finishFailure(
        'timeout',
        '上部模块',
        '同步窗口关闭，未能完成 1.2 秒稳定夹持',
        8
      );
    }
    return state;
  }

  advance(ticks = 1) {
    for (let index = 0; index < ticks; index += 1) this.tick();
    return this.state;
  }

  snapshot() {
    return this.state;
  }

  fingerprint() {
    const state = this.state;
    const payload = {
      tick: state.tick,
      phase: state.phase,
      completed: state.completed,
      inventory: state.inventory,
      durability: state.durability,
      offset: round(state.offset),
      pressure: round(state.pressure),
      syncMs: round(state.syncMs),
      collisions: state.timeline.collisions.map((item) => [
        item.tick,
        item.type,
        item.object,
        round(item.position.x),
        round(item.position.y)
      ]),
      conflicts: state.timeline.conflicts.map((item) => [item.tick, item.key]),
      results: state.timeline.results.map((item) => [
        item.tick,
        item.kind,
        item.completed,
        item.inventory
      ])
    };
    return fnv1a(JSON.stringify(payload));
  }

  serialize() {
    return JSON.parse(JSON.stringify(this.state));
  }

  restore(snapshot, options = {}) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('无效的模拟快照');
    }
    this.state = JSON.parse(JSON.stringify(snapshot));
    if (options.releaseInputs !== false) {
      this.state.leftHeld = false;
      this.state.rightHeld = false;
    }
    return this.state;
  }

  static fromSnapshot(snapshot, options = {}) {
    const engine = new AssemblyEngine({ autoStart: false });
    engine.restore(snapshot, options);
    return engine;
  }
}
