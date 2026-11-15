// Parameter schema, validation, presets and (de)serialization.
export const TILE_SIZE = 1024;
export const BLOCK_SIZE = 64; // dirty-region granularity (16 x 16 blocks)

// Thread density must divide the tile size evenly, otherwise thread phases do
// not line up on opposite edges. The UI slider and JSON loader snap to these.
// Every entry divides 1024 and is divisible by 4 (continuous interlacing).
export const LEGAL_DENSITIES = [8, 16, 32, 64, 128];

export function snapDensity(value) {
  return LEGAL_DENSITIES.reduce((best, d) =>
    Math.abs(d - value) < Math.abs(best - value) ? d : best
  );
}

export const DEFAULT_PARAMS = Object.freeze({
  version: 1,
  seed: "fabric-001",
  threadDensity: 64, // warp/weft threads per tile side (divides 1024)
  fiberDirection: 0, // degrees, 0 = balanced, rotates fuzz + sheen
  wearLevel: 0.35, // 0..1, fraction/strength of abraded area
  creaseStrength: 0.4, // 0..1
  baseColor: [168, 122, 86],
  paletteJitter: 0.12,
});

export const PRESETS = {
  // Visual comparison set, also used by the one-click restore button.
  balanced: {
    label: "标准棉麻（对照基线）",
    params: { ...DEFAULT_PARAMS },
  },
  dense: {
    label: "高密经纬",
    params: { ...DEFAULT_PARAMS, seed: "fabric-dense", threadDensity: 128, wearLevel: 0.15, creaseStrength: 0.2 },
  },
  worn: {
    label: "重度磨损",
    params: { ...DEFAULT_PARAMS, seed: "fabric-worn", threadDensity: 32, wearLevel: 0.85, creaseStrength: 0.65 },
  },
  folded: {
    label: "强折痕斜绒",
    params: {
      ...DEFAULT_PARAMS,
      seed: "fabric-fold",
      threadDensity: 64,
      fiberDirection: 35,
      wearLevel: 0.45,
      creaseStrength: 0.95,
    },
  },
};

const RANGES = {
  threadDensity: [8, 160, "integer"],
  fiberDirection: [-90, 90, "number"],
  wearLevel: [0, 1, "number"],
  creaseStrength: [0, 1, "number"],
  paletteJitter: [0, 1, "number"],
};

export class ParamError extends Error {
  constructor(field, message) {
    super(`参数非法 [${field}]: ${message}`);
    this.field = field;
  }
}

export function validateParams(input) {
  if (input === null || typeof input !== "object") {
    throw new ParamError("root", "参数必须是对象");
  }
  const out = { ...DEFAULT_PARAMS, ...input };
  for (const [key, [min, max, kind]] of Object.entries(RANGES)) {
    const value = out[key];
    if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
      throw new ParamError(key, "需要有限数值");
    }
    if (kind === "integer" && !Number.isInteger(value)) {
      throw new ParamError(key, "需要整数");
    }
    if (value < min || value > max) {
      throw new ParamError(key, `超出允许范围 [${min}, ${max}]`);
    }
  }
  if (typeof out.seed !== "string" || out.seed.length === 0) {
    throw new ParamError("seed", "需要非空字符串");
  }
  if (
    !Array.isArray(out.baseColor) ||
    out.baseColor.length !== 3 ||
    out.baseColor.some((c) => !Number.isInteger(c) || c < 0 || c > 255)
  ) {
    throw new ParamError("baseColor", "需要 3 个 0..255 整数");
  }
  out.fiberDirection = ((out.fiberDirection + 90) % 180) - 90;
  out.threadDensity = snapDensity(out.threadDensity);
  return out;
}

export function serializeParams(params) {
  return JSON.stringify(validateParams(params), null, 2);
}

export function deserializeParams(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ParamError("json", `JSON 解析失败: ${err.message}`);
  }
  return validateParams(parsed);
}
