import { GLASS_DEFS, TILE_COLS, TILE_ROWS } from "./state.js";

export const FLOOR_Y = -1.3;
export const TARGET = [0, 0.02, -0.16];

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => mul(a, 1 / Math.hypot(a[0], a[1], a[2]));
const deg = (value) => (value * Math.PI) / 180;

export function glassHalfZ(thickness) {
  return 0.018 + thickness * 0.0062;
}

export function lampPosition(lamp, index = 0) {
  const angle = deg(lamp.angle);
  const radius = 2.08 + (lamp.height - 1.4) * 0.08 + index * 0.04;
  return [
    Math.sin(angle) * radius,
    lamp.height - 0.3,
    Math.cos(angle) * radius,
  ];
}

export function cameraBasis(view) {
  const yaw = deg(view.yaw);
  const pitch = deg(view.pitch);
  const horizontal = Math.cos(pitch) * view.distance;
  const eye = [
    TARGET[0] + Math.sin(yaw) * horizontal,
    TARGET[1] + Math.sin(pitch) * view.distance,
    TARGET[2] + Math.cos(yaw) * horizontal,
  ];
  const forward = norm(sub(TARGET, eye));
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  return {
    eye,
    forward,
    right,
    up,
    tanHalfFov: Math.tan(deg(view.fov) * 0.5),
  };
}

export function viewportRects(state, width, height) {
  const splitX = Math.round(width * state.split);
  return [
    { x: 0, y: 0, w: splitX, h: height, aspect: splitX / height, camera: cameraBasis(state.viewA) },
    {
      x: splitX,
      y: 0,
      w: width - splitX,
      h: height,
      aspect: (width - splitX) / height,
      camera: cameraBasis(state.viewB),
    },
  ];
}

export function projectPoint(point, viewport) {
  const { camera } = viewport;
  const local = sub(point, camera.eye);
  const depth = dot(local, camera.forward);
  if (depth <= 0.01) return null;
  const ndcX = dot(local, camera.right) / (depth * camera.tanHalfFov * viewport.aspect);
  const ndcY = dot(local, camera.up) / (depth * camera.tanHalfFov);
  return {
    x: viewport.x + (ndcX * 0.5 + 0.5) * viewport.w,
    y: viewport.y + (1 - (ndcY * 0.5 + 0.5)) * viewport.h,
    depth,
    visible: Math.abs(ndcX) <= 1.08 && Math.abs(ndcY) <= 1.08,
  };
}

function rotateY(point, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c * point[0] - s * point[2], point[1], s * point[0] + c * point[2]];
}

function inverseRotateY(point, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c * point[0] + s * point[2], point[1], -s * point[0] + c * point[2]];
}

export function glassBox(index, state) {
  const definition = GLASS_DEFS[index];
  return {
    center: definition.center,
    half: [definition.half[0], definition.half[1], glassHalfZ(state.glasses[index].thickness)],
    rot: definition.rot,
    color: definition.color,
  };
}

export function intersectBox(origin, direction, box) {
  const localOrigin = inverseRotateY(sub(origin, box.center), box.rot);
  const localDirection = inverseRotateY(direction, box.rot);
  let near = -Infinity;
  let far = Infinity;
  const nearNormal = [0, 0, 0];

  for (let axis = 0; axis < 3; axis += 1) {
    const o = localOrigin[axis];
    const d = localDirection[axis];
    const half = box.half[axis];
    if (Math.abs(d) < 1e-7) {
      if (o < -half || o > half) return null;
      continue;
    }
    let t0 = (-half - o) / d;
    let t1 = (half - o) / d;
    let sign = -1;
    if (t0 > t1) {
      [t0, t1] = [t1, t0];
      sign = 1;
    }
    if (t0 > near) {
      near = t0;
      nearNormal[0] = 0;
      nearNormal[1] = 0;
      nearNormal[2] = 0;
      nearNormal[axis] = sign;
    }
    far = Math.min(far, t1);
    if (near > far) return null;
  }

  if (far <= Math.max(near, 0)) return null;
  const enter = Math.max(near, 0);
  const normal = rotateY(nearNormal, box.rot);
  return { enter, exit: far, normal, localOrigin };
}

export function lampOcclusion(index, state, viewport) {
  const lamp = state.lamps[index];
  const lampPos = lampPosition(lamp, index);
  const ray = sub(lampPos, viewport.camera.eye);
  const lampDistance = Math.hypot(...ray);
  const direction = norm(ray);
  const hits = [];

  state.glasses.forEach((glass, glassIndex) => {
    if (!glass.visible) return;
    const box = glassBox(glassIndex, state);
    const hit = intersectBox(viewport.camera.eye, direction, box);
    if (hit && hit.enter > 0.05 && hit.enter < lampDistance - 0.03) {
      hits.push({ name: GLASS_DEFS[glassIndex].name, enter: hit.enter, thickness: glass.thickness });
    }
  });

  hits.sort((a, b) => a.enter - b.enter);
  return {
    point: lampPos,
    source: lampPos,
    screen: projectPoint(lampPos, viewport),
    hits,
    occluded: hits.length > 0,
    order: hits.map((hit) => hit.name).join(" → ") || "直接可见",
  };
}

