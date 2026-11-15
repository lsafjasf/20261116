export const CONFIG = Object.freeze({
  totalPackages: 48,
  duration: 600,
  tick: 0.1,
  cacheCapacity: 6,
  errorRateLimit: 0.06,
  enginePackTime: 1.8,
  enginePackCooldown: 1.05,
  beltStart: 245,
  beltEnd: 675,
  laneStart: 780,
  laneEnd: 1000,
  beltSpeed: 148,
  laneSpeed: 122,
  spawnStart: 6,
  spawnGap: 10.5,
  safetyGrace: 3,
  scanCost: 0.9,
  packCost: 2.1,
  repairAmount: 20,
  repairCooldown: 8,
});

const SIDE_DELAY = { p1: 0.24, p2: 0.18 };
const VALID_ACTIONS = new Set([
  'scan',
  'release',
  'stop',
  'resume',
  'repair',
  'laneA',
  'laneB',
  'pack',
]);

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function ceilTick(value) {
  return round(Math.ceil((value - 1e-7) / CONFIG.tick) * CONFIG.tick, 1);
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createBlueprints(seed, total) {
  const destinations = Array.from({ length: total }, (_, index) =>
    index % 2 === 0 ? 'A' : 'B'
  );
  const random = seededRandom(seed);
  for (let index = destinations.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [destinations[index], destinations[swap]] = [
      destinations[swap],
      destinations[index],
    ];
  }
  return destinations.map((dest, index) => ({
    id: index + 1,
    serial: `PKG-${String(index + 1).padStart(3, '0')}`,
    dest,
    spawnAt: round(CONFIG.spawnStart + index * CONFIG.spawnGap, 1),
  }));
}

function hashState(state) {
  const text = JSON.stringify(state);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function laneY(lane) {
  return lane === 'A' ? 238 : 454;
}

function packagePosition(pkg) {
  if (!pkg) return { x: -999, y: -999 };
  return { x: round(pkg.x), y: round(pkg.y) };
}

export class SortingSimulation {
  constructor(options = {}) {
    this.schema = 1;
    this.seed = options.seed ?? 20261116;
    this.total = options.total ?? CONFIG.totalPackages;
    this.runId = options.runId ?? `RUN-${this.seed.toString(16).toUpperCase()}`;
    this.blueprints = createBlueprints(this.seed, this.total);
    this.packages = this.blueprints.map((blueprint) => ({
      ...blueprint,
      status: 'pending',
      x: 56,
      y: 312,
      lane: null,
      plannedLane: null,
      lanePos: 0,
      jamUntil: 0,
      gateWaitStart: null,
      blockedAt: null,
      packedAt: null,
      packingLane: null,
      packingDue: null,
    }));
    this.time = 0;
    this.tickIndex = 0;
    this.phase = 'running';
    this.failureReason = null;
    this.completedAt = null;
    this.finalDigest = null;
    this.lineStop = false;
    this.caches = { A: [], B: [] };
    this.contamination = { A: 0, B: 0 };
    this.overflow = { A: null, B: null };
    this.durability = { p1: 100, p2: 100 };
    this.cooldowns = { p1Repair: 0, p2Repair: 0, pack: 0 };
    this.stats = {
      spawned: 0,
      scanned: 0,
      released: 0,
      routed: 0,
      packed: 0,
      errors: 0,
      contaminatedPacks: 0,
      overflowHits: 0,
      collisions: 0,
      stops: 0,
      repairs: 0,
    };
    this.inputs = [];
    this.pending = [];
    this.timeline = [];
    this.inputSequence = 0;
    this.eventSequence = 0;
    this.collisionSequence = 0;
    this.lastPhysicsCollisionAt = -99;
    this.lastCheckpointAt = 0;
    this.replaySource = null;
    this.replayInjected = 0;
    this.event('shift_start', {
      message: '双人分拣班次开始',
      objects: this.blueprints.map((item) => ({
        id: item.id,
        serial: item.serial,
        dest: item.dest,
      })),
    });
  }

  static fromRecording(recording) {
    const sim = new SortingSimulation({
      seed: recording.seed,
      total: recording.total,
      runId: recording.runId,
    });
    sim.replaySource = {
      ...recording,
      inputs: recording.inputs.map((input) => ({ ...input })),
    };
    sim.replayInjected = 0;
    sim.timeline = [];
    sim.eventSequence = 0;
    sim.event('replay_loaded', {
      message: '完整记录已载入回放台',
      sourceRun: recording.runId,
      expectedDigest: recording.finalDigest,
    });
    return sim;
  }

  static fromSnapshot(snapshot) {
    const sim = new SortingSimulation({
      seed: snapshot.seed,
      total: snapshot.total,
      runId: snapshot.runId,
    });
    const saved = snapshot.state;
    sim.packages = structuredClone(saved.packages);
    sim.time = saved.time;
    sim.tickIndex = saved.tickIndex;
    sim.phase = saved.phase;
    sim.failureReason = saved.failureReason;
    sim.completedAt = saved.completedAt;
    sim.finalDigest = saved.finalDigest;
    sim.lineStop = saved.lineStop;
    sim.caches = structuredClone(saved.caches);
    sim.contamination = structuredClone(saved.contamination);
    sim.overflow = structuredClone(saved.overflow);
    sim.durability = structuredClone(saved.durability);
    sim.cooldowns = structuredClone(saved.cooldowns);
    sim.stats = structuredClone(saved.stats);
    sim.inputs = structuredClone(snapshot.inputs);
    sim.pending = structuredClone(snapshot.pending);
    sim.timeline = structuredClone(snapshot.timeline);
    sim.inputSequence = saved.inputSequence;
    sim.eventSequence = saved.eventSequence;
    sim.collisionSequence = saved.collisionSequence;
    sim.lastPhysicsCollisionAt = saved.lastPhysicsCollisionAt;
    sim.lastCheckpointAt = saved.lastCheckpointAt;
    return sim;
  }

  packageById(id) {
    return this.packages.find((pkg) => pkg.id === id);
  }

  frontQueued() {
    return this.packages.find((pkg) => pkg.status === 'queue') ?? null;
  }

  scannedPackage() {
    return this.packages.find((pkg) => pkg.status === 'scanned') ?? null;
  }

  beltPackages() {
    return this.packages
      .filter((pkg) => pkg.status === 'belt')
      .sort((left, right) => right.x - left.x);
  }

  routeTarget() {
    return this.beltPackages().find((pkg) => pkg.x < CONFIG.beltEnd + 1) ?? null;
  }

  cacheLoad() {
    return this.caches.A.length + this.caches.B.length;
  }

  errorRate() {
    if (this.stats.packed === 0) return 0;
    return this.stats.errors / this.total;
  }

  stateSummary() {
    const belt = this.packages
      .filter((pkg) => pkg.status === 'belt')
      .map((pkg) => ({
        id: pkg.id,
        serial: pkg.serial,
        dest: pkg.dest,
        x: round(pkg.x),
        y: round(pkg.y),
        plannedLane: pkg.plannedLane,
      }));
    return {
      time: round(this.time, 1),
      phase: this.phase,
      lineStop: this.lineStop,
      queue: this.packages
        .filter((pkg) => pkg.status === 'queue' || pkg.status === 'scanned')
        .map((pkg) => ({ id: pkg.id, serial: pkg.serial, status: pkg.status })),
      belt,
      cacheA: [...this.caches.A],
      cacheB: [...this.caches.B],
      contamination: {
        A: round(this.contamination.A),
        B: round(this.contamination.B),
      },
      overflow: {
        A: this.overflow.A ? { since: round(this.overflow.A.since) } : null,
        B: this.overflow.B ? { since: round(this.overflow.B.since) } : null,
      },
      durability: { ...this.durability },
      progress: {
        scanned: this.stats.scanned,
        released: this.stats.released,
        packed: this.stats.packed,
        errors: this.stats.errors,
        total: this.total,
      },
    };
  }

  digestState() {
    return {
      time: round(this.time, 1),
      phase: this.phase,
      lineStop: this.lineStop,
      caches: { A: [...this.caches.A], B: [...this.caches.B] },
      contamination: {
        A: round(this.contamination.A),
        B: round(this.contamination.B),
      },
      durability: {
        p1: round(this.durability.p1),
        p2: round(this.durability.p2),
      },
      stats: { ...this.stats },
      packages: this.packages.map((pkg) => ({
        id: pkg.id,
        status: pkg.status,
        x: round(pkg.x),
        y: round(pkg.y),
        lane: pkg.lane,
        plannedLane: pkg.plannedLane,
        packedAt: pkg.packedAt === null ? null : round(pkg.packedAt, 1),
      })),
      pending: this.pending.map((item) => item.id),
    };
  }

  digest() {
    return hashState(this.digestState());
  }

  objectRef(pkg, role) {
    return {
      id: pkg?.id ?? null,
      serial: pkg?.serial ?? null,
      dest: pkg?.dest ?? null,
      role: role ?? null,
      status: pkg?.status ?? null,
      position: packagePosition(pkg),
    };
  }

  event(kind, payload = {}, at = this.time) {
    this.eventSequence += 1;
    const entry = {
      id: `e${this.eventSequence}`,
      at: round(at, 1),
      kind,
      ...payload,
      state: this.stateSummary(),
      digest: this.digest(),
    };
    this.timeline.push(entry);
    return entry;
  }

  press(side, action) {
    if (this.phase !== 'running' || !VALID_ACTIONS.has(action)) return null;
    if (side !== 'p1' && side !== 'p2') return null;
    this.inputSequence += 1;
    const baseDelay = SIDE_DELAY[side];
    const fatigueDelay = this.durability[side] < 35 ? 0.1 : 0;
    const effectiveAt = ceilTick(this.time + baseDelay + fatigueDelay);
    const input = {
      id: `i${this.inputSequence}`,
      sequence: this.inputSequence,
      side,
      action,
      at: round(this.time, 1),
      effectiveAt,
      dueTick: Math.round(effectiveAt / CONFIG.tick),
      delay: round(effectiveAt - this.time, 1),
    };
    this.inputs.push(input);
    this.pending.push({ ...input });

    const inversion = this.pending.find(
      (other) =>
        other.id !== input.id &&
        other.side !== input.side &&
        other.sequence < input.sequence &&
        other.dueTick > input.dueTick
    );
    if (inversion) {
      const objects = [
        ...this.conflictObjects(inversion.side, inversion.action),
        ...this.conflictObjects(side, action),
      ].filter(
        (item, index, list) =>
          item.id !== null && list.findIndex((other) => other.id === item.id) === index
      );
      this.event('conflict', {
        conflict: 'order_inversion',
        message: '两侧输入先后与执行先后相反',
        atExecution: effectiveAt,
        inputOrder: [
          {
            side: inversion.side,
            action: inversion.action,
            at: inversion.at,
            effectiveAt: inversion.effectiveAt,
          },
          {
            side: input.side,
            action: input.action,
            at: input.at,
            effectiveAt: input.effectiveAt,
          },
        ],
        executionOrder: [
          {
            side: input.side,
            action: input.action,
            effectiveAt: input.effectiveAt,
          },
          {
            side: inversion.side,
            action: inversion.action,
            effectiveAt: inversion.effectiveAt,
          },
        ],
        objects,
      });
    }

    this.event(
      'input',
      {
        side,
        action,
        inputId: input.id,
        effectiveAt,
        delay: input.delay,
        objects: this.conflictObjects(side, action),
      },
      input.at
    );
    return input;
  }

  conflictObjects(side, action) {
    if (side === 'p1') {
      const target =
        action === 'release' ? this.scannedPackage() : this.frontQueued();
      const objects = [
        this.objectRef(target, action === 'release' ? '待放行包裹' : '待扫码包裹'),
      ];
      if (action === 'release') {
        const trailing = this.beltPackages()[0];
        if (trailing) objects.push(this.objectRef(trailing, '皮带前车'));
      }
      return objects;
    }
    if (action === 'pack') {
      const lane =
        this.caches.A.length >= this.caches.B.length ? 'A' : 'B';
      const target =
        this.packageById(this.caches[lane][0]) ??
        this.blockedPackages(lane)[0] ??
        this.packageById(this.caches[lane === 'A' ? 'B' : 'A'][0]);
      return [this.objectRef(target, '待装箱包裹')];
    }
    const target = this.routeTarget();
    return [this.objectRef(target, '待分流包裹')];
  }

  collision(type, objects, result = {}, point = null) {
    this.collisionSequence += 1;
    this.stats.collisions += 1;
    return this.event('collision', {
      collisionId: `c${this.collisionSequence}`,
      collision: type,
      point:
        point ??
        objects.find((item) => item.position?.x > 0)?.position ?? {
          x: -999,
          y: -999,
        },
      objects,
      result,
    });
  }

  scheduleReplayInputs() {
    if (!this.replaySource) return;
    const inputs = this.replaySource.inputs;
    while (this.replayInjected < inputs.length) {
      const source = inputs[this.replayInjected];
      if (source.at > this.time + 1e-7) break;
      this.inputSequence += 1;
      const scheduled = {
        ...source,
        id: source.id ?? `i${this.inputSequence}`,
        sequence: this.inputSequence,
        dueTick: Math.round(source.effectiveAt / CONFIG.tick),
      };
      this.inputs.push(scheduled);
      this.pending.push({ ...scheduled });
      this.event('input', {
        side: scheduled.side,
        action: scheduled.action,
        inputId: scheduled.id,
        effectiveAt: scheduled.effectiveAt,
        delay: scheduled.delay,
        objects: this.conflictObjects(scheduled.side, scheduled.action),
        replayed: true,
      });
      this.replayInjected += 1;
    }
  }

  advanceTick() {
    if (this.phase !== 'running') return false;
    if (this.time >= CONFIG.duration - 1e-7) {
      this.fail('ten_minute_window');
      return false;
    }
    this.tickIndex += 1;
    this.time = round(this.tickIndex * CONFIG.tick, 1);
    this.scheduleReplayInputs();
    const due = this.pending
      .filter((input) => input.dueTick <= this.tickIndex)
      .sort((left, right) => left.dueTick - right.dueTick || left.sequence - right.sequence);
    this.pending = this.pending.filter((input) => input.dueTick > this.tickIndex);
    for (const input of due) this.applyAction(input);
    if (this.phase === 'running') this.physicsTick();
    if (
      this.phase === 'running' &&
      this.time - this.lastCheckpointAt >= 5 - 1e-7
    ) {
      this.lastCheckpointAt = this.time;
      this.event('checkpoint', { message: '共享状态检查点' });
    }
    if (this.phase === 'running' && this.time >= CONFIG.duration - 1e-7) {
      this.fail('ten_minute_window');
    }
    return this.phase === 'running';
  }

  advanceTo(targetTime) {
    const target = Math.min(targetTime, CONFIG.duration);
    while (this.phase === 'running' && this.time < target - 1e-7) {
      this.advanceTick();
    }
    return this;
  }

  applyAction(input) {
    if (this.phase !== 'running') return;
    if (input.action === 'scan') this.actionScan(input);
    else if (input.action === 'release') this.actionRelease(input);
    else if (input.action === 'stop') this.actionStop(input);
    else if (input.action === 'resume') this.actionResume(input);
    else if (input.action === 'repair') this.actionRepair(input);
    else if (input.action === 'laneA' || input.action === 'laneB') {
      this.actionRoute(input, input.action === 'laneA' ? 'A' : 'B');
    } else if (input.action === 'pack') this.actionPack(input);
  }

  actionScan(input) {
    const pkg = this.frontQueued();
    if (!pkg) {
      this.event('action_rejected', {
        side: input.side,
        action: input.action,
        reason: '没有待扫码包裹',
      });
      return;
    }
    pkg.status = 'scanned';
    pkg.x = 166;
    pkg.y = 326;
    this.stats.scanned += 1;
    this.durability.p1 = round(Math.max(0, this.durability.p1 - CONFIG.scanCost));
    this.event('scan', {
      side: 'p1',
      message: `${pkg.serial} 已扫码，目的地 ${pkg.dest}`,
      objects: [this.objectRef(pkg, '扫描位包裹')],
    });
    if (this.durability.p1 <= 0) this.fail('scanner_durability');
  }

  actionRelease(input) {
    if (this.lineStop) {
      this.event('action_rejected', {
        side: input.side,
        action: input.action,
        reason: '上游已停线，需先复线',
      });
      return;
    }
    const pkg = this.scannedPackage();
    if (!pkg) {
      this.event('action_rejected', {
        side: input.side,
        action: input.action,
        reason: '没有已扫码包裹',
      });
      return;
    }
    const ahead = this.beltPackages()[0];
    pkg.status = 'belt';
    pkg.x = CONFIG.beltStart;
    pkg.y = 312;
    pkg.lane = null;
    pkg.plannedLane = null;
    pkg.gateWaitStart = null;
    this.stats.released += 1;
    this.event('release', {
      side: 'p1',
      message: `${pkg.serial} 放行至主输送带`,
      objects: [this.objectRef(pkg, '放行包裹')],
    });
    if (ahead && ahead.x - CONFIG.beltStart < 72) {
      pkg.jamUntil = round(this.time + 1.1, 1);
      ahead.jamUntil = round(this.time + 1.1, 1);
      this.durability.p1 = round(Math.max(0, this.durability.p1 - 2.4));
      this.collision(
        'belt_feed_collision',
        [
          this.objectRef(pkg, '新放行包裹'),
          this.objectRef(ahead, '皮带前车'),
        ],
        {
          gap: round(ahead.x - CONFIG.beltStart, 1),
          durabilityLoss: 2.4,
          beltPause: 1.1,
          result: '两件包裹在放行口挤压，皮带短暂停转',
        },
        { x: CONFIG.beltStart, y: 312 }
      );
      if (this.durability.p1 <= 0) this.fail('scanner_durability');
    }
  }

  actionRoute(input, lane) {
    const pkg = this.routeTarget();
    if (!pkg) {
      this.event('action_rejected', {
        side: input.side,
        action: input.action,
        reason: '主带没有可分流包裹',
      });
      return;
    }
    const previous = pkg.plannedLane;
    pkg.plannedLane = lane;
    this.stats.routed += 1;
    this.event('route', {
      side: input.side,
      message: `${pkg.serial} 分流锁定 ${lane} 通道`,
      objects: [this.objectRef(pkg, '分流包裹')],
      targetLane: lane,
      correct: pkg.dest === lane,
    });
    if (previous && previous !== lane) {
      this.collision(
        'diverter_override',
        [this.objectRef(pkg, '分流中的包裹')],
        {
          from: previous,
          to: lane,
          durabilityLoss: 1.2,
          result: '分流臂在包裹通过前反向切换',
        },
        { x: CONFIG.beltEnd, y: 312 }
      );
      this.durability.p2 = round(Math.max(0, this.durability.p2 - 1.2));
      if (this.durability.p2 <= 0) this.fail('packer_durability');
    }
  }

  actionPack(input) {
    if (this.cooldowns.pack > this.time) {
      this.event('action_rejected', {
        side: input.side,
        action: input.action,
        reason: '装箱机仍在复位',
      });
      return;
    }
    const lane =
      this.caches.A.length >= this.caches.B.length ? 'A' : 'B';
    if (this.caches[lane].length === 0) {
      const alternate = lane === 'A' ? 'B' : 'A';
      if (this.caches[alternate].length > 0) {
        this.actionPackLane(input, alternate);
      } else {
        this.event('action_rejected', {
          side: input.side,
          action: input.action,
          reason: '两侧缓存均无包裹',
        });
      }
      return;
    }
    this.actionPackLane(input, lane);
  }

  actionPackLane(input, lane) {
    const id = this.caches[lane].shift();
    const pkg = this.packageById(id);
    pkg.status = 'packing';
    pkg.packingLane = lane;
    pkg.packingDue = ceilTick(this.time + CONFIG.enginePackTime);
    pkg.x = 1150;
    pkg.y = laneY(lane) + (lane === 'A' ? 22 : -22);
    this.cooldowns.pack = round(this.time + CONFIG.enginePackCooldown, 1);
    this.durability.p2 = round(Math.max(0, this.durability.p2 - CONFIG.packCost));
    this.event('pack_start', {
      side: 'p2',
      message: `${pkg.serial} 进入 ${lane} 箱装箱`,
      objects: [this.objectRef(pkg, '装箱包裹')],
      lane,
    });
    if (this.durability.p2 <= 0) this.fail('packer_durability');
  }

  completePacking(pkg) {
    pkg.status = 'packed';
    pkg.packedAt = this.time;
    pkg.x = 1200;
    pkg.y = 566;
    const lane = pkg.packingLane;
    const wrongLane = pkg.dest !== lane;
    const contaminated =
      !wrongLane && this.contamination[lane] >= 1.2;
    let errorReason = null;
    if (wrongLane) {
      this.stats.errors += 1;
      this.stats.contaminatedPacks += 1;
      this.contamination[lane] = round(
        Math.min(5, this.contamination[lane] + 2.4)
      );
      errorReason = 'wrong_lane';
    } else if (contaminated) {
      this.stats.errors += 1;
      this.stats.contaminatedPacks += 1;
      this.contamination[lane] = round(
        Math.max(0, this.contamination[lane] - 1.15)
      );
      errorReason = 'downstream_contamination';
    } else {
      this.contamination[lane] = round(
        Math.max(0, this.contamination[lane] - 0.12)
      );
    }
    this.stats.packed += 1;
    this.event('pack_complete', {
      side: 'p2',
      message: errorReason
        ? `${pkg.serial} 装箱异常：${errorReason}`
        : `${pkg.serial} 正确装箱`,
      objects: [this.objectRef(pkg, '已装箱包裹')],
      result: {
        success: !errorReason,
        errorReason,
        expectedLane: pkg.dest,
        actualLane: lane,
        contamination: round(this.contamination[lane]),
      },
    });
    if (this.errorRate() >= CONFIG.errorRateLimit) {
      this.fail('error_threshold');
    } else if (this.stats.packed === this.total) {
      this.succeed();
    }
  }

  actionStop(input) {
    if (this.lineStop) {
      this.event('action_rejected', {
        side: input.side,
        action: input.action,
        reason: '产线已经停止',
      });
      return;
    }
    this.lineStop = true;
    this.stats.stops += 1;
    const activeOverflow = Object.entries(this.overflow)
      .filter(([, value]) => value)
      .map(([lane, value]) => ({
        lane,
        elapsed: round(this.time - value.since, 1),
      }));
    this.event('line_stop', {
      side: 'p1',
      message: '上游输送已停止',
      result: {
        safetyConfirmed: activeOverflow.every(
          (item) => item.elapsed <= CONFIG.safetyGrace
        ),
        activeOverflow,
      },
    });
  }

  actionResume(input) {
    if (!this.lineStop) {
      this.event('action_rejected', {
        side: input.side,
        action: input.action,
        reason: '产线没有停止',
      });
      return;
    }
    const activeOverflow = Object.keys(this.overflow).filter(
      (lane) => this.overflow[lane]
    );
    this.lineStop = false;
    this.event('line_resume', {
      side: 'p1',
      message: activeOverflow.length
        ? `带警告复线：${activeOverflow.join('/')} 缓存仍溢出`
        : '上游输送恢复',
      result: { activeOverflow },
    });
  }

  actionRepair(input) {
    const cooldownKey = input.side === 'p1' ? 'p1Repair' : 'p2Repair';
    if (this.cooldowns[cooldownKey] > this.time) {
      this.event('action_rejected', {
        side: input.side,
        action: input.action,
        reason: '维护冷却中',
      });
      return;
    }
    this.durability[input.side] = round(
      Math.min(100, this.durability[input.side] + CONFIG.repairAmount)
    );
    this.cooldowns[cooldownKey] = round(this.time + CONFIG.repairCooldown, 1);
    this.stats.repairs += 1;
    this.event('repair', {
      side: input.side,
      message: `${input.side === 'p1' ? '扫描仪' : '装箱机'}完成维护`,
      result: { durability: this.durability[input.side] },
    });
  }

  physicsTick() {
    const dt = CONFIG.tick;
    const movingBelt = this.beltPackages();
    for (const pkg of this.packages) {
      if (pkg.status === 'pending' && pkg.spawnAt <= this.time + 1e-7) {
        pkg.status = 'queue';
        pkg.x = 58;
        pkg.y = 318;
        this.stats.spawned += 1;
        this.event('spawn', {
          message: `${pkg.serial} 到达上游队列`,
          objects: [this.objectRef(pkg, '新到包裹')],
        });
      }
      if (pkg.status === 'belt') {
        if (pkg.jamUntil <= this.time) {
          pkg.x = round(pkg.x + CONFIG.beltSpeed * dt);
        }
        pkg.y = 312;
        if (pkg.x >= CONFIG.beltEnd) {
          if (pkg.plannedLane) {
            pkg.status = 'lane';
            pkg.lane = pkg.plannedLane;
            pkg.lanePos = 0;
            pkg.x = CONFIG.laneStart;
            pkg.y = laneY(pkg.lane);
            this.event('gate_pass', {
              message: `${pkg.serial} 进入 ${pkg.lane} 通道`,
              objects: [this.objectRef(pkg, '过闸包裹')],
              lane: pkg.lane,
            });
          } else {
            pkg.x = CONFIG.beltEnd;
            if (pkg.gateWaitStart === null) {
              pkg.gateWaitStart = this.time;
              this.event('gate_wait', {
                message: `${pkg.serial} 在分流口等待路线`,
                objects: [this.objectRef(pkg, '等待分流包裹')],
              });
            }
          }
        }
      }
      if (pkg.status === 'lane') {
        pkg.lanePos = round(pkg.lanePos + CONFIG.laneSpeed * dt);
        pkg.x = round(Math.min(CONFIG.laneEnd, CONFIG.laneStart + pkg.lanePos));
        if (pkg.lanePos >= CONFIG.laneEnd - CONFIG.laneStart) {
          this.arriveAtCache(pkg);
        }
      }
      if (pkg.status === 'packing' && pkg.packingDue <= this.time) {
        this.completePacking(pkg);
      }
      if (pkg.status === 'packed') {
        pkg.y = 566;
      }
    }
    this.advanceLineRelations();
    this.processBlockedLanes();
    this.updateOverflowChain();
    this.detectBeltCollisions();
    this.contamination.A = round(
      Math.max(0, this.contamination.A - 0.012 * dt),
      3
    );
    this.contamination.B = round(
      Math.max(0, this.contamination.B - 0.012 * dt),
      3
    );
    this.reslotPackages();
  }

  advanceLineRelations() {
    for (const lane of ['A', 'B']) {
      const blocked = this.packages
        .filter((pkg) => pkg.status === 'blocked' && pkg.blockedLane === lane)
        .sort((left, right) => left.blockedAt - right.blockedAt);
      blocked.forEach((pkg, index) => {
        pkg.x = round(1004 - index * 18);
        pkg.y = laneY(lane) + (index % 2 === 0 ? 4 : -4);
      });
    }
  }

  arriveAtCache(pkg) {
    const lane = pkg.lane;
    if (this.caches[lane].length < CONFIG.cacheCapacity) {
      pkg.status = 'cache';
      pkg.x = 1036;
      pkg.y = laneY(lane);
      this.caches[lane].push(pkg.id);
      this.event('cache_arrival', {
        message: `${pkg.serial} 进入 ${lane} 缓存`,
        objects: [this.objectRef(pkg, '缓存包裹')],
        lane,
        cacheSize: this.caches[lane].length,
        correctLane: pkg.dest === lane,
      });
      return;
    }
    pkg.status = 'blocked';
    pkg.blockedLane = lane;
    pkg.blockedAt = this.time;
    pkg.x = 1004;
    pkg.y = laneY(lane);
    if (!this.overflow[lane]) {
      this.overflow[lane] = {
        since: this.time,
        lane,
        firstPackageId: pkg.id,
        chainStartedAt: null,
        lastDamageAt: null,
      };
      this.event('overflow', {
        message: `${lane} 缓存已满，上游必须停线`,
        objects: [this.objectRef(pkg, '阻塞包裹')],
        lane,
        cacheSize: this.caches[lane].length,
        graceSeconds: CONFIG.safetyGrace,
      });
    } else {
      this.event('overflow_cascade', {
        message: `${pkg.serial} 在 ${lane} 缓存口排队`,
        objects: [this.objectRef(pkg, '阻塞包裹')],
        lane,
        queueLength: this.blockedPackages(lane).length,
      });
    }
  }

  blockedPackages(lane) {
    return this.packages.filter(
      (pkg) => pkg.status === 'blocked' && pkg.blockedLane === lane
    );
  }

  processBlockedLanes() {
    for (const lane of ['A', 'B']) {
      while (
        this.caches[lane].length < CONFIG.cacheCapacity &&
        this.blockedPackages(lane).length > 0
      ) {
        const pkg = this.blockedPackages(lane).sort(
          (left, right) => left.blockedAt - right.blockedAt
        )[0];
        pkg.status = 'cache';
        pkg.x = 1036;
        pkg.y = laneY(lane);
        pkg.blockedAt = null;
        this.caches[lane].push(pkg.id);
        this.event('blocked_released', {
          message: `${pkg.serial} 等待后进入 ${lane} 缓存`,
          objects: [this.objectRef(pkg, '解除阻塞包裹')],
          lane,
        });
      }
      if (
        this.overflow[lane] &&
        this.caches[lane].length < CONFIG.cacheCapacity &&
        this.blockedPackages(lane).length === 0
      ) {
        const elapsed = round(this.time - this.overflow[lane].since, 1);
        this.event('overflow_clear', {
          message: `${lane} 缓存压力解除`,
          lane,
          elapsed,
        });
        this.overflow[lane] = null;
      }
    }
  }

  updateOverflowChain() {
    for (const lane of ['A', 'B']) {
      const overflow = this.overflow[lane];
      if (!overflow || this.lineStop) continue;
      const elapsed = this.time - overflow.since;
      if (elapsed < CONFIG.safetyGrace - 1e-7) continue;
      if (
        overflow.lastDamageAt !== null &&
        this.time - overflow.lastDamageAt < 2 - 1e-7
      ) {
        continue;
      }
      overflow.lastDamageAt = this.time;
      if (overflow.chainStartedAt === null) overflow.chainStartedAt = this.time;
      this.stats.overflowHits += 1;
      this.durability.p1 = round(Math.max(0, this.durability.p1 - 3.2));
      this.durability.p2 = round(Math.max(0, this.durability.p2 - 2.2));
      const blocked = this.blockedPackages(lane)[0];
      this.collision(
        'overflow_chain',
        [
          this.objectRef(blocked, '阻塞包裹'),
          this.objectRef(this.packageById(this.caches[lane][0]), '缓存头件'),
        ],
        {
          lane,
          elapsed: round(elapsed, 1),
          overflowHits: this.stats.overflowHits,
          durabilityLoss: { p1: 3.2, p2: 2.2 },
          result: '缓存溢出向上游反压，主带与装箱机同时受损',
        },
        { x: 1010, y: laneY(lane) }
      );
      if (this.stats.overflowHits >= 3) {
        this.fail('cache_overflow_chain');
      }
      if (this.durability.p1 <= 0 || this.durability.p2 <= 0) {
        this.fail('durability_depleted');
      }
    }
  }

  detectBeltCollisions() {
    if (this.time - this.lastPhysicsCollisionAt < 1.2) return;
    const belt = this.beltPackages();
    for (let index = 0; index < belt.length - 1; index += 1) {
      const ahead = belt[index];
      const behind = belt[index + 1];
      if (ahead.x - behind.x >= 68) continue;
      if (ahead.jamUntil > this.time || behind.jamUntil > this.time) continue;
      const point = {
        x: round((ahead.x + behind.x) / 2),
        y: 312,
      };
      ahead.jamUntil = round(this.time + 1, 1);
      behind.jamUntil = round(this.time + 1, 1);
      this.lastPhysicsCollisionAt = this.time;
      this.durability.p1 = round(Math.max(0, this.durability.p1 - 1.4));
      this.collision(
        'belt_rear_end',
        [
          this.objectRef(ahead, '被追尾包裹'),
          this.objectRef(behind, '追尾包裹'),
        ],
        {
          gap: round(ahead.x - behind.x, 1),
          beltPause: 1,
          durabilityLoss: 1.4,
          result: '主带包裹追尾，节拍短暂失步',
        },
        point
      );
      if (this.durability.p1 <= 0) this.fail('scanner_durability');
      break;
    }
  }

  reslotPackages() {
    const queued = this.packages
      .filter((pkg) => pkg.status === 'queue')
      .sort((left, right) => left.id - right.id);
    queued.forEach((pkg, index) => {
      pkg.x = round(48 + Math.min(index, 5) * 17);
      pkg.y = round(318 + Math.min(index, 7) * 7);
    });
    const scanned = this.scannedPackage();
    if (scanned) {
      scanned.x = 166;
      scanned.y = 326;
    }
    for (const lane of ['A', 'B']) {
      const cached = this.caches[lane].map((id) => this.packageById(id));
      cached.forEach((pkg, index) => {
        pkg.x = 1036 + (index % 3) * 48;
        pkg.y = laneY(lane) + (Math.floor(index / 3) - 0.5) * 54;
      });
      const packing = this.packages.find(
        (pkg) => pkg.status === 'packing' && pkg.packingLane === lane
      );
      if (packing) {
        packing.x = 1152;
        packing.y = laneY(lane);
      }
    }
  }

  fail(reason) {
    if (this.phase !== 'running') return;
    this.phase = 'failure';
    this.failureReason = reason;
    this.completedAt = this.time;
    this.finalDigest = this.digest();
    this.event('shift_complete', {
      message: '班次失败',
      result: {
        success: false,
        reason,
        time: this.time,
        packed: this.stats.packed,
        errors: this.stats.errors,
        errorRate: round(this.errorRate(), 4),
        digest: this.finalDigest,
      },
    });
  }

  succeed() {
    if (this.phase !== 'running') return;
    if (this.errorRate() >= CONFIG.errorRateLimit) {
      this.fail('error_threshold');
      return;
    }
    this.phase = 'success';
    this.completedAt = this.time;
    this.finalDigest = this.digest();
    this.event('shift_complete', {
      message: '班次成功',
      result: {
        success: true,
        time: this.time,
        packed: this.stats.packed,
        errors: this.stats.errors,
        errorRate: round(this.errorRate(), 4),
        digest: this.finalDigest,
      },
    });
  }

  exportState() {
    return {
      packages: structuredClone(this.packages),
      time: this.time,
      tickIndex: this.tickIndex,
      phase: this.phase,
      failureReason: this.failureReason,
      completedAt: this.completedAt,
      finalDigest: this.finalDigest,
      lineStop: this.lineStop,
      caches: structuredClone(this.caches),
      contamination: structuredClone(this.contamination),
      overflow: structuredClone(this.overflow),
      durability: structuredClone(this.durability),
      cooldowns: structuredClone(this.cooldowns),
      stats: structuredClone(this.stats),
      inputSequence: this.inputSequence,
      eventSequence: this.eventSequence,
      collisionSequence: this.collisionSequence,
      lastPhysicsCollisionAt: this.lastPhysicsCollisionAt,
      lastCheckpointAt: this.lastCheckpointAt,
    };
  }

  snapshot() {
    return {
      schema: this.schema,
      seed: this.seed,
      total: this.total,
      runId: this.runId,
      state: this.exportState(),
      inputs: structuredClone(this.inputs),
      pending: structuredClone(this.pending),
      timeline: structuredClone(this.timeline),
    };
  }

  recording() {
    return {
      schema: 1,
      runId: this.runId,
      seed: this.seed,
      total: this.total,
      createdAt: new Date().toISOString(),
      duration: round(this.completedAt ?? this.time, 1),
      phase: this.phase,
      success: this.phase === 'success',
      failureReason: this.failureReason,
      inputs: structuredClone(this.inputs),
      timeline: structuredClone(this.timeline),
      finalDigest: this.finalDigest ?? this.digest(),
      finalSummary: this.stateSummary(),
      stats: structuredClone(this.stats),
    };
  }
}

export function replayRecording(recording, options = {}) {
  const sim = SortingSimulation.fromRecording(recording);
  const target = options.to ?? recording.duration;
  sim.advanceTo(target);
  return sim;
}
