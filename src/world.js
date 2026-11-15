import {
  MATERIALS,
  MATERIAL_LIST,
  MAX_RANGE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "./config.js";
import { RNG, normalizeSeed, round, stableHash } from "./rng.js";

const W = WORLD_WIDTH;
const H = WORLD_HEIGHT;
const TOTAL_MATERIALS = 4;

function index(x, y) {
  return y * W + x;
}

function inBounds(x, y) {
  return x >= 0 && x < W && y >= 0 && y < H;
}

export function tileAt(grid, x, y) {
  if (!inBounds(x, y)) return MATERIALS.basalt.id;
  return grid[index(x, y)];
}

export function materialForTile(value) {
  if (value === MATERIALS.gate.id) return MATERIALS.gate;
  return MATERIAL_LIST[value - 1] ?? MATERIALS.basalt;
}

export function isSolid(value) {
  return value > 0 && value < MATERIALS.gate.id;
}

export function isWalkableCell(world, x, y) {
  const value = tileAt(world.grid, Math.floor(x), Math.floor(y));
  return value === 0 || value === MATERIALS.gate.id;
}

export function isWalkableTile(world, x, y) {
  if (x < 0 || x >= W || y < 0 || y >= H) return false;
  const value = world.grid[index(x, y)];
  return value === 0 || value === MATERIALS.gate.id;
}

function setTile(grid, x, y, value) {
  if (x <= 0 || x >= W - 1 || y <= 0 || y >= H - 1) return;
  grid[index(x, y)] = value;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function chooseStart(rng) {
  const x = Math.floor(W * 0.5 + rng.between(-4, 4));
  const y = Math.floor(H * 0.5 + rng.between(-3, 3));
  return { x, y };
}

function makeExits(rng) {
  const topX = rng.int(Math.floor(W * 0.18), Math.floor(W * 0.34));
  const bottomX = rng.int(Math.floor(W * 0.62), Math.floor(W * 0.82));
  const rightY = rng.int(Math.floor(H * 0.48), Math.floor(H * 0.72));
  return [
    { id: 0, name: "北侧裂隙", x: topX, y: 2, side: "north" },
    { id: 1, name: "南侧裂隙", x: bottomX, y: H - 3, side: "south" },
    { id: 2, name: "东侧裂隙", x: W - 3, y: rightY, side: "east" },
  ];
}

function carveExitApproach(grid, exit) {
  const center = { x: exit.x, y: exit.y };
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      setTile(grid, exit.x + dx, exit.y + dy, 0);
    }
  }
  if (exit.side === "north") {
    for (let y = 1; y <= 6; y += 1) setTile(grid, exit.x, y, 0);
  } else if (exit.side === "south") {
    for (let y = H - 2; y >= H - 7; y -= 1) setTile(grid, exit.x, y, 0);
  } else {
    for (let x = W - 2; x >= W - 7; x -= 1) setTile(grid, x, exit.y, 0);
  }
  grid[index(exit.x, exit.y)] = MATERIALS.gate.id;
}

function addStrata(grid, rng, start, exits) {
  const safeFromSpawn = 4.5;
  const safeFromExit = 3.5;
  for (let segment = 0; segment < 58; segment += 1) {
    const material =
      segment < TOTAL_MATERIALS
        ? MATERIAL_LIST[segment]
        : rng.pick(MATERIAL_LIST);
    const x = rng.int(4, W - 5);
    const y = rng.int(4, H - 5);
    if (distance({ x, y }, start) < safeFromSpawn) continue;
    if (exits.some((exit) => distance({ x, y }, exit) < safeFromExit)) continue;
    const horizontal = rng.next() < 0.48;
    const length = rng.int(4, 13);
    const thickness = rng.int(1, 3);
    for (let along = 0; along < length; along += 1) {
      for (let thick = 0; thick < thickness; thick += 1) {
        const tx = horizontal ? x + along : x + thick;
        const ty = horizontal ? y + thick : y + along;
        if (distance({ x: tx, y: ty }, start) < safeFromSpawn) continue;
        if (exits.some((exit) => distance({ x: tx, y: ty }, exit) < safeFromExit)) {
          continue;
        }
        setTile(grid, tx, ty, material.id);
      }
    }
  }
}

