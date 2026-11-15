export function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function lineRects(layout, zoom = 1, scrollPx = 0) {
  return layout.lines.map((line, index) => ({
    index,
    left: line.x * zoom,
    top: line.y * zoom - scrollPx,
    width: line.width * zoom,
    height: layout.lineHeight * zoom
  }));
}

export function findOverlaps(rects) {
  const overlaps = [];
  for (let index = 1; index < rects.length; index += 1) {
    const previous = rects[index - 1];
    const current = rects[index];
    if (previous.top + previous.height > current.top + 0.001) {
      overlaps.push({ first: previous.index, second: current.index });
    }
  }
  return overlaps;
}

export function maxScroll(layout, zoom, viewportHeight) {
  return Math.max(0, layout.height * zoom - viewportHeight);
}