export function glassScreenPolygon(index, state, viewport) {
  const box = glassBox(index, state);
  const points = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const local = [box.half[0] * sx, box.half[1] * sy, box.half[2] * sz];
        const world = add(box.center, rotateY(local, box.rot));
        const projected = projectPoint(world, viewport);
        if (projected) points.push(projected);
      }
    }
  }
  return points;
}

export function boundsOfPoints(points) {
  if (!points.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionBounds(rectangles) {
  const valid = rectangles.filter(Boolean);
  if (!valid.length) return null;
  const minX = Math.min(...valid.map((rect) => rect.x));
  const minY = Math.min(...valid.map((rect) => rect.y));
  const maxX = Math.max(...valid.map((rect) => rect.x + rect.w));
  const maxY = Math.max(...valid.map((rect) => rect.y + rect.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function clampRect(rect, width, height, padding = 0) {
  const x = Math.max(0, Math.floor(rect.x - padding));
  const y = Math.max(0, Math.floor(rect.y - padding));
  const right = Math.min(width, Math.ceil(rect.x + rect.w + padding));
  const bottom = Math.min(height, Math.ceil(rect.y + rect.h + padding));
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

function lampInfluenceRect(index, state, viewports, width, height) {
  const lamp = state.lamps[index];
  const position = lampPosition(lamp, index);
  const points = [];
  for (const viewport of viewports) {
    for (let i = 0; i < 8; i += 1) {
      const angle = (i / 8) * Math.PI * 2;
      points.push(projectPoint([position[0] + Math.cos(angle) * 0.42, position[1] + 0.42, position[2] + Math.sin(angle) * 0.42], viewport));
      points.push(projectPoint([position[0] + Math.cos(angle) * 3.1, FLOOR_Y + 0.01, position[2] + Math.sin(angle) * 3.1], viewport));
    }
    points.push(projectPoint(position, viewport));
  }
  return boundsOfPoints(points.filter((point) => point && point.visible));
}

function glassInfluenceRect(index, state, viewports) {
  const points = [];
  for (const viewport of viewports) {
    points.push(...glassScreenPolygon(index, state, viewport));
    const box = glassBox(index, state);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const local = [box.half[0] * sx, -box.half[1], box.half[2] * sz];
        const world = add(box.center, rotateY(local, box.rot));
        points.push(projectPoint([world[0], FLOOR_Y + 0.01, world[2]], viewport));
      }
    }
  }
  return boundsOfPoints(points.filter(Boolean));
}

export function dirtyRectForChange(change, before, after, width, height) {
  if (change.type === "view" || change.type === "all" || change.type === "resize") {
    return { x: 0, y: 0, w: width, h: height };
  }

  const viewports = viewportRects(after, width, height);
  const parts = [];
  if (change.type === "light") {
    for (const index of change.indices || [0, 1]) {
      parts.push(lampInfluenceRect(index, before, viewports, width, height));
      parts.push(lampInfluenceRect(index, after, viewports, width, height));
    }
    for (let i = 0; i < 3; i += 1) parts.push(glassInfluenceRect(i, after, viewports));
    parts.push({ x: 0, y: height * 0.32, w: width, h: height * 0.68 });
  } else if (change.type === "glass") {
    for (const index of change.indices || [0, 1, 2]) {
      parts.push(glassInfluenceRect(index, before, viewports));
      parts.push(glassInfluenceRect(index, after, viewports));
    }
  } else if (change.type === "fog") {
    parts.push({ x: 0, y: height * 0.26, w: width, h: height * 0.74 });
  } else {
    return { x: 0, y: 0, w: width, h: height };
  }

  return clampRect(unionBounds(parts) || { x: 0, y: 0, w: width, h: height }, width, height, 34);
}

export function dirtyTiles(rect, width, height) {
  const tileW = width / TILE_COLS;
  const tileH = height / TILE_ROWS;
  const tiles = [];
  for (let row = 0; row < TILE_ROWS; row += 1) {
    for (let col = 0; col < TILE_COLS; col += 1) {
      const x = col * tileW;
      const y = row * tileH;
      if (x + tileW > rect.x && x < rect.x + rect.w && y + tileH > rect.y && y < rect.y + rect.h) {
        tiles.push({
          x: Math.round(x),
          y: Math.round(y),
          w: Math.ceil(tileW),
          h: Math.ceil(tileH),
          index: row * TILE_COLS + col,
        });
      }
    }
  }
  return tiles;
}

export function probePointForLamp(index, state, width, height) {
  const viewports = viewportRects(state, width, height);
  return viewports.map((viewport, viewIndex) => {
    const evidence = lampOcclusion(index, state, viewport);
    return {
      view: viewIndex === 0 ? "A" : "B",
      evidence,
      screen: evidence.screen,
    };
  });
}
