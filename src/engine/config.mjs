// World, physics and rule constants. Pure data so browser and Node share it.
export const WORLD = Object.freeze({
  width: 1280,
  height: 720,
  dt: 0.05, // fixed simulation step (20 Hz)
  shoreWidth: 150,
  safeEdge: 240, // crate center x <= this means the crate is on the safe shore
  lakeTop: 90,
  lakeBottom: 630,
});

export const CRATE = Object.freeze({
  startX: 866,
  startY: 360,
  half: 34,
  mass: 0.45,
  linearDamping: 0.62, // velocity retained per second fraction factor handled in step
  angularDamping: 0.9,
});

export const ANCHOR = Object.freeze({
  leftX: 70,
  rightX: 1210,
  railTop: 170,
  railBottom: 550,
  startY: 360,
  moveSpeed: 150, // px/s along the rail
  tetherK: 9, // anchor -> player elastic tether stiffness
});

export const ROPE = Object.freeze({
  k: 0.055, // spring stiffness per px of stretch
  damping: 0.14,
  restLeft: 796, // initial left rope rest length (matches player->crate distance)
  restRight: 344,
  winchSpeed: 78, // rest-length change px/s
  minRest: 120,
  maxRest: 1100,
  snapTension: 24,
});

export const ICE = Object.freeze({
  cols: 12,
  rows: 7,
  startIntegrity: 100,
  stressToDamage: 0.42, // damage per second at stress = 1
  crackThreshold: 0.34, // zone becomes cracked when strength drops below this
  breakThreshold: 0,
  weakPenalty: 0.45, // weak zones take extra stress multiplier factor
  crackSpread: 0.18, // neighbouring zone stress coupling
});

export const STEER = Object.freeze({
  guideK: 42, // right player steering acceleration
  damping: 0.9,
});

export const JERK = Object.freeze({
  impulse: 130, // velocity kick px/s
  shockStress: 0.2, // ice stress added by a discrete jerk
  overlapWindow: 2, // ticks within which two jerks count as an ordering conflict
});

export const ZONES = buildZones();

function buildZones() {
  const zones = [];
  const lakeW = WORLD.width - WORLD.shoreWidth * 2;
  const lakeH = WORLD.lakeBottom - WORLD.lakeTop;
  const zw = lakeW / ICE.cols;
  const zh = lakeH / ICE.rows;
  for (let r = 0; r < ICE.rows; r += 1) {
    for (let c = 0; c < ICE.cols; c += 1) {
      zones.push({
        id: `Z-${String(r * ICE.cols + c + 1).padStart(2, '0')}`,
        row: r,
        col: c,
        x: WORLD.shoreWidth + c * zw,
        y: WORLD.lakeTop + r * zh,
        w: zw,
        h: zh,
        // Thin-ice pockets placed asymmetrically so one-sided pulls are punished.
        weak: weakAt(r, c),
      });
    }
  }
  return zones;
}

function weakAt(row, col) {
  const pockets = [
    [2, 3], [2, 4], [3, 3],
    [4, 7], [4, 8], [3, 8],
    [1, 6],
  ];
  return pockets.some(([r, c]) => r === row && c === col);
}

export function zoneAt(x, y) {
  if (x < WORLD.shoreWidth || x > WORLD.width - WORLD.shoreWidth) return null;
  if (y < WORLD.lakeTop || y > WORLD.lakeBottom) return null;
  const lakeW = WORLD.width - WORLD.shoreWidth * 2;
  const c = Math.min(ICE.cols - 1, Math.floor((x - WORLD.shoreWidth) / (lakeW / ICE.cols)));
  const r = Math.min(ICE.rows - 1, Math.floor((y - WORLD.lakeTop) / ((WORLD.lakeBottom - WORLD.lakeTop) / ICE.rows)));
  return r * ICE.cols + c;
}