export function findPath(world, from, to) {
  const start = { x: Math.floor(from.x), y: Math.floor(from.y) };
  const goal = { x: Math.floor(to.x), y: Math.floor(to.y) };
  if (!isWalkableTile(world, start.x, start.y)) return null;
  const queue = [start];
  const visited = new Uint8Array(W * H);
  const parent = new Int32Array(W * H).fill(-1);
  visited[index(start.x, start.y)] = 1;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.x === goal.x && current.y === goal.y) {
      const path = [];
      let cursor = index(goal.x, goal.y);
      while (cursor !== -1) {
        path.push({ x: cursor % W, y: Math.floor(cursor / W) });
        cursor = parent[cursor];
      }
      path.reverse();
      return path;
    }
    for (const [dx, dy] of dirs) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const nextIndex = index(nx, ny);
      if (visited[nextIndex]) continue;
      if (!isWalkableTile(world, nx, ny)) continue;
      visited[nextIndex] = 1;
      parent[nextIndex] = index(current.x, current.y);
      queue.push({ x: nx, y: ny });
    }
  }
  return null;
}

function carveFallbackCorridor(grid, start, target, rng) {
  const horizontalFirst = rng.next() < 0.5;
  let x = start.x;
  let y = start.y;
  const carve = () => setTile(grid, x, y, 0);
  if (horizontalFirst) {
    while (x !== target.x) {
      x += Math.sign(target.x - x);
      carve();
    }
    while (y !== target.y) {
      y += Math.sign(target.y - y);
      carve();
    }
  } else {
    while (y !== target.y) {
      y += Math.sign(target.y - y);
      carve();
    }
    while (x !== target.x) {
      x += Math.sign(target.x - x);
      carve();
    }
  }
}

function ensureExitAccess(grid, start, exits, rng) {
  const probeWorld = { grid };
  for (const exit of exits) {
    const path = findPath(probeWorld, start, exit);
    if (!path) carveFallbackCorridor(grid, start, exit, rng);
  }
}

function repairMaterialCoverage(grid, start, exits) {
  for (const material of MATERIAL_LIST) {
    let count = 0;
    for (let y = 2; y < H - 2; y += 1) {
      for (let x = 2; x < W - 2; x += 1) {
        if (grid[index(x, y)] === material.id) count += 1;
      }
    }
    if (count > 18) continue;
    for (let patch = 0; patch < 4; patch += 1) {
      const x = 8 + ((material.id * 13 + patch * 7) % (W - 16));
      const y = 7 + ((material.id * 9 + patch * 11) % (H - 14));
      if (distance({ x, y }, start) < 4) continue;
      if (exits.some((exit) => distance({ x, y }, exit) < 3)) continue;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 4; dx += 1) {
          setTile(grid, x + dx, y + dy, material.id);
        }
      }
    }
  }
}

function findOpenCandidates(grid, predicate) {
  const candidates = [];
  for (let y = 5; y < H - 5; y += 1) {
    for (let x = 5; x < W - 5; x += 1) {
      if (grid[index(x, y)] === 0 && predicate(x, y)) {
        candidates.push({ x, y });
      }
    }
  }
  return candidates;
}

