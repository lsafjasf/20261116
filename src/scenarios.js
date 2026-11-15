import { circle, rectangle, boundsOf } from "./geometry.js";

export const SCENE_WIDTH = 1200;
export const SCENE_HEIGHT = 760;

export const SCENARIOS = [
  {
    id: "before",
    name: "优化前 · 暴力基线",
    shortName: "优化前",
    description: "620 个混合对象，不剪枝，全部对象对进入窄相。",
    count: 620,
    seed: 0x20161116,
    mode: "brute"
  },
  {
    id: "after",
    name: "优化后 · 空间网格",
    shortName: "优化后",
    description: "与优化前完全相同的 620 个对象和种子，仅启用网格剪枝。",
    count: 620,
    seed: 0x20161116,
    mode: "grid"
  },
  {
    id: "boundary",
    name: "边界参数 · 极端尺寸",
    shortName: "边界参数",
    description: "覆盖超小/超大对象、网格线、场景边缘、相切与极端旋转。",
    count: 280,
    seed: 0x0bad5eed,
    mode: "grid"
  }
];

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function between(random, minimum, maximum) {
  return minimum + (maximum - minimum) * random();
}

function makeBody(id, random, animated = true) {
  const shape = random() < 0.52 ? "circle" : "rect";
  const x = between(random, 20, SCENE_WIDTH - 20);
  const y = between(random, 20, SCENE_HEIGHT - 20);
  const speed = between(random, 4, 16);
  const direction = between(random, 0, Math.PI * 2);
  const motion = animated
    ? { vx: Math.cos(direction) * speed, vy: Math.sin(direction) * speed }
    : { vx: 0, vy: 0 };

  if (shape === "circle") {
    return circle(x, y, between(random, 9, 33), {
      id,
      hue: between(random, 158, 198),
      spin: 0,
      ...motion
    });
  }

  return rectangle(
    x,
    y,
    between(random, 18, 68),
    between(random, 11, 42),
    between(random, 0, Math.PI * 2),
    {
      id,
      hue: between(random, 18, 46),
      spin: between(random, -0.34, 0.34),
      ...motion
    }
  );
}

function cornerOf(rect, signX, signY) {
  const localX = (rect.width / 2) * signX;
  const localY = (rect.height / 2) * signY;
  const cos = Math.cos(rect.angle);
  const sin = Math.sin(rect.angle);
  return {
    x: rect.x + localX * cos - localY * sin,
    y: rect.y + localX * sin + localY * cos
  };
}

