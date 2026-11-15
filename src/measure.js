import { hashBytes } from "./config.js";
import { createCanvas, layoutFor } from "./atlas.js";

function pixelData(canvas) {
  return canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}

function insideAnyRect(x, y, rects) {
  return rects.some((rect) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h);
}

export function analyzeCanvas(canvas, entries, config) {
  const started = performance.now();
  const { slots, capacity } = layoutFor(config);
  const image = pixelData(canvas);
  const pixels = image.data;
  let fillPixels = 0;
  let maxAlpha = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    const alpha = pixels[index];
    if (alpha > maxAlpha) maxAlpha = alpha;
    if (alpha > 8) fillPixels += 1;
  }

  let guardViolations = 0;
  let guardAlphaMax = 0;
  const slotMap = new Map(entries.map((entry) => [entry.slot, entry]));
  const alphaBounds = {};

  for (const [slotIndex, entry] of slotMap.entries()) {
    const slot = slots[slotIndex];
    if (!slot) continue;
    for (let x = slot.x; x < slot.x + slot.w; x += 1) {
      for (const y of [slot.y, slot.y + slot.h - 1]) {
        const alpha = pixels[(y * canvas.width + x) * 4 + 3];
        guardAlphaMax = Math.max(guardAlphaMax, alpha);
        if (alpha > 0) guardViolations += 1;
      }
    }
    for (let y = slot.y; y < slot.y + slot.h; y += 1) {
      for (const x of [slot.x, slot.x + slot.w - 1]) {
        const alpha = pixels[(y * canvas.width + x) * 4 + 3];
        guardAlphaMax = Math.max(guardAlphaMax, alpha);
        if (alpha > 0) guardViolations += 1;
      }
    }

    let minX = slot.contentRect.x + slot.contentRect.w;
    let minY = slot.contentRect.y + slot.contentRect.h;
    let maxX = slot.contentRect.x;
    let maxY = slot.contentRect.y;
    for (let y = slot.contentRect.y; y < slot.contentRect.y + slot.contentRect.h; y += 1) {
      for (let x = slot.contentRect.x; x < slot.contentRect.x + slot.contentRect.w; x += 1) {
        if (pixels[(y * canvas.width + x) * 4 + 3] <= 8) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    alphaBounds[entry.id] = maxX >= minX
      ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
      : null;
  }

  const atlasPixels = config.width * config.height;
  const occupiedSlots = entries.length;
  return {
    hash: hashBytes(pixels),
    fillPixels,
    fillRatio: fillPixels / atlasPixels,
    occupiedSlots,
    capacity,
    slotRatio: capacity ? occupiedSlots / capacity : 0,
    slotFillRatio: occupiedSlots ? fillPixels / (occupiedSlots * config.cell * config.cell) : 0,
    guardViolations,
    guardAlphaMax,
    maxAlpha,
    alphaBounds,
    atlasBytes: atlasPixels * 4,
    usedBytes: fillPixels * 4,
    elapsedMs: performance.now() - started,
  };
}

export function compareCanvases(canvasA, canvasB) {
  if (canvasA.width !== canvasB.width || canvasA.height !== canvasB.height) {
    throw new Error("Canvas dimensions differ");
  }
  const a = pixelData(canvasA);
  const b = pixelData(canvasB);
  const diff = createCanvas(canvasA.width, canvasA.height);
  const diffContext = diff.getContext("2d");
  const diffImage = diffContext.createImageData(canvasA.width, canvasA.height);
  let diffPixels = 0;
  let diffChannels = 0;
  for (let index = 0; index < a.data.length; index += 4) {
    const changed =
      a.data[index] !== b.data[index] ||
      a.data[index + 1] !== b.data[index + 1] ||
      a.data[index + 2] !== b.data[index + 2] ||
      a.data[index + 3] !== b.data[index + 3];
    if (changed) {
      diffPixels += 1;
      diffImage.data[index] = 255;
      diffImage.data[index + 1] = 72;
      diffImage.data[index + 2] = 104;
      diffImage.data[index + 3] = 220;
    } else {
      const alpha = a.data[index + 3];
      diffImage.data[index] = 18;
      diffImage.data[index + 1] = 33;
      diffImage.data[index + 2] = 42;
      diffImage.data[index + 3] = alpha > 0 ? 72 : 255;
    }
    for (let channel = 0; channel < 4; channel += 1) {
      if (a.data[index + channel] !== b.data[index + channel]) diffChannels += 1;
    }
  }
  diffContext.putImageData(diffImage, 0, 0);
  return {
    diffPixels,
    diffChannels,
    diffRatio: diffPixels / (canvasA.width * canvasA.height),
    diffCanvas: diff,
    hashA: hashBytes(a.data),
    hashB: hashBytes(b.data),
    equal: diffPixels === 0,
  };
}

export function hashRegionOutsideSlots(canvas, slotsToExclude) {
  const pixels = pixelData(canvas).data;
  let hash = 2166136261;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (insideAnyRect(x, y, slotsToExclude)) continue;
      const index = (y * canvas.width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        hash ^= pixels[index + channel];
        hash = Math.imul(hash, 16777619);
      }
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function pixelHashFromCanvas(canvas) {
  return hashBytes(pixelData(canvas).data);
}
