/*
 * Lighthouse co-op simulation core.
 * Pure deterministic logic: fixed timestep, seeded RNG, no DOM access.
 * Runs unchanged in the browser and in Node (tests / replay verification).
 */
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.LighthouseSim = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;
  const DT = 1 / 30;
  const WORLD = { w: 900, h: 640 };
  const CENTER = { x: 450, y: 320 };
  const HARBOR = { x: 842, y: 320, r: 48 };

  const TUNING = {
    rotSpeed: 2.35,           // rad/s at full rotation input
    powerStep: 0.75,          // power units per second of held input
    heatOnBase: 8,            // heat gain per second with lamp on at power 0
    heatOnPower: 24,          // extra heat per second at full power
    heatCoolOn: 14,           // passive cooling even while the lamp is lit
    heatCool: 26,             // heat loss per second with lamp off
    overheatAt: 100,
    overheatSeconds: 4,
    overheatResumeHeat: 64,
    hazardPerSec: 9,          // hazard gain per second a reef is lit
    hazardDecay: 8,
    hazardFail: 100,
    beamMinHalf: 0.075,       // radians, half-angle at power 0
    beamMaxHalf: 0.44,        // radians, half-angle at power 1
    rangeMin: 330,
    rangeMax: 520,
    shipSpeed: 64,
    shipTurn: 1.15,
    driftSpeed: 15,
    driftWander: 2.6,
    driftBiasToHarbor: 0.35,
    timeoutSeconds: 90,
    reefCount: 7,
    shipCount: 3
  };

  const MODES = ['ready', 'running', 'paused', 'overheat', 'success', 'failed'];

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function angDiff(a, b) {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function dist(ax, ay, bx, by) {
    return Math.hypot(ax - bx, ay - by);
  }

  // Deterministic seeded RNG (mulberry32). State is part of the hash.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return {
      next() {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      get state() {
        return a >>> 0;
      },
      set state(v) {
        a = v >>> 0;
      }
    };
  }

  // FNV-1a over a canonical string; identical across JS engines.
  function hashString(str) {
    let h = 0x811C9DC5;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function r4(v) {
    return Math.round(v * 10000) / 10000;
  }

  class Simulation {
    constructor(seed) {
      this.seed = (seed === undefined ? 1 : seed) >>> 0;
      this.events = [];
      this.inputLog = [];
      this.reset(this.seed);
    }

    reset(seed) {
      if (seed !== undefined) this.seed = seed >>> 0;
      this.rng = mulberry32(this.seed);
      this.mode = 'ready';
      this.time = 0;
      this.stepCount = 0;
      this.angle = 0;                  // lamp heading, radians (toward spawns)
      this.power = 0.55;               // 0..1 output
      this.heat = 24;
      this.overheatLeft = 0;
      this.hazard = 0;
      this.lampOn = true;
      this.failReason = null;
      this.targetShip = 0;
      this.reefLitMask = 0;
      this.beam = { half: 0, range: 0, litShips: [] };
      this.reefs = this._makeReefs();
      this.ships = this._makeShips();
      this.lastEvent = null;
      this.events.length = 0;
      this.inputLog.length = 0;
      this._emit('reset', { seed: this.seed });
      return this.snapshot();
    }

    _makeReefs() {
      const reefs = [];
      let guard = 0;
      while (reefs.length < TUNING.reefCount && guard < 500) {
        guard++;
        const x = 90 + this.rng.next() * (WORLD.w - 200);
        const y = 60 + this.rng.next() * (WORLD.h - 120);
        if (dist(x, y, CENTER.x, CENTER.y) < 115) continue;
        if (dist(x, y, HARBOR.x, HARBOR.y) < HARBOR.r + 70) continue;
        // Keep the spawn lanes (left edge) and harbour approach clear.
        if (x < 175) continue;
        if (x > WORLD.w - 150 && Math.abs(y - HARBOR.y) < 120) continue;
        if (reefs.some((r) => dist(r.x, r.y, x, y) < 85)) continue;
        reefs.push({
          id: reefs.length,
          x,
          y,
          r: 17 + this.rng.next() * 13,
          lit: false
        });
      }
      return reefs;
    }

    _makeShips() {
      const ships = [];
      for (let i = 0; i < TUNING.shipCount; i++) {
        const y = 110 + i * ((WORLD.h - 220) / (TUNING.shipCount - 1));
        ships.push({
          id: i,
          x: 46 + this.rng.next() * 18,
          y: y + (this.rng.next() - 0.5) * 26,
          heading: 0,
          speed: 0,
          lit: false,
          state: 'sailing',
          dockTime: null
        });
      }
      return ships;
    }

    _emit(type, detail) {
      const ev = {
        step: this.stepCount,
        time: r4(this.time),
        type,
        detail: detail || {}
      };
      this.events.push(ev);
      if (this.events.length > 60) this.events.shift();
      this.lastEvent = ev;
    }

    // One player steers the lamp, the other sets output. Inputs are recorded.
    applyInput(input) {
      if (!input || typeof input !== 'object') return;
      if (this.mode !== 'running' && this.mode !== 'overheat') return;
      const rec = {
        step: this.stepCount,
        rot: clamp(Number(input.rot) || 0, -1, 1),
        power: clamp(Number(input.power) || 0, -1, 1),
        lamp: typeof input.lamp === 'boolean' ? input.lamp : null,
        target: Number.isInteger(input.target) ? input.target : null
      };
      this.inputLog.push(rec);
      this._pending = rec;
    }

    start() {
      if (this.mode === 'ready') {
        this.mode = 'running';
        this._emit('start', {});
      }
      return this.mode;
    }

    pause() {
      if (this.mode === 'running' || this.mode === 'overheat') {
        this._prevMode = this.mode;
        this.mode = 'paused';
        this._emit('pause', {});
      }
      return this.mode;
    }

    resume() {
      if (this.mode === 'paused') {
        this.mode = this._prevMode || 'running';
        this._emit('resume', { mode: this.mode });
      }
      return this.mode;
    }

    restart(seed) {
      return this.reset(seed);
    }

    // Failure recovery: restart from the same seeded layout.
    recover() {
      if (this.mode === 'failed' || this.mode === 'success') {
        this._emit('recover', { reason: this.failReason });
        return this.reset(this.seed);
      }
      return this.snapshot();
    }

    get _input() {
      return this._pending || { rot: 0, power: 0, lamp: null, target: null };
    }

    step() {
      if (this.mode === 'ready' || this.mode === 'paused' ||
          this.mode === 'success' || this.mode === 'failed') {
        this._pending = null;
        return this.snapshot();
      }

      const inp = this._input;
      this._pending = null;
      this.stepCount++;
      this.time = r4(this.time + DT);

      if (this.mode === 'overheat') {
        this._stepOverheat(inp);
      } else {
        this._stepRunning(inp);
      }

      this._checkEndConditions();
      return this.snapshot();
    }

    _stepRunning(inp) {
      if (typeof inp.lamp === 'boolean') this.lampOn = inp.lamp;
      if (inp.target !== null) this.targetShip = inp.target;

      this.angle = this.angle + inp.rot * TUNING.rotSpeed * DT;
      this.angle = this.angle % (Math.PI * 2);
      if (this.angle < 0) this.angle += Math.PI * 2;

      this.power = clamp(this.power + inp.power * TUNING.powerStep * DT, 0, 1);

      if (this.lampOn) {
        const rise = TUNING.heatOnBase + TUNING.heatOnPower * this.power;
        this.heat = clamp(
          this.heat + (rise - TUNING.heatCoolOn) * DT, 0, TUNING.overheatAt);
      } else {
        this.heat = clamp(this.heat - TUNING.heatCool * DT, 0, TUNING.overheatAt);
      }

      if (this.heat >= TUNING.overheatAt) {
        this.mode = 'overheat';
        this.overheatLeft = TUNING.overheatSeconds;
        this.lampOn = false;
        this._emit('overheat', { heat: r4(this.heat) });
      }

      this._updateBeam();
      this._updateHazard(DT);
      this._updateShips(DT);
    }

    _stepOverheat(inp) {
      // Output is forced down while the lamp chamber cools.
      this.power = clamp(this.power - 0.9 * DT, 0, 1);
      this.heat = clamp(this.heat - TUNING.heatCool * 1.25 * DT, 0, TUNING.overheatAt);
      this.overheatLeft = Math.max(0, this.overheatLeft - DT);
      this.lampOn = false;
      this._updateBeam();
      this._updateHazard(DT);
      this._updateShips(DT);

      if (this.overheatLeft <= 0 && this.heat <= TUNING.overheatResumeHeat) {
        this.mode = 'running';
        this.lampOn = true;
        this._emit('cooled', { heat: r4(this.heat) });
      }
    }

    _updateBeam() {
      const half = TUNING.beamMinHalf +
        (TUNING.beamMaxHalf - TUNING.beamMinHalf) * this.power;
      const range = TUNING.rangeMin +
        (TUNING.rangeMax - TUNING.rangeMin) * this.power;
      this.beam.half = half;
      this.beam.range = range;
      this.beam.litShips = [];
      this.reefLitMask = 0;

      if (!this.lampOn) {
        for (const reef of this.reefs) reef.lit = false;
        for (const ship of this.ships) ship.lit = false;
        return;
      }

      for (const reef of this.reefs) {
        const d = dist(CENTER.x, CENTER.y, reef.x, reef.y);
        const a = Math.atan2(reef.y - CENTER.y, reef.x - CENTER.x);
        reef.lit = d <= range && Math.abs(angDiff(a, this.angle)) <= half;
        if (reef.lit) this.reefLitMask |= (1 << reef.id);
      }

      for (const ship of this.ships) {
        if (ship.state !== 'sailing') {
          ship.lit = false;
          continue;
        }
        const d = dist(CENTER.x, CENTER.y, ship.x, ship.y);
        const a = Math.atan2(ship.y - CENTER.y, ship.x - CENTER.x);
        ship.lit = this.lampOn && d <= range &&
          Math.abs(angDiff(a, this.angle)) <= half;
        if (ship.lit) this.beam.litShips.push(ship.id);
      }
    }

    _updateHazard(dt) {
      const litCount = this.reefs.reduce((n, r) => n + (r.lit ? 1 : 0), 0);
      if (litCount > 0) {
        this.hazard = clamp(
          this.hazard + TUNING.hazardPerSec * litCount * dt, 0, TUNING.hazardFail);
      } else {
        this.hazard = clamp(this.hazard - TUNING.hazardDecay * dt, 0, TUNING.hazardFail);
      }
    }

    _updateShips(dt) {
      for (const ship of this.ships) {
        if (ship.state !== 'sailing') continue;

        if (ship.lit) {
          // Safe water: steer toward the harbour, bending around reefs.
          let aim = Math.atan2(HARBOR.y - ship.y, HARBOR.x - ship.x);
          let best = null;
          for (const reef of this.reefs) {
            const d = dist(ship.x, ship.y, reef.x, reef.y);
            if (d < reef.r + 130 && (!best || d < best.d)) {
              best = { reef, d };
            }
          }
          if (best) {
            const away = Math.atan2(ship.y - best.reef.y, ship.x - best.reef.x);
            const weight = clamp(1 - best.d / (best.reef.r + 130), 0, 1);
            aim = aim + angDiff(away, aim) * (0.6 + weight * 0.4);
          }
          const turn = clamp(angDiff(aim, ship.heading),
            -TUNING.shipTurn * dt, TUNING.shipTurn * dt);
          ship.heading += turn;
          ship.speed = TUNING.shipSpeed;
        } else {
          // Dark water: no pilot guidance; wandering drift with a weak
          // harbour instinct so ships do not sprint straight into reefs.
          const want = Math.atan2(HARBOR.y - ship.y, HARBOR.x - ship.x);
          ship.heading += (this.rng.next() - 0.5) * 2 * TUNING.driftWander * dt;
          ship.heading += angDiff(want, ship.heading) * TUNING.driftBiasToHarbor * dt;
          ship.speed = TUNING.driftSpeed;
        }

        ship.x += Math.cos(ship.heading) * ship.speed * dt;
        ship.y += Math.sin(ship.heading) * ship.speed * dt;

        if (dist(ship.x, ship.y, HARBOR.x, HARBOR.y) <= HARBOR.r) {
          ship.state = 'docked';
          ship.dockTime = r4(this.time);
          this._emit('dock', { ship: ship.id, time: ship.dockTime });
          continue;
        }

        for (const reef of this.reefs) {
          if (dist(ship.x, ship.y, reef.x, reef.y) <= reef.r + 6) {
            ship.state = 'wrecked';
            this._emit('wreck', { ship: ship.id, reef: reef.id });
            break;
          }
        }
        if (ship.state !== 'sailing') continue;

        if (ship.x < -20 || ship.x > WORLD.w + 20 ||
            ship.y < -20 || ship.y > WORLD.h + 20) {
          ship.state = 'lost';
          this._emit('lost', { ship: ship.id });
        }
      }
    }

    _checkEndConditions() {
      if (this.mode !== 'running' && this.mode !== 'overheat') return;

      const docked = this.ships.filter((s) => s.state === 'docked').length;
      if (docked === this.ships.length) {
        this.mode = 'success';
        this.lampOn = false;
        this._emit('success', { time: r4(this.time) });
        return;
      }

      const lost = this.ships.some((s) => s.state === 'wrecked' || s.state === 'lost');
      if (lost) {
        this.mode = 'failed';
        this.failReason = 'ship-lost';
        this.lampOn = false;
        this._emit('fail', { reason: this.failReason });
        return;
      }

      if (this.hazard >= TUNING.hazardFail) {
        this.mode = 'failed';
        this.failReason = 'hazard-overflow';
        this.lampOn = false;
        this._emit('fail', { reason: this.failReason });
        return;
      }

      if (this.time >= TUNING.timeoutSeconds) {
        this.mode = 'failed';
        this.failReason = 'timeout';
        this.lampOn = false;
        this._emit('fail', { reason: this.failReason });
      }
    }

    snapshot() {
      return {
        version: VERSION,
        seed: this.seed,
        mode: this.mode,
        time: r4(this.time),
        step: this.stepCount,
        angle: r4(this.angle),
        power: r4(this.power),
        heat: r4(this.heat),
        hazard: r4(this.hazard),
        lampOn: this.lampOn,
        overheatLeft: r4(this.overheatLeft),
        targetShip: this.targetShip,
        rngState: this.rng.state,
        reefs: this.reefs.map((r) => ({
          id: r.id, x: r4(r.x), y: r4(r.y), r: r4(r.r), lit: r.lit
        })),
        ships: this.ships.map((s) => ({
          id: s.id, x: r4(s.x), y: r4(s.y), heading: r4(s.heading),
          speed: r4(s.speed), lit: s.lit, state: s.state, dockTime: s.dockTime
        })),
        beam: {
          half: r4(this.beam.half),
          range: r4(this.beam.range),
          litShips: this.beam.litShips.slice()
        },
        reefLitMask: this.reefLitMask,
        failReason: this.failReason,
        inputsRecorded: this.inputLog.length,
        eventsEmitted: this.events.length
      };
    }

    // Canonical serialization: sorted keys, fixed numeric rounding.
    static canonicalize(value) {
      if (Array.isArray(value)) {
        return '[' + value.map(Simulation.canonicalize).join(',') + ']';
      }
      if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return '{' + keys
          .map((k) => JSON.stringify(k) + ':' + Simulation.canonicalize(value[k]))
          .join(',') + '}';
      }
      return JSON.stringify(value);
    }

    stateHash() {
      return hashString(Simulation.canonicalize(this.snapshot()));
    }

    stats() {
      const sailing = this.ships.filter((s) => s.state === 'sailing').length;
      const docked = this.ships.filter((s) => s.state === 'docked').length;
      const wrecked = this.ships.filter((s) => s.state === 'wrecked').length;
      const lost = this.ships.filter((s) => s.state === 'lost').length;
      const litReefs = this.reefs.filter((r) => r.lit).length;
      return {
        mode: this.mode,
        time: r4(this.time),
        heat: r4(this.heat),
        hazard: r4(this.hazard),
        power: r4(this.power),
        lampOn: this.lampOn,
        sailing,
        docked,
        wrecked,
        lost,
        litReefs,
        targetShip: this.targetShip,
        stateHash: this.stateHash()
      };
    }

    toRecord() {
      return {
        version: VERSION,
        seed: this.seed,
        inputs: this.inputLog.map((r) => Object.assign({}, r))
      };
    }

    // Re-execute a saved (seed, input) record. Must yield the identical hash.
    static replay(record, maxSteps) {
      const sim = new Simulation(record.seed);
      const byStep = new Map();
      for (const rec of record.inputs) {
        if (!byStep.has(rec.step)) byStep.set(rec.step, []);
        byStep.get(rec.step).push(rec);
      }
      sim.start();
      const limit = maxSteps || Math.ceil(TUNING.timeoutSeconds / DT) + 120;
      let guard = 0;
      while (guard++ < limit) {
        const queued = byStep.get(sim.stepCount) || [];
        for (const rec of queued) sim.applyInput(rec);
        const before = sim.mode;
        sim.step();
        if (sim.mode === 'success' || sim.mode === 'failed') break;
        if (before === sim.mode && sim.stepCount > limit) break;
      }
      return {
        mode: sim.mode,
        hash: sim.stateHash(),
        snapshot: sim.snapshot(),
        stats: sim.stats(),
        sim
      };
    }
  }

  return {
    Simulation,
    TUNING,
    WORLD,
    CENTER,
    HARBOR,
    DT,
    MODES,
    VERSION,
    hashString,
    mulberry32,
    clamp,
    angDiff,
    dist
  };
});
