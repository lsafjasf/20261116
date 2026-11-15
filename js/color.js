// 色彩数学核心：对比度、色差、色觉障碍模拟。纯函数，浏览器与 Node 通用。

export function clamp(v, lo = 0, hi = 1) {
  return Math.min(hi, Math.max(lo, v));
}

export function hexToRgb(hex) {
  if (typeof hex !== 'string') throw new TypeError('hex must be a string');
  let h = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new RangeError(`invalid hex color: ${hex}`);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }) {
  const to = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function srgbChannelToLinear(c) {
  const v = clamp(c, 0, 255) / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function relativeLuminance({ r, g, b }) {
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

// WCAG 2.x 对比度，范围 [1, 21]
export function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexToRgb(hexA));
  const lb = relativeLuminance(hexToRgb(hexB));
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// --- CIE Lab（D65）用于色差 ---
export function rgbToLab({ r, g, b }) {
  const rl = srgbChannelToLinear(r);
  const gl = srgbChannelToLinear(g);
  const bl = srgbChannelToLinear(b);
  let x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  let y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
  let z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

// CIE76 ΔE，0 表示完全相同
export function deltaE(hexA, hexB) {
  const la = rgbToLab(hexToRgb(hexA));
  const lb = rgbToLab(hexToRgb(hexB));
  return Math.hypot(la.L - lb.L, la.a - lb.a, la.b - lb.b);
}

// --- 色觉障碍模拟（Machado 2009，severity = 1.0，作用于线性 sRGB）---
const CVD_MATRICES = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

export const VISION_MODES = ['normal', 'protan', 'deutan', 'tritan'];

function linearToSrgbChannel(v) {
  v = clamp(v);
  return (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;
}

// 返回模拟后的 hex；mode 为 normal 时原样返回
export function simulateVision(hex, mode) {
  if (mode === 'normal') return hex.toLowerCase();
  const m = CVD_MATRICES[mode];
  if (!m) throw new RangeError(`unknown vision mode: ${mode}`);
  const { r, g, b } = hexToRgb(hex);
  const lin = [srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b)];
  const out = m.map((row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]);
  return rgbToHex({
    r: linearToSrgbChannel(out[0]),
    g: linearToSrgbChannel(out[1]),
    b: linearToSrgbChannel(out[2]),
  });
}

// --- 用途判定阈值 ---
export const THRESHOLDS = {
  smallText: 4.5, // WCAG AA 小字
  button: 3.0, // WCAG 非文本 UI 组件
  chartDeltaE: 12, // 图表系列最小可区分色差
};

// 评估一对颜色在指定视觉模式下是否适合某用途
export function evaluatePair(hexA, hexB, mode = 'normal') {
  if (!VISION_MODES.includes(mode)) throw new RangeError(`unknown vision mode: ${mode}`);
  const a = simulateVision(hexA, mode);
  const b = simulateVision(hexB, mode);
  const ratio = contrastRatio(a, b);
  const dE = deltaE(a, b);
  return {
    mode,
    contrast: Math.round(ratio * 100) / 100,
    deltaE: Math.round(dE * 100) / 100,
    smallText: ratio >= THRESHOLDS.smallText,
    button: ratio >= THRESHOLDS.button,
    chart: dE >= THRESHOLDS.chartDeltaE,
  };
}

// 在全部视觉模式下评估；任一模式不达标即整体不达标
export function evaluatePairAllModes(hexA, hexB) {
  const modes = VISION_MODES.map((m) => evaluatePair(hexA, hexB, m));
  return {
    modes,
    smallText: modes.every((m) => m.smallText),
    button: modes.every((m) => m.button),
    chart: modes.every((m) => m.chart),
  };
}
