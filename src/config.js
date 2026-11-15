export const TICK_MS = 50;
export const TICK_SECONDS = TICK_MS / 1000;
export const WORLD_WIDTH = 67;
export const WORLD_HEIGHT = 43;
export const MOVE_SPEED = 0.14;
export const PLAYER_RADIUS = 0.42;
export const MAX_RANGE = 20;
export const SCAN_RAYS = 144;
export const SCAN_COST = 7;
export const SCAN_COOLDOWN_TICKS = 34;
export const SCAN_EXPOSURE = 16;
export const MAX_EXPOSURE = 100;
export const MAX_BATTERY = 100;
export const MAX_HULL = 100;
export const IDLE_DRAIN = 0.006;
export const MOVE_DRAIN = 0.024;
export const CHECKPOINT_INTERVAL = 120;
export const PATROL_KILL_RADIUS = 1.15;
export const EXIT_ACTION_RADIUS = 1.8;
export const RECOVERY_COST = 18;
export const RECOVERY_BATTERY_FLOOR = 18;

export const MATERIALS = Object.freeze({
  basalt: Object.freeze({
    id: 1,
    key: "basalt",
    name: "玄武岩",
    reflectivity: 0.44,
    color: "#334052",
    glow: "#72829b",
    frequency: 196,
  }),
  granite: Object.freeze({
    id: 2,
    key: "granite",
    name: "花岗岩",
    reflectivity: 0.7,
    color: "#564755",
    glow: "#b78f9f",
    frequency: 294,
  }),
  shale: Object.freeze({
    id: 3,
    key: "shale",
    name: "页岩",
    reflectivity: 0.29,
    color: "#3f4b42",
    glow: "#829d80",
    frequency: 147,
  }),
  crystal: Object.freeze({
    id: 4,
    key: "crystal",
    name: "石英脉",
    reflectivity: 0.94,
    color: "#31545d",
    glow: "#7de5ee",
    frequency: 587,
  }),
  gate: Object.freeze({
    id: 9,
    key: "gate",
    name: "出口",
    reflectivity: 0.82,
    color: "#9a7d3e",
    glow: "#ffd779",
    frequency: 440,
  }),
});

export const MATERIAL_LIST = Object.freeze([
  MATERIALS.basalt,
  MATERIALS.granite,
  MATERIALS.shale,
  MATERIALS.crystal,
]);

export const STATUSES = Object.freeze({
  READY: "READY",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
});

export const FAILURE_LABELS = Object.freeze({
  patrol: "被巡逻声源捕获",
  wrong_exit: "提交了错误出口",
  battery: "电池耗尽",
  exposure: "声呐暴露值达到上限",
  hull: "监听器结构失效",
});
