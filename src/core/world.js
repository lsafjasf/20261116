export const WORLD_WIDTH = 2400;
export const WORLD_HEIGHT = 1600;
export const SHIP_RADIUS = 15;
export const SENSOR_RADIUS = 260;
export const CELL_SIZE = 160;

export const SHIP_PHYSICS = Object.freeze({
  thrust: 430,
  turnRate: 3.05,
  linearDrag: 0.24,
  angularDrag: 1.8,
  maxSpeed: 470,
  restitution: 0.42,
});

const mulberry32 = (seed) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const normalizeAngle = (angle) => {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
};

const cloneShip = (ship) => ({
  x: ship.x,
  y: ship.y,
  vx: ship.vx,
  vy: ship.vy,
  angle: ship.angle,
  angularVelocity: ship.angularVelocity,
});

export class PhysicsWorld {
  constructor({
    seed = 613,
    broadphase = "grid",
    cache = true,
    nodeCount = 96,
  } = {}) {
    if (broadphase !== "grid" && broadphase !== "naive") {
      throw new RangeError('broadphase must be "grid" or "naive"');
    }
    this.seed = seed >>> 0;
    this.broadphase = broadphase;
    this.cacheEnabled = Boolean(cache);
    this.ship = {
      x: WORLD_WIDTH / 2,
      y: WORLD_HEIGHT / 2,
      vx: 0,
      vy: 0,
      angle: -Math.PI / 2,
      angularVelocity: 0,
    };
    this.previousShip = cloneShip(this.ship);
    this.requestedNodeCount = nodeCount;
    this.nodes = this.generateNodes(nodeCount);
    this.spatialGrid = this.buildSpatialGrid();
    this.queryCache = new Map();
    this.resetRuntime();
  }

  generateNodes(count) {
    const random = mulberry32(this.seed);
    const nodes = [];
    const startX = WORLD_WIDTH / 2;
    const startY = WORLD_HEIGHT / 2;
    let attempts = 0;

    while (nodes.length < count && attempts < count * 300) {
      attempts += 1;
      const x = 90 + random() * (WORLD_WIDTH - 180);
      const y = 90 + random() * (WORLD_HEIGHT - 180);
      if (Math.hypot(x - startX, y - startY) < 370) continue;
      if (nodes.some((node) => Math.hypot(x - node.x, y - node.y) < 54)) continue;
      nodes.push({
        id: nodes.length,
        x,
        y,
        radius: 10 + random() * 17,
        shapeSeed: Math.floor(random() * 0xffffffff),
        phase: random() * Math.PI * 2,
      });
    }

    return nodes;
  }