function boundaryBodies(startId) {
  const bodies = [];
  let id = startId;
  const add = (body) => {
    body.id = id;
    id += 1;
    bodies.push(body);
  };

  add(
    rectangle(600, 380, 1180, 36, 0.08, {
      hue: 34,
      spin: 0,
      vx: 0,
      vy: 0,
      boundaryCase: "wide"
    })
  );
  add(
    rectangle(600, 380, 48, 716, 0.015, {
      hue: 48,
      spin: 0,
      vx: 0,
      vy: 0,
      boundaryCase: "tall"
    })
  );
  add(
    circle(0, 210, 14, {
      hue: 188,
      spin: 0,
      vx: 0,
      vy: 0,
      boundaryCase: "scene-edge"
    })
  );
  add(
    rectangle(SCENE_WIDTH, 610, 30, 20, 0.72, {
      hue: 22,
      spin: 0,
      vx: 0,
      vy: 0,
      boundaryCase: "scene-edge"
    })
  );
  add(
    circle(360, 360, 0.0001, {
      hue: 176,
      spin: 0,
      vx: 0,
      vy: 0,
      boundaryCase: "tiny-on-grid-line"
    })
  );
  add(
    rectangle(720, 288, 8, 4, Math.PI / 2, {
      hue: 28,
      spin: 0,
      vx: 0,
      vy: 0,
      boundaryCase: "tiny-on-grid-line"
    })
  );
  add(
    circle(250, 100, 10, {
      hue: 166,
      spin: 0,
      vx: 0,
      vy: 0,
      boundaryCase: "tangent-circle"
    })
  );
  add(
    circle(270, 100, 10, {
      hue: 198,
      spin: 0,
      vx: 0,
      vy: 0,
      boundaryCase: "tangent-circle"
    })
  );
  add(
    rectangle(845, 122, 40, 20, 0, {
      hue: 40,
      spin: 0,
      vx: 0,
      vy: 0,
      boundaryCase: "tangent-rect"
    })
  );
  add(
    rectangle(885, 122, 40, 20, 0, {
      hue: 24,
      spin: 0,
      vx: 0,
      vy: 0,
      boundaryCase: "tangent-rect"
    })
  );

  const cornerRect = rectangle(990, 610, 100, 50, 0.44, {
    hue: 32,
    spin: 0,
    vx: 0,
    vy: 0,
    boundaryCase: "circle-at-corner"
  });
  add(cornerRect);
  const corner = cornerOf(cornerRect, 1, 1);
  add(
    circle(corner.x, corner.y, 12, {
      hue: 190,
      spin: 0,
      vx: 0,
      vy: 0,
      boundaryCase: "circle-at-corner"
    })
  );

  add(
    circle(360.5, 288.5, 0, {
      hue: 172,
      spin: 0,
      vx: 0,
      vy: 0,
      boundaryCase: "zero-radius"
    })
  );
  add(
    rectangle(505, 505, 0.02, 6, Math.PI / 4, {
      hue: 30,
      spin: 0,
      vx: 0,
      vy: 0,
      boundaryCase: "near-zero-width"
    })
  );
  add(
    rectangle(790, 480, 72, 24, Math.PI * 2, {
      hue: 44,
      spin: 0,
      vx: 0,
      vy: 0,
      boundaryCase: "wrapped-angle"
    })
  );
  add(
    rectangle(790, 454, 72, 24, 0, {
      hue: 20,
      spin: 0,
      vx: 0,
      vy: 0,
      boundaryCase: "wrapped-angle"
    })
  );
  return bodies;
}

export function createScenarioObjects(scenarioId) {
  const scenario = SCENARIOS.find((entry) => entry.id === scenarioId);
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
  const random = mulberry32(scenario.seed);
  const objects = [];
  for (let index = 0; index < scenario.count; index += 1) {
    objects.push(makeBody(index + 1, random, true));
  }
  if (scenario.id === "boundary") {
    objects.push(...boundaryBodies(scenario.count + 1));
  }
  for (const object of objects) object.bounds = boundsOf(object);
  return objects;
}

export function cloneScene(objects) {
  return objects.map((object) => ({
    ...object,
    bounds: object.bounds ? { ...object.bounds } : undefined
  }));
}

export function stepMotion(objects, deltaSeconds, sceneWidth, sceneHeight) {
  for (const object of objects) {
    if (!object.vx && !object.vy && !object.spin) continue;
    const radiusX = object.shape === "circle" ? object.radius : object.width / 2;
    const radiusY = object.shape === "circle" ? object.radius : object.height / 2;
    object.x += object.vx * deltaSeconds;
    object.y += object.vy * deltaSeconds;
    object.angle += object.spin * deltaSeconds;
    if (object.x < radiusX) {
      object.x = radiusX;
      object.vx = Math.abs(object.vx);
    } else if (object.x > sceneWidth - radiusX) {
      object.x = sceneWidth - radiusX;
      object.vx = -Math.abs(object.vx);
    }
    if (object.y < radiusY) {
      object.y = radiusY;
      object.vy = Math.abs(object.vy);
    } else if (object.y > sceneHeight - radiusY) {
      object.y = sceneHeight - radiusY;
      object.vy = -Math.abs(object.vy);
    }
  }
}

export function sceneStats(objects) {
  let circles = 0;
  let rectangles = 0;
  for (const object of objects) {
    if (object.shape === "circle") circles += 1;
    else rectangles += 1;
  }
  return { total: objects.length, circles, rectangles };
}