function makeCurrents(grid, rng, start, exits) {
  const candidates = findOpenCandidates(
    grid,
    (x, y) =>
      Math.hypot(x - start.x, y - start.y) > 7 &&
      exits.every((exit) => Math.hypot(x - exit.x, y - exit.y) > 4),
  );
  const currents = [];
  for (let currentIndex = 0; currentIndex < 3 && candidates.length > 0; currentIndex += 1) {
    const pickIndex = rng.int(0, candidates.length - 1);
    const anchor = candidates.splice(pickIndex, 1)[0];
    currents.push({
      id: currentIndex,
      name: ["冷涡", "斜流", "底涌"][currentIndex],
      x: anchor.x + 0.5,
      y: anchor.y + 0.5,
      radius: rng.between(2.5, 4.4),
      strength: rng.between(0.42, 0.86),
      angle: rng.between(0, Math.PI * 2),
    });
  }
  return currents;
}

function orbitPosition(patrol, tick) {
  const angle = patrol.phase + tick * patrol.angularSpeed;
  return {
    x: patrol.anchor.x + Math.cos(angle) * patrol.orbitRadius,
    y: patrol.anchor.y + Math.sin(angle) * patrol.orbitRadius,
  };
}

function validOrbit(grid, anchor, radius) {
  for (let sample = 0; sample < 16; sample += 1) {
    const angle = (sample / 16) * Math.PI * 2;
    const x = Math.floor(anchor.x + Math.cos(angle) * radius);
    const y = Math.floor(anchor.y + Math.sin(angle) * radius);
    if (grid[index(x, y)] !== 0) return false;
  }
  return true;
}

function makePatrols(grid, rng, start, exits) {
  const candidates = findOpenCandidates(
    grid,
    (x, y) =>
      Math.hypot(x - start.x, y - start.y) > 13 &&
      exits.every((exit) => Math.hypot(x - exit.x, y - exit.y) > 5),
  );
  const patrols = [];
  for (let patrolIndex = 0; patrolIndex < 3 && candidates.length > 0; patrolIndex += 1) {
    let anchor = null;
    let radius = 2.5;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pickIndex = rng.int(0, candidates.length - 1);
      const candidate = candidates[pickIndex];
      if (patrols.some((patrol) => distance(candidate, patrol.anchor) < 8)) continue;
      for (let shrink = 0; shrink < 3; shrink += 1) {
        const trialRadius = 2.5 - shrink * 0.7;
        if (validOrbit(grid, candidate, trialRadius)) {
          anchor = candidate;
          radius = trialRadius;
          break;
        }
      }
      if (anchor) break;
    }
    if (!anchor) {
      anchor = candidates[rng.int(0, candidates.length - 1)];
      radius = 1.2;
    }
    const patrol = {
      id: patrolIndex,
      name: ["低频哨兵", "涡流哨兵", "盲音哨兵"][patrolIndex],
      anchor: { x: anchor.x + 0.5, y: anchor.y + 0.5 },
      orbitRadius: radius,
      phase: rng.between(0, Math.PI * 2),
      angularSpeed: rng.between(0.009, 0.018),
      pingInterval: 34 + patrolIndex * 7,
    };
    const initial = orbitPosition(patrol, 0);
    patrols.push({
      ...patrol,
      x: initial.x,
      y: initial.y,
      alertTicks: 0,
      target: null,
    });
  }
  return patrols;
}

export function sampleCurrent(world, x, y) {
  let vx = 0;
  let vy = 0;
  let strength = 0;
  let active = null;
  for (const current of world.currents) {
    const dx = x - current.x;
    const dy = y - current.y;
    const normalized = Math.hypot(dx, dy) / current.radius;
    if (normalized >= 1) continue;
    const falloff = (1 - normalized) ** 2;
    const curl = current.angle + normalized * 1.6;
    vx += Math.cos(curl) * current.strength * falloff;
    vy += Math.sin(curl) * current.strength * falloff;
    strength += current.strength * falloff;
    active = current;
  }
  const magnitude = Math.hypot(vx, vy);
  if (magnitude > 0.001) {
    vx /= Math.max(1, magnitude);
    vy /= Math.max(1, magnitude);
  }
  return {
    vx: round(vx, 6),
    vy: round(vy, 6),
    strength: round(Math.min(1, strength), 6),
    name: active?.name ?? "静水",
  };
}

