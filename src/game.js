import { clamp, distance2D, normalizeAngle, pointToSegmentDistance, polar, seededRandom, TAU } from "./utils.js";

export const BEACON_COUNT = 3;
export const PLAYER_SPEED = 2.7;
export const TURN_SPEED = 1.95;
export const WORLD_RADIUS = 19;

export const MATERIALS = {
  crystal: {
    id: "crystal",
    name: "冰晶壁",
    short: "晶",
    decay: 0.19,
    tone: 5200,
    reverb: 0.34,
    color: "#8fe8e1",
  },
  frost: {
    id: "frost",
    name: "霜岩壁",
    short: "霜",
    decay: 0.34,
    tone: 3200,
    reverb: 0.56,
    color: "#9bb9db",
  },
  blackice: {
    id: "blackice",
    name: "黑冰壁",
    short: "黑",
    decay: 0.52,
    tone: 1800,
    reverb: 0.72,
    color: "#647a94",
  },
};

function safeAngleSector(random, base, spread) {
  return normalizeAngle(base + (random() * 2 - 1) * spread);
}

export function createLevel(seed) {
  const random = seededRandom(seed, "level-v1");
  const sectorOffset = random() * TAU;
  const wrongBearing = normalizeAngle(sectorOffset + 0.36 + random() * 0.38);
  const beaconAngles = [
    safeAngleSector(random, sectorOffset + 1.46, 0.34),
    safeAngleSector(random, sectorOffset + 3.48, 0.4),
    safeAngleSector(random, sectorOffset + 4.92, 0.32),
  ];

  const beacons = beaconAngles.map((angle, index) => {
    const radius = 7.4 + random() * 3.7 + index * 0.45;
    const position = polar(angle, radius);
    return {
      id: `beacon-${index + 1}`,
      index,
      name: ["低频声标", "双声标", "冰裂声标"][index],
      frequency: [196, 261.6, 329.6][index],
      angle,
      distance: radius,
      x: position.x,
      z: position.z,
      activePhase: Math.floor(random() * 8),
    };
  });

  const wrongCenter = polar(wrongBearing, 5.7);
  const tangent = wrongBearing + Math.PI / 2;
  const halfLength = 3.2;
  const firstCrevasse = {
    id: "false-path",
    label: "错误方向：薄冰断层",
    wrongPath: true,
    width: 0.72,
    ax: wrongCenter.x - Math.sin(tangent) * halfLength,
    az: wrongCenter.z - Math.cos(tangent) * halfLength,
    bx: wrongCenter.x + Math.sin(tangent) * halfLength,
    bz: wrongCenter.z + Math.cos(tangent) * halfLength,
  };

  const crevasses = [firstCrevasse];
  for (let index = 0; index < 2; index += 1) {
    const angle = normalizeAngle(sectorOffset + 2.1 + index * 2.28 + random() * 0.5);
    const center = polar(angle, 9 + random() * 3);
    const radial = angle + Math.PI / 2 + (random() - 0.5) * 0.65;
    const length = 2.4 + random() * 1.8;
    crevasses.push({
      id: `crevasse-${index + 1}`,
      label: "冰层断裂带",
      wrongPath: false,
      width: 0.55 + random() * 0.25,
      ax: center.x - Math.sin(radial) * length,
      az: center.z - Math.cos(radial) * length,
      bx: center.x + Math.sin(radial) * length,
      bz: center.z + Math.cos(radial) * length,
    });
  }

  const materialAnchors = [
    { ...MATERIALS.crystal, x: beacons[0].x * 0.7, z: beacons[0].z * 0.7, radius: 6.5 },
    { ...MATERIALS.frost, x: beacons[1].x, z: beacons[1].z, radius: 7.2 },
    { ...MATERIALS.blackice, x: beacons[2].x, z: beacons[2].z, radius: 7.0 },
  ];

  return {
    seed: String(seed),
    wrongBearing,
    beacons,
    crevasses,
    materialAnchors,
    entrance: { id: "entrance", name: "入口共振腔", x: 0, z: 0, radius: 1.25 },
    signature: [
      roundLevelNumber(wrongBearing),
      ...beacons.flatMap((beacon) => [roundLevelNumber(beacon.angle), roundLevelNumber(beacon.distance)]),
      ...crevasses.slice(1).flatMap((crevasse) => [roundLevelNumber(crevasse.ax), roundLevelNumber(crevasse.bz)]) ,
    ].join("|"),
  };
}

