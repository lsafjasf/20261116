// 纯几何辅助函数：鼠标与键盘路径共用，不依赖 DOM 事件类型。

export const STEP = 10;
export const FINE_STEP = 1;
export const MIN_SIZE = 4;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeShape(raw) {
  const x = Math.min(raw.x1, raw.x2);
  const y = Math.min(raw.y1, raw.y2);
  return {
    ...raw,
    x,
    y,
    width: Math.abs(raw.x2 - raw.x1),
    height: Math.abs(raw.y2 - raw.y1),
  };
}

function bboxOf(el) {
  return {
    x: Math.min(el.x1, el.x2),
    y: Math.min(el.y1, el.y2),
    w: Math.abs(el.x2 - el.x1),
    h: Math.abs(el.y2 - el.y1),
  };
}

function pointInRect(px, py, box, pad = 0) {
  return px >= box.x - pad && px <= box.x + box.w + pad &&
         py >= box.y - pad && py <= box.h + box.y + pad;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// 命中测试：返回最上层（数组末尾）命中的元素 id，未命中返回 null。
export function hitTest(elements, point) {
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const el = elements[i];
    const box = bboxOf(el);
    if (el.type === 'line') {
      if (distToSegment(point.x, point.y, el.x1, el.y1, el.x2, el.y2) <= 8) return el.id;
    } else if (pointInRect(point.x, point.y, box, 6)) {
      return el.id;
    }
  }
  return null;
}

// 把屏幕坐标（含平移/缩放）换算为文档坐标。
export function screenToDoc(point, view, canvasSize) {
  return {
    x: (point.x - canvasSize.width / 2 - view.panX) / view.zoom + canvasSize.width / 2,
    y: (point.y - canvasSize.height / 2 - view.panY) / view.zoom + canvasSize.height / 2,
  };
}

export function docToScreen(point, view, canvasSize) {
  return {
    x: (point.x - canvasSize.width / 2) * view.zoom + canvasSize.width / 2 + view.panX,
    y: (point.y - canvasSize.height / 2) * view.zoom + canvasSize.height / 2 + view.panY,
  };
}

export function round2(value) {
  return Math.round(value * 100) / 100;
}
