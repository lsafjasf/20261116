// 本地持久化层：所有写入都先经过严格校验，损坏数据永不覆盖最后可读快照。

export const SCHEMA_VERSION = 1;

export const FIELD_DEFS = [
  { key: 'skinColor', label: '肤色', type: 'color', group: 'colors' },
  { key: 'armorColor', label: '装甲色', type: 'color', group: 'colors' },
  { key: 'capeColor', label: '披风色', type: 'color', group: 'colors' },
  { key: 'weapon', label: '武器', type: 'select', group: 'equipment',
    options: ['none', 'sword', 'staff', 'bow'] },
  { key: 'helmet', label: '头盔', type: 'select', group: 'equipment',
    options: ['none', 'light', 'heavy'] },
  { key: 'shield', label: '盾牌', type: 'select', group: 'equipment',
    options: ['none', 'buckler', 'tower'] },
  { key: 'speed', label: '动画速度', type: 'range', group: 'animation', min: 0, max: 100, step: 1 },
  { key: 'bounce', label: '弹跳幅度', type: 'range', group: 'animation', min: 0, max: 40, step: 1 },
  { key: 'swing', label: '挥摆角度', type: 'range', group: 'animation', min: 0, max: 90, step: 1 },
];

export function defaultConfig() {
  return {
    schemaVersion: SCHEMA_VERSION,
    colors: {
      skinColor: '#e8b88a',
      armorColor: '#4a7bd0',
      capeColor: '#b33a3a',
    },
    equipment: {
      weapon: 'sword',
      helmet: 'light',
      shield: 'none',
    },
    animation: {
      speed: 50,
      bounce: 12,
      swing: 30,
    },
  };
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// 返回 { ok: true, value } 或 { ok: false, error }
export function validateConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '配置必须是 JSON 对象' };
  }
  if (input.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, error: `不支持的 schemaVersion=${String(input.schemaVersion)}，期望 ${SCHEMA_VERSION}` };
  }
  const out = defaultConfig();
  for (const def of FIELD_DEFS) {
    const group = input[def.group];
    if (group === undefined || group === null || typeof group !== 'object' || Array.isArray(group)) {
      return { ok: false, error: `缺少分组 ${def.group}` };
    }
    const raw = group[def.key];
    if (raw === undefined) {
      return { ok: false, error: `缺少字段 ${def.group}.${def.key}` };
    }
    if (def.type === 'color') {
      if (typeof raw !== 'string' || !HEX_RE.test(raw)) {
        return { ok: false, error: `${def.key} 必须是 #RRGGBB 颜色，收到 ${JSON.stringify(raw)}` };
      }
      out[def.group][def.key] = raw.toLowerCase();
    } else if (def.type === 'select') {
      if (!def.options.includes(raw)) {
        return { ok: false, error: `${def.key} 取值非法：${JSON.stringify(raw)}` };
      }
      out[def.group][def.key] = raw;
    } else {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < def.min || raw > def.max) {
        return { ok: false, error: `${def.key} 必须是 ${def.min}-${def.max} 之间的数字，收到 ${JSON.stringify(raw)}` };
      }
      out[def.group][def.key] = Math.round(raw * 100) / 100;
    }
  }
  const allowedKeys = new Set(FIELD_DEFS.map((d) => d.key));
  for (const groupName of ['colors', 'equipment', 'animation']) {
    for (const key of Object.keys(input[groupName])) {
      if (!allowedKeys.has(key)) {
        return { ok: false, error: `存在未知字段 ${groupName}.${key}` };
      }
    }
  }
  return { ok: true, value: out };
}

// 稳定哈希：先规范化字段顺序再做 SHA-256，同样的配置永远得到同样的哈希。
export async function hashConfig(config) {
  const check = validateConfig(config);
  if (!check.ok) throw new Error(`无法为非法配置计算哈希：${check.error}`);
  const canonical = canonicalJSON(check.value);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function canonicalJSON(config) {
  const ordered = { schemaVersion: config.schemaVersion };
  for (const groupName of ['colors', 'equipment', 'animation']) {
    ordered[groupName] = {};
    for (const def of FIELD_DEFS.filter((d) => d.group === groupName)) {
      ordered[groupName][def.key] = config[groupName][def.key];
    }
  }
  return JSON.stringify(ordered);
}