function roundLevelNumber(value) {
  return Number(value.toFixed(4));
}

export function materialAt(level, position) {
  let selected = MATERIALS.blackice;
  let bestDistance = Infinity;
  for (const anchor of level.materialAnchors) {
    const distance = distance2D(position, anchor);
    if (distance < anchor.radius && distance < bestDistance) {
      selected = MATERIALS[anchor.id];
      bestDistance = distance;
    }
  }
  return selected;
}

export function nearestTarget(level, state) {
  const remaining = level.beacons.filter((beacon) => !state.collected.includes(beacon.id));
  const candidates = remaining.length > 0 ? remaining : [level.entrance];
  return candidates.reduce((nearest, candidate) => (
    distance2D(state.player, candidate) < distance2D(state.player, nearest) ? candidate : nearest
  ));
}

export function acousticReading(level, state) {
  const target = nearestTarget(level, state);
  const delta = target.x - state.player.x;
  const dz = target.z - state.player.z;
  const bearing = Math.atan2(delta, dz);
  const relative = normalizeAngle(bearing - state.player.yaw);
  const distance = Math.hypot(delta, dz);
  return {
    target,
    bearing,
    relative,
    distance,
    pan: clamp(Math.sin(relative) * 0.9, -0.94, 0.94),
    frontness: Math.cos(relative),
  };
}

export class IceGame {
  constructor(seed = "FROST-042") {
    this.reset(seed);
  }

  reset(seed = this.level?.seed || "FROST-042") {
    this.level = createLevel(seed);
    this.phase = "idle";
    this.elapsed = 0;
    this.collected = [];
    this.events = [];
    this.trail = [{ x: 0, z: 0, time: 0 }];
    this.player = { x: 0, z: 0, yaw: 0 };
    this.turnVelocity = 0;
    this.moveVelocity = 0;
    this.stepPhase = 0;
    this.justStepped = false;
    this.stepSide = 1;
    this.trailClock = 0;
    this.danger = 0;
    this.nearestCrevasse = null;
    this.boundaryWarning = false;
    this.currentMaterial = materialAt(this.level, this.player);
    this.target = this.level.beacons[0];
    this.failureCause = null;
    this.finishedAt = null;
    this.updateAcoustics();
    return this;
  }

  start() {
    if (this.phase === "playing") return { started: false, reason: "already-playing" };
    if (this.phase === "won" || this.phase === "failed") {
      this.reset(this.level.seed);
    }
    this.phase = "playing";
    return { started: true, seed: this.level.seed };
  }

  pause() {
    if (this.phase !== "playing") return false;
    this.phase = "paused";
    return true;
  }

  resume() {
    if (this.phase !== "paused") return false;
    this.phase = "playing";
    return true;
  }

  stop() {
    if (this.phase === "playing" || this.phase === "paused") {
      this.phase = "stopped";
    }
  }

  update(dt, controls) {
    this.justStepped = false;
    if (this.phase !== "playing") return;
    const safeDt = clamp(dt, 0, 0.05);
    this.elapsed += safeDt;

    const turnInput = Number(Boolean(controls.turnRight)) - Number(Boolean(controls.turnLeft));
    const moveInput = Number(Boolean(controls.forward)) - Number(Boolean(controls.back));
    this.turnVelocity += (turnInput * TURN_SPEED - this.turnVelocity) * Math.min(1, safeDt * 14);
    this.moveVelocity += (moveInput * PLAYER_SPEED - this.moveVelocity) * Math.min(1, safeDt * 10);
    this.player.yaw = normalizeAngle(this.player.yaw + this.turnVelocity * safeDt);

    const forwardX = Math.sin(this.player.yaw);
    const forwardZ = Math.cos(this.player.yaw);
    const nextX = this.player.x + forwardX * this.moveVelocity * safeDt;
    const nextZ = this.player.z + forwardZ * this.moveVelocity * safeDt;
    const radius = Math.hypot(nextX, nextZ);
    this.boundaryWarning = radius > WORLD_RADIUS - 1;
    if (radius <= WORLD_RADIUS) {
      this.player.x = nextX;
      this.player.z = nextZ;
    } else {
      const scale = WORLD_RADIUS / radius;
      this.player.x = nextX * scale;
      this.player.z = nextZ * scale;
      this.moveVelocity *= 0.2;
    }

    this.updateMovementFootsteps(safeDt);
    this.updateTrail(safeDt);
    this.collectReachableBeacon();
    this.updateHazards();
    this.updateAcoustics();
    this.checkExit();
  }

