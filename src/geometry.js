export const GEOMETRY_EPSILON = 1e-9;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function circle(x, y, radius, extra = {}) {
  return { id: extra.id, shape: "circle", x, y, radius, ...extra };
}

export function rectangle(x, y, width, height, angle = 0, extra = {}) {
  return { id: extra.id, shape: "rect", x, y, width, height, angle, ...extra };
}

export function boundsOf(object) {
  if (object.shape === "circle") {
    const radius = Math.max(0, object.radius);
    return {
      minX: object.x - radius,
      minY: object.y - radius,
      maxX: object.x + radius,
      maxY: object.y + radius
    };
  }

  const halfWidth = Math.max(0, object.width) / 2;
  const halfHeight = Math.max(0, object.height) / 2;
  const cos = Math.cos(object.angle);
  const sin = Math.sin(object.angle);
  const extentX = Math.abs(cos) * halfWidth + Math.abs(sin) * halfHeight;
  const extentY = Math.abs(sin) * halfWidth + Math.abs(cos) * halfHeight;
  return {
    minX: object.x - extentX,
    minY: object.y - extentY,
    maxX: object.x + extentX,
    maxY: object.y + extentY
  };
}

export function boundsOverlap(a, b, margin = 0) {
  return (
    a.minX <= b.maxX + margin &&
    a.maxX + margin >= b.minX &&
    a.minY <= b.maxY + margin &&
    a.maxY + margin >= b.minY
  );
}

export function pairKey(idA, idB) {
  const low = Math.min(idA, idB);
  const high = Math.max(idA, idB);
  return low * 0x100000 + high;
}

export function pairKeyString(idA, idB) {
  const low = Math.min(idA, idB);
  const high = Math.max(idA, idB);
  return `${low}:${high}`;
}

export function contactKey(contact) {
  return pairKeyString(contact.a, contact.b);
}

export function containsPoint(object, px, py) {
  if (object.shape === "circle") {
    const dx = px - object.x;
    const dy = py - object.y;
    return dx * dx + dy * dy <= object.radius * object.radius + GEOMETRY_EPSILON;
  }

  const dx = px - object.x;
  const dy = py - object.y;
  const cos = Math.cos(object.angle);
  const sin = Math.sin(object.angle);
  const localX = dx * cos + dy * sin;
  const localY = -dx * sin + dy * cos;
  return (
    Math.abs(localX) <= object.width / 2 + GEOMETRY_EPSILON &&
    Math.abs(localY) <= object.height / 2 + GEOMETRY_EPSILON
  );
}

function circleCircle(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const radius = a.radius + b.radius;
  const distanceSquared = dx * dx + dy * dy;
  if (distanceSquared > radius * radius + GEOMETRY_EPSILON) return null;
  const distance = Math.sqrt(distanceSquared);
  const nx = distance > GEOMETRY_EPSILON ? dx / distance : 1;
  const ny = distance > GEOMETRY_EPSILON ? dy / distance : 0;
  return { a: a.id, b: b.id, nx, ny, depth: radius - distance };
}

function localToWorld(rect, x, y) {
  const cos = Math.cos(rect.angle);
  const sin = Math.sin(rect.angle);
  return { x: rect.x + x * cos - y * sin, y: rect.y + x * sin + y * cos };
}

function circleRect(circleObject, rectObject) {
  const dx = circleObject.x - rectObject.x;
  const dy = circleObject.y - rectObject.y;
  const cos = Math.cos(rectObject.angle);
  const sin = Math.sin(rectObject.angle);
  const localX = dx * cos + dy * sin;
  const localY = -dx * sin + dy * cos;
  const halfWidth = rectObject.width / 2;
  const halfHeight = rectObject.height / 2;
  const closestX = clamp(localX, -halfWidth, halfWidth);
  const closestY = clamp(localY, -halfHeight, halfHeight);
  const offsetX = localX - closestX;
  const offsetY = localY - closestY;
  const distanceSquared = offsetX * offsetX + offsetY * offsetY;
  const radius = circleObject.radius;
  if (distanceSquared > radius * radius + GEOMETRY_EPSILON) return null;

  let normalX;
  let normalY;
  let depth;
  if (distanceSquared > GEOMETRY_EPSILON) {
    const distance = Math.sqrt(distanceSquared);
    const localNX = (closestX - localX) / distance;
    const localNY = (closestY - localY) / distance;
    normalX = localNX * cos - localNY * sin;
    normalY = localNX * sin + localNY * cos;
    depth = radius - distance;
  } else {
    const edgeX = halfWidth - Math.abs(localX);
    const edgeY = halfHeight - Math.abs(localY);
    if (edgeX < edgeY) {
      const sign = localX < 0 ? 1 : -1;
      normalX = sign * cos;
      normalY = sign * sin;
      depth = radius + edgeX;
    } else {
      const sign = localY < 0 ? 1 : -1;
      normalX = -sign * sin;
      normalY = sign * cos;
      depth = radius + edgeY;
    }
  }

  return {
    a: circleObject.id,
    b: rectObject.id,
    nx: normalX,
    ny: normalY,
    depth
  };
}

function projectRadius(rect, axisX, axisY) {
  const cos = Math.cos(rect.angle);
  const sin = Math.sin(rect.angle);
  return (
    Math.abs((cos * axisX + sin * axisY) * rect.width) / 2 +
    Math.abs((-sin * axisX + cos * axisY) * rect.height) / 2
  );
}

function rectRect(a, b) {
  const axes = [
    [Math.cos(a.angle), Math.sin(a.angle)],
    [-Math.sin(a.angle), Math.cos(a.angle)],
    [Math.cos(b.angle), Math.sin(b.angle)],
    [-Math.sin(b.angle), Math.cos(b.angle)]
  ];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let minimumOverlap = Infinity;
  let minimumAxisX = 1;
  let minimumAxisY = 0;

  for (const [axisX, axisY] of axes) {
    const distance = dx * axisX + dy * axisY;
    const overlap =
      projectRadius(a, axisX, axisY) +
      projectRadius(b, axisX, axisY) -
      Math.abs(distance);
    if (overlap < -GEOMETRY_EPSILON) return null;
    if (overlap < minimumOverlap) {
      minimumOverlap = Math.max(0, overlap);
      const sign = distance < 0 ? -1 : 1;
      minimumAxisX = axisX * sign;
      minimumAxisY = axisY * sign;
    }
  }

  return {
    a: a.id,
    b: b.id,
    nx: minimumAxisX,
    ny: minimumAxisY,
    depth: minimumOverlap
  };
}

export function narrowPhase(a, b) {
  if (a.shape === "circle" && b.shape === "circle") return circleCircle(a, b);
  if (a.shape === "circle" && b.shape === "rect") return circleRect(a, b);
  if (a.shape === "rect" && b.shape === "circle") {
    const contact = circleRect(b, a);
    if (!contact) return null;
    return { a: a.id, b: b.id, nx: -contact.nx, ny: -contact.ny, depth: contact.depth };
  }
  return rectRect(a, b);
}

export function contactDigest(contacts) {
  const text = contacts
    .map((contact) => `${contactKey(contact)}:${contact.depth.toFixed(9)}`)
    .sort()
    .join("|");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
