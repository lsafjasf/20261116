import { hashBytes, clamp } from "./config.js";
import { traceShape } from "./shapes.js";

export function layoutFor(config) {
  const cols = Math.floor(config.width / config.cell);
  const rows = Math.floor(config.height / config.cell);
  const capacity = cols * rows;
  const slots = Array.from({ length: capacity }, (_, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = col * config.cell;
    const y = row * config.cell;
    const padding = config.padding;
    return {
      index,
      col,
      row,
      x,
      y,
      w: config.cell,
      h: config.cell,
      contentRect: {
        x: x + padding,
        y: y + padding,
        w: config.cell - padding * 2,
        h: config.cell - padding * 2,
      },
    };
  });
  return {
    cols,
    rows,
    capacity,
    slots,
    usedWidth: cols * config.cell,
    usedHeight: rows * config.cell,
  };
}

export function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function cloneCanvas(source) {
  const canvas = createCanvas(source.width, source.height);
  canvas.getContext("2d").drawImage(source, 0, 0);
  return canvas;
}

export function entriesBySlot(entries) {
  const map = new Map();
  for (const entry of entries) map.set(entry.slot, entry);
  return map;
}

export function entryAt(entries, slot) {
  return entries.find((entry) => entry.slot === slot) || null;
}

export function moveEntry(entries, entryId, targetSlot) {
  const moving = entries.find((entry) => entry.id === entryId);
  if (!moving) throw new Error(`Unknown entry: ${entryId}`);
  const occupied = entries.find((entry) => entry.slot === targetSlot);
  const oldSlot = moving.slot;
  if (oldSlot === targetSlot) return { entries, dirtySlots: [], swappedId: null };
  moving.slot = targetSlot;
  if (occupied) occupied.slot = oldSlot;
  return {
    entries,
    dirtySlots: occupied ? [oldSlot, targetSlot] : [oldSlot, targetSlot],
    swappedId: occupied ? occupied.id : null,
  };
}

export function clearSlot(context, slot) {
  context.clearRect(slot.x, slot.y, slot.w, slot.h);
}

export function drawEntry(context, entry, slot, config) {
  const content = slot.contentRect;
  const padding = clamp(config.padding, 2, Math.floor(config.cell * 0.28));
  const guard = Math.min(1, padding);
  const diameter = Math.min(content.w, content.h) * entry.scale;
  const centerX = content.x + content.w * 0.5;
  const centerY = content.y + content.h * 0.5;

  context.save();
  context.beginPath();
  context.rect(content.x, content.y, content.w, content.h);
  context.clip();
  context.translate(centerX, centerY);
  context.rotate((entry.rotation * Math.PI) / 180);

  const gradient = context.createLinearGradient(-diameter * 0.35, -diameter * 0.45, diameter * 0.45, diameter * 0.5);
  gradient.addColorStop(0, `hsl(${entry.hue} 90% 72%)`);
  gradient.addColorStop(0.52, `hsl(${entry.hue + 28} 80% 55%)`);
  gradient.addColorStop(1, `hsl(${entry.hue + 72} 68% 42%)`);

  context.shadowColor = `hsla(${entry.hue} 70% 12% / 0.82)`;
  context.shadowBlur = entry.shadowBlur;
  context.shadowOffsetX = entry.shadowDx;
  context.shadowOffsetY = entry.shadowDy;
  context.fillStyle = gradient;
  const fillRule = traceShape(context, entry.kind, diameter, entry.seed);
  context.fill(fillRule);

  context.shadowColor = "transparent";
  context.shadowBlur = 0;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  context.strokeStyle = "rgba(255,255,255,0.23)";
  context.lineWidth = Math.max(1, diameter * 0.014);
  context.stroke();
  context.restore();

  context.clearRect(slot.x, slot.y, slot.w, guard);
  context.clearRect(slot.x, slot.y + slot.h - guard, slot.w, guard);
  context.clearRect(slot.x, slot.y, guard, slot.h);
  context.clearRect(slot.x + slot.w - guard, slot.y, guard, slot.h);
}

export function renderSlots(canvas, entries, config, slotIndexes) {
  const { slots } = layoutFor(config);
  const map = entriesBySlot(entries);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = false;
  for (const slotIndex of new Set(slotIndexes)) {
    const slot = slots[slotIndex];
    if (!slot) continue;
    clearSlot(context, slot);
    const entry = map.get(slotIndex);
    if (entry) drawEntry(context, entry, slot, config);
  }
  return [...new Set(slotIndexes)];
}

export function renderAtlas(entries, config) {
  const canvas = createCanvas(config.width, config.height);
  canvas.getContext("2d", { willReadFrequently: true });
  const slots = entries.map((entry) => entry.slot);
  renderSlots(canvas, entries, config, slots);
  return canvas;
}