  updateMovementFootsteps(dt) {
    const speed = Math.abs(this.moveVelocity);
    if (speed > 0.18) {
      const before = this.stepPhase;
      this.stepPhase += dt * (3.4 + speed * 0.7);
      if (this.stepPhase - Math.floor(this.stepPhase) < before - Math.floor(before)) {
        this.justStepped = true;
        this.stepSide *= -1;
      }
    } else {
      this.stepPhase = 0;
    }
  }

  updateTrail(dt) {
    this.trailClock += dt;
    const last = this.trail[this.trail.length - 1];
    if (distance2D(last, this.player) > 0.18 && this.trailClock > 0.12) {
      this.trail.push({ x: this.player.x, z: this.player.z, time: this.elapsed });
      this.trailClock = 0;
      if (this.trail.length > 900) this.trail.shift();
    }
  }

  collectReachableBeacon() {
    for (const beacon of this.level.beacons) {
      if (this.collected.includes(beacon.id)) continue;
      if (distance2D(this.player, beacon) <= 1.12) {
        this.collected.push(beacon.id);
        this.events.push({ type: "beacon", id: beacon.id, time: this.elapsed });
        this.updateAcoustics();
      }
    }
  }

  updateHazards() {
    let closest = null;
    let danger = 0;
    for (const crevasse of this.level.crevasses) {
      const distance = pointToSegmentDistance(
        this.player,
        { x: crevasse.ax, z: crevasse.az },
        { x: crevasse.bx, z: crevasse.bz },
      ) - crevasse.width;
      const proximity = 1 - clamp(distance / 2.8, 0, 1);
      if (proximity > danger) {
        danger = proximity;
        closest = crevasse;
      }
      if (distance < crevasse.width * 0.38) {
        this.fail("crevasse", crevasse);
        return;
      }
    }
    this.danger = danger;
    this.nearestCrevasse = closest;
  }

  updateAcoustics() {
    this.target = nearestTarget(this.level, this);
    this.currentMaterial = materialAt(this.level, this.player);
  }

  checkExit() {
    if (this.collected.length < BEACON_COUNT) return;
    if (distance2D(this.player, this.level.entrance) <= this.level.entrance.radius) {
      this.phase = "won";
      this.finishedAt = this.elapsed;
      this.events.push({ type: "success", time: this.elapsed });
    }
  }

  fail(cause, hazard = null) {
    this.phase = "failed";
    this.failureCause = { cause, hazardId: hazard?.id ?? null, time: this.elapsed };
    this.events.push({ type: "failure", cause, hazardId: hazard?.id ?? null, time: this.elapsed });
  }

  reading() {
    return acousticReading(this.level, this);
  }

  stateSnapshot() {
    return {
      seed: this.level.seed,
      phase: this.phase,
      elapsed: this.elapsed,
      player: { ...this.player },
      collected: [...this.collected],
      turnVelocity: this.turnVelocity,
      moveVelocity: this.moveVelocity,
      stepPhase: this.stepPhase,
      stepSide: this.stepSide,
      trail: this.trail.map((point) => ({ ...point })),
    };
  }

  restoreState(snapshot) {
    const level = createLevel(snapshot.seed);
    this.level = level;
    this.phase = snapshot.phase;
    this.elapsed = snapshot.elapsed;
    this.player = { ...snapshot.player };
    this.collected = [...snapshot.collected];
    this.turnVelocity = snapshot.turnVelocity;
    this.moveVelocity = snapshot.moveVelocity;
    this.stepPhase = snapshot.stepPhase;
    this.stepSide = snapshot.stepSide;
    this.trail = snapshot.trail.map((point) => ({ ...point }));
    this.events = [];
    this.failureCause = null;
    this.updateAcoustics();
    this.updateHazards();
  }
}
