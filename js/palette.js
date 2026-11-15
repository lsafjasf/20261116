// 调色板生成与工程状态模型。纯逻辑，Node 可测。
import { hexToRgb, rgbToHex, evaluatePairAllModes } from './color.js';

// mulberry32：确定性伪随机，保证同种子可复现
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.min(1, Math.max(0, s));
  l = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return rgbToHex({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 });
}

export const COLOR_ROLES = ['primary', 'secondary', 'accent', 'neutral', 'surface'];

export function makeColor(hex, role, locked = false, id = null) {
  return { id: id ?? `c-${Math.random().toString(36).slice(2, 8)}`, hex: hex.toLowerCase(), role, locked };
}

// 由种子生成一个方案：颜色、图层顺序、预览坐标、关键帧参数全部确定
export function generateScheme(name, seed, count = 5) {
  const rand = mulberry32(seed);
  const baseHue = Math.floor(rand() * 360);
  const colors = [];
  for (let i = 0; i < count; i++) {
    const hue = (baseHue + i * (360 / count) + rand() * 24 - 12 + 360) % 360;
    const sat = 0.45 + rand() * 0.45;
    const light = 0.3 + rand() * 0.45;
    colors.push(makeColor(hslToHex(hue, sat, light), COLOR_ROLES[i % COLOR_ROLES.length], false, `c-${seed}-${i}`));
  }
  return {
    name,
    seed,
    colors,
    order: colors.map((c) => c.id), // 图层顺序
    positions: colors.map((_, i) => ({ x: 8 + i * 18, y: 20 + Math.round(rand() * 40) })), // 预览坐标 %
    keyframes: { duration: 2 + Math.round(rand() * 30) / 10, amplitude: 4 + Math.round(rand() * 8) },
  };
}

// 重新生成未锁定颜色；锁定颜色、图层顺序、坐标、关键帧保持不变
export function regenerateUnlocked(scheme, newSeed) {
  const rand = mulberry32(newSeed);
  const next = {
    ...scheme,
    seed: newSeed,
    colors: scheme.colors.map((c) => ({ ...c })),
    order: [...scheme.order],
    positions: scheme.positions.map((p) => ({ ...p })),
    keyframes: { ...scheme.keyframes },
  };
  next.colors.forEach((c) => {
    if (c.locked) return;
    const hue = Math.floor(rand() * 360);
    const sat = 0.45 + rand() * 0.45;
    const light = 0.3 + rand() * 0.45;
    c.hex = hslToHex(hue, sat, light);
  });
  return next;
}

// 汇总一个方案的全部配对警告（跨全部视觉模式）
export function collectWarnings(scheme) {
  const warnings = [];
  const ordered = scheme.order.map((id) => scheme.colors.find((c) => c.id === id)).filter(Boolean);
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const ev = evaluatePairAllModes(ordered[i].hex, ordered[j].hex);
      for (const use of ['smallText', 'button', 'chart']) {
        if (!ev[use]) {
          const badModes = ev.modes.filter((m) => !m[use]).map((m) => m.mode);
          warnings.push({ a: ordered[i].id, b: ordered[j].id, use, modes: badModes });
        }
      }
    }
  }
  return warnings;
}

// 导出 CSS 变量；变量顺序 = 图层顺序，与屏幕预览一致
export function exportCssVariables(scheme) {
  const ordered = scheme.order.map((id) => scheme.colors.find((c) => c.id === id)).filter(Boolean);
  const lines = [':root {'];
  ordered.forEach((c, i) => {
    lines.push(`  --brand-${scheme.name.toLowerCase()}-${c.role}-${i + 1}: ${c.hex};`);
  });
  lines.push('}');
  return lines.join('\n');
}

// 工程快照：导出前保存，可完整恢复
export function createSnapshot(state, label = '') {
  return {
    version: 1,
    label,
    at: new Date().toISOString(),
    state: JSON.parse(JSON.stringify(state)),
  };
}

export function serializeState(state) {
  return JSON.stringify(state);
}

export function deserializeState(json) {
  const parsed = JSON.parse(json);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.schemes)) {
    throw new Error('unrecognized state format');
  }
  for (const s of parsed.schemes) {
    if (!Array.isArray(s.colors) || !Array.isArray(s.order) || !Array.isArray(s.positions)) {
      throw new Error('corrupt scheme in state');
    }
    for (const c of s.colors) hexToRgb(c.hex); // 校验颜色合法性
  }
  return parsed;
}
