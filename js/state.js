export const GLASS_DEFS = [
  { name: "琥珀", color: [1.0, 0.63, 0.26], center: [-0.82, 0.22, 0.08], half: [0.72, 1.12], rot: 0.18 },
  { name: "青蓝", color: [0.16, 0.84, 0.9], center: [0.08, 0.18, -0.42], half: [0.86, 1.18], rot: -0.26 },
  { name: "珊瑚", color: [1.0, 0.35, 0.24], center: [0.83, 0.2, -0.94], half: [0.63, 1.03], rot: 0.42 },
];

export const LAMP_DEFS = [
  { name: "L1", color: [0.2, 0.94, 1.0], label: "CYAN" },
  { name: "L2", color: [1.0, 0.36, 0.3], label: "CORAL" },
];

export const OBJECT_COUNT = 3 + 1 + 2 + 1 + 1;
export const TILE_COLS = 12;
export const TILE_ROWS = 8;

export function makeInitialState() {
  return {
    version: 1,
    viewA: { yaw: 38, pitch: 17, distance: 7.15, fov: 39 },
    viewB: { yaw: -63, pitch: 11, distance: 7.5, fov: 42 },
    split: 0.67,
    glasses: [
      { thickness: 6, visible: true },
      { thickness: 14, visible: true },
      { thickness: 28, visible: true },
    ],
    fog: { density: 0.42, height: 0.52 },
    lamps: [
      { angle: -34, height: 1.5, intensity: 1.65, behind: false },
      { angle: 68, height: 0.7, intensity: 1.9, behind: false },
    ],
    hoverObject: -1,
  };
}

export function makeReferenceSnapshot() {
  return {
    name: "L2 背光 · 双视图对照",
    createdAt: "built-in",
    state: {
      version: 1,
      viewA: { yaw: 38, pitch: 17, distance: 7.15, fov: 39 },
      viewB: { yaw: -63, pitch: 11, distance: 7.5, fov: 42 },
      split: 0.67,
      glasses: [
        { thickness: 8, visible: true },
        { thickness: 18, visible: true },
        { thickness: 30, visible: true },
      ],
      fog: { density: 0.48, height: 0.54 },
      lamps: [
        { angle: -52, height: 1.7, intensity: 1.65, behind: false },
        { angle: 150, height: 0.62, intensity: 2.15, behind: true },
      ],
      hoverObject: -1,
    },
  };
}

export function cloneState(state) {
  if (typeof structuredClone === "function") return structuredClone(state);
  return JSON.parse(JSON.stringify(state));
}

export function sanitizeState(value) {
  if (!value || typeof value !== "object") throw new Error("参数快照为空");
  const next = cloneState(value);
  const finite = (number, name, min, max) => {
    if (!Number.isFinite(number) || number < min || number > max) {
      throw new Error(`${name} 超出范围 [${min}, ${max}]`);
    }
    return number;
  };
  for (const key of ["viewA", "viewB"]) {
    const view = next[key];
    view.yaw = finite(view.yaw, `${key}.yaw`, -180, 180);
    view.pitch = finite(view.pitch, `${key}.pitch`, 1, 55);
    view.distance = finite(view.distance, `${key}.distance`, 4.5, 14);
    view.fov = finite(view.fov, `${key}.fov`, 24, 70);
  }
  next.glasses.forEach((glass, index) => {
    glass.thickness = finite(glass.thickness, `glass[${index}].thickness`, 2, 30);
  });
  next.fog.density = finite(next.fog.density, "fog.density", 0, 1);
  next.fog.height = finite(next.fog.height, "fog.height", 0.12, 0.9);
  next.lamps.forEach((lamp, index) => {
    lamp.angle = finite(lamp.angle, `lamp[${index}].angle`, -180, 180);
    lamp.height = finite(lamp.height, `lamp[${index}].height`, 0.2, 3.2);
    lamp.intensity = finite(lamp.intensity, `lamp[${index}].intensity`, 0.2, 3.0);
  });
  return next;
}

export function stateFingerprint(state) {
  const canonical = {
    viewA: state.viewA,
    viewB: state.viewB,
    split: state.split,
    glasses: state.glasses.map((glass) => glass.thickness),
    fog: state.fog,
    lamps: state.lamps.map((lamp) => [lamp.angle, lamp.height, lamp.intensity]),
  };
  const text = JSON.stringify(canonical);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
