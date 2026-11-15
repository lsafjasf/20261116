export const STORAGE_KEY = 'kbd-drawing:state:v1';
export const LAST_GOOD_KEY = 'kbd-drawing:last-good:v1';
export const CORRUPT_KEY = 'kbd-drawing:corrupt-raw:v1';
export const HISTORY_LIMIT = 100;

// 瞬时命令：不进撤销栈（光标移动、平移、缩放、工具切换、画布尺寸）。
export const EPHEMERAL_COMMANDS = [
  'cursor-move', 'cursor-set', 'pan-by', 'pan-drag', 'primary-move',
  'primary-down', 'zoom', 'set-tool', 'set-canvas-size', 'clear-error', 'focus-info',
];
export const EPHEMERAL_SET = new Set(EPHEMERAL_COMMANDS);
export const isEphemeral = (type) => EPHEMERAL_SET.has(type);
