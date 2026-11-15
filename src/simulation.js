import * as C from './config.js';

// Deterministic PRNG so every replay reproduces identical jitter.
export class RNG {
  constructor(seed = C.DEFAULT_SEED) {
    this.state = seed >>> 0;
  }

  next() {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// FNV-1a hash used to prove that replay / speed changes never alter state.
export function hashObject(value) {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export class Simulation {
  constructor(seed = C.DEFAULT_SEED) {
    this.seed = seed;
    this.reset();
  }

  reset() {
    this.tick = 0;
    this.rand = new RNG(this.seed);
    // Separate stream for network jitter so player commands never shift the
    // inflow randomness that replay must reproduce.
    this.netRand = new RNG((this.seed ^ 0x9e3779b9) >>> 0);
    this.cmdSeq = 0;
    this.gate = { position: 0.5, target: 0.5, movePerTick: 0.1 };
    this.pump = {
      speed: 0,
      target: 0,
      heat: 25,
      durability: C.START_DURABILITY,
      tripped: false,
      tripCount: 0
    };
    this.upstreamLevel = C.INITIAL_UPSTREAM_LEVEL;
    this.channelLevel = C.INITIAL_CHANNEL_LEVEL;
    this.streetDepth = 0;
    this.pressure = 0;
    this.inflow = 0;
    this.gateFlow = 0;
    this.pumpFlow = 0;
    this.queue = []; // {id, player, type, value, issuedTick, dueTick}
    this.timeline = { inputs: [], events: [], metrics: [], conflicts: [] };
    this.ended = null; // {result, reason, tick}
  }

  get simSeconds() {
    return this.tick * C.TICK_SECONDS;
  }

  // A command is issued on one player's side and only reaches the shared
  // actuator after a randomized network latency (drawn from the seeded RNG).
  issueCommand(player, type, value, issuedTick = this.tick) {
    if (this.ended) return null;
    const baseLatency =
      type === 'pump_set' ? C.PUMP_LATENCY_TICKS : C.GATE_LATENCY_TICKS;
    const delay =
      baseLatency + Math.floor(this.netRand.next() * (C.LATENCY_JITTER + 1));
    const command = {
      id: `c${this.cmdSeq++}`,
      player,
      type,
      value: Math.round(value * 1000) / 1000,
      issuedTick,
      dueTick: issuedTick + delay,
      delay
    };
    this.queue.push(command);
    this.queue.sort((a, b) => a.dueTick - b.dueTick || a.id.localeCompare(b.id));
    this.timeline.inputs.push({ ...command });
    return command;
  }

  snapshot() {
    return {
      version: 1,
      seed: this.seed,
      tick: this.tick,
      randState: this.rand.state,
      netRandState: this.netRand.state,
      cmdSeq: this.cmdSeq,
      gate: { ...this.gate },
      pump: { ...this.pump },
      upstreamLevel: this.upstreamLevel,
      channelLevel: this.channelLevel,
      streetDepth: this.streetDepth,
      pressure: this.pressure,
      inflow: this.inflow,
      gateFlow: this.gateFlow,
      pumpFlow: this.pumpFlow,
      queue: this.queue.map((cmd) => ({ ...cmd })),
      ended: this.ended ? { ...this.ended } : null
    };
  }

  restore(snapshot) {
    this.seed = snapshot.seed;
    this.tick = snapshot.tick;
    this.rand = new RNG(this.seed);
    this.rand.state = snapshot.randState;
    this.netRand = new RNG((this.seed ^ 0x9e3779b9) >>> 0);
    this.netRand.state = snapshot.netRandState;
    this.cmdSeq = snapshot.cmdSeq;
    this.gate = { ...snapshot.gate };
    this.pump = { ...snapshot.pump };
    this.upstreamLevel = snapshot.upstreamLevel;
    this.channelLevel = snapshot.channelLevel;
    this.streetDepth = snapshot.streetDepth;
    this.pressure = snapshot.pressure;
    this.inflow = snapshot.inflow;
    this.gateFlow = snapshot.gateFlow;
    this.pumpFlow = snapshot.pumpFlow;
    this.queue = snapshot.queue.map((cmd) => ({ ...cmd }));
    this.ended = snapshot.ended ? { ...snapshot.ended } : null;
    if (!this.timeline) this.timeline = { inputs: [], events: [], metrics: [], conflicts: [] };
    return this;
  }

  recordEvent(type, detail) {
    const event = {
      tick: this.tick,
      simTime: Number(this.simSeconds.toFixed(2)),
      ...detail,
      // Explicit last so a detail field named `type` cannot override it.
      type
    };
    this.timeline.events.push(event);
    return event;
  }

  // Detect same-object, same-due-tick commands from the two players.
  detectConflicts(due) {
    for (let i = 0; i < due.length; i++) {
      for (let j = i + 1; j < due.length; j++) {
        const a = due[i];
        const b = due[j];
        if (a.player === b.player || a.type !== b.type) continue;
        const object = a.type === 'pump_set' ? 'pump-station' : 'sluice-gate';
        const position = a.type === 'pump_set' ? 'x=1420m' : 'x=0m';
        const conflicting =
          a.type === 'pump_set'
            ? a.value !== b.value
            : Math.abs(a.value - b.value) > 0.05;
        const conflict = {
          tick: this.tick,
          simTime: Number(this.simSeconds.toFixed(2)),
          object,
          position,
          commands: [a.id, b.id],
          players: [a.player, b.player],
          values: [a.value, b.value],
          orderSensitive: conflicting,
          note: conflicting
            ? 'opposing targets: last applied command wins'
            : 'same target from both sides: redundant simultaneous write'
        };
        this.timeline.conflicts.push(conflict);
        this.recordEvent('command_conflict', { object, position, ...conflict });
      }
    }
  }

  applyDueCommands() {
    const due = this.queue.filter((cmd) => cmd.dueTick <= this.tick);
    if (due.length === 0) return;
    this.detectConflicts(due);
    // Deterministic ordering: actuator group, then player id, then issue time.
    due.sort((a, b) => {
      const group = (cmd) => (cmd.type === 'pump_set' ? 1 : 0);
      return (
        group(a) - group(b) ||
        a.player.localeCompare(b.player) ||
        a.issuedTick - b.issuedTick ||
        a.id.localeCompare(b.id)
      );
    });
    for (const cmd of due) {
      if (cmd.type === 'pump_set') {
        this.pump.target = cmd.value;
      } else {
        this.gate.target = cmd.value;
      }
      this.recordEvent('command_applied', {
        commandId: cmd.id,
        player: cmd.player,
        type: cmd.type,
        value: cmd.value
      });
    }
    this.queue = this.queue.filter((cmd) => cmd.dueTick > this.tick);
  }

  step() {
    if (this.ended) return this.ended;
    const dt = C.TICK_SECONDS;
    this.applyDueCommands();

    // 1. Storm inflow enters the upstream pool.
    this.inflow = C.inflowAt(this.simSeconds, () => this.rand.next());

    // 2. Gate moves toward its target and passes water downstream.
    const gateDelta = this.gate.target - this.gate.position;
    const gateStep = Math.max(
      -this.gate.movePerTick,
      Math.min(this.gate.movePerTick, gateDelta)
    );
    this.gate.position = Math.max(0, Math.min(1, this.gate.position + gateStep));
    const head = Math.max(0, this.upstreamLevel - this.channelLevel);
    const gateArea = C.GATE_WIDTH * (0.1 + this.gate.position * 2.4);
    this.gateFlow = Math.min(
      this.inflow * 1.6,
      C.GATE_DISCHARGE_CD * gateArea * Math.sqrt(2 * C.GRAVITY * Math.max(0.02, head))
    );

    // 3. Pump ramps toward target, trips permanently block new output.
    if (this.pump.tripped && this.pump.heat <= 55) {
      // Automatic restart once the unit has cooled down enough.
      this.pump.tripped = false;
      this.pump.speed = 0;
    }
    if (!this.pump.tripped) {
      const pumpDelta = this.pump.target - this.pump.speed;
      const pumpStep = Math.max(
        -C.PUMP_RAMP_PER_TICK,
        Math.min(C.PUMP_RAMP_PER_TICK, pumpDelta)
      );
      this.pump.speed = Math.max(0, Math.min(1, this.pump.speed + pumpStep));
    }
    this.pumpFlow = this.pump.tripped ? 0 : this.pump.speed * C.PUMP_RATED_FLOW;

    // 4. Mass balance for the two pools.
    this.upstreamLevel += ((this.inflow - this.gateFlow) * dt) / C.UPSTREAM_AREA;
    this.channelLevel +=
      ((this.gateFlow - this.pumpFlow) * dt) / C.CHANNEL_AREA;

    // 5. Overtopping: water above the bank spills into the street and drains.
    const overtop = Math.max(0, this.channelLevel - C.CHANNEL_BANK_LEVEL);
    if (overtop > 0) {
      const spillVolume = overtop * C.CHANNEL_AREA;
      this.channelLevel = C.CHANNEL_BANK_LEVEL;
      this.streetDepth += (spillVolume * dt) / C.STREET_VOLUME;
      this.recordEvent('overtop', { depthGain: Number(overtop.toFixed(3)) });
    }
    this.streetDepth = Math.max(0, this.streetDepth - C.STREET_DRAIN_PER_SEC * dt);

    // 6. Heat: pumping heats the unit, idle time cools it.
    let nextHeat;
    if (this.pump.tripped) {
      nextHeat = this.pump.heat - C.HEAT_COOLING;
    } else {
      const heatGain = C.HEAT_PER_FLOW * this.pump.speed * this.pump.speed;
      nextHeat =
        this.pump.heat + heatGain - C.HEAT_COOLING * (1 - this.pump.speed);
    }
    this.pump.heat = Math.min(C.OVERHEAT_TEMP, Math.max(20, nextHeat));
    if (this.pump.heat >= C.OVERHEAT_TEMP && !this.pump.tripped) {
      this.pump.tripped = true;
      this.pump.tripCount += 1;
      this.pump.durability = Math.max(0, this.pump.durability - C.OVERHEAT_DURABILITY_LOSS);
      this.recordEvent('pump_overheat', {
        heat: Number(this.pump.heat.toFixed(1)),
        durability: this.pump.durability
      });
    }

    // 7. Pressure differential across the structure (kPa).
    this.pressure = head * 9.81;
    if (this.pressure >= C.COLLISION_DP) {
      this.recordEvent('structural_collision', {
        pressure: Number(this.pressure.toFixed(2)),
        object: 'sluice-gate',
        position: 'x=0m'
      });
    }

    // 8. Record the shared-state metric row for this exact tick.
    this.timeline.metrics.push({
      tick: this.tick,
      t: Number(this.simSeconds.toFixed(2)),
      upstream: Number(this.upstreamLevel.toFixed(4)),
      channel: Number(this.channelLevel.toFixed(4)),
      street: Number(this.streetDepth.toFixed(4)),
      pressure: Number(this.pressure.toFixed(3)),
      heat: Number(this.pump.heat.toFixed(2)),
      durability: this.pump.durability,
      gate: Number(this.gate.position.toFixed(3)),
      pump: Number(this.pump.speed.toFixed(3)),
      inflow: Number(this.inflow.toFixed(3)),
      gateFlow: Number(this.gateFlow.toFixed(3)),
      pumpFlow: Number(this.pumpFlow.toFixed(3))
    });

    this.tick += 1;
    if (this.streetDepth >= C.STREET_FAILURE_LEVEL) {
      this.ended = { result: 'failure', reason: 'street-flooded', tick: this.tick };
      this.recordEvent('mission_end', this.ended);
    } else if (this.pump.durability <= C.MIN_DURABILITY || this.pump.tripCount >= C.MAX_TRIPS) {
      this.ended = { result: 'failure', reason: 'pump-destroyed', tick: this.tick };
      this.recordEvent('mission_end', this.ended);
    } else if (this.tick >= C.TOTAL_TICKS) {
      this.ended = { result: 'success', reason: 'held-safe-level-30min', tick: this.tick };
      this.recordEvent('mission_end', this.ended);
    }
    return this.ended;
  }

  runToEnd(maxTicks = C.TOTAL_TICKS) {
    let guard = 0;
    while (!this.ended && guard < maxTicks) {
      this.step();
      guard += 1;
    }
    return this.ended;
  }
}
