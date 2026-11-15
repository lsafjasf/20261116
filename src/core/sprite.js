import { hslToRgb, rgbToCss } from "./color.js";
import { createRng } from "./rng.js";

function insideRoundedRect(x, y, width, height, radius) {
  const nearX = Math.min(x, width - 1 - x);
  const nearY = Math.min(y, height - 1 - y);
  if (nearX >= radius || nearY >= radius) return true;
  const dx = radius - nearX;
  const dy = radius - nearY;
  return dx * dx + dy * dy <= radius * radius;
}

export function createSpriteFrame(id, index, options = {}) {
  const seed = options.seed ?? 0x628;
  const variant = options.variant ?? 0;
  const rng = createRng(seed + index * 7919 + variant * 104729);
  const contentWidth = 24 + rng.int(0, 40) + Math.min(variant, 3) * 2;
  const contentHeight = 22 + rng.int(0, 36);
  const padLeft = rng.int(1, 4);
  const padTop = rng.int(1, 4);
  const padRight = rng.int(1, 4);
  const padBottom = rng.int(1, 4);
  const width = contentWidth + padLeft + padRight;
  const height = contentHeight + padTop + padBottom;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const hue = (index * 37 + variant * 23 + 12) % 360;
  const primary = hslToRgb(hue, 0.72, 0.53);
  const accent = hslToRgb((hue + 56) % 360, 0.88, 0.66);
  const shade = hslToRgb((hue + 305) % 360, 0.58, 0.31);
  const radius = Math.max(3, Math.floor(Math.min(contentWidth, contentHeight) * 0.18));

  for (let y = 0; y < contentHeight; y += 1) {
    for (let x = 0; x < contentWidth; x += 1) {
      if (!insideRoundedRect(x, y, contentWidth, contentHeight, radius)) continue;
      const nx = x / Math.max(1, contentWidth - 1);
      const ny = y / Math.max(1, contentHeight - 1);
      const diagonal = (nx + ny) * 0.5;
      let color = diagonal < 0.46 ? primary : diagonal < 0.82 ? accent : shade;
      const eyeY = contentHeight * 0.36;
      const eyeRadius = Math.max(1, Math.min(contentWidth, contentHeight) * 0.045);
      const leftEye = (x - contentWidth * 0.34) ** 2 + (y - eyeY) ** 2;
      const rightEye = (x - contentWidth * 0.66) ** 2 + (y - eyeY) ** 2;
      if (leftEye < eyeRadius ** 2 || rightEye < eyeRadius ** 2) color = [247, 250, 252];
      if (y > contentHeight * 0.7 && x > contentWidth * 0.25 && x < contentWidth * 0.75) {
        color = shade;
      }
      const targetX = padLeft + x;
      const targetY = padTop + y;
      const offset = (targetY * width + targetX) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
  }

  return {
    id,
    width,
    height,
    pixels,
    colors: [rgbToCss(primary), rgbToCss(accent), rgbToCss(shade)],
    version: variant,
  };
}

export function createDemoFrames(count = 100, options = {}) {
  const seed = options.seed ?? 628;
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    frames.push(createSpriteFrame(`spr-${String(index).padStart(3, "0")}`, index, {
      seed,
    }));
  }
  return frames;
}

export function frameCenterColor(frame) {
  const x = Math.floor(frame.width / 2);
  const y = Math.floor(frame.height / 2);
  const offset = (y * frame.width + x) * 4;
  return Array.from(frame.pixels.slice(offset, offset + 4));
}

export function hashPixels(pixels) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < pixels.length; index += 1) {
    hash ^= pixels[index];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
