export const WORLD = {
  width: 2000,
  height: 1400,
  durationMs: 15 * 60 * 1000,
  snapRadius: 30,
  dangerClearance: 26,
  startDurability: 100
};

export const ROADS = [
  { id: 'R1', name: '北环大道', x1: 60, y1: 200, x2: 1940, y2: 200 },
  { id: 'R2', name: '滨河大道', x1: 60, y1: 1200, x2: 1940, y2: 1200 },
  { id: 'R3', name: '深南中路', x1: 100, y1: 700, x2: 1900, y2: 700 },
  { id: 'R4', name: '西部通道', x1: 300, y1: 60, x2: 300, y2: 1340 },
  { id: 'R5', name: '中央轴线', x1: 1000, y1: 60, x2: 1000, y2: 1340 },
  { id: 'R6', name: '东部快线', x1: 1700, y1: 60, x2: 1700, y2: 1340 },
  { id: 'R7', name: '联络线A', x1: 300, y1: 450, x2: 1700, y2: 450 },
  { id: 'R8', name: '联络线B', x1: 300, y1: 950, x2: 1700, y2: 950 },
  { id: 'S1', name: '北侧辅路', x1: 100, y1: 160, x2: 1700, y2: 160 },
  { id: 'S2', name: '中北辅路', x1: 260, y1: 410, x2: 1700, y2: 410 },
  { id: 'S3', name: '中南辅路', x1: 100, y1: 660, x2: 1900, y2: 660 },
  { id: 'S4', name: '中南辅路B', x1: 100, y1: 910, x2: 1660, y2: 910 },
  { id: 'S5', name: '南侧辅路', x1: 100, y1: 1160, x2: 1700, y2: 1160 },
  { id: 'V1', name: '西绕匝道', x1: 260, y1: 120, x2: 260, y2: 1180 },
  { id: 'V2', name: '中绕匝道', x1: 960, y1: 120, x2: 960, y2: 1180 },
  { id: 'V3', name: '东绕匝道', x1: 1660, y1: 120, x2: 1660, y2: 1180 }
];

export const DANGERS = [
  { id: 'D1', roadId: 'R1', x: 520, y: 200 },
  { id: 'D2', roadId: 'R4', x: 300, y: 450 },
  { id: 'D3', roadId: 'R7', x: 1000, y: 450 },
  { id: 'D4', roadId: 'R5', x: 1000, y: 700 },
  { id: 'D5', roadId: 'R3', x: 1500, y: 700 },
  { id: 'D6', roadId: 'R6', x: 1700, y: 950 },
  { id: 'D7', roadId: 'R8', x: 600, y: 950 },
  { id: 'D8', roadId: 'R2', x: 1200, y: 1200 }
];

export const SAFE_ROUTES = [
  {
    id: 'routeA',
    name: '安全路线甲（北部绕行）',
    points: [
      [100, 700], [100, 660], [260, 660], [260, 160],
      [960, 160], [960, 410], [1660, 410], [1660, 450], [1900, 450]
    ]
  },
  {
    id: 'routeB',
    name: '安全路线乙（南部绕行）',
    points: [
      [100, 700], [100, 660], [100, 910], [260, 910],
      [260, 1160], [560, 1160], [960, 1160], [960, 910],
      [1660, 910], [1660, 700], [1900, 700]
    ]
  }
];

export const BLOCKED_ROUTE = {
  id: 'routeBlocked',
  name: '受阻尝试路线（穿过 D5）',
  points: [
    [100, 700], [700, 700], [1500, 700], [1900, 700]
  ]
};

export function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(px, py, x1, y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return dist(px, py, x1 + t * dx, y1 + t * dy);
}

export function nearestRoad(x, y) {
  let best = null;
  for (const road of ROADS) {
    const d = distToSegment(x, y, road.x1, road.y1, road.x2, road.y2);
    if (!best || d < best.distance) best = { road, distance: d };
  }
  return best;
}

export function nearestDanger(x, y) {
  let best = null;
  for (const danger of DANGERS) {
    const d = dist(x, y, danger.x, danger.y);
    if (!best || d < best.distance) best = { danger, distance: d };
  }
  return best;
}

export function segmentsIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (d === 0) return false;
  const ua = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const ub = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return ua > 0 && ua < 1 && ub > 0 && ub < 1;
}
