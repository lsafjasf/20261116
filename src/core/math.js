// 3x2 仿射矩阵（列主序，与 Canvas setTransform 参数一致）：
// [ a c e ]   向量 (x, y) -> (a*x + c*y + e, b*x + d*y + f)
// [ b d f ]

export function identity() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

export function multiply(m1, m2) {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export function translate(x, y) {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function rotate(rad) {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

export function scale(sx, sy = sx) {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

// 节点本地 TRS -> 矩阵：先缩放、再旋转、最后平移
export function localMatrix(node) {
  const t = node.transform;
  const m = multiply(translate(t.x, t.y), rotate(t.rotation));
  return multiply(m, scale(t.scaleX, t.scaleY));
}

export function applyPoint(m, x, y) {
  return {
    x: m.a * x + m.c * y + m.e,
    y: m.b * x + m.d * y + m.f,
  };
}

export function invert(m) {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) {
    throw new Error('矩阵不可逆（缩放为 0 或接近奇异）');
  }
  const inv = 1 / det;
  return {
    a: m.d * inv,
    b: -m.b * inv,
    c: -m.c * inv,
    d: m.a * inv,
    e: (m.c * m.f - m.d * m.e) * inv,
    f: (m.b * m.e - m.a * m.f) * inv,
  };
}

// 轴对齐包围盒（世界坐标），输入为本地坐标的四个角点
export function boundsOf(corners, matrix) {
  const pts = corners.map((p) => applyPoint(matrix, p.x, p.y));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