  buildSpatialGrid() {
    const grid = new Map();
    for (const node of this.nodes) {
      const cx = Math.floor(node.x / CELL_SIZE);
      const cy = Math.floor(node.y / CELL_SIZE);
      const key = `${cx}:${cy}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(node.id);
      else grid.set(key, [node.id]);
    }
    return grid;
  }

  resetRuntime() {
    this.time = 0;
    this.previousTime = 0;
    this.stepCount = 0;
    this.collisions = 0;
    this.lastCollision = false;
    this.thrusterActive = false;
    this.lastInput = { thrust: false, turn: 0 };
    this.metrics = {
      candidateCount: 0,
      broadphaseCandidateCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
      distanceChecks: 0,
      collisionChecks: 0,
      nodeCount: this.nodes.length,
    };
    this.queryCache.clear();
  }

  reset() {
    Object.assign(this.ship, {
      x: WORLD_WIDTH / 2,
      y: WORLD_HEIGHT / 2,
      vx: 0,
      vy: 0,
      angle: -Math.PI / 2,
      angularVelocity: 0,
    });
    this.previousShip = cloneShip(this.ship);
    this.resetRuntime();
  }

  freezeInterpolation() {
    this.previousShip = cloneShip(this.ship);
    this.previousTime = this.time;
  }

  queryCandidates(x, y) {
    const radiusSquared = SENSOR_RADIUS * SENSOR_RADIUS;
    const candidates = [];
    let distanceChecks = 0;

    if (this.broadphase === "naive") {
      for (const node of this.nodes) {
        distanceChecks += 1;
        const dx = node.x - x;
        const dy = node.y - y;
        if (dx * dx + dy * dy <= radiusSquared) candidates.push(node.id);
      }
      this.metrics.broadphaseCandidateCount = this.nodes.length;
    } else {
      const cx = Math.floor(x / CELL_SIZE);
      const cy = Math.floor(y / CELL_SIZE);
      const key = `${cx}:${cy}`;
      let coarseCandidates = this.cacheEnabled ? this.queryCache.get(key) : undefined;

      if (coarseCandidates) {
        this.metrics.cacheHits += 1;
      } else {
        if (this.cacheEnabled) this.metrics.cacheMisses += 1;
        const cellRadius = Math.ceil(SENSOR_RADIUS / CELL_SIZE);
        coarseCandidates = [];
        for (let gy = cy - cellRadius; gy <= cy + cellRadius; gy += 1) {
          for (let gx = cx - cellRadius; gx <= cx + cellRadius; gx += 1) {
            const bucket = this.spatialGrid.get(`${gx}:${gy}`);
            if (!bucket) continue;
            coarseCandidates.push(...bucket);
          }
        }
        coarseCandidates.sort((a, b) => a - b);
        if (this.cacheEnabled) this.queryCache.set(key, coarseCandidates);
      }

      for (const id of coarseCandidates) {
        const node = this.nodes[id];
        distanceChecks += 1;
        const dx = node.x - x;
        const dy = node.y - y;
        if (dx * dx + dy * dy <= radiusSquared) candidates.push(id);
      }
      this.metrics.broadphaseCandidateCount = coarseCandidates.length;
    }

    this.metrics.distanceChecks += distanceChecks;
    this.metrics.candidateCount = candidates.length;
    return candidates;
  }

  resolveCollisions(candidates) {
    const ship = this.ship;
    let collided = false;
    for (const id of candidates) {
      const node = this.nodes[id];
      const dx = ship.x - node.x;
      const dy = ship.y - node.y;
      const minDistance = SHIP_RADIUS + node.radius;
      const distance = Math.hypot(dx, dy);
      this.metrics.collisionChecks += 1;
      if (distance >= minDistance) continue;

      const nx = distance > 0 ? dx / distance : 1;
      const ny = distance > 0 ? dy / distance : 0;
      ship.x += nx * (minDistance - distance + 0.01);
      ship.y += ny * (minDistance - distance + 0.01);
      const velocityAlongNormal = ship.vx * nx + ship.vy * ny;
      if (velocityAlongNormal < 0) {
        ship.vx -= (1 + SHIP_PHYSICS.restitution) * velocityAlongNormal * nx;
        ship.vy -= (1 + SHIP_PHYSICS.restitution) * velocityAlongNormal * ny;
      }
      collided = true;
    }
    if (collided) this.collisions += 1;
    this.lastCollision = collided;
  }

  applyBounds() {
    const ship = this.ship;
    if (ship.x < SHIP_RADIUS) {
      ship.x = SHIP_RADIUS;
      ship.vx = Math.abs(ship.vx) * SHIP_PHYSICS.restitution;
    } else if (ship.x > WORLD_WIDTH - SHIP_RADIUS) {
      ship.x = WORLD_WIDTH - SHIP_RADIUS;
      ship.vx = -Math.abs(ship.vx) * SHIP_PHYSICS.restitution;
    }
    if (ship.y < SHIP_RADIUS) {
      ship.y = SHIP_RADIUS;
      ship.vy = Math.abs(ship.vy) * SHIP_PHYSICS.restitution;
    } else if (ship.y > WORLD_HEIGHT - SHIP_RADIUS) {
      ship.y = WORLD_HEIGHT - SHIP_RADIUS;
      ship.vy = -Math.abs(ship.vy) * SHIP_PHYSICS.restitution;
    }
  }

  step(dt, input = { thrust: false, turn: 0 }) {
    if (!Number.isFinite(dt) || dt <= 0) {
      throw new RangeError("PhysicsWorld.step requires a positive finite dt");
    }

    this.previousShip = cloneShip(this.ship);
    this.previousTime = this.time;
    const thrust = Boolean(input.thrust);
    const turn = Math.max(-1, Math.min(1, Number(input.turn) || 0));
    this.lastInput = { thrust, turn };
    this.thrusterActive = thrust;

    const ship = this.ship;
    ship.angularVelocity += turn * SHIP_PHYSICS.turnRate * 3.4 * dt;
    ship.angularVelocity *= Math.exp(-SHIP_PHYSICS.angularDrag * dt);
    ship.angle = normalizeAngle(ship.angle + ship.angularVelocity * dt);

    if (thrust) {
      ship.vx += Math.cos(ship.angle) * SHIP_PHYSICS.thrust * dt;
      ship.vy += Math.sin(ship.angle) * SHIP_PHYSICS.thrust * dt;
    }

    const drag = Math.exp(-SHIP_PHYSICS.linearDrag * dt);
    ship.vx *= drag;
    ship.vy *= drag;
    const speed = Math.hypot(ship.vx, ship.vy);
    if (speed > SHIP_PHYSICS.maxSpeed) {
      const scale = SHIP_PHYSICS.maxSpeed / speed;
      ship.vx *= scale;
      ship.vy *= scale;
    }

    ship.x += ship.vx * dt;
    ship.y += ship.vy * dt;
    this.time += dt;
    this.stepCount += 1;

    const candidates = this.queryCandidates(ship.x, ship.y);
    this.resolveCollisions(candidates);
    this.applyBounds();
  }

  sample(alpha = 1) {
    const t = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
    const current = this.ship;
    const previous = this.previousShip;
    const angleDelta = normalizeAngle(current.angle - previous.angle);
    return {
      x: previous.x + (current.x - previous.x) * t,
      y: previous.y + (current.y - previous.y) * t,
      vx: previous.vx + (current.vx - previous.vx) * t,
      vy: previous.vy + (current.vy - previous.vy) * t,
      angle: normalizeAngle(previous.angle + angleDelta * t),
      angularVelocity:
        previous.angularVelocity + (current.angularVelocity - previous.angularVelocity) * t,
      alpha: t,
      thrusterActive: this.thrusterActive,
      time: this.previousTime + (this.time - this.previousTime) * t,
    };
  }

  getCacheHitRate() {
    const total = this.metrics.cacheHits + this.metrics.cacheMisses;
    return total === 0 ? 0 : this.metrics.cacheHits / total;
  }

  getPublicState() {
    return {
      simTime: this.time,
      stepCount: this.stepCount,
      ship: {
        x: this.ship.x,
        y: this.ship.y,
        vx: this.ship.vx,
        vy: this.ship.vy,
        angle: this.ship.angle,
        angularVelocity: this.ship.angularVelocity,
      },
      collisions: this.collisions,
      sceneSeed: this.seed,
      nodeCount: this.nodes.length,
    };
  }
}
