import { SHAPE_NAMES, mulberry32 } from "./config.js";

export const SHAPE_KINDS = ["drop", "star", "blade", "blob", "ring", "ghost", "shard", "crown"];

function starPath(ctx, radius, points, inner, rotation) {
  ctx.beginPath();
  for (let index = 0; index < points * 2; index += 1) {
    const angle = rotation + (index * Math.PI) / points;
    const length = index % 2 === 0 ? radius : radius * inner;
    const x = Math.cos(angle) * length;
    const y = Math.sin(angle) * length;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function dropPath(ctx, radius) {
  ctx.beginPath();
  ctx.moveTo(0, -radius);
  ctx.bezierCurveTo(radius * 0.18, -radius * 0.45, radius * 0.8, -radius * 0.08, radius * 0.56, radius * 0.55);
  ctx.bezierCurveTo(radius * 0.36, radius * 1.01, -radius * 0.32, radius * 0.94, -radius * 0.5, radius * 0.5);
  ctx.bezierCurveTo(-radius * 0.7, radius * 0.02, -radius * 0.22, -radius * 0.55, 0, -radius);
  ctx.closePath();
}

function bladePath(ctx, radius, lean) {
  ctx.beginPath();
  ctx.moveTo(lean * radius, -radius);
  ctx.bezierCurveTo(radius * 0.65, -radius * 0.35, radius * 0.55, radius * 0.55, -radius * 0.12, radius * 0.92);
  ctx.bezierCurveTo(-radius * 0.3, radius * 0.22, -radius * 0.76, -radius * 0.2, lean * radius, -radius);
  ctx.closePath();
}

function blobPath(ctx, radius, seed) {
  const rand = mulberry32(seed);
  const control = [];
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2;
    const wobble = 0.72 + rand() * 0.25;
    control.push([Math.cos(angle) * radius * wobble, Math.sin(angle) * radius * wobble]);
  }
  ctx.beginPath();
  ctx.moveTo(control[0][0], control[0][1]);
  for (let index = 0; index < 8; index += 1) {
    const current = control[index];
    const next = control[(index + 1) % 8];
    const midX = (current[0] + next[0]) * 0.5;
    const midY = (current[1] + next[1]) * 0.5;
    ctx.quadraticCurveTo(current[0], current[1], midX, midY);
  }
  ctx.closePath();
}

function ringPath(ctx, radius) {
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.arc(0, 0, radius * 0.43, 0, Math.PI * 2, true);
  ctx.closePath();
}

function ghostPath(ctx, radius, lean) {
  ctx.beginPath();
  ctx.moveTo(-radius * 0.62, radius * 0.82);
  ctx.lineTo(-radius * 0.62, -radius * 0.12);
  ctx.bezierCurveTo(-radius * 0.62, -radius * 1.06, radius * 0.65, -radius * 1.06, radius * 0.62, -radius * 0.12);
  ctx.lineTo(radius * 0.62 + lean, radius * 0.78);
  ctx.lineTo(radius * 0.28, radius * 0.59);
  ctx.lineTo(-radius * 0.03, radius * 0.87);
  ctx.lineTo(-radius * 0.31, radius * 0.58);
  ctx.closePath();
}

function shardPath(ctx, radius, seed) {
  const rand = mulberry32(seed);
  ctx.beginPath();
  for (let index = 0; index < 7; index += 1) {
    const angle = (index / 7) * Math.PI * 2 + rand() * 0.28;
    const length = radius * (index % 2 === 0 ? 0.96 : 0.55);
    const x = Math.cos(angle) * length;
    const y = Math.sin(angle) * length;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function crownPath(ctx, radius) {
  ctx.beginPath();
  ctx.moveTo(-radius * 0.88, radius * 0.78);
  ctx.lineTo(-radius * 0.72, -radius * 0.45);
  ctx.lineTo(-radius * 0.38, radius * 0.04);
  ctx.lineTo(-radius * 0.06, -radius * 0.92);
  ctx.lineTo(radius * 0.31, radius * 0.02);
  ctx.lineTo(radius * 0.75, -radius * 0.48);
  ctx.lineTo(radius * 0.88, radius * 0.78);
  ctx.closePath();
}

export function traceShape(ctx, kind, diameter, seed = 1) {
  const radius = diameter * 0.5;
  const rand = mulberry32(seed);
  const lean = (rand() - 0.5) * radius * 0.22;
  switch (kind) {
    case "star":
      starPath(ctx, radius, 5 + (seed % 3), 0.4 + rand() * 0.1, rand() * Math.PI);
      return "nonzero";
    case "blade":
      bladePath(ctx, radius, lean / Math.max(radius, 1));
      return "nonzero";
    case "blob":
      blobPath(ctx, radius, seed);
      return "nonzero";
    case "ring":
      ringPath(ctx, radius);
      return "evenodd";
    case "ghost":
      ghostPath(ctx, radius, lean);
      return "nonzero";
    case "shard":
      shardPath(ctx, radius, seed);
      return "nonzero";
    case "crown":
      crownPath(ctx, radius);
      return "nonzero";
    case "drop":
    default:
      dropPath(ctx, radius);
      return "nonzero";
  }
}

export function generateEntries(count, seed = 42, startSerial = 1, slots = null) {
  const rand = mulberry32(seed);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const serial = startSerial + index;
    const kind = SHAPE_KINDS[(index + seed) % SHAPE_KINDS.length];
    const hue = Math.floor(rand() * 360);
    entries.push({
      id: `sh-${String(serial).padStart(4, "0")}`,
      name: `${SHAPE_NAMES[(serial - 1) % SHAPE_NAMES.length]} ${serial}`,
      kind,
      seed: 1009 + index * 7919 + seed * 31,
      hue,
      slot: slots ? slots[index] : index,
      scale: 0.78 + rand() * 0.2,
      rotation: (rand() - 0.5) * 70,
      shadowBlur: 6 + rand() * 8,
      shadowDx: 3 + rand() * 5,
      shadowDy: 4 + rand() * 6,
    });
  }
  return entries;
}

export function entrySignature(entry) {
  return [
    entry.id,
    entry.kind,
    entry.seed,
    entry.hue,
    entry.slot,
    entry.scale,
    entry.rotation,
    entry.shadowBlur,
    entry.shadowDx,
    entry.shadowDy,
  ].join("|");
}
