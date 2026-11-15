import { RUN_LENGTH_TICKS, DT } from './constants.js';

// Light zones span the x axis. Each zone declares an ambient EV; a narrow
// flicker band at every boundary adds the "complex lighting" the brief asks
// for. Values are pure functions of world position, so replays stay exact.
export const LIGHT_ZONES = [
  { x0: -26, x1: -12, ev: 8 },
  { x0: -12, x1: 2, ev: 12 },
  { x0: 2, x1: 16, ev: 6 },
  { x0: 16, x1: 30, ev: 11 },
];

export const TARGETS = [
  { id: 'bird', name: '红隼', color: '#e8533f', size: 2.0,
    path: (t) => ({ x: -18 + 14 * t, y: 1.5 + 0.8 * Math.sin(t * 2.2), z: 16 }),
    windows: [[3.0, 5.2]] },
  { id: 'cyclist', name: '骑行者', color: '#3fa0e8', size: 2.0,
    path: (t) => ({ x: -6 + 11 * (t - 7), y: 0.4, z: 14 }),
    windows: [[9.4, 11.6]] },
  { id: 'lantern', name: '灯笼', color: '#e8b63f', size: 2.0,
    path: (t) => ({ x: 4 + 8 * (t - 14), y: 2.2 + 0.5 * Math.cos(t * 1.7), z: 18 }),
    windows: [[15.4, 18.2]] },
];

export function targetAt(target, tick) {
  const t = tick * DT;
  const p = target.path(t);
  return { ...p, id: target.id, name: target.name, color: target.color, size: target.size };
}

export function allTargetPositions(tick) {
  return TARGETS.map((target) => targetAt(target, tick));
}

// EV at a world position. Boundary bands oscillate every ~0.33 s so a static
// exposure setting cannot ride them through the whole crossing.
export function lightAt(x, tick) {
  const t = tick * DT;
  for (const zone of LIGHT_ZONES) {
    if (x >= zone.x0 && x < zone.x1) {
      const edge = Math.min(x - zone.x0, zone.x1 - x);
      if (edge < 1.2) {
        const next = LIGHT_ZONES[LIGHT_ZONES.indexOf(zone) + 1];
        const other = next ? next.ev : zone.ev;
        const mix = 0.5 + 0.5 * Math.sin(t * 19 + x * 0.7);
        return zone.ev * (1 - mix * 0.55) + other * (mix * 0.55);
      }
      return zone.ev;
    }
  }
  return LIGHT_ZONES[0].ev;
}

export function runLength() {
  return RUN_LENGTH_TICKS;
}