export function echoIntensity(material, distance) {
  const attenuation = Math.exp(-distance * 0.075);
  return round(Math.min(1, material.reflectivity * attenuation), 6);
}

export function castRay(world, origin, angle, maxRange = MAX_RANGE, step = 0.28) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let distance = step; distance <= maxRange; distance += step) {
    const x = Math.floor(origin.x + cos * distance);
    const y = Math.floor(origin.y + sin * distance);
    if (x < 0 || x >= W || y < 0 || y >= H) {
      return {
        distance: round(distance, 4),
        material: MATERIALS.basalt,
        intensity: 0,
      };
    }
    const tile = world.grid[index(x, y)];
    if (isSolid(tile) || tile === MATERIALS.gate.id) {
      const material = materialForTile(tile);
      return {
        distance: round(distance, 4),
        material,
        intensity: echoIntensity(material, distance),
      };
    }
  }
  return null;
}

export function scanSonar(world, origin, rays = 144, maxRange = MAX_RANGE) {
  const hits = [];
  for (let ray = 0; ray < rays; ray += 1) {
    const angle = (ray / rays) * Math.PI * 2;
    const hit = castRay(world, origin, angle, maxRange);
    if (!hit) continue;
    hits.push({
      angle: round(angle, 6),
      distance: hit.distance,
      intensity: hit.intensity,
      materialKey: hit.material.key,
      materialName: hit.material.name,
    });
  }
  return hits;
}

export function detectPatrolEcho(world, origin, patrol, maxRange = MAX_RANGE) {
  const dx = patrol.x - origin.x;
  const dy = patrol.y - origin.y;
  const distance = Math.hypot(dx, dy);
  if (distance > maxRange || distance < 0.1) return null;
  const angle = Math.atan2(dy, dx);
  const wall = castRay(world, origin, angle, distance, 0.2);
  if (wall && wall.distance < distance - 0.5) return null;
  return {
    angle: round(angle, 6),
    distance: round(distance, 4),
    intensity: round(Math.max(0.22, 0.96 * Math.exp(-distance * 0.08)), 6),
    materialKey: "patrol",
    materialName: "巡逻声源",
  };
}

export function worldSignature(world) {
  return stableHash({
    width: world.width,
    height: world.height,
    grid: Array.from(world.grid),
    start: world.start,
    exits: world.exits,
    correctExitIndex: world.correctExitIndex,
    currents: world.currents,
    patrols: world.initialPatrols,
  });
}

export function generateWorld(seedInput) {
  const seed = normalizeSeed(seedInput);
  const rng = new RNG(seed ^ 0x51ed270b);
  const grid = new Uint8Array(W * H);

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      grid[index(x, y)] = edge ? MATERIAL_LIST[(x * 3 + y * 5) % 4].id : 0;
    }
  }

  const start = chooseStart(rng);
  const exits = makeExits(rng);
  for (const exit of exits) carveExitApproach(grid, exit);
  for (let dy = -3; dy <= 3; dy += 1) {
    for (let dx = -3; dx <= 3; dx += 1) {
      setTile(grid, start.x + dx, start.y + dy, 0);
    }
  }

  addStrata(grid, rng, start, exits);
  repairMaterialCoverage(grid, start, exits);
  ensureExitAccess(grid, start, exits, rng);
  for (const exit of exits) grid[index(exit.x, exit.y)] = MATERIALS.gate.id;

  const world = {
    seed,
    width: W,
    height: H,
    grid,
    start: { x: start.x + 0.5, y: start.y + 0.5 },
    exits,
    correctExitIndex: rng.int(0, exits.length - 1),
    currents: makeCurrents(grid, rng, start, exits),
    initialPatrols: makePatrols(grid, rng, start, exits),
    runtimeSeed: rng.nextU32(),
  };
  return world;
}

export { index as tileIndex, W as GRID_WIDTH, H as GRID_HEIGHT };
export { orbitPosition };
