import { clamp } from "./geometry.js";
import { SpatialIndex } from "./spatial-index.js";

export const BASE_CONFIG = Object.freeze({
  seed: 0x5eedc0de,
  width: 960,
  height: 540,
  worldWidth: 3200,
  worldHeight: 2000,
  terrainCount: 9000,
  textCount: 260,
  dynamicCount: 240,
  initialCamera: { x: 700, y: 410 },
});

const TERRAIN_COLORS = [
  "#193b3a",
  "#214942",
  "#2b5348",
  "#345c4c",
  "#1b3438",
  "#3f6552",
];

const TEXT_COLORS = ["#f4e5b8", "#bfe9d3", "#d8e7f0", "#f0c990"];
const DYNAMIC_HUES = [18, 42, 168, 198, 322, 276];

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBetween(random, min, max) {
  return min + random() * (max - min);
}

export function dynamicBounds(object) {
  const size = object.radius * 2 + 8;
  return {
    x: object.x - object.radius - 4,
    y: object.y - object.radius - 4,
    w: size,
    h: size,
  };
}

export function textBounds(text) {
  return {
    x: text.x - 6,
    y: text.y - 5,
    w: text.width + 12,
    h: text.height + 9,
  };
}

export function viewportWorldRect(scene) {
  return {
    x: scene.camera.x,
    y: scene.camera.y,
    w: scene.config.width,
    h: scene.config.height,
  };
}

export function createScene(overrides = {}) {
  const config = { ...BASE_CONFIG, ...overrides };
  const random = mulberry32(config.seed);
  const scene = {
    config,
    tick: 0,
    camera: { ...config.initialCamera },
    cameraRevision: 0,
    layers: { terrain: true, text: true, dynamic: true },
    terrain: [],
    texts: [],
    dynamics: [],
    actions: { deleted: [], pans: 0, layerToggles: 0 },
    textIndex: null,
    dynamicIndex: null,
  };

  for (let id = 0; id < config.terrainCount; id += 1) {
    const size = randomBetween(random, 3, 17);
    scene.terrain.push({
      id,
      x: randomBetween(random, 0, config.worldWidth),
      y: randomBetween(random, 0, config.worldHeight),
      w: size,
      h: size * randomBetween(random, 0.55, 1.25),
      variant: Math.floor(random() * 4),
      color: TERRAIN_COLORS[Math.floor(random() * TERRAIN_COLORS.length)],
      alpha: randomBetween(random, 0.35, 0.85),
    });
  }

  for (let id = 0; id < config.textCount; id += 1) {
    const fontSize = Math.floor(randomBetween(random, 11, 16));
    const label = `${id % 3 === 0 ? "SECTOR" : "NODE"}-${String(id).padStart(3, "0")}`;
    scene.texts.push({
      id,
      x: randomBetween(random, 20, config.worldWidth - 100),
      y: randomBetween(random, 20, config.worldHeight - 30),
      label,
      fontSize,
      font: `600 ${fontSize}px ui-monospace, monospace`,
      color: TEXT_COLORS[id % TEXT_COLORS.length],
      background: id % 4 === 0 ? "rgba(7, 20, 24, 0.48)" : "rgba(7, 20, 24, 0.25)",
      width: Math.ceil(label.length * fontSize * 0.68),
      height: fontSize + 2,
    });
  }

  scene.textIndex = new SpatialIndex(160);
  for (const text of scene.texts) scene.textIndex.insert(text, textBounds(text));

  for (let id = 0; id < config.dynamicCount; id += 1) {
    const baseX = randomBetween(random, 40, config.worldWidth - 40);
    const baseY = randomBetween(random, 40, config.worldHeight - 40);
    const object = {
      id,
      order: id,
      alive: true,
      x: baseX,
      y: baseY,
      baseX,
      baseY,
      radius: randomBetween(random, 5, 10),
      phase: randomBetween(random, 0, Math.PI * 2),
      ampX: randomBetween(random, 8, 34),
      ampY: randomBetween(random, 5, 24),
      speedX: randomBetween(random, 0.018, 0.06),
      speedY: randomBetween(random, 0.014, 0.052),
      hue: DYNAMIC_HUES[id % DYNAMIC_HUES.length],
      shape: id % 3,
    };
    scene.dynamics.push(object);
  }

  scene.dynamicIndex = new SpatialIndex(96);
  for (const object of scene.dynamics) {
    scene.dynamicIndex.insert(object, dynamicBounds(object));
  }
  return scene;
}

export function advanceScene(scene, steps = 1) {
  for (let step = 0; step < steps; step += 1) {
    scene.tick += 1;
    const tick = scene.tick;
    for (const object of scene.dynamics) {
      if (!object.alive) continue;
      object.x =
        object.baseX + Math.cos(object.phase + tick * object.speedX) * object.ampX;
      object.y =
        object.baseY + Math.sin(object.phase * 1.7 + tick * object.speedY) * object.ampY;
      scene.dynamicIndex.update(object, dynamicBounds(object));
    }
  }
  return scene;
}

export function panCamera(scene, dx, dy) {
  const { width, height, worldWidth, worldHeight } = scene.config;
  const nextX = clamp(Math.round(scene.camera.x + dx), 0, worldWidth - width);
  const nextY = clamp(Math.round(scene.camera.y + dy), 0, worldHeight - height);
  if (nextX === scene.camera.x && nextY === scene.camera.y) return false;
  scene.camera.x = nextX;
  scene.camera.y = nextY;
  scene.cameraRevision += 1;
  scene.actions.pans += 1;
  return true;
}

export function setLayerVisible(scene, layer, visible) {
  if (!(layer in scene.layers) || scene.layers[layer] === visible) return false;
  scene.layers[layer] = visible;
  scene.actions.layerToggles += 1;
  return true;
}

export function deleteObject(scene, id) {
  const object = scene.dynamics.find((candidate) => candidate.id === id);
  if (!object || !object.alive) return false;
  object.alive = false;
  scene.dynamicIndex.remove(object);
  scene.actions.deleted.push(id);
  return true;
}

export function deleteVisibleObject(scene) {
  const viewport = viewportWorldRect(scene);
  const candidates = scene.dynamicIndex
    .query(viewport)
    .filter(
      (object) =>
        object.x + object.radius >= viewport.x &&
        object.x - object.radius <= viewport.x + viewport.w &&
        object.y + object.radius >= viewport.y &&
        object.y - object.radius <= viewport.y + viewport.h,
    )
    .sort((a, b) => a.order - b.order);
  if (candidates.length === 0) return false;
  return deleteObject(scene, candidates[0].id);
}

export function publicSnapshot(scene) {
  return {
    tick: scene.tick,
    camera: { ...scene.camera },
    layers: { ...scene.layers },
    counts: {
      terrain: scene.terrain.length,
      text: scene.texts.length,
      dynamic: scene.dynamics.filter((object) => object.alive).length,
    },
    actions: {
      deleted: [...scene.actions.deleted],
      pans: scene.actions.pans,
      layerToggles: scene.actions.layerToggles,
    },
  };
}
