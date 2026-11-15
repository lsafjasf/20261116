import {
  expandRect,
  intersectRect,
  rectsTouch,
  unionRect,
} from "./geometry.js";

export function clipToViewport(rect, width, height) {
  return intersectRect(rect, { x: 0, y: 0, w: width, h: height });
}

export function alignRect(rect) {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  return {
    x,
    y,
    w: Math.ceil(rect.x + rect.w) - x,
    h: Math.ceil(rect.y + rect.h) - y,
  };
}

export function mergeDirtyRects(rects, gap = 0) {
  const merged = rects.filter((rect) => rect.w > 0 && rect.h > 0).map((rect) => ({ ...rect }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < merged.length; i += 1) {
      for (let j = i + 1; j < merged.length; j += 1) {
        const a = expandRect(merged[i], gap / 2);
        if (!rectsTouch(a, merged[j])) continue;
        merged[i] = unionRect(merged[i], merged[j]);
        merged.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return merged;
}

export function totalRectArea(rects) {
  return rects.reduce((sum, rect) => sum + rect.w * rect.h, 0);
}

export function clampDirtySet(rects, maxRects, width, height) {
  if (rects.length <= maxRects) return rects;
  return [{ x: 0, y: 0, w: width, h: height }];
}
